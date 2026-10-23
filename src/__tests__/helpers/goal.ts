import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createMockAPI, createMockContext } from "./mocks";
import { installCustomUI } from "./custom-ui";
import { trustedCliRoots } from "../../human-ui";
import { setBoard, getBoard, migrateLegacySnapshot } from "../../state";
import { startSupervisor } from "../../supervisor";
import { registerCommands } from "../../commands";
import { registerEventHandlers } from "../../events";
import { getHandler } from "./lifecycle";
import { setSessionScopeEnabled } from "../../scope";
import type { TaskBoardSnapshot } from "../../types";
import { createEmptyBoard } from "../../engine";

export type GoalFixtureEntry = {
  type: "custom";
  id: string;
  parentId: string | null;
  customType: string;
  data: unknown;
};
export async function goalFixture(
  options: { emptyBoard?: boolean; unsupervisedLegacy?: boolean } = {},
) {
  // Mechanism simulation: real journal and installed CLI path; mocked TTY/UI, not human identity proof.
  const root = trustedCliRoots()[0];
  if (!root) throw new Error("Pi peer dependency required");
  const argv = process.argv;
  const tty = [
    Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
  ];
  process.argv = [process.execPath, join(root, "dist/cli.js")];
  for (const stream of [process.stdin, process.stdout])
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  const dir = mkdtempSync(join(tmpdir(), "goal-lifecycle-"));
  const path = join(dir, "session.jsonl");
  let entries: GoalFixtureEntry[] = [];
  let leaf: string | null = null;
  let count = 0;
  let failure:
    | ((type: string, data: unknown) => "before" | "memory" | "after" | undefined)
    | undefined;
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { model: { provider: "faux", id: "test" } });
  Object.assign(ctx.sessionManager, {
    getSessionFile: () => path,
    getLeafId: () => leaf,
    getBranch: () => entries,
    getEntries: () => entries,
    getEntry: (id: string) => entries.find((e) => e.id === id),
    getLeafEntry: () => entries.find((e) => e.id === leaf),
  });
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
  mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const fail = failure?.(customType, data);
    if (fail === "before") throw new Error("Before append");
    const entry: GoalFixtureEntry = {
      type: "custom",
      id: `e${++count}`,
      parentId: leaf,
      customType,
      data: structuredClone(data),
    };
    entries.push(entry);
    leaf = entry.id;
    if (fail === "memory") throw new Error("Memory-only append");
    appendFileSync(path, JSON.stringify(entry) + "\n");
    if (fail === "after") throw new Error("Written, acknowledgement lost");
  });
  const board: TaskBoardSnapshot = {
    version: 2,
    generation: 47,
    workflowStatus: "active",
    finalAcceptanceTaskId: "old-task",
    stagnantSettles: 0,
    tasks: [
      {
        id: "old-task",
        title: "Old unfinished",
        prompt: "Synthetic old work",
        profile: "worker",
        phase: 1,
        dependencies: [],
        status: "implementing",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
    phases: [{ phase: 1, status: "active" }],
  };
  if (options.unsupervisedLegacy) {
    const legacy = {
      version: 1 as const,
      tasks: board.tasks.map((task) => ({ ...task, status: "done" as const })),
      phases: board.phases,
    };
    mock.api.appendEntry("phased-tasks:snapshot", legacy);
    setBoard(migrateLegacySnapshot(legacy));
  } else {
    if (!options.emptyBoard) mock.api.appendEntry("continuous-tasks:snapshot", board);
    setBoard(options.emptyBoard ? createEmptyBoard() : board);
  }
  setSessionScopeEnabled(true);
  registerEventHandlers(mock.api);
  if (!options.unsupervisedLegacy) startSupervisor(mock.api, ctx, "Synthetic old goal");
  registerCommands(mock.api);
  const command = mock.registerCommand.mock.calls[0]![1];
  if (!options.unsupervisedLegacy) await command.handler("stop", ctx);
  const old = getBoard();
  const oldEntry = [...entries]
    .reverse()
    .find((e) => e.customType === "continuous-tasks:snapshot")!;
  vi.mocked(ctx.ui.select).mockResolvedValue("确认提交所选方案");
  let nextDraftChoice = 1;
  const ui = installCustomUI(ctx, (driver) => {
    const choice = nextDraftChoice;
    nextDraftChoice = 1;
    if (choice > 1 && driver.render().includes("需要你回应"))
      for (let i = 0; i < choice; i++) driver.press("\u001b[B");
    driver.reviewAll();
  });
  mock.sendMessage.mockClear();
  return {
    ...mock,
    ctx,
    dir,
    path,
    old,
    oldEntry,
    ui,
    chooseDraft: (index: number) => {
      nextDraftChoice = index;
    },
    command: (input: string) => command.handler(input, ctx),
    fire: (event: string, payload: unknown = {}) => getHandler(mock, event)(payload, ctx),
    entries: () => entries,
    fail: (fn: typeof failure) => {
      failure = fn;
    },
    reload: () => {
      entries = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line) as GoalFixtureEntry);
      leaf = entries.at(-1)?.id ?? null;
      count = Math.max(count, entries.length);
    },
    restoreHost: () => {
      process.argv = argv;
      [process.stdin, process.stdout].forEach((stream, index) => {
        const d = tty[index];
        if (d) Object.defineProperty(stream, "isTTY", d);
        else Reflect.deleteProperty(stream, "isTTY");
      });
      ui.assertNoScriptErrors();
    },
  };
}
