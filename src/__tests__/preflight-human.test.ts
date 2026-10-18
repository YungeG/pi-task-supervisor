import { installCustomUI } from "./helpers/custom-ui";
import { visibleWidth } from "@earendil-works/pi-tui";
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

const drivers: ReturnType<typeof installCustomUI>[] = [];
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
  for (const ui of drivers.splice(0)) ui.assertNoScriptErrors();
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
  vi.mocked(ctx.ui.select).mockResolvedValue("允许上述范围");
  const ui = installCustomUI(ctx, (d) => {
    d.reviewAll();
  });
  drivers.push(ui);
  return { ...mock, ctx, path, entries, ui };
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

it("attaches formatted reading and goal context without granting or skipping original permission material", async () => {
  const h = fixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await submitted(h);
  h.ui.assertNoScriptErrors();
  expect(h.ui.rendered.join("\n")).toContain("格式化浏览");
  expect(h.ui.rendered.join("\n")).toContain("只读核对");
  const title = vi.mocked(h.ctx.ui.select).mock.calls[0]?.[0] ?? "missing";
  expect(title.split("\n")).toHaveLength(2);
  expect(title.split("\n")[1]).toContain("Local fixture");
  const original = h.ui.reviewedMaterial.join("").replaceAll("·", " ").replaceAll("\\\\", "\\");
  expect(original).toContain("未选择，本次不授权");
  expect(original).toContain(localProposal.permissions[1]?.limits ?? "missing");
  expect(h.entries.some((entry) => entry.customType === "continuous-tasks:preflight-control")).toBe(
    false,
  );
});

it("shows every permission limit and prohibition in structured native text rather than duplicated JSON", async () => {
  const h = fixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await submitted(h);
  h.ui.assertNoScriptErrors();
  const material = h.ui.reviewedMaterial.join("").replaceAll("·", " ").replaceAll("\\\\", "\\");
  const title = vi.mocked(h.ctx.ui.select).mock.calls[0]?.[0] ?? "";
  expect(title).toContain("请求 ");
  expect(title).toMatch(/^[^\r\n]+\n问题：[^\r\n]+$/u);
  for (const line of title.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
  expect(material).toContain("目标：Local fixture");
  expect(material).toContain("本次允许");
  expect(material).toContain("未选择，本次不授权");
  expect(material).toContain("禁止事项");
  expect(material).not.toContain("Entire proposal:");
  expect(material).not.toContain('{"summary"');
  for (const permission of localProposal.permissions) {
    for (const value of [
      permission.id,
      permission.action,
      permission.target,
      permission.environment,
      permission.limits,
      permission.risks,
      permission.fallback,
      permission.reconfirm,
    ])
      expect(material).toContain(value);
  }
  for (const value of [
    ...localProposal.steps,
    ...localProposal.acceptance,
    ...localProposal.prohibitions,
    ...localProposal.reconfirm,
  ])
    expect(material).toContain(value);
  expect(h.entries.some((entry) => entry.customType === "continuous-tasks:preflight-control")).toBe(
    false,
  );
});

it("preserves significant whitespace in the displayed scope instead of silently normalizing paths or limits", async () => {
  const h = fixture();
  const planning = beginPreflight(h.api, h.ctx, "Local fixture");
  const proposal = structuredClone(localProposal);
  proposal.permissions[0]!.target = "source  files";
  proposal.permissions[0]!.limits = "No publish\nNo install";
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await createSubmitPreflightTool(h.api).execute(
    "submit",
    { preflightId: planning.preflightId, proposal },
    undefined,
    undefined,
    h.ctx,
  );
  h.ui.assertNoScriptErrors();
  const material = h.ui.reviewedMaterial.join("").replaceAll("·", " ").replaceAll("\\\\", "\\");
  const title = vi.mocked(h.ctx.ui.select).mock.calls[0]?.[0] ?? "";
  expect(title).toContain("请求 ");
  expect(title).toMatch(/^[^\r\n]+\n问题：[^\r\n]+$/u);
  for (const line of title.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
  expect(material).toContain('"source  files"');
  expect(material).toContain('"No publish\\nNo install"');
  expect(currentRuntime().preflight?.proposal?.permissions[0]?.target).toBe("source  files");
  expect(currentRuntime().preflight?.approval).toBeUndefined();
});

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
it("does not lose the saved machine result or create a fault when optional widget refresh fails", async () => {
  const h = fixture();
  vi.mocked(h.ctx.ui.select).mockImplementationOnce(async () => {
    vi.mocked(h.ctx.ui.setWidget).mockImplementation(() => {
      throw new Error("UI transport unavailable");
    });
    return "允许上述范围";
  });
  const result = await submitted(h);
  expect(result.isError).not.toBe(true);
  expect(result.details.status).toBe("approved");
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.details);
  expect(currentRuntime().journalFault).toBeUndefined();
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
  vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("稍后决定");
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
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
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
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
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
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
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

it("shows one concise permission notification and keeps technical status explicitly available", async () => {
  const { preflightLifecycle } = await import("./helpers/preflight");
  const h = preflightLifecycle();
  await h.command("preflight Local fixture");
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: currentRuntime().preflight!.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  vi.mocked(h.ctx.ui.notify).mockClear();
  h.mock.sendMessage.mockClear();
  await h.command("approve");
  expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(vi.mocked(h.ctx.ui.notify).mock.calls[0]?.[0]).toContain("权限已确认");
  expect(vi.mocked(h.ctx.ui.notify).mock.calls[0]?.[0]).not.toContain("Preflight plan:");
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
  await h.command("status");
  expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toContain("Preflight plan:");
});

it("native no-ID first start confirms separately and dispatches once", async () => {
  const { preflightLifecycle } = await import("./helpers/preflight");
  const h = preflightLifecycle();
  await h.command("preflight Local fixture");
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  const outcome = await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: currentRuntime().preflight!.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  h.ui.assertNoScriptErrors();
  expect(outcome.details.status).toBe("approved");
  expect(currentRuntime().preflight?.approval?.permissionIds).toEqual(["A1"]);
  expect(h.ui.reviewedMaterial.length).toBeGreaterThan(0);
  expect(
    h.entries.filter((entry) => entry.customType === "continuous-tasks:supervisor"),
  ).toHaveLength(0);
  vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("稍后启动");
  const later = await startApprovedPreflight(h.mock.api, h.ctx);
  h.ui.assertNoScriptErrors();
  expect(later.status).toBe("deferred");
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(
    h.entries.filter((entry) => entry.customType === "continuous-tasks:supervisor"),
  ).toHaveLength(0);
  const [title, offered] = vi.mocked(h.ctx.ui.select).mock.calls.at(-1)!;
  expect(title).toContain("首次启动");
  expect(title).toContain("请求 ");
  expect(title).toMatch(/^[^\r\n]+\n问题：[^\r\n]+$/u);
  for (const line of title.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
  expect(offered).toContain("稍后启动");
  h.mock.sendMessage.mockClear();
  vi.mocked(h.ctx.ui.notify).mockClear();
  await h.command("start");
  const notices = vi.mocked(h.ctx.ui.notify).mock.calls.map(([message]) => message);
  expect(notices.some((message) => message.trim().startsWith("{"))).toBe(false);
  expect(notices.join("\n")).toContain("启动确认已保存");
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

it("mandatory widget hide failure defers owner permission before review/native controls without a journal fault", async () => {
  const h = fixture();
  vi.mocked(h.ctx.ui.setWidget).mockImplementation(() => {
    throw new Error("mandatory hide failed");
  });
  const result = await submitted(h);
  h.ui.assertNoScriptErrors();
  expect(result.details.status).toBe("deferred");
  expect(h.ui.custom).not.toHaveBeenCalled();
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
  expect(h.entries.some((entry) => entry.customType === "continuous-tasks:preflight-control")).toBe(
    false,
  );
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().preflight?.approval).toBeUndefined();
});

it.each([false, true])(
  "externally observes real scope-driver assertion errors after production returns (afterDone=%s)",
  async (afterDone) => {
    const h = fixture();
    const marker = afterDone ? "AFTER_REVIEW_DONE_MARKER" : "BEFORE_REVIEW_DONE_MARKER";
    const ui = installCustomUI(h.ctx, (d) => {
      if (afterDone) d.reviewAll();
      expect(marker).toBe("deliberate failed script assertion");
    });
    const result = await submitted(h);
    expect(() => {
      ui.assertNoScriptErrors();
    }).toThrow(marker);
    expect(result.details.status).toBe(afterDone ? "approved" : "deferred");
  },
);
