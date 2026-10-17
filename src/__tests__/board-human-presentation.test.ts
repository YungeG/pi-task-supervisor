import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { decisionScope, readBoardHumanPresentation } from "../board-human";
import { readableBoardRequest } from "../human-presentation";
import { captureReadbackFrame } from "../human-control";
import { journalDigest } from "../human-journal";
import { createEmptyBoard } from "../engine";
import { currentRuntime, createRuntime } from "../runtime";
import { createMockContext } from "./helpers/mocks";
import type { DecisionRecord } from "../types";

const dirs: string[] = [];
beforeEach(() => Object.assign(currentRuntime(), createRuntime()));
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "board-presentation-"));
  dirs.push(dir);
  const session = SessionManager.create(dir, join(dir, "sessions"));
  session.appendMessage({ role: "user", content: "Synthetic structural fixture", timestamp: 1 });
  const ctx = createMockContext();
  Object.assign(ctx, { sessionManager: session });
  const decision: DecisionRecord = {
    id: "decision-1",
    taskId: "task-1",
    question: "Allow scope?",
    whyUserOwned: "Owner choice",
    createdAt: "2026-10-16T00:00:00.000Z",
    spec: { version: 1, kind: "authorization", scope: "Local source", prohibitions: ["No push"] },
  };
  const board = {
    ...createEmptyBoard(),
    generation: 1,
    workflowStatus: "waiting_for_decision" as const,
    decision,
    finalAcceptanceTaskId: "task-1",
    phases: [{ phase: 1, status: "active" as const }],
    tasks: [
      {
        id: "task-1",
        title: "Task",
        prompt: "Work",
        profile: "dev",
        phase: 1,
        dependencies: [],
        status: "ready" as const,
        createdAt: decision.createdAt,
        updatedAt: decision.createdAt,
      },
    ],
  };
  session.appendCustomEntry("continuous-tasks:snapshot", board);
  const frame = captureReadbackFrame(ctx, "board", decision.id, decisionScope(decision), board);
  // Structural A/B mechanism simulation only: no native answer or human identity is asserted.
  const controlId = session.appendCustomEntry("continuous-tasks:event", {
    type: "resolve_decision",
    id: decision.id,
    outcome: "approve",
    answer: "Saved scope",
    humanInteraction: frame,
  });
  const witness = () =>
    session.appendCustomEntry("continuous-tasks:human-readback", {
      version: 1,
      controlEntryId: controlId,
      controlDigest: journalDigest(session.getEntry(controlId)),
      frame,
    });
  return { ctx, session, board, frame, controlId, witness };
}
it("reads confirmed A/B through actual SessionManager without writes (representative)", () => {
  const h = fixture();
  h.witness();
  const before = readFileSync(h.session.getSessionFile()!, "utf8");
  const runtime = { ...currentRuntime() };
  expect(readBoardHumanPresentation(h.ctx)).toMatchObject({
    status: "available",
    confirmed: { controlEntryId: h.controlId, value: "Saved scope" },
  });
  expect(readFileSync(h.session.getSessionFile()!, "utf8")).toBe(before);
  expect(currentRuntime()).toEqual(runtime);
});
function rewrite(h: ReturnType<typeof fixture>, change: (rows: any[]) => void) {
  const path = h.session.getSessionFile()!;
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  change(rows);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
it("distinguishes absent from unconfirmed and never trusts retained JSON", () => {
  const ctx = createMockContext();
  currentRuntime().boardHumanContext = {
    sessionId: "test-session",
    content: 'Confirmed: {"outcome":"approve"}',
  };
  expect(readBoardHumanPresentation(ctx)).toEqual({ status: "absent" });
  const h = fixture();
  expect(readBoardHumanPresentation(h.ctx).status).toBe("unknown");
});
it("returns the last verified request even after decision clearing without creating C/repair", () => {
  const h = fixture();
  h.witness();
  const second = { ...h.board.decision, id: "decision-2", question: "Second scope?" };
  const base = { ...h.board, decision: second, generation: 3 };
  h.session.appendCustomEntry("continuous-tasks:snapshot", base);
  const frame = captureReadbackFrame(h.ctx, "board", second.id, decisionScope(second), base);
  const id = h.session.appendCustomEntry("continuous-tasks:event", {
    type: "resolve_decision",
    id: second.id,
    outcome: "reject",
    answer: "No scope",
    humanInteraction: frame,
  });
  h.session.appendCustomEntry("continuous-tasks:human-readback", {
    version: 1,
    controlEntryId: id,
    controlDigest: journalDigest(h.session.getEntry(id)),
    frame,
  });
  currentRuntime().board.decision = undefined;
  expect(readBoardHumanPresentation(h.ctx)).toMatchObject({
    status: "available",
    confirmed: { controlEntryId: id, request: second, outcome: "reject" },
  });
  expect(currentRuntime().boardRepair).toBeUndefined();
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("does not fall back to old success when the latest control lacks B", () => {
  const h = fixture();
  h.witness();
  h.session.appendCustomEntry("continuous-tasks:event", {
    type: "resolve_decision",
    id: "decision-2",
    outcome: "approve",
    answer: "Later",
    humanInteraction: { ...h.frame, requestId: "decision-2" },
  });
  expect(readBoardHumanPresentation(h.ctx).status).toBe("unknown");
});
it.each(["scope", "semantic", "witness", "conflict", "owner", "base"])(
  "rejects %s corruption, never old success",
  (kind) => {
    const h = fixture();
    h.witness();
    rewrite(h, (rows) => {
      const a = rows.find((row) => row.id === h.controlId);
      const b = rows.find((row) => row.customType === "continuous-tasks:human-readback");
      if (kind === "scope") {
        a.data.humanInteraction.scopeDigest = "a".repeat(64);
        b.data.frame = a.data.humanInteraction;
      }
      if (kind === "semantic") a.data.outcome = "answer";
      if (kind === "witness") b.data.controlDigest = "a".repeat(64);
      if (kind === "conflict") {
        const copy = { ...a, id: "duplicate", parentId: b.id };
        rows.push(copy);
        vi.spyOn(h.session, "getLeafId").mockReturnValue("duplicate");
      }
      if (kind === "owner") {
        a.data.humanInteraction.owner = "preflight";
        b.data.frame = a.data.humanInteraction;
      }
      if (kind === "base") {
        const base = rows.find((row) => row.id === h.frame.baseSnapshotEntryId);
        base.data.decision.taskId = "missing";
        a.data.humanInteraction.baseSnapshotDigest = journalDigest(base.data);
        b.data.frame = a.data.humanInteraction;
      }
      if (!["conflict", "witness"].includes(kind)) b.data.controlDigest = journalDigest(a);
    });
    expect(readBoardHumanPresentation(h.ctx).status).toBe("unknown");
  },
);
it.each([
  "missing-file",
  "broken-parent",
  "truncated",
  "ownerless-malformed",
  "missing-control-parent",
])("checks physical ancestry before shortcuts: %s", (kind) => {
  const h = fixture();
  h.witness();
  if (kind === "missing-file") rmSync(h.session.getSessionFile()!);
  if (kind === "broken-parent")
    rewrite(h, (rows) => {
      rows[1].parentId = "absent";
    });
  if (kind === "truncated") writeFileSync(h.session.getSessionFile()!, "incomplete");
  if (kind === "ownerless-malformed") {
    vi.spyOn(h.session, "getBranch").mockReturnValue([]);
    writeFileSync(h.session.getSessionFile()!, "bad\n");
  }
  if (kind === "missing-control-parent")
    rewrite(h, (rows) => {
      rows.splice(
        rows.findIndex((row) => row.id === h.controlId),
        1,
      );
    });
  expect(readBoardHumanPresentation(h.ctx).status).toBe("unknown");
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("reads only current physical branch and accepts SDK getter-only contexts", () => {
  const h = fixture();
  h.witness();
  const savedLeaf = h.session.getLeafId()!;
  h.session.branch(h.frame.baseSnapshotEntryId);
  expect(readBoardHumanPresentation(h.ctx)).toEqual({ status: "absent" });
  h.session.branch(savedLeaf);
  const getterOnly = {
    ...h.ctx,
    sessionManager: {
      getSessionId: () => h.session.getSessionId(),
      getLeafId: () => h.session.getLeafId(),
      getSessionFile: () => h.session.getSessionFile(),
      getEntries: () => h.session.getEntries(),
      getBranch: () => {
        throw new Error("Physical branch must win");
      },
    },
  } as unknown as typeof h.ctx;
  const result = readBoardHumanPresentation(getterOnly);
  expect(result.status).toBe("available");
  if (result.status === "available") result.confirmed.request.question = "Changed consumer copy";
  expect(readBoardHumanPresentation(h.ctx)).toMatchObject({
    confirmed: { request: { question: "Allow scope?" } },
  });
});
it("handles setup-only and in-memory sessions but cannot verify in-memory controls", () => {
  const dir = mkdtempSync(join(tmpdir(), "presentation-setup-"));
  dirs.push(dir);
  const session = SessionManager.create(dir, join(dir, "sessions"));
  const ctx = createMockContext();
  Object.assign(ctx, { sessionManager: session });
  session.appendThinkingLevelChange("off");
  expect(readBoardHumanPresentation(ctx)).toEqual({ status: "absent" });
  const memory = SessionManager.inMemory(dir);
  Object.assign(ctx, { sessionManager: memory });
  memory.appendCustomEntry("continuous-tasks:event", { humanInteraction: {} });
  expect(readBoardHumanPresentation(ctx).status).toBe("unknown");
});
it("preserves authorization whitespace, prohibitions, identity and legacy distinctions", () => {
  const h = fixture();
  const decision = {
    ...h.board.decision,
    question: "\u001b[31mQuestion\u001b[0m",
    spec: {
      version: 1 as const,
      kind: "authorization" as const,
      scope: "  precise\n scope\t",
      prohibitions: [" No  push "],
    },
  };
  const readable = readableBoardRequest(decision);
  expect(readable.title).toBe("Question");
  expect(readable.body).toContain(JSON.stringify(decision.spec.scope));
  expect(readable.body).toContain(JSON.stringify(" No  push "));
  expect(readable.body).toContain("不代表任务验收通过");
  const legacy = readableBoardRequest({
    ...decision,
    spec: undefined,
    options: [" Original legacy option "],
  });
  expect(legacy.body).toContain("权限未知");
  expect(legacy.body).toContain('" Original legacy option "');
});
it("distinguishes business choices and information without changing option values", () => {
  const h = fixture();
  const options = ["Later", " 稍后决定 ", "重新核对全文"];
  const choice = readableBoardRequest({
    ...h.board.decision,
    supersedes: "old",
    spec: { version: 1, kind: "choice" },
    options,
  });
  for (const option of options) expect(choice.body).toContain(option);
  expect(choice.body).toContain("不新增业务权限");
  expect(choice.body).toContain("old");
  for (const format of ["text", "integer", "date"] as const) {
    expect(
      readableBoardRequest({
        ...h.board.decision,
        spec: { version: 1, kind: "information", format },
      }).body,
    ).toContain(`信息（${format}）`);
  }
});
