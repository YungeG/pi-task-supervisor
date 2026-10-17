import { installCustomUI } from "./helpers/custom-ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../config";
import { beginPreflight, restorePreflight } from "../preflight";
import { restoreBoardHuman } from "../board-human";
import { createEmptyBoard } from "../engine";
import { createSubmitPreflightTool } from "../tools";
import { registerEventHandlers } from "../events";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { trustedCliRoots } from "../human-ui";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import { localProposal } from "./helpers/preflight";

const drivers: ReturnType<typeof installCustomUI>[] = [];
const dirs: string[] = [];
const argv = process.argv;
const descriptors = [process.stdin, process.stdout].map((s) =>
  Object.getOwnPropertyDescriptor(s, "isTTY"),
);
const realAppend = fs.appendFileSync;
beforeEach(() => {
  resetState();
  process.argv = [process.execPath, join(trustedCliRoots()[0]!, "dist", "cli.js")];
  for (const stream of [process.stdin, process.stdout])
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
});
afterEach(() => {
  fs.appendFileSync = realAppend;
  syncBuiltinESMExports();
  process.argv = argv;
  [process.stdin, process.stdout].forEach((stream, i) => {
    if (descriptors[i]) Object.defineProperty(stream, "isTTY", descriptors[i]);
    else Reflect.deleteProperty(stream, "isTTY");
  });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  for (const ui of drivers.splice(0)) ui.assertNoScriptErrors();
});
function manager() {
  const dir = fs.mkdtempSync(join(tmpdir(), "native-ancestry-"));
  dirs.push(dir);
  return SessionManager.create(dir, join(dir, "sessions"));
}
function host(session: SessionManager) {
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { sessionManager: session });
  mock.appendEntry.mockImplementation((kind: string, data: unknown) => {
    session.appendCustomEntry(kind, data);
  });
  registerEventHandlers(mock.api, async () => DEFAULT_CONFIG);
  const restore = mock.on.mock.calls.find(([name]) => name === "session_start")![1] as (
    event: unknown,
    context: typeof ctx,
  ) => unknown;
  const ui = installCustomUI(ctx, (d) => {
    d.reviewAll();
  });
  drivers.push(ui);
  return { ...mock, ctx, ui, restore: () => restore({}, ctx) };
}
it("rejects a native tool-result descendant whose C parent failed to persist", async () => {
  // Actual SDK persistence/leaf/getBranch behavior; only native UI source boundary is simulated.
  const session = manager();
  session.appendMessage({
    role: "user",
    content: "Owned synthetic fixture",
    timestamp: Date.now(),
  });
  const h = host(session);
  const plan = beginPreflight(h.api, h.ctx, "Local fixture");
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  let failed = false;
  fs.appendFileSync = (path: unknown, body: unknown, ...rest: unknown[]) => {
    if (path === session.getSessionFile() && typeof body === "string") {
      const row = JSON.parse(body);
      if (
        !failed &&
        row.customType === "continuous-tasks:preflight" &&
        row.data?.phase === "approved"
      ) {
        failed = true;
        throw new Error("Physical C append failure");
      }
    }
    (realAppend as (...args: unknown[]) => void)(path, body, ...rest);
  };
  syncBuiltinESMExports();
  const outcome = await createSubmitPreflightTool(h.api).execute(
    "submit",
    { preflightId: plan.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  fs.appendFileSync = realAppend;
  syncBuiltinESMExports();
  expect(failed).toBe(true);
  expect(outcome.details.projectionPending).toBe(true);
  const phantom = session.getLeafId();
  expect(fs.readFileSync(session.getSessionFile()!, "utf8")).not.toContain(`"id":"${phantom}"`);
  // Same public appendMessage path used by the host after its tool returns.
  session.appendMessage({
    role: "toolResult",
    toolCallId: "submit",
    toolName: "submit_preflight",
    content: outcome.content,
    isError: true,
    timestamp: Date.now(),
  });
  const reopened = SessionManager.open(session.getSessionFile()!);
  expect(reopened.getBranch()).toHaveLength(1); // native traversal truncates at the absent C.
  expect(reopened.getBranch()[0]?.parentId).toBe(phantom);
  resetState();
  const restart = host(reopened);
  expect(() => restoreBoardHuman(restart.ctx, createEmptyBoard())).toThrow(
    "JOURNAL_BRANCH_INVALID",
  );
  expect(() => {
    restorePreflight(restart.ctx);
  }).toThrow("JOURNAL_BRANCH_INVALID");
  await restart.restore();
  expect(currentRuntime().journalFault).toMatch(/journal|ancestry/i);
  expect(currentRuntime().enabled).toBe(false);
  expect(restart.sendMessage.mock.calls.some(([, options]) => options.triggerTurn)).toBe(false);
});
it("does not mistake a real setup-only unflushed session for broken persistence", async () => {
  const session = manager();
  session.appendThinkingLevelChange("off");
  expect(fs.existsSync(session.getSessionFile()!)).toBe(false);
  await host(session).restore();
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("holds an ownerless native branch whose previously persisted file disappeared", async () => {
  const session = manager();
  session.appendMessage({ role: "user", content: "Persisted fixture", timestamp: Date.now() });
  fs.rmSync(session.getSessionFile()!);
  await host(session).restore();
  expect(currentRuntime().journalFault).toMatch(/journal/);
});
it("does not certify setup-only from a truncated metadata branch when its durable file disappeared", async () => {
  const session = manager();
  session.appendMessage({ role: "user", content: "Persisted fixture", timestamp: Date.now() });
  const id = session.appendCustomEntry("other:metadata", {});
  const leaf = session.getEntry(id)!;
  leaf.parentId = "missing-parent";
  expect(session.getBranch()).toHaveLength(1);
  fs.rmSync(session.getSessionFile()!);
  await host(session).restore();
  expect(currentRuntime().journalFault).toMatch(/journal/);
});

it("validates an existing malformed durable file even with no native owner records", async () => {
  const session = manager();
  fs.writeFileSync(session.getSessionFile()!, "not a journal\n");
  await host(session).restore();
  expect(currentRuntime().journalFault).toMatch(/journal/);
});

it("allows ownerless in-memory startup without granting recoverable approval", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "native-memory-"));
  dirs.push(dir);
  const session = SessionManager.inMemory(dir);
  session.appendMessage({ role: "user", content: "Memory-only fixture", timestamp: Date.now() });
  await host(session).restore();
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().preflight).toBeUndefined();
});
