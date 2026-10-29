import { enterPlanningMode } from "../management-policy";
import { enableSessionScope } from "../scope";
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resetState } from "../state";
import { currentRuntime } from "../runtime";
import { createSubmitPreflightTool } from "../tools";
import {
  approvePreflight,
  repairPreflightProjection,
  startApprovedPreflight,
} from "../preflight-human";
import {
  beginPreflight,
  preflightContext,
  preflightStatusLines,
  preflightAuthorizationIssue,
  inspectPreflightStart,
  PREFLIGHT_ENTRY,
} from "../preflight";
import { journalDigest } from "../human-journal";
import { localProposal, preflightLifecycle } from "./helpers/preflight";

beforeEach(() => {
  resetState();
});
async function ready(approve = true) {
  const h = preflightLifecycle();
  beginPreflight(h.mock.api, h.ctx, "Local fixture");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue(approve ? "允许上述范围" : "稍后决定");
  await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: currentRuntime().preflight!.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  h.mock.sendMessage.mockClear();
  return h;
}
async function missingCache() {
  const h = await ready(false);
  const append = h.mock.appendEntry.getMockImplementation() as (
    type: string,
    data: unknown,
  ) => void;
  h.mock.appendEntry.mockImplementation((type, data: any) => {
    if (type === PREFLIGHT_ENTRY && data.approval) throw new Error("C write failed");
    append(type, data);
  });
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  const saved = await approvePreflight(h.mock.api, h.ctx);
  expect(saved.projectionPending).toBe(true);
  expect(saved.confirmed?.kind).toBe("approve");
  return { ...h, append, saved };
}
it("requires a real current context for a bound permission check", () => {
  expect(
    preflightAuthorizationIssue(undefined, {
      preflightId: "p",
      planId: "plan",
      planDigest: "a".repeat(64),
    }),
  ).toContain("current-session verification context");
});
it.each(["preflightId", "planId", "planDigest"] as const)(
  "rejects a mismatched execution binding %s",
  async (field) => {
    const h = await ready();
    const state = currentRuntime().preflight!;
    const binding = {
      preflightId: state.preflightId,
      planId: state.planId!,
      planDigest: state.planDigest!,
      [field]: "wrong",
    };
    expect(preflightAuthorizationIssue(h.ctx, binding)).toBe(
      "Bound preflight identity does not match",
    );
  },
);
it.each(["stale approval", "duplicate selected right", "changed control timestamp"])(
  "does not execute with %s even if the state claims approved",
  async (corruption) => {
    const h = await ready();
    const state = currentRuntime().preflight!;
    if (!state.approval) throw new Error("Missing native approval fixture");
    if (corruption === "stale approval") state.approval.planId = "stale";
    else if (corruption === "duplicate selected right") state.approval.permissionIds = ["A1", "A1"];
    else state.approval.createdAt = "different";
    const issue = preflightAuthorizationIssue(h.ctx, {
      preflightId: state.preflightId,
      planId: state.planId!,
      planDigest: state.planDigest!,
    });
    const expected =
      corruption === "stale approval"
        ? "Preflight approval is stale"
        : corruption === "duplicate selected right"
          ? "Invalid preflight permission selection"
          : "Invalid native preflight closure";
    expect(issue).toBe(expected);
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  },
);
it("does not inherit a bound grant from a changed live session", async () => {
  const h = await ready();
  const state = currentRuntime().preflight!;
  vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("other");
  expect(
    preflightAuthorizationIssue(h.ctx, {
      preflightId: state.preflightId,
      planId: state.planId!,
      planDigest: state.planDigest!,
    }),
  ).toContain("another session");
});
it("rejects startup inspection under a foreign owner or without its requested plan", async () => {
  const h = await ready();
  currentRuntime().preflight!.sessionId = "other";
  expect(() => inspectPreflightStart(h.ctx, "Local fixture")).toThrow("another session");
  resetState();
  expect(() => inspectPreflightStart(h.ctx, "Local fixture", "missing")).toThrow("No preflight");
  expect(inspectPreflightStart(h.ctx, "Unbound existing policy")).toBeUndefined();
});
it("keeps native preflight scope bound to the original Supervisor goal", async () => {
  const h = await ready();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  expect((await startApprovedPreflight(h.mock.api, h.ctx)).status).toBe("started");
  const state = currentRuntime().preflight!;
  currentRuntime().supervisor!.goal = "Different goal";
  expect(
    preflightAuthorizationIssue(h.ctx, {
      preflightId: state.preflightId,
      planId: state.planId!,
      planDigest: state.planDigest!,
    }),
  ).toContain("Bound supervisor goal changed");
});

it("retains exactly one start A/B/S when C fails and repairs only C", async () => {
  const h = await ready();
  const append = h.mock.appendEntry.getMockImplementation() as (
    type: string,
    data: unknown,
  ) => void;
  h.mock.appendEntry.mockImplementation((type, data: any) => {
    if (type === PREFLIGHT_ENTRY && data.started) throw new Error("started C failed");
    append(type, data);
  });
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  const saved = await startApprovedPreflight(h.mock.api, h.ctx);
  expect(saved).toMatchObject({
    status: "already_saved",
    projectionPending: true,
    startupPending: "projection",
    confirmed: { kind: "start" },
  });
  expect(
    h.entries.filter(
      (e) =>
        e.customType === "continuous-tasks:supervisor" &&
        (e.data as { version?: number }).version !== 6,
    ),
  ).toHaveLength(1);
  const count = h.entries.length;
  h.mock.appendEntry.mockImplementation(append);
  repairPreflightProjection(h.mock.api, h.ctx);
  expect(h.entries.length).toBe(count + 1);
  expect(h.entries.at(-1)?.customType).toBe(PREFLIGHT_ENTRY);
  expect(currentRuntime().preflight?.phase).toBe("started");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});
it("Later saves only start metadata, not a start control or Supervisor", async () => {
  const h = await ready();
  const count = h.entries.filter(
    (e) => e.customType === "continuous-tasks:preflight-control",
  ).length;
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后启动");
  expect((await startApprovedPreflight(h.mock.api, h.ctx)).status).toBe("deferred");
  expect(
    h.entries.filter((e) => e.customType === "continuous-tasks:preflight-control"),
  ).toHaveLength(count);
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});
it.each(["request epoch", "pending input"])(
  "drops a start answer invalidated by %s during actual callback",
  async (invalidation) => {
    const h = await ready();
    vi.mocked(h.ctx.ui.select).mockImplementation(async () => {
      if (invalidation === "request epoch") currentRuntime().humanEpoch++;
      else vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
      return "开始执行";
    });
    expect((await startApprovedPreflight(h.mock.api, h.ctx)).status).toBe("deferred");
    expect(currentRuntime().preflight?.started).toBeUndefined();
    expect(currentRuntime().supervisor).toBeUndefined();
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  },
);
it.each(["missing control", "wrong control type", "wrong projected digest"])(
  "refuses repair with %s and preserves the held hint",
  async (corruption) => {
    const h = await missingCache();
    const hint = currentRuntime().preflightRepair!;
    if (corruption === "missing control") hint.controlEntryId = "absent";
    else if (corruption === "wrong control type") hint.controlEntryId = h.entries[0]!.id;
    else hint.projectedDigest = "a".repeat(64);
    const before = structuredClone(hint);
    const fault = currentRuntime().journalFault;
    const count = h.entries.length;
    expect(() => {
      repairPreflightProjection(h.mock.api, h.ctx);
    }).toThrow(/repair control|authority changed/i);
    expect(currentRuntime().preflightRepair).toEqual(before);
    expect(currentRuntime().journalFault).toBe(fault);
    expect(h.entries).toHaveLength(count);
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  },
);
it("routes explicit preflight cache repair before the journal-fault gate with no continuation", async () => {
  const h = await missingCache();
  h.mock.appendEntry.mockImplementation(h.append);
  const count = h.entries.length;
  await h.command("repair-preflight");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().preflightRepair).toBeUndefined();
  expect(h.entries).toHaveLength(count + 1);
  expect(h.entries.at(-1)?.customType).toBe(PREFLIGHT_ENTRY);
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});

it("retains proof and fault when the repair C itself fails", async () => {
  const h = await missingCache();
  const before = structuredClone(currentRuntime().preflightRepair);
  const fault = currentRuntime().journalFault;
  expect(() => {
    repairPreflightProjection(h.mock.api, h.ctx);
  }).toThrow("C write failed");
  expect(currentRuntime().preflightRepair).toEqual(before);
  expect(currentRuntime().journalFault).toBe(fault);
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});
it("repairs a confirmed cache without clearing an independent fault", async () => {
  const h = await missingCache();
  currentRuntime().journalFault = "independent owner fault";
  h.mock.appendEntry.mockImplementation(h.append);
  repairPreflightProjection(h.mock.api, h.ctx);
  expect(currentRuntime().journalFault).toBe("independent owner fault");
  expect(currentRuntime().preflightRepair).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});
it("refuses a normalized orphan after its readback witness is missing", async () => {
  const h = await missingCache();
  const rows = readFileSync(h.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const witness = rows.find((r) => r.customType === "continuous-tasks:human-readback");
  const index = rows.indexOf(witness);
  rows.splice(index, 1);
  const last = rows.at(-1)!;
  vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue(last.id);
  vi.mocked(h.ctx.sessionManager.getBranch).mockReturnValue(rows.slice(1));
  // Complete LF simulates native trailing-LF normalization, not a witness.
  writeFileSync(h.path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const hint = structuredClone(currentRuntime().preflightRepair);
  expect(() => {
    repairPreflightProjection(h.mock.api, h.ctx);
  }).toThrow(/Unconfirmed/);
  expect(currentRuntime().preflightRepair).toEqual(hint);
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});
it("shows saved-result repair guidance instead of asking for approval again", async () => {
  const h = await missingCache();
  expect(preflightContext(h.ctx)).toContain("Do not execute or request the same approval again");
  expect(preflightStatusLines(h.ctx).join("\n")).toContain("repair-preflight");
  expect(preflightStatusLines(h.ctx).join("\n")).not.toContain(
    "Next preflight: /task-supervisor approve",
  );
  expect(
    preflightAuthorizationIssue(h.ctx, {
      preflightId: h.saved.state.preflightId,
      planId: h.saved.state.planId!,
      planDigest: h.saved.state.planDigest!,
    }),
  ).toBe(currentRuntime().journalFault);
});
it("delivers rejection and partial permission state to Main without an execution agreement", async () => {
  const h = await ready(false);
  h.chooseDraft(2);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("不允许");
  await approvePreflight(h.mock.api, h.ctx);
  expect(preflightContext(h.ctx)).toContain("selection was rejected");
  expect(preflightStatusLines(h.ctx).join("\n")).toContain("selection was rejected");
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  const partial = await approvePreflight(h.mock.api, h.ctx, undefined, "A2");
  expect(partial.status).toBe("partial");
  expect(preflightContext(h.ctx)).toContain("No complete current authorization");
  expect(journalDigest(currentRuntime().preflight?.approval?.permissionIds)).toBe(
    journalDigest(["A2"]),
  );
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});
