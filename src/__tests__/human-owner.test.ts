import { installCustomUI } from "./helpers/custom-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerBoardDecision,
  boardHumanContext,
  restoreBoardHuman,
  repairBoardProjection,
} from "../board-human";
import { trustedCliRoots } from "../human-ui";
import { inspectSessionJournal, findReadbackProof } from "../human-journal";
import { saveReadbackProjection, sessionJournalView } from "../human-control";
import { getBoard, reconstructState, resetState, setBoard } from "../state";
import { currentRuntime } from "../runtime";
import { createWorkflowGateTool } from "../tools";
import { registerCommands } from "../commands";
import {
  startSupervisor,
  holdSupervisor,
  prepareToolCapture,
  supervisorState,
} from "../supervisor";
import { setSessionScopeEnabled } from "../scope";
import type { TaskBoardSnapshot } from "../types";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const drivers: ReturnType<typeof installCustomUI>[] = [];
const dirs: string[] = [];
const argv = process.argv;
const ttyDescriptors = [
  Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
];
beforeEach(() => {
  resetState();
  setSessionScopeEnabled(true);
  // Mechanism simulation only: real installed CLI path and real files, simulated TTY/UI.
  const root = trustedCliRoots()[0];
  if (!root) throw new Error("Test requires the installed Pi peer dependency");
  process.argv = [process.execPath, join(root, "dist", "cli.js")];
  for (const stream of [process.stdin, process.stdout])
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
});
afterEach(() => {
  process.argv = argv;
  [process.stdin, process.stdout].forEach((stream, i) => {
    const descriptor = ttyDescriptors[i];
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const ui of drivers.splice(0)) ui.assertNoScriptErrors();
});
function baseBoard(): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 1,
    workflowStatus: "active",
    finalAcceptanceTaskId: "t1",
    stagnantSettles: 0,
    tasks: [
      {
        id: "t1",
        title: "Current",
        prompt: "Implement",
        profile: "worker",
        phase: 1,
        status: "implementing",
        dependencies: [],
        createdAt: "now",
        updatedAt: "now",
      },
    ],
    phases: [{ phase: 1, status: "active" }],
  };
}
function waitingBoard(
  kind: "information" | "choice" | "authorization" = "information",
): TaskBoardSnapshot {
  return {
    ...baseBoard(),
    workflowStatus: "waiting_for_decision",
    decision: {
      id: "question1",
      taskId: "t1",
      question: "Provide value",
      whyUserOwned: "User-owned information",
      createdAt: "now",
      spec:
        kind === "information"
          ? { version: 1, kind, format: "integer" }
          : kind === "choice"
            ? { version: 1, kind }
            : { version: 1, kind, scope: "Only local tests", prohibitions: ["No network"] },
      ...(kind === "choice" ? { options: ["Option A", "Option B"] } : {}),
    },
  };
}
type Entry = {
  type: "custom";
  id: string;
  parentId: string | null;
  customType: string;
  data: unknown;
};
function fixture(board: TaskBoardSnapshot) {
  const dir = mkdtempSync(join(tmpdir(), "human-owner-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  let entries: Entry[] = [];
  let leaf: string | null = null;
  let count = 0;
  let fail: ((kind: string) => boolean) | undefined;
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx.sessionManager, {
    getSessionFile: () => path,
    getLeafId: () => leaf,
    getBranch: () => entries,
  });
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
  mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const entry: Entry = {
      type: "custom",
      id: `e${++count}`,
      parentId: leaf,
      customType,
      data: structuredClone(data),
    };
    entries.push(entry);
    leaf = entry.id;
    if (fail?.(customType)) throw new Error("Simulated write failure after native memory update");
    appendFileSync(path, JSON.stringify(entry) + "\n");
  });
  mock.api.appendEntry("continuous-tasks:snapshot", board);
  setBoard(board);
  vi.mocked(ctx.ui.select).mockResolvedValue("允许上述范围");
  Object.assign(ctx.ui, { input: vi.fn(async () => "42") });
  const ui = installCustomUI(ctx, (d) => {
    d.reviewAll();
  });
  drivers.push(ui);
  return {
    ...mock,
    ctx,
    path,
    ui,
    failWrites: (predicate: (kind: string) => boolean) => {
      fail = predicate;
    },
    reload: () => {
      entries = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line) as Entry);
      leaf = entries.at(-1)?.id ?? null;
    },
  };
}
async function pendingBoardCache() {
  const test = fixture(waitingBoard());
  test.failWrites((kind) => kind === "continuous-tasks:snapshot");
  expect((await answerBoardDecision(test.api, test.ctx)).projectionPending).toBe(true);
  test.reload();
  resetState();
  setBoard(restoreBoardHuman(test.ctx, reconstructState(test.ctx)));
  test.failWrites(() => false);
  return test;
}

describe("board owner live publisher and carrier", () => {
  it("shows the original board question with formatted browsing while defer saves no control", async () => {
    const test = fixture(waitingBoard("authorization"));
    vi.mocked(test.ctx.ui.select).mockResolvedValueOnce("稍后决定");
    const result = await answerBoardDecision(test.api, test.ctx);
    test.ui.assertNoScriptErrors();
    expect(result.status).toBe("deferred");
    expect(test.ui.rendered.join("\n")).toContain("格式化浏览");
    expect(test.ui.rendered.join("\n")).toContain("只读核对");
    expect(test.ui.reviewedMaterial.join("\n")).toContain("Only·local·tests");
    const title = vi.mocked(test.ctx.ui.select).mock.calls[0]?.[0] ?? "missing";
    expect(title.split("\n")[1]).toBe("问题：Provide value");
    expect(getBoard().workflowStatus).toBe("waiting_for_decision");
    expect(getBoard().decision?.question).toBe("Provide value");
    expect(
      test.appendEntry.mock.calls.some(
        ([kind, data]) =>
          kind === "continuous-tasks:event" &&
          data !== null &&
          typeof data === "object" &&
          "type" in data &&
          data.type === "resolve_decision",
      ),
    ).toBe(false);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["information", "choice"] as const)(
    "delivers the saved %s value in the one tool result",
    async (kind) => {
      const test = fixture(baseBoard());
      if (kind === "choice") vi.mocked(test.ctx.ui.select).mockResolvedValue("选项 2 · Option B");
      const decision = waitingBoard(kind).decision!;
      const result = await createWorkflowGateTool(test.api).execute(
        "gate",
        { action: "wait_for_decision", taskId: "t1", decision },
        undefined,
        undefined,
        test.ctx,
      );
      test.ui.assertNoScriptErrors();
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
      expect(test.ui.reviewedMaterial.join("")).toContain("User-owned·information");
      if (kind === "choice")
        expect(vi.mocked(test.ctx.ui.select).mock.calls.at(-1)?.[1]).toContain("选项 2 · Option B");
      const text = JSON.stringify(result.content);
      expect(text).toContain(kind === "choice" ? "Option B" : "42");
      expect(text).toContain("controlEntryId");
      expect(text).toContain("confirmed");
      expect(test.sendMessage).not.toHaveBeenCalled();
      expect(getBoard().workflowStatus).toBe("active");
    },
  );
  it("includes information and scope in the sole idle continuation", async () => {
    const test = fixture(waitingBoard());
    registerCommands(test.api);
    const command = test.registerCommand.mock.calls.find(
      ([name]) => name === "task-supervisor",
    )![1];
    await command.handler("decide", test.ctx);
    expect(test.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("详情：/task-supervisor tasks → 确认与回应"),
      "info",
    );
    expect(test.sendMessage).toHaveBeenCalledTimes(1);
    expect(test.sendMessage.mock.calls[0]![0].content).toContain('"value":"42"');
    expect(test.sendMessage.mock.calls[0]![0].content).toContain('"kind":"information"');
    expect(test.sendUserMessage).not.toHaveBeenCalled();
  });
  it.each(["fault", "budget"] as const)(
    "saves information under an independent %s hold without clearing counters or dispatching",
    async (hold) => {
      const test = fixture(baseBoard());
      Object.assign(test.ctx, { model: { provider: "faux", id: "test" } });
      startSupervisor(test.api, test.ctx, "Existing authorized goal");
      if (hold === "fault")
        holdSupervisor(test.api, test.ctx, "fault", "Inspect existing work", "interrupted");
      const owner = supervisorState()!;
      Object.assign(owner, {
        reviews: 40,
        continuations: 20,
        stagnant: 3,
        tokens: 78,
        cost: 2,
        epoch: 9,
      });
      const before = structuredClone(owner);
      const waiting = { ...waitingBoard(), generation: 2 };
      test.api.appendEntry("continuous-tasks:snapshot", waiting);
      setBoard(waiting);
      registerCommands(test.api);
      test.sendMessage.mockClear();
      const command = test.registerCommand.mock.calls.find(
        ([name]) => name === "task-supervisor",
      )![1];
      await command.handler("decide", test.ctx);
      expect(getBoard().workflowStatus).toBe("active");
      expect(supervisorState()).toEqual(before);
      expect(boardHumanContext(test.ctx)).toContain('"value":"42"');
      expect(test.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("saves a native answer but does not dispatch through an unresolved host receipt intent", async () => {
    const test = fixture(baseBoard());
    Object.assign(test.ctx, { model: { provider: "faux", id: "test" } });
    startSupervisor(test.api, test.ctx, "Existing authorized goal");
    prepareToolCapture(test.api, {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "pending-human-gate",
      input: { command: "Synthetic intent only; never execute" },
    });
    const store = currentRuntime().receiptStore!;
    expect(store.pendingCount).toBe(1);
    const before = store.checkpoint();
    const waiting = { ...waitingBoard(), generation: 2 };
    test.api.appendEntry("continuous-tasks:snapshot", waiting);
    setBoard(waiting);
    registerCommands(test.api);
    test.sendMessage.mockClear();
    const command = test.registerCommand.mock.calls.find(
      ([name]) => name === "task-supervisor",
    )![1];
    await command.handler("decide", test.ctx);
    expect(getBoard().workflowStatus).toBe("active");
    expect(boardHumanContext(test.ctx)).toContain('"value":"42"');
    expect(store.checkpoint()).toEqual(before);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });

  it("retains confirmed information when C fails, then reconstructs without reapproval", async () => {
    const test = fixture(waitingBoard());
    test.failWrites((kind) => kind === "continuous-tasks:snapshot");
    const answer = await answerBoardDecision(test.api, test.ctx);
    expect(answer.confirmed?.value).toBe("42");
    expect(answer.projectionPending).toBe(true);
    expect(currentRuntime().journalFault).toBeDefined();
    expect(test.sendMessage).not.toHaveBeenCalled();
    test.reload();
    resetState();
    const restored = restoreBoardHuman(test.ctx, reconstructState(test.ctx));
    expect(restored.workflowStatus).toBe("active");
    expect(currentRuntime().journalFault).toMatch(/projection/i);
    expect(boardHumanContext(test.ctx)).toContain('"value":"42"');
    expect(test.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it("repairs only the saved board cache without asking or dispatching again", async () => {
    const test = fixture(waitingBoard());
    test.failWrites((kind) => kind === "continuous-tasks:snapshot");
    const saved = await answerBoardDecision(test.api, test.ctx);
    expect(saved.projectionPending).toBe(true);
    test.reload();
    resetState();
    setBoard(restoreBoardHuman(test.ctx, reconstructState(test.ctx)));
    test.failWrites(() => false);
    const count = test.appendEntry.mock.calls.length;
    repairBoardProjection(test.api, test.ctx);
    expect(test.appendEntry).toHaveBeenCalledTimes(count + 1);
    expect(test.appendEntry.mock.calls.at(-1)?.[0]).toBe("continuous-tasks:snapshot");
    expect(getBoard().workflowStatus).toBe("active");
    expect(currentRuntime().boardRepair).toBeUndefined();
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(test.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it("makes board repair a no-op when exact C is already present", async () => {
    const test = fixture(waitingBoard());
    test.failWrites((kind) => kind === "continuous-tasks:snapshot");
    await answerBoardDecision(test.api, test.ctx);
    test.reload();
    resetState();
    const view = restoreBoardHuman(test.ctx, reconstructState(test.ctx));
    setBoard(view);
    test.failWrites(() => false);
    test.api.appendEntry("continuous-tasks:snapshot", view);
    const count = test.appendEntry.mock.calls.length;
    repairBoardProjection(test.api, test.ctx);
    expect(test.appendEntry).toHaveBeenCalledTimes(count);
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it("retains board repair evidence and fault after failed reinspection", async () => {
    const test = fixture(waitingBoard());
    test.failWrites((kind) => kind === "continuous-tasks:snapshot");
    await answerBoardDecision(test.api, test.ctx);
    const hint = structuredClone(currentRuntime().boardRepair);
    const fault = currentRuntime().journalFault;
    writeFileSync(test.path, "broken journal");
    expect(() => {
      repairBoardProjection(test.api, test.ctx);
    }).toThrow();
    expect(currentRuntime().boardRepair).toEqual(hint);
    expect(currentRuntime().journalFault).toBe(fault);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it("does not clear an independent fault after board cache repair", async () => {
    const test = fixture(waitingBoard());
    test.failWrites((kind) => kind === "continuous-tasks:snapshot");
    await answerBoardDecision(test.api, test.ctx);
    test.reload();
    resetState();
    setBoard(restoreBoardHuman(test.ctx, reconstructState(test.ctx)));
    currentRuntime().journalFault = "independent fault";
    test.failWrites(() => false);
    repairBoardProjection(test.api, test.ctx);
    expect(currentRuntime().journalFault).toBe("independent fault");
    expect(test.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["missing control", "wrong node", "wrong digest"])(
    "rejects board repair with %s while preserving its held result",
    async (corruption) => {
      const test = await pendingBoardCache();
      const hint = currentRuntime().boardRepair!;
      if (corruption === "missing control") hint.controlEntryId = "absent";
      else if (corruption === "wrong node") hint.controlEntryId = "e1";
      else hint.projectedDigest = "a".repeat(64);
      const before = structuredClone(hint);
      const fault = currentRuntime().journalFault;
      const count = test.appendEntry.mock.calls.length;
      expect(() => {
        repairBoardProjection(test.api, test.ctx);
      }).toThrow(/Invalid board repair control|Board repair authority changed/);
      expect(currentRuntime().boardRepair).toEqual(before);
      expect(currentRuntime().journalFault).toBe(fault);
      expect(test.appendEntry).toHaveBeenCalledTimes(count);
      expect(test.sendMessage).not.toHaveBeenCalled();
    },
  );
  it("retains board repair evidence when C writing fails again", async () => {
    const test = await pendingBoardCache();
    const hint = structuredClone(currentRuntime().boardRepair);
    const fault = currentRuntime().journalFault;
    test.failWrites((kind) => kind === "continuous-tasks:snapshot");
    expect(() => {
      repairBoardProjection(test.api, test.ctx);
    }).toThrow("Simulated write failure");
    expect(currentRuntime().boardRepair).toEqual(hint);
    expect(currentRuntime().journalFault).toBe(fault);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it("does not repair over a contradictory same-generation board cache", async () => {
    const test = await pendingBoardCache();
    const view = getBoard();
    view.tasks[0]!.prompt = "Different scope";
    test.api.appendEntry("continuous-tasks:snapshot", view);
    expect(() => {
      repairBoardProjection(test.api, test.ctx);
    }).toThrow("Conflicting board projection");
    expect(currentRuntime().journalFault).toMatch(/projection/);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["cancel", "pending input", "scope change"])(
    "invalidates the actual information callback after %s",
    async (reason) => {
      const test = fixture(waitingBoard());
      const abort = new AbortController();
      vi.mocked(test.ctx.ui.input).mockImplementation(async () => {
        if (reason === "cancel") abort.abort();
        else if (reason === "pending input")
          vi.mocked(test.ctx.hasPendingMessages).mockReturnValue(true);
        else setBoard({ ...getBoard(), generation: 2 });
        return "42";
      });
      expect((await answerBoardDecision(test.api, test.ctx, abort.signal)).status).toBe("deferred");
      expect(test.appendEntry.mock.calls.some(([kind]) => kind === "continuous-tasks:event")).toBe(
        false,
      );
      expect(test.sendMessage).not.toHaveBeenCalled();
    },
  );
  it("does not save an invalid typed information value", async () => {
    const test = fixture(waitingBoard());
    vi.mocked(test.ctx.ui.input).mockResolvedValue("not an integer");
    expect((await answerBoardDecision(test.api, test.ctx)).status).toBe("deferred");
    expect(getBoard().workflowStatus).toBe("waiting_for_decision");
    expect(test.appendEntry.mock.calls.some(([kind]) => kind === "continuous-tasks:event")).toBe(
      false,
    );
  });

  it("records an actual authorization rejection once and never asks the terminal decision again", async () => {
    const test = fixture(waitingBoard("authorization"));
    vi.mocked(test.ctx.ui.select).mockResolvedValue("不允许");
    const rejected = await answerBoardDecision(test.api, test.ctx);
    expect(rejected).toMatchObject({
      status: "rejected",
      confirmed: { outcome: "reject", value: "不批准上述范围" },
    });
    expect(getBoard()).toMatchObject({
      workflowStatus: "waiting_for_decision",
      decision: { response: "rejected" },
    });
    const count = test.appendEntry.mock.calls.length;
    expect((await answerBoardDecision(test.api, test.ctx)).status).toBe("rejected");
    expect(test.ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(test.appendEntry).toHaveBeenCalledTimes(count);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it("routes explicit board repair before the journal-fault gate without enabling or dispatching", async () => {
    const test = await pendingBoardCache();
    registerCommands(test.api);
    const handler = test.registerCommand.mock.calls.find(([name]) => name === "task-supervisor")![1]
      .handler;
    const count = test.appendEntry.mock.calls.length;
    await handler("repair-decision", test.ctx);
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(test.appendEntry).toHaveBeenCalledTimes(count + 1);
    expect(test.appendEntry.mock.calls.at(-1)?.[0]).toBe("continuous-tasks:snapshot");
    expect(test.sendMessage).not.toHaveBeenCalled();
    expect(test.ctx.ui.input).toHaveBeenCalledTimes(1);
  });

  it("does not accept a no-op control append as a saved response", async () => {
    const test = fixture(waitingBoard());
    const append = test.appendEntry.getMockImplementation() as (
      kind: string,
      data: unknown,
    ) => void;
    test.appendEntry.mockImplementation((kind, data) => {
      if (kind !== "continuous-tasks:event") append(kind, data);
    });
    await expect(answerBoardDecision(test.api, test.ctx)).rejects.toMatchObject({
      code: "READBACK_INVALID",
    });
    expect(getBoard().workflowStatus).toBe("waiting_for_decision");
    expect(
      test.appendEntry.mock.calls.some(([kind]) => kind === "continuous-tasks:human-readback"),
    ).toBe(false);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects a base changed on disk during the native callback", async () => {
    const test = fixture(waitingBoard());
    vi.mocked(test.ctx.ui.input).mockImplementation(async () => {
      const entries = test.ctx.sessionManager.getBranch();
      const base = entries[0];
      if (!base || base.type !== "custom") throw new Error("Missing base fixture");
      (base.data as TaskBoardSnapshot).tasks[0]!.prompt = "Changed after presentation";
      const header = readFileSync(test.path, "utf8").split("\n")[0] ?? "";
      writeFileSync(
        test.path,
        header + "\n" + entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      return "42";
    });
    await expect(answerBoardDecision(test.api, test.ctx)).rejects.toMatchObject({
      code: "READBACK_INVALID",
    });
    expect(test.appendEntry.mock.calls.some(([kind]) => kind === "continuous-tasks:event")).toBe(
      false,
    );
    expect(test.sendMessage).not.toHaveBeenCalled();
  });
  it("rechecks file authority rather than trusting a copied proof DTO for cache writes", async () => {
    const test = fixture(waitingBoard());
    await answerBoardDecision(test.api, test.ctx);
    const proof = findReadbackProof(
      inspectSessionJournal(sessionJournalView(test.ctx)),
      "board",
      "question1",
    );
    if (proof.status !== "confirmed") throw new Error("Missing genuine proof fixture");
    const count = test.appendEntry.mock.calls.length;
    const forged = { ...proof, control: { ...proof.control, id: "forged" } };
    expect(() => {
      saveReadbackProjection(test.api, test.ctx, forged, getBoard());
    }).toThrow("READBACK_INVALID");
    expect(test.appendEntry).toHaveBeenCalledTimes(count);
    expect(test.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["continuous-tasks:event", "continuous-tasks:human-readback"])(
    "never confirms a phantom %s write",
    async (failedKind) => {
      const test = fixture(waitingBoard());
      test.failWrites((kind) => kind === failedKind);
      await expect(answerBoardDecision(test.api, test.ctx)).rejects.toThrow();
      expect(currentRuntime().journalFault).toBeDefined();
      expect(getBoard().workflowStatus).toBe("waiting_for_decision");
      expect(test.sendMessage).not.toHaveBeenCalled();
      test.reload();
      resetState();
      if (failedKind.endsWith("human-readback"))
        expect(() => restoreBoardHuman(test.ctx, reconstructState(test.ctx))).toThrow(
          /Unconfirmed/,
        );
      else
        expect(restoreBoardHuman(test.ctx, reconstructState(test.ctx)).workflowStatus).toBe(
          "waiting_for_decision",
        );
    },
  );
});

it.each(["Later", "稍后决定", "重新核对全文"])(
  "saves the original reserved business value %s through the real indexed owner UI",
  async (value) => {
    const test = fixture(baseBoard());
    const decision = { ...waitingBoard("choice").decision!, options: [value, "Other value"] };
    vi.mocked(test.ctx.ui.select).mockImplementationOnce(async (_title, labels) =>
      labels.find((label) => label.startsWith("选项 1 · ")),
    );
    const result = await createWorkflowGateTool(test.api).execute(
      "gate",
      {
        action: "wait_for_decision",
        taskId: "t1",
        decision,
      },
      undefined,
      undefined,
      test.ctx,
    );
    test.ui.assertNoScriptErrors();
    expect(vi.mocked(test.ctx.ui.select).mock.calls.at(-1)?.[1]).toContain(`选项 1 · ${value}`);
    expect(result.isError).not.toBe(true);
    expect(
      result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    ).toContain(`"value":"${value}"`);
    expect(getBoard().workflowStatus).toBe("active");
    expect(test.sendMessage).not.toHaveBeenCalled();
    const branch = inspectSessionJournal(sessionJournalView(test.ctx)).branch;
    expect(
      branch.filter(
        (node) =>
          node.customType === "continuous-tasks:event" &&
          (node.data as { type?: unknown }).type === "resolve_decision",
      ),
    ).toHaveLength(1);
  },
);
