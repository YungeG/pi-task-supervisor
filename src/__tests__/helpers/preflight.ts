import { installCustomUI } from "./custom-ui";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedCliRoots } from "../../human-ui";
import { beginPreflight, preflightContext } from "../../preflight";
import { assertPlanningAdmission, enterPlanningMode } from "../../management-policy";
import { enableSessionScope, updateActiveTools } from "../../scope";
import { refreshUI } from "../../state";
import { currentRuntime } from "../../runtime";
const drivers: ReturnType<typeof installCustomUI>[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const ui of drivers.splice(0)) ui.assertNoScriptErrors();
});
import { afterEach, vi } from "vitest";
import { lifecycle } from "./lifecycle";

/** SDK persistence boundary with actual unique identities. Default setup deliberately
 * preserves the historical v2 permission protocol through the host initializer; new
 * workflow tests pass consolidated:true and use the real human command route. */
export function preflightLifecycle(options: { consolidated?: boolean } = {}) {
  const h = lifecycle();
  // Real-file/native-boundary simulation, never a production source bypass.
  const dir = mkdtempSync(join(tmpdir(), "preflight-fixture-"));
  const path = join(dir, "session.jsonl");
  const oldArgv = process.argv;
  const descriptors = [process.stdin, process.stdout].map((s) =>
    Object.getOwnPropertyDescriptor(s, "isTTY"),
  );
  const root = trustedCliRoots()[0];
  if (!root) throw new Error("Installed Pi peer dependency required");
  process.argv = [process.execPath, join(root, "dist", "cli.js")];
  for (const stream of [process.stdin, process.stdout])
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  cleanups.push(() => {
    process.argv = oldArgv;
    [process.stdin, process.stdout].forEach((stream, i) => {
      if (descriptors[i]) Object.defineProperty(stream, "isTTY", descriptors[i]);
      else Reflect.deleteProperty(stream, "isTTY");
    });
    rmSync(dir, { recursive: true, force: true });
  });
  const header = JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n";
  writeFileSync(path, header);
  Object.assign(h.ctx.sessionManager, { getSessionFile: vi.fn(() => path) });
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  const entries: Array<{
    type: "custom";
    id: string;
    parentId: string | null;
    timestamp: string;
    customType: string;
    data: unknown;
  }> = [];
  let leaf: string | null = null;
  vi.mocked(h.ctx.sessionManager.getBranch).mockImplementation(() => entries);
  vi.mocked(h.ctx.sessionManager.getLeafId).mockImplementation(() => leaf);
  h.mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const id = `entry-${entries.length + 1}`;
    entries.push({
      type: "custom",
      id,
      parentId: leaf,
      timestamp: new Date().toISOString(),
      customType,
      data: structuredClone(data),
    });
    leaf = id;
    appendFileSync(path, JSON.stringify(entries.at(-1)) + "\n");
  });
  let nextDraftChoice = 1;
  const ui = installCustomUI(h.ctx, (d) => {
    const choice = nextDraftChoice;
    nextDraftChoice = 1;
    if (choice > 1 && d.render().includes("需要你回应"))
      for (let i = 0; i < choice; i++) d.press("\u001b[B");
    d.reviewAll();
  });
  drivers.push(ui);
  const command = async (args: string) => {
    vi.mocked(h.ctx.ui.select).mockImplementation(async (_title, options) =>
      options.includes("开始执行")
        ? "开始执行"
        : options.includes("确认提交所选方案")
          ? "确认提交所选方案"
          : (options.find((option) => /^选项 1(?:$| ·)/u.test(option)) ?? "允许上述范围"),
    );
    try {
      if (!options.consolidated && args.startsWith("preflight ") && !currentRuntime().goal) {
        // Historical host setup, not a current human command or a new legacy switch.
        let began = false;
        try {
          await h.ctx.waitForIdle();
          assertPlanningAdmission(h.ctx);
          beginPreflight(h.mock.api, h.ctx, args.slice("preflight ".length));
          began = true;
          enableSessionScope(h.mock.api);
          enterPlanningMode(h.mock.api, h.ctx);
          updateActiveTools(h.mock.api, true);
          refreshUI(h.ctx);
          const content = preflightContext(h.ctx);
          if (!content) throw Error("Retained planning context unavailable");
          h.mock.api.sendMessage(
            { customType: "continuous-tasks:preflight-planning", content, display: false },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch (error) {
          if (began) {
            currentRuntime().cancel();
            currentRuntime().journalFault ??=
              "Preflight planning dispatch failed; inspect journal before control";
          }
          h.ctx.ui.notify(
            error instanceof Error ? error.message : "Retained planning failed",
            "error",
          );
        }
      } else await h.command(args);
    } finally {
      vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
    }
  };
  return {
    ...h,
    command,
    ui,
    chooseDraft: (index: number) => {
      nextDraftChoice = index;
    },
    entries,
    path,
    syncJournal: () => {
      writeFileSync(path, header + entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    },
  };
}

export const localProposal = {
  summary: "Implement the local fixture with a bounded dependency option",
  steps: ["Inspect current code", "Implement approved changes", "Run local validation"],
  acceptance: ["Local validation passes"],
  permissions: [
    {
      id: "A1",
      action: "Modify the approved source and tests",
      target: "Current repository source and tests",
      environment: "Local checkout only",
      required: true,
      limits: "No external changes or new dependencies",
      risks: "Reversible local file changes",
      fallback: "Keep the current implementation if approval is refused",
      reconfirm: "New paths, goals or external effects",
    },
    {
      id: "A2",
      action: "Install a specific optional dependency",
      target: "Approved fixture dependency only",
      environment: "Local checkout only",
      required: false,
      limits: "One explicitly named dependency",
      risks: "Dependency and lock-file change",
      fallback: "Use the documented no-new-dependency route",
      reconfirm: "Package or source changes",
    },
  ],
  prohibitions: ["No push, publication, deployment or credential changes"],
  reconfirm: ["Material scope changes require a new exact proposal"],
};
