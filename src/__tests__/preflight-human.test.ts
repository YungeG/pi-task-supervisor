import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginPreflight,
  PREFLIGHT_ENTRY,
  restorePreflight,
  preflightContext,
  preflightStatusLines,
} from "../preflight";
import { randomUUID } from "node:crypto";
import { observeTool, prepareToolCapture, saveSupervisor, supervisorState } from "../supervisor";
import {
  approvePreflight,
  repairPreflightProjection,
  startApprovedPreflight,
} from "../preflight-human";
import { createSubmitPreflightTool } from "../tools";
import { trustedCliRoots } from "../human-ui";
import { findReadbackProof, inspectSessionJournal } from "../human-journal";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import { localProposal } from "./helpers/preflight";

const dirs: string[] = [];
const argv = process.argv;
const descriptors = [process.stdin, process.stdout].map((s) =>
  Object.getOwnPropertyDescriptor(s, "isTTY"),
);
beforeEach(() => {
  resetState();
  const root = trustedCliRoots()[0];
  if (!root) throw new Error("Installed Pi required for native mechanism simulation");
  process.argv = [process.execPath, join(root, "dist", "cli.js")];
  for (const s of [process.stdin, process.stdout])
    Object.defineProperty(s, "isTTY", { configurable: true, value: true });
});
afterEach(() => {
  process.argv = argv;
  [process.stdin, process.stdout].forEach((s, i) => {
    if (descriptors[i]) Object.defineProperty(s, "isTTY", descriptors[i]);
    else Reflect.deleteProperty(s, "isTTY");
  });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture() {
  const mock = createMockAPI();
  const ctx = createMockContext();
  const dir = mkdtempSync(join(tmpdir(), "preflight-native-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const entries: any[] = [];
  let leaf: string | null = null;
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
  Object.assign(ctx.sessionManager, {
    getSessionFile: () => path,
    getBranch: () => entries,
    getLeafId: () => leaf,
  });
  mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const entry = {
      type: "custom",
      id: `e${entries.length + 1}`,
      parentId: leaf,
      customType,
      data: structuredClone(data),
    };
    entries.push(entry);
    leaf = entry.id;
    appendFileSync(path, JSON.stringify(entry) + "\n");
  });
  vi.mocked(ctx.ui.select).mockResolvedValue("Approve");
  return { ...mock, ctx, path, entries };
}
async function submitted(h: ReturnType<typeof fixture>) {
  const planning = beginPreflight(h.api, h.ctx, "Local fixture");
  return createSubmitPreflightTool(h.api).execute(
    "submit",
    { preflightId: planning.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
}
function failCache(h: ReturnType<typeof fixture>) {
  const append = h.appendEntry.getMockImplementation() as (kind: string, data: unknown) => void;
  h.appendEntry.mockImplementation((kind: string, data: unknown) => {
    if (
      kind === PREFLIGHT_ENTRY &&
      data &&
      typeof data === "object" &&
      "approval" in data &&
      data.approval
    )
      throw new Error("cache write failed");
    append(kind, data);
  });
  return append;
}

it("native submit approves required only without starting", async () => {
  const h = fixture();
  const planning = beginPreflight(h.api, h.ctx, "Local fixture");
  vi.mocked(h.ctx.isIdle).mockReturnValue(false);
  const result = await createSubmitPreflightTool(h.api).execute(
    "submit",
    { preflightId: planning.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).not.toBe(true);
  expect(currentRuntime().preflight).toMatchObject({
    phase: "approved",
    approval: { permissionIds: ["A1"] },
  });
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(currentRuntime().supervisor).toBeUndefined();
  const state = currentRuntime().preflight!;
  const request = (state as any).permissionRequest;
  const journal = inspectSessionJournal({
    path: h.path,
    sessionId: "test-session",
    leafId: h.ctx.sessionManager.getLeafId(),
  });
  expect(findReadbackProof(journal, "preflight", request.id).status).toBe("confirmed");
  expect(JSON.stringify(result.content)).toContain("controlEntryId");
  expect(JSON.stringify(result.content)).toContain("remainingGates");
  expect(h.ctx.waitForIdle).not.toHaveBeenCalled();
  expect(h.sendMessage).not.toHaveBeenCalled();
});
it("tells Main that approved permissions are not started and offers no-ID start", async () => {
  const h = fixture();
  await submitted(h);
  expect(preflightContext(h.ctx)).toContain("approved, not started");
  expect(preflightContext(h.ctx)).not.toContain("Submit it through submit_preflight");
  expect(preflightStatusLines(h.ctx)).toContain("Next preflight: /task-supervisor start");
});

it("rejects a fabricated request predecessor during raw restoration", async () => {
  const h = fixture();
  await submitted(h);
  const state = currentRuntime().preflight!;
  if (state.version !== 2 || !state.permissionRequest) throw new Error("No native request fixture");
  h.api.appendEntry(PREFLIGHT_ENTRY, {
    ...state,
    permissionRequest: {
      ...state.permissionRequest,
      id: randomUUID(),
      supersedes: { requestId: randomUUID() },
    },
  });
  expect(() => {
    restorePreflight(h.ctx);
  }).toThrow(/request|predecessor/i);
});
it("rejects reuse of a permission request UUID as a start request", async () => {
  const h = fixture();
  await submitted(h);
  const state = currentRuntime().preflight!;
  if (state.version !== 2 || !state.permissionRequest) throw new Error("No native request fixture");
  h.api.appendEntry(PREFLIGHT_ENTRY, {
    ...state,
    startRequest: { id: state.permissionRequest.id },
  });
  expect(() => {
    restorePreflight(h.ctx);
  }).toThrow(/request/i);
});
it("rebinds changed permission selection after defer to a fresh logical request", async () => {
  const h = fixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("Defer");
  await submitted(h);
  const first = currentRuntime().preflight!;
  if (first.version !== 2 || !first.permissionRequest) throw new Error("No native request fixture");
  const result = await approvePreflight(h.api, h.ctx, undefined, "all");
  const next = result.state;
  if (next.version !== 2 || !next.permissionRequest) throw new Error("No native request fixture");
  expect(next.permissionRequest.id).not.toBe(first.permissionRequest.id);
  expect(next.permissionRequest.supersedes).toMatchObject({
    requestId: first.permissionRequest.id,
  });
  expect(next.approval?.permissionIds).toEqual(["A1", "A2"]);
});

it("preserves the original repair hint and fault when reinspection fails", async () => {
  const h = fixture();
  failCache(h);
  const outcome = await submitted(h);
  expect(outcome.details.projectionPending).toBe(true);
  const hint = structuredClone(currentRuntime().preflightRepair);
  const fault = currentRuntime().journalFault;
  writeFileSync(h.path, "not a complete journal");
  expect(() => {
    repairPreflightProjection(h.api, h.ctx);
  }).toThrow();
  expect(currentRuntime().preflightRepair).toEqual(hint);
  expect(currentRuntime().journalFault).toBe(fault);
  expect(h.sendMessage).not.toHaveBeenCalled();
});
it("treats an already persisted exact C as a repair no-op", async () => {
  const h = fixture();
  const append = failCache(h);
  const outcome = await submitted(h);
  expect(outcome.details.projectionPending).toBe(true);
  h.appendEntry.mockImplementation(append);
  h.api.appendEntry(PREFLIGHT_ENTRY, outcome.details.state);
  const count = h.appendEntry.mock.calls.length;
  repairPreflightProjection(h.api, h.ctx);
  expect(h.appendEntry).toHaveBeenCalledTimes(count);
  expect(currentRuntime().preflightRepair).toBeUndefined();
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(h.sendMessage).not.toHaveBeenCalled();
});
it("does not turn a failed first permission-control append into approval or a second receipt", async () => {
  const h = fixture();
  const append = h.appendEntry.getMockImplementation() as (kind: string, data: unknown) => void;
  h.appendEntry.mockImplementation((kind: string, data: unknown) => {
    if (kind === "continuous-tasks:preflight-control")
      throw new Error("permission control append failed");
    append(kind, data);
  });
  const result = await submitted(h);
  expect(result.isError).toBe(true);
  expect(currentRuntime().journalFault).toBeDefined();
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  expect(h.entries.some((entry) => entry.customType === "continuous-tasks:human-readback")).toBe(
    false,
  );
  expect(h.sendMessage).not.toHaveBeenCalled();
});

it("does not publish first startup when the live start control cannot be saved", async () => {
  const h = fixture();
  await submitted(h);
  Object.assign(h.ctx, { model: { provider: "faux", id: "test" } });
  vi.mocked(h.ctx.ui.select).mockResolvedValue("Start execution");
  const append = h.appendEntry.getMockImplementation() as (kind: string, data: unknown) => void;
  h.appendEntry.mockImplementation((kind: string, data: unknown) => {
    if (kind === "continuous-tasks:preflight-control")
      throw new Error("start control append failed");
    append(kind, data);
  });
  await expect(startApprovedPreflight(h.api, h.ctx)).rejects.toThrow("start control append failed");
  expect(currentRuntime().journalFault).toBeDefined();
  expect(currentRuntime().preflight?.phase).toBe("approved");
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(supervisorState()).toBeUndefined();
  expect(h.entries.some((entry) => entry.customType === "continuous-tasks:supervisor")).toBe(false);
  expect(h.sendMessage).not.toHaveBeenCalled();
});

it("retains the confirmed start response when S persistence fails without retrying", async () => {
  const h = fixture();
  await submitted(h);
  Object.assign(h.ctx, { model: { provider: "faux", id: "test" } });
  vi.mocked(h.ctx.ui.select).mockResolvedValue("Start execution");
  const append = h.appendEntry.getMockImplementation() as (kind: string, data: unknown) => void;
  h.appendEntry.mockImplementation((kind: string, data: unknown) => {
    if (kind === "continuous-tasks:supervisor") throw new Error("S failed");
    append(kind, data);
  });
  const result = await startApprovedPreflight(h.api, h.ctx);
  expect(result.status).toBe("already_saved");
  expect(result.confirmed?.kind).toBe("start");
  expect(result.projectionPending).toBe(true);
  expect(result.state.started).toBeUndefined();
  expect(currentRuntime().journalFault).toBeDefined();
  expect(h.sendMessage).not.toHaveBeenCalled();
});

it("retains Supervisor counters in a read-only hold when preflight restoration throws", async () => {
  const { preflightLifecycle } = await import("./helpers/preflight");
  const h = preflightLifecycle();
  await h.command("preflight Local fixture");
  vi.mocked(h.ctx.ui.select).mockResolvedValue("Approve");
  await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: currentRuntime().preflight!.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  await h.command("start");
  // Simulate host events through the receipt owner's public interface, not an
  // impossible mutation of the checkpoint epoch behind its ledger.
  for (let i = 0; i < 11; i++) {
    const tool = {
      toolCallId: `held-${i}`,
      toolName: "bash",
      input: { command: "synthetic only" },
    };
    prepareToolCapture(h.mock.api, { type: "tool_call", ...tool });
    observeTool(h.mock.api, {
      type: "tool_result",
      ...tool,
      content: [{ type: "text", text: "synthetic host result" }],
      isError: false,
      details: undefined,
      structuredContent: { exit_code: 0 },
    });
  }
  Object.assign(supervisorState()!, {
    reviews: 7,
    continuations: 5,
    tokens: 123,
    cost: 2,
    epoch: 11,
  });
  saveSupervisor(h.mock.api);
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, { ...currentRuntime().preflight, version: 99 });
  currentRuntime().supervisor = undefined;
  h.mock.appendEntry.mockClear();
  h.mock.sendMessage.mockClear();
  await h.fire("session_tree");
  expect(currentRuntime().journalFault).toBeDefined();
  expect(supervisorState()).toMatchObject({
    status: "fault",
    reviews: 7,
    continuations: 5,
    tokens: 123,
    cost: 2,
    epoch: 11,
  });
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(h.mock.sendMessage.mock.calls.some(([, options]) => options.triggerTurn)).toBe(false);
});

it("native no-ID first start confirms separately and dispatches once", async () => {
  const { preflightLifecycle } = await import("./helpers/preflight");
  const h = preflightLifecycle();
  await h.command("preflight Local fixture");
  vi.mocked(h.ctx.ui.select).mockResolvedValue("Approve");
  const outcome = await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: currentRuntime().preflight!.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  expect(outcome.details.status).toBe("approved");
  h.mock.sendMessage.mockClear();
  await h.command("start");
  expect(
    h.entries.find((entry) => entry.customType === "continuous-tasks:supervisor")?.data,
  ).toMatchObject({
    version: 3,
    receipts: [],
    receiptLedger: { receiptCount: 0, sequence: 0, head: null, pending: [] },
  });
  expect(currentRuntime().preflight?.phase).toBe("started");
  const continuation = h.mock.sendMessage.mock.calls.find(
    ([, options]) => options.triggerTurn,
  )?.[0];
  expect(continuation?.content).toContain("Confirmed preflight execution agreement");
  expect(continuation?.content).toContain("selectedPermissionIds");
  expect(continuation?.content).toContain("prohibitions");
  expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
    1,
  );
  await h.command("start");
  expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
    1,
  );
});
