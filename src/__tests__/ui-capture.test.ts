import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureUiBoardView, captureUiSummary } from "../ui-capture";
import { createEmptyBoard } from "../engine";
import { currentRuntime, createRuntime } from "../runtime";
import { createMockContext } from "./helpers/mocks";
import { localProposal } from "./helpers/preflight";
import * as boardHuman from "../board-human";
import * as preflightOwner from "../preflight";
import * as supervisorOwner from "../supervisor";
import * as humanPresentation from "../human-presentation";
import * as flowOwner from "../flow";
import { digest } from "../supervisor";
import { ReceiptStore } from "../receipt-store";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureReadbackFrame } from "../human-control";
import { journalDigest, type ReadbackFrame } from "../human-journal";
import type { NativePermissionControl, NativeStartControl, PreflightState } from "../preflight";

const dirs: string[] = [];
import type { SupervisorState } from "../supervisor";

beforeEach(() => Object.assign(currentRuntime(), createRuntime()));
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function preflight() {
  currentRuntime().preflight = {
    version: 2,
    sessionId: "test-session",
    preflightId: "p",
    goal: "Local goal",
    phase: "awaiting_authorization",
    revision: 1,
    proposal: structuredClone(localProposal),
  };
}
function supervisor(sessionId = "test-session"): SupervisorState {
  return {
    version: 1,
    sessionId,
    goal: "Supervisor goal",
    model: { provider: "p", id: "m" },
    status: "active",
    reviews: 0,
    continuations: 0,
    stagnant: 0,
    epoch: 0,
    pending: false,
    receipts: [],
    bindings: [],
    tokens: 0,
    cost: 0,
  };
}
it("captures zero-task preflight and excludes foreign owner data everywhere (representative)", () => {
  preflight();
  const ctx = createMockContext();
  const board = createEmptyBoard();
  const view = captureUiBoardView(ctx, board);
  expect(view.summary.visible).toBe(true);
  expect(view.documents).toHaveLength(5);
  expect(view.documents.find((d) => d.id === "preflight")).toMatchObject({
    availability: "available",
  });
  expect(JSON.stringify(view)).toContain(localProposal.permissions[1]!.fallback);
  currentRuntime().supervisor = {
    ...supervisor("foreign"),
    goal: "FOREIGN_MARKER",
    reason: "FOREIGN_MARKER",
    tokens: 987654321,
  };
  currentRuntime().preflight = {
    ...currentRuntime().preflight!,
    sessionId: "foreign",
    goal: "FOREIGN_MARKER",
    proposal: { ...localProposal, summary: "FOREIGN_MARKER" },
  };
  const foreign = captureUiBoardView(ctx, board);
  expect(JSON.stringify(foreign)).not.toContain("FOREIGN_MARKER");
  expect(JSON.stringify(foreign)).not.toContain("987654321");
  expect(foreign.summary.headline.text).toContain("身份");
});
it("summary does not inspect board history (representative)", () => {
  const ctx = createMockContext();
  vi.mocked(ctx.sessionManager.getBranch).mockImplementation(() => {
    throw new Error("history forbidden");
  });
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue(null);
  expect(captureUiSummary(ctx, createEmptyBoard()).counts.total).toBe(0);
  expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
});
it("captures pure counts without hydration, owner scheduling, restore, repair or writes", () => {
  preflight();
  const runtime = currentRuntime();
  runtime.enabled = true;
  runtime.supervisor = {
    ...supervisor(),
    status: "paused",
    reason: "Hold",
    holdCause: "user_pause",
    reviews: 40,
  };
  runtime.journalFault = "Existing fault";
  runtime.boardRepair = {
    sessionId: "test-session",
    controlEntryId: "c",
    projectedDigest: "d",
    faultMessage: "Hold",
    ownsJournalFault: false,
  };
  runtime.preflightRepair = { ...runtime.boardRepair };
  runtime.cancel = vi.fn();
  const forbidden = vi.fn(() => {
    throw new Error("receipt mutation forbidden");
  });
  runtime.receiptStore = {
    sessionId: "test-session",
    get pendingCount() {
      return 2;
    },
    get stats() {
      return { pending: 2, count: 4 };
    },
    prepareToolCapture: forbidden,
    commitToolReceipt: forbidden,
    readReceipts: forbidden,
    appendCheckpoint: forbidden,
    checkpoint: forbidden,
  } as unknown as ReceiptStore;
  const spies = [
    vi.spyOn(boardHuman, "restoreBoardHuman"),
    vi.spyOn(boardHuman, "repairBoardProjection"),
    vi.spyOn(boardHuman, "answerBoardDecision"),
    vi.spyOn(preflightOwner, "restorePreflight"),
    vi.spyOn(supervisorOwner, "startSupervisor"),
  ];
  const ctx = createMockContext();
  const board = runtime.board;
  const before = JSON.stringify({ ...runtime, receiptStore: undefined });
  const view = captureUiBoardView(ctx, board);
  const summary = captureUiSummary(ctx, board);
  expect(summary.next.text).toBe("下一步未一致确认，请查看状态");
  expect(view.documents[0]!.text).toContain('"pending": 2');
  expect(view.documents[0]!.text).not.toContain("Next: ");
  expect(JSON.stringify({ ...runtime, receiptStore: undefined })).toBe(before);
  expect(runtime.cancel).not.toHaveBeenCalled();
  expect(forbidden).not.toHaveBeenCalled();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  expect(ctx.ui.setWidget).not.toHaveBeenCalled();
});
it.each(["session", "leaf", "generation"])(
  "throws UI-only on %s changes without returning partial material",
  (kind) => {
    const ctx = createMockContext();
    const board = createEmptyBoard();
    vi.mocked(ctx.isIdle).mockImplementation(() => {
      if (kind === "session")
        vi.mocked(ctx.sessionManager.getSessionId).mockReturnValue("new-session");
      if (kind === "leaf") vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("new-leaf");
      if (kind === "generation") board.generation++;
      return true;
    });
    expect(() => captureUiBoardView(ctx, board)).toThrow("UI-only identity-changed");
    expect(currentRuntime().journalFault).toBeUndefined();
  },
);
it("rejects summary identity drift and unreadable identity without runtime faults", () => {
  const ctx = createMockContext();
  const board = createEmptyBoard();
  vi.mocked(ctx.hasPendingMessages).mockImplementation(() => {
    board.generation++;
    return false;
  });
  expect(() => captureUiSummary(ctx, board)).toThrow("identity-changed");
  vi.mocked(ctx.sessionManager.getSessionId).mockImplementation(() => {
    throw new Error("identity unreadable");
  });
  expect(() => captureUiSummary(ctx, board)).toThrow("identity unreadable");
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("conservatively labels flow read failures without overwriting or clearing owner faults", () => {
  const ctx = createMockContext();
  vi.mocked(ctx.isIdle).mockImplementation(() => {
    throw new Error("private error marker");
  });
  currentRuntime().journalFault = "Original fault";
  const view = captureUiBoardView(ctx, createEmptyBoard());
  expect(view.summary.headline.text).toBe("需检查");
  expect(view.summary.blockers.some((b) => b.text.includes("未知"))).toBe(true);
  expect(JSON.stringify(view)).not.toContain("private error marker");
  expect(currentRuntime().journalFault).toBe("Original fault");
});
it("deep freezes independent plain clones for delayed consumers and uses one capture clock", () => {
  preflight();
  const ctx = createMockContext();
  const board = createEmptyBoard();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1234);
  const view = captureUiBoardView(ctx, board);
  const original = JSON.stringify(view);
  expect(clock).toHaveBeenCalledTimes(1);
  clock.mockImplementation(() => {
    throw new Error("render must not get time");
  });
  board.phases.push({ phase: 4, status: "pending" });
  currentRuntime().preflight!.proposal!.steps.push("Source mutation");
  vi.mocked(ctx.sessionManager.getSessionId).mockImplementation(() => {
    throw new Error("delayed read forbidden");
  });
  expect(JSON.stringify(view)).toBe(original);
  expect(Object.isFrozen(view.board.phases)).toBe(true);
  expect(Object.isFrozen(view.documents[0])).toBe(true);
  expect(() => {
    (view.board.phases as unknown[]).push({});
  }).toThrow();
  expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
});
it.each(["applicable", "expired", "stale"])(
  "labels external reports %s, never liveness",
  (kind) => {
    const board = { ...createEmptyBoard(), workflowStatus: "active" as const };
    vi.spyOn(Date, "now").mockReturnValue(1000);
    currentRuntime().supervisor = {
      ...supervisor(),
      externalWait: {
        boardDigest: kind === "stale" ? "bad" : digest(board),
        epoch: 0,
        observedAt: 123,
        deadlineAt: kind === "expired" ? 900 : 2000,
        phase: "results_pending",
        refs: [{ taskId: "t", source: "workflow", runId: "exact-run-id" }],
      },
    };
    const view = captureUiBoardView(createMockContext(), board);
    const overview = view.documents[0]!.text;
    expect(overview).toContain(
      kind === "applicable" ? "适用于此捕获" : kind === "expired" ? "已过期" : "不适用于此捕获",
    );
    expect(overview).toContain("不证明进程实时存活");
    expect(overview).toContain("exact-run-id");
    expect(overview).toContain('"observedAt": 123');
    expect(overview).toContain('"deadlineAt":');
  },
);
it("shows all phases, blockers, acceptance evidence and owner records without inferring success", () => {
  const board = createEmptyBoard();
  board.finalAcceptanceTaskId = "final";
  board.phases = [
    { phase: 1, status: "completed", title: "Phase one" },
    { phase: 2, status: "active", title: "Phase two" },
  ];
  board.tasks = [
    {
      id: "final",
      title: "Accept",
      prompt: "Full prompt",
      profile: "dev",
      phase: 2,
      dependencies: [],
      status: "done",
      createdAt: "now",
      updatedAt: "now",
      completionEvidence: {
        summary: "Evidence",
        refs: [{ kind: "artifact", label: "Record", status: "passed", ref: "evidence-ref" }],
        residualRisks: ["Risk"],
      },
    },
  ];
  currentRuntime().supervisor = {
    ...supervisor(),
    status: "completed",
    acceptedDigest: "owner-record-digest",
  };
  const view = captureUiBoardView(createMockContext(), board);
  const acceptance = view.documents.find((d) => d.id === "acceptance")!.text;
  expect(acceptance).toContain("evidence-ref");
  expect(acceptance).toContain("owner-record-digest");
  expect(acceptance).toContain("全 done 不代表目标通过");
  expect(view.documents[0]!.text).toContain("Phase one");
  expect(view.documents[0]!.text).toContain("Phase two");
  expect(view.board.tasks[0]!.prompt).toBe("Full prompt");
});
it("keeps all five zero-task documents reachable with absent/unknown explanations", () => {
  const view = captureUiBoardView(createMockContext(), createEmptyBoard());
  expect(view.documents.map((d) => d.id)).toEqual([
    "overview",
    "acceptance",
    "current-board-request",
    "latest-board-response",
    "preflight",
  ]);
  expect(view.documents.find((d) => d.id === "current-board-request")!.availability).toBe("absent");
  expect(view.documents.find((d) => d.id === "latest-board-response")!.availability).toBe("absent");
  expect(view.documents.find((d) => d.id === "preflight")!.availability).toBe("absent");
});
it("current scope is distinct from history and never presented as approval", () => {
  const board = createEmptyBoard();
  board.decision = {
    id: "new-scope",
    taskId: "t",
    question: "Question",
    whyUserOwned: "Why",
    createdAt: "now",
    spec: {
      version: 1,
      kind: "authorization",
      scope: "  Exact\nnew scope ",
      prohibitions: ["No deploy"],
    },
  };
  const view = captureUiBoardView(createMockContext(), board);
  const request = view.documents.find((d) => d.id === "current-board-request")!;
  expect(request.text).toContain('"  Exact\\nnew scope "');
  expect(request.text).toContain("不是授权证明");
  expect(request.text).toContain("No deploy");
  expect(view.documents.find((d) => d.id === "latest-board-response")!.availability).toBe("absent");
});
it("legacy and missing preflight proofs do not hide full current scope and selection", () => {
  preflight();
  currentRuntime().preflight = {
    ...currentRuntime().preflight!,
    version: 2,
    permissionRequest: { id: "missing-proof", permissionIds: ["A2"] },
    startRequest: { id: "missing-start" },
  };
  const view = captureUiBoardView(createMockContext(), createEmptyBoard());
  const doc = view.documents.find((d) => d.id === "preflight")!;
  expect(doc.availability).toBe("available");
  expect(doc.text).toContain("permission 历史：unknown");
  expect(doc.text).toContain("start 历史：unknown");
  expect(doc.text).toContain("未选择，本次不授权");
  expect(doc.text).toContain(localProposal.permissions[1]!.fallback);
  currentRuntime().preflight = { ...currentRuntime().preflight!, version: 1 };
  expect(
    captureUiBoardView(createMockContext(), createEmptyBoard()).documents.find(
      (d) => d.id === "preflight",
    )!.text,
  ).toContain("legacy");
});
function physicalContext() {
  const dir = mkdtempSync(join(tmpdir(), "capture-history-"));
  dirs.push(dir);
  const session = SessionManager.create(dir, join(dir, "sessions"));
  session.appendMessage({
    role: "user",
    content: "Synthetic mechanism only, not human identity",
    timestamp: 1,
  });
  const ctx = createMockContext();
  Object.defineProperty(ctx, "sessionManager", { configurable: true, get: () => session });
  function control(kind: string, data: object, frame: ReadbackFrame) {
    const id = session.appendCustomEntry(kind, { ...data, humanInteraction: frame });
    session.appendCustomEntry("continuous-tasks:human-readback", {
      version: 1,
      controlEntryId: id,
      controlDigest: journalDigest(session.getEntry(id)),
      frame,
    });
    return id;
  }
  return { ctx, session, control };
}
it.each(["foreign", "missing"] as const)(
  "excludes real receipt store statistics with %s identity without touching live state",
  (identity) => {
    const own = physicalContext();
    const foreign = physicalContext();
    const store = new ReceiptStore(undefined, foreign.ctx, foreign.session.getSessionId());
    const limits = { maxEntries: 4093, maxBytes: 61234567 };
    store.configure(limits);
    if (identity === "missing") Object.defineProperty(store, "sessionId", { value: undefined });
    const runtime = currentRuntime();
    runtime.receiptStore = store;
    runtime.cancel = vi.fn();
    const storeFields = () =>
      structuredClone(
        Object.fromEntries(
          Object.entries(store).filter(
            ([key, value]) => key !== "ctx" && key !== "pi" && typeof value !== "function",
          ),
        ),
      );
    const beforeStore = storeFields();
    const beforeStats = store.stats;
    const beforeRuntime = JSON.stringify({ ...runtime, receiptStore: undefined });
    const paths = [own, foreign].map((h) => h.session.getSessionFile()!);
    const beforeBytes = paths.map((path) => readFileSync(path, "utf8"));
    const stats = vi.spyOn(store, "stats", "get");
    const forbidden = [
      vi.spyOn(store, "prepareToolCapture"),
      vi.spyOn(store, "commitToolReceipt"),
      vi.spyOn(store, "readReceipts"),
      vi.spyOn(store, "appendCheckpoint"),
      vi.spyOn(store, "checkpoint"),
      vi.spyOn(store, "closeUnknown"),
      vi.spyOn(ReceiptStore, "restore"),
      vi.spyOn(ReceiptStore, "migrate"),
      vi.spyOn(own.session, "appendCustomEntry"),
      vi.spyOn(foreign.session, "appendCustomEntry"),
      vi.spyOn(supervisorOwner, "startSupervisor"),
      runtime.cancel,
    ];
    const summary = captureUiSummary(own.ctx, runtime.board);
    const view = captureUiBoardView(own.ctx, runtime.board);
    for (const doc of view.documents)
      for (const value of Object.values(limits))
        expect(JSON.stringify(doc)).not.toContain(`${value}`);
    for (const value of Object.values(limits))
      expect(JSON.stringify(view)).not.toContain(`${value}`);
    expect(stats).not.toHaveBeenCalled();
    for (const captured of [summary, view.summary]) {
      expect(captured.visible).toBe(true);
      expect(captured.headline.text).toBe("需检查");
      expect(captured.blockers).toContainEqual(
        expect.objectContaining({ source: "receipt", text: expect.stringContaining("身份") }),
      );
    }
    expect(view.documents[0]!.text).toContain("回执计数未知");
    expect(view.documents[0]!.text).toContain("身份需检查");
    expect(runtime.receiptStore).toBe(store);
    expect(storeFields()).toEqual(beforeStore);
    expect(JSON.stringify({ ...runtime, receiptStore: undefined })).toBe(beforeRuntime);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(beforeBytes);
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    expect(own.ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(own.ctx.ui.setWidget).not.toHaveBeenCalled();
    stats.mockRestore();
    expect(store.stats).toEqual(beforeStats);
  },
);
it("shows real same-session receipt statistics after checking identity", () => {
  const h = physicalContext();
  const store = new ReceiptStore(undefined, h.ctx, h.session.getSessionId());
  const limits = { maxEntries: 3971, maxBytes: 59876543 };
  store.configure(limits);
  currentRuntime().receiptStore = store;
  const expected = store.stats;
  const stats = vi.spyOn(store, "stats", "get");
  expect(captureUiSummary(h.ctx, currentRuntime().board).visible).toBe(false);
  expect(stats).not.toHaveBeenCalled();
  const view = captureUiBoardView(h.ctx, currentRuntime().board);
  expect(view.documents[0]!.text).toContain(JSON.stringify(expected, null, 2));
  expect(stats).toHaveBeenCalledOnce();
  expect(view.summary.blockers).toEqual([]);
});
it("keeps original board response after clearing, separate from a new request; bad latest becomes unknown", () => {
  const h = physicalContext();
  const request = {
    id: "old",
    taskId: "t",
    question: "Old question",
    whyUserOwned: "Original why",
    createdAt: "now",
    spec: {
      version: 1 as const,
      kind: "authorization" as const,
      scope: "Old scope",
      prohibitions: ["Old prohibition"],
    },
  };
  const board = {
    ...createEmptyBoard(),
    generation: 1,
    workflowStatus: "waiting_for_decision" as const,
    decision: request,
    finalAcceptanceTaskId: "t",
    tasks: [
      {
        id: "t",
        title: "Task",
        prompt: "Prompt",
        profile: "dev",
        phase: 1,
        dependencies: [],
        status: "ready" as const,
        createdAt: "now",
        updatedAt: "now",
      },
    ],
  };
  h.session.appendCustomEntry("continuous-tasks:snapshot", board);
  const frame = captureReadbackFrame(
    h.ctx,
    "board",
    request.id,
    boardHuman.decisionScope(request),
    board,
  );
  const id = h.control(
    "continuous-tasks:event",
    { type: "resolve_decision", id: request.id, outcome: "approve", answer: "Original answer" },
    frame,
  );
  const cleared = boardHuman.projectBoardAnswer(board, {
    id: request.id,
    outcome: "approve",
    answer: "Original answer",
  });
  const view = captureUiBoardView(h.ctx, cleared);
  const latest = view.documents.find((d) => d.id === "latest-board-response")!;
  expect(latest.availability).toBe("available");
  for (const expected of [
    "Old scope",
    "Old prohibition",
    "Original answer",
    id,
    "原请求/历史回应，不代表当前授权",
  ])
    expect(latest.text).toContain(expected);
  expect(view.documents.find((d) => d.id === "current-board-request")!.availability).toBe("absent");
  const changed = {
    ...board,
    decision: { ...request, id: "new", spec: { ...request.spec, scope: "New scope" } },
  };
  const next = captureUiBoardView(h.ctx, changed);
  expect(next.documents.find((d) => d.id === "current-board-request")!.text).toContain("New scope");
  expect(next.documents.find((d) => d.id === "latest-board-response")!.text).not.toContain(
    "New scope",
  );
  h.session.appendCustomEntry("continuous-tasks:event", {
    type: "resolve_decision",
    id: "bad-latest",
    outcome: "approve",
    answer: "Unconfirmed",
    humanInteraction: { ...frame, requestId: "bad-latest" },
  });
  expect(
    captureUiBoardView(h.ctx, changed).documents.find((d) => d.id === "latest-board-response")!
      .availability,
  ).toBe("unknown");
});
function preflightProof(kind: "approve" | "reject" = "approve") {
  const h = physicalContext();
  const goal = "Local fixture goal";
  const base: PreflightState = {
    version: 2,
    sessionId: h.session.getSessionId(),
    preflightId: "pf-fixture",
    goal,
    phase: "awaiting_authorization",
    revision: 1,
    planId: "pf-fixture.r1",
    planDigest: preflightOwner.preflightDigest(h.session.getSessionId(), goal, localProposal),
    proposal: structuredClone(localProposal),
    permissionRequest: { id: randomUUID(), permissionIds: ["A1"] },
  };
  h.session.appendCustomEntry("continuous-tasks:preflight", base);
  const frame = captureReadbackFrame(
    h.ctx,
    "preflight",
    base.permissionRequest!.id,
    preflightOwner.preflightPermissionScope(base, ["A1"]),
    base,
  );
  const body: NativePermissionControl = {
    version: 2,
    sessionId: base.sessionId,
    preflightId: base.preflightId,
    planId: base.planId!,
    planDigest: base.planDigest!,
    permissionIds: ["A1"],
    createdAt: "2026-10-16T00:00:00.000Z",
    humanInteraction: frame,
    ...(kind === "approve"
      ? { kind: "approve", answer: "Approve" }
      : { kind: "reject", answer: "Reject" }),
  };
  const id = h.control("continuous-tasks:preflight-control", body, frame);
  const projected = preflightOwner.projectPreflightPermissions(base, body, id);
  return { ...h, base, projected, id };
}
it.each(["approve", "reject"] as const)(
  "shows original %s permission history and exact selected/unselected scope",
  (kind) => {
    const h = preflightProof(kind);
    currentRuntime().preflight = h.projected;
    const doc = captureUiBoardView(h.ctx, createEmptyBoard()).documents.find(
      (d) => d.id === "preflight",
    )!;
    expect(doc.availability).toBe("available");
    expect(doc.text).toContain("permission 原请求/历史回应，不代表当前授权");
    expect(doc.text).toContain(h.id);
    expect(doc.text).toContain(kind === "approve" ? "Approve" : "Reject");
    expect(doc.text).toContain("未选择，本次不授权");
    expect(doc.text).toContain(localProposal.permissions[0]!.reconfirm);
  },
);
it.each([false, true])(
  "reads v3 S-prefix only when present (%s), without touching live store or authority",
  (withStartup) => {
    const h = preflightProof();
    const base: PreflightState = { ...h.projected, version: 2, startRequest: { id: randomUUID() } };
    h.session.appendCustomEntry("continuous-tasks:preflight", base);
    const approvalDigest = journalDigest(h.session.getEntry(h.id));
    const frame = captureReadbackFrame(
      h.ctx,
      "preflight",
      base.startRequest!.id,
      preflightOwner.preflightStartScope(base, approvalDigest),
      base,
    );
    const body: NativeStartControl = {
      version: 2,
      sessionId: base.sessionId,
      preflightId: base.preflightId,
      planId: base.planId!,
      planDigest: base.planDigest!,
      permissionIds: ["A1"],
      createdAt: "2026-10-16T01:00:00.000Z",
      humanInteraction: frame,
      kind: "start",
      answer: "Start execution",
      approvalControlEntryId: h.id,
      approvalControlDigest: approvalDigest,
    };
    const id = h.control("continuous-tasks:preflight-control", body, frame);
    const startup = {
      ...supervisor(base.sessionId),
      goal: base.goal,
      preflightBinding: {
        preflightId: base.preflightId,
        planId: base.planId!,
        planDigest: base.planDigest!,
      },
    };
    const live = new ReceiptStore(undefined, h.ctx, base.sessionId, "live-unrelated-goal");
    const startupStore = new ReceiptStore(undefined, h.ctx, base.sessionId, "startup-goal");
    if (withStartup)
      h.session.appendCustomEntry("continuous-tasks:supervisor", {
        ...startup,
        version: 3,
        receiptLedger: startupStore.checkpoint(),
      });
    const runtime = currentRuntime();
    runtime.preflight = preflightOwner.projectPreflightStart(base, body, id);
    runtime.supervisor = { ...startup, reviews: 7, continuations: 4, tokens: 20, cost: 1 };
    runtime.receiptStore = live;
    runtime.journalFault = "Retained fault";
    runtime.boardRepair = {
      sessionId: base.sessionId,
      controlEntryId: "old",
      projectedDigest: "old",
      faultMessage: "Old repair",
      ownsJournalFault: false,
    };
    runtime.cancel = vi.fn();
    const storeFields = () =>
      structuredClone(
        Object.fromEntries(
          Object.entries(live).filter(
            ([key, value]) => key !== "ctx" && key !== "pi" && typeof value !== "function",
          ),
        ),
      );
    const liveBefore = storeFields();
    const runtimeBefore = JSON.stringify({ ...runtime, receiptStore: undefined });
    const path = h.session.getSessionFile()!;
    const bytes = readFileSync(path, "utf8");
    const stats = live.stats;
    const append = vi.spyOn(h.session, "appendCustomEntry");
    const observe = vi.spyOn(live, "prepareToolCapture");
    const lookup = vi.spyOn(live, "readReceipts");
    const dispatch = vi.spyOn(supervisorOwner, "startSupervisor");
    const doc = captureUiBoardView(h.ctx, runtime.board).documents.find(
      (d) => d.id === "preflight",
    )!;
    expect(doc.text).toContain(
      withStartup ? "start 原请求/历史回应，不代表当前授权" : "start 历史：unknown",
    );
    expect(live.stats).toEqual(stats);
    expect(storeFields()).toEqual(liveBefore);
    expect(JSON.stringify({ ...runtime, receiptStore: undefined })).toBe(runtimeBefore);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    for (const spy of [append, observe, lookup, dispatch, runtime.cancel])
      expect(spy).not.toHaveBeenCalled();
  },
);
it("consumes original owner-next/preflight labels as presentation, with unchanged limits", () => {
  const next = vi.spyOn(flowOwner, "nextFlowStep").mockReturnValue("Original owner explanation");
  currentRuntime().supervisor = supervisor();
  currentRuntime().receiptStore = new ReceiptStore(undefined, createMockContext(), "test-session");
  const board = { ...createEmptyBoard(), workflowStatus: "active" as const };
  expect(captureUiSummary(createMockContext(), board).next.text).toBe("Original owner explanation");
  expect(next).toHaveBeenCalledOnce();
  preflight();
  const display = vi.spyOn(humanPresentation, "preflightSummary").mockReturnValue({
    label: "Original preflight label",
    next: "Original preflight next",
    color: "muted",
  });
  expect(captureUiSummary(createMockContext(), createEmptyBoard()).headline.text).toBe(
    "Original preflight label",
  );
  expect(display).toHaveBeenCalledOnce();
  currentRuntime().supervisor!.reviews = flowOwner.SUPERVISOR_LIMITS.reviews;
  expect(
    captureUiSummary(createMockContext(), board).blockers.some((b) =>
      b.text.includes(`40/${flowOwner.SUPERVISOR_LIMITS.reviews}`),
    ),
  ).toBe(true);
});
it("turns failed owner presentation checks into UI-only uncertainty", () => {
  preflight();
  vi.spyOn(humanPresentation, "preflightSummary").mockImplementation(() => {
    throw new Error("private-owner-message");
  });
  vi.spyOn(flowOwner, "nextFlowStep").mockImplementation(() => {
    throw new Error("private-next-message");
  });
  const view = captureUiBoardView(createMockContext(), createEmptyBoard());
  expect(view.summary.next.text).toBe("下一步未一致确认，请查看状态");
  expect(JSON.stringify(view)).not.toContain("private-owner-message");
  expect(JSON.stringify(view)).not.toContain("private-next-message");
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("keeps receipt read errors unknown and never attempts receipt recovery", () => {
  const recover = vi.fn();
  currentRuntime().receiptStore = {
    sessionId: "test-session",
    get pendingCount() {
      throw new Error("read failed");
    },
    get stats() {
      throw new Error("stats failed");
    },
    readReceipts: recover,
    closeUnknown: recover,
  } as unknown as ReceiptStore;
  const view = captureUiBoardView(createMockContext(), createEmptyBoard());
  expect(view.documents[0]!.text).toContain("回执计数未知");
  expect(view.summary.headline.text).toBe("需检查");
  expect(recover).not.toHaveBeenCalled();
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("retains original goal whitespace and separate inconsistent owner sources in overview", () => {
  preflight();
  currentRuntime().supervisor = { ...supervisor(), goal: "  Supervisor\n goal " };
  currentRuntime().preflight!.goal = "Distinct preflight goal";
  const view = captureUiBoardView(createMockContext(), createEmptyBoard());
  expect(view.summary.goals).toHaveLength(2);
  expect(view.documents[0]!.text).toContain('"  Supervisor\\n goal "');
  expect(view.documents[0]!.text).toContain("Distinct preflight goal");
});
