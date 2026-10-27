// Negative unit seams only. Recorded native facts are real owned producer bytes, but the
// fileless volatile current frame is deliberately NOT new eligibility or acceptance proof.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ToolCallEvent,
  ToolResultEvent,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { inspectSessionJournal } from "../human-journal";
import { readControlFences } from "../control-journal";
import { currentRuntime } from "../runtime";
import { resetState, setBoard } from "../state";
import {
  captureInvocationFrame,
  invocationCarrierCurrent,
  invocationFrameCurrent,
  qualifiedEvidence,
  qualificationProjection,
} from "../qualified-evidence";
import {
  admitManagedInvocation,
  attestManagedReceipt,
  observeManagedInvocationEnd,
  observeManagedInvocationResult,
} from "../invocation-runtime";
import {
  queueCompletionIntents,
  repairCompletionMetadata,
  finalizeCompletionIntentsAtBoundary,
} from "../completion-intents";
import { ReceiptStore, type HostReceipt } from "../receipt-store";
import {
  attestInvocation,
  sealInvocationRoot,
  invocationOwnerKey,
  invocationUnknownIssue,
  invocationGraphIssue,
} from "../invocation-tree";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import { activeBoard } from "./helpers/lifecycle";
import type { TaskStatus } from "../types";
const createTask = ({ id, status }: { id: string; status: TaskStatus }) => ({
  ...activeBoard().tasks[0]!,
  id,
  status,
});
import { createEmptyBoard } from "../engine";

const path = fileURLToPath(new URL("./fixtures/codemode-only-sdk.jsonl", import.meta.url));
const bytes = readFileSync(path);
expect(createHash("sha256").update(bytes).digest("hex")).toBe(
  "d58a550aedd795b4c8b4d7f669f41cb401070664842c80a05cca50a03c7b28ca",
);
const rows = bytes
  .toString()
  .trimEnd()
  .split("\n")
  .map(
    (line) => JSON.parse(line) as { id: string; data?: { kind?: string; receipt?: HostReceipt } },
  );
const source = readControlFences(
  inspectSessionJournal({ path, sessionId: rows[0]!.id, leafId: rows.at(-1)!.id }),
);
const originalQ = [...source.invocations!.qualifications.values()][0]!;
const originalReceipt = rows.find((row) => row.data?.receipt?.id === originalQ.data.receiptId)!
  .data!.receipt!;
function setup() {
  const runtime = currentRuntime(),
    ctx = createMockContext(),
    mock = createMockAPI(),
    owner = structuredClone(originalQ.data.owner);
  vi.mocked(ctx.sessionManager.getSessionId).mockReturnValue(
    owner.kind === "goal" ? owner.goal.sessionId : owner.board.sessionId,
  );
  ctx.cwd = "/owned-negative-no-current-check-inputs";
  runtime.management = {
    mode: "supervised",
    state: "active",
    source: "volatile",
    activeWorkOwner: owner,
    lastGoal: null,
    attention: [],
  };
  runtime.controlJournal = structuredClone(source);
  runtime.invocation = { live: new Map(), results: new Map(), frames: new Map() };
  const frame = captureInvocationFrame(ctx, owner),
    node = runtime.controlJournal.invocations!.nodes.get(originalQ.data.operationId)!;
  runtime.invocation.frames.set(node.rootId, frame);
  const receipt = structuredClone(originalReceipt),
    graph = runtime.controlJournal.invocations!,
    q = graph.qualifications.get([...graph.qualifications.keys()][0]!)!;
  const query = (epoch = originalQ.data.epoch) =>
    qualifiedEvidence(receipt, originalQ.data.taskId, originalQ.data.taskDigest, epoch, ctx);
  return { runtime, ctx, mock, owner, frame, node, receipt, graph, q, query };
}
beforeEach(() => {
  resetState();
});
describe("non-authoritative projection and current-host barriers", () => {
  it("does not re-commit applied history or invent a missing intent set at another boundary", async () => {
    const h = setup(),
      commit = vi.fn();
    await finalizeCompletionIntentsAtBoundary(h.mock.api, h.ctx, commit);
    h.runtime.controlJournal = undefined;
    await finalizeCompletionIntentsAtBoundary(h.mock.api, h.ctx, commit);
    expect(commit).not.toHaveBeenCalled();
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it("returns only existing immutable attestation metadata without turning it into current proof", () => {
    const h = setup();
    expect(
      attestManagedReceipt(
        h.mock.api,
        h.ctx,
        h.node.rootId,
        h.receipt.id,
        h.q.data.taskId,
        h.q.data.taskDigest,
      ),
    ).toEqual(h.q.ref);
    expect(h.query().eligible).toBe(false);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it.each([
    "duplicate-record",
    "duplicate-key",
    "missing-node",
    "missing-seal",
    "wrong-owner",
    "wrong-version",
    "wrong-receipt",
    "unsafe-sibling",
  ])("rejects %s in attestation projections without appending or freshening", (kind) => {
    const h = setup(),
      data = structuredClone(originalQ.data);
    if (kind !== "duplicate-record") data.recordId = "negative-new-record";
    if (kind !== "duplicate-record" && kind !== "duplicate-key") h.graph.qualifications.clear();
    if (kind === "missing-node") h.graph.nodes.delete(data.operationId);
    if (kind === "missing-seal") h.graph.seals.delete(h.node.rootId);
    if (kind === "wrong-owner")
      data.owner = {
        kind: "board",
        board: {
          sessionId: h.ctx.sessionManager.getSessionId(),
          boardRunId: "untrusted",
          seedEntryId: "untrusted",
        },
      };
    if (kind === "wrong-version") data.artifactVersion.versionId = "0".repeat(64);
    if (kind === "wrong-receipt") data.receiptId = "tool:untrusted";
    if (kind === "unsafe-sibling") {
      const other = structuredClone(h.node);
      other.operationId = "untrusted-late";
      other.start.sequence = h.node.end!.sequence + 1;
      other.end!.sequence = h.node.end!.sequence + 2;
      h.graph.nodes.set(other.operationId, other);
    }
    expect(() => {
      attestInvocation(h.graph, data, { entryId: "not-a-receipt", digest: "0".repeat(64) });
    }).toThrow(/Eligibility identity|not bound to its actual|stale versions/);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it.each([
    "duplicate-record",
    "duplicate-root",
    "missing-root",
    "missing-end",
    "child-root",
    "missing-index",
    "wrong-owner",
  ])("rejects a %s seal projection", (kind) => {
    const h = setup(),
      seal = h.graph.seals.get(h.node.rootId)!,
      data = structuredClone(seal.data),
      root = h.graph.nodes.get(h.node.rootId)!;
    if (kind !== "duplicate-record") data.recordId = "negative-new-record";
    if (kind !== "duplicate-record" && kind !== "duplicate-root") h.graph.seals.clear();
    if (kind === "missing-root") h.graph.nodes.delete(data.rootId);
    if (kind === "missing-end") delete root.end;
    if (kind === "child-root") root.parentId = "untrusted";
    if (kind === "missing-index") h.graph.roots.delete(data.rootId);
    if (kind === "wrong-owner")
      data.owner = {
        kind: "board",
        board: {
          sessionId: h.ctx.sessionManager.getSessionId(),
          boardRunId: "untrusted",
          seedEntryId: "untrusted",
        },
      };
    expect(() => {
      sealInvocationRoot(h.graph, data, { entryId: "not-a-receipt", digest: "0".repeat(64) });
    }).toThrow(/seal is immutable|no matching actual root end/);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it("keeps missing and historical active nodes uncertain, with explicit attention taking precedence", () => {
    const h = setup();
    h.graph.active.add("missing");
    expect(invocationUnknownIssue(h.graph, new Set())).toMatch(/uncertain invocation/);
    expect(invocationGraphIssue(h.graph)).toMatch(/active\/unknown/);
    expect(invocationUnknownIssue(h.graph, new Set(), "original attention")).toBe(
      "original attention",
    );
    expect(
      invocationOwnerKey({
        kind: "board",
        board: { sessionId: "s", boardRunId: "a", seedEntryId: "e" },
      }),
    ).not.toBe(
      invocationOwnerKey({
        kind: "board",
        board: { sessionId: "s", boardRunId: "b", seedEntryId: "e" },
      }),
    );
  });
  it.each([
    "no-graph",
    "stale-frame",
    "missing-node",
    "missing-end",
    "missing-seal",
    "held-seal",
    "missing-version",
  ])("never attests across %s", (kind) => {
    const h = setup();
    h.graph.qualifications.clear();
    if (kind === "no-graph") h.runtime.controlJournal = {};
    if (kind === "stale-frame") h.frame.humanEpoch++;
    if (kind === "missing-node") h.graph.nodes.delete(h.node.operationId);
    if (kind === "missing-end") delete h.node.end;
    if (kind === "missing-seal") h.graph.seals.delete(h.node.rootId);
    const seal = h.graph.seals.get(h.node.rootId);
    if (kind === "held-seal" && seal) seal.data.outcome = "held";
    if (kind === "missing-version" && seal) seal.data.artifactVersion = null;
    expect(() =>
      attestManagedReceipt(
        h.mock.api,
        h.ctx,
        h.node.rootId,
        h.receipt.id,
        h.q.data.taskId,
        h.q.data.taskDigest,
      ),
    ).toThrow(/no current live host root frame|actual qualified root seal/);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it.each(["missing-store", "missing-body", "failed", "nonzero", "wrong-task"])(
    "does not substitute %s for its original receipt",
    (kind) => {
      const h = setup();
      h.graph.qualifications.clear();
      if (kind !== "missing-store") {
        h.runtime.receiptStore = new ReceiptStore(
          undefined,
          h.ctx,
          h.ctx.sessionManager.getSessionId(),
        );
        if (kind === "failed") h.receipt.ok = false;
        if (kind === "nonzero") h.receipt.exitCode = 2;
        if (kind === "wrong-task") h.receipt.reviews = [];
        vi.spyOn(h.runtime.receiptStore, "readReceipts").mockReturnValue(
          kind === "missing-body" ? [] : [h.receipt],
        );
      }
      expect(() =>
        attestManagedReceipt(
          h.mock.api,
          h.ctx,
          h.node.rootId,
          h.receipt.id,
          h.q.data.taskId,
          h.q.data.taskDigest,
        ),
      ).toThrow(/not an actual successful review check/);
      expect(h.mock.appendEntry).not.toHaveBeenCalled();
    },
  );
  it.each(["missing-owner", "different-owner", "unknown-version"])(
    "does not queue with %s",
    (kind) => {
      const h = setup(),
        board = createEmptyBoard();
      board.tasks = [createTask({ id: "t-1.1", status: "reviewing" })];
      setBoard(board);
      h.runtime.invocation!.live.set("negative", {
        operationId: h.node.operationId,
        rootId: h.node.rootId,
        frame: h.frame,
        allowed: false,
      });
      if (kind === "missing-owner") h.runtime.management!.activeWorkOwner = null;
      if (kind === "different-owner" && h.owner.kind === "goal")
        h.runtime.management!.activeWorkOwner = {
          kind: "goal",
          goal: { ...h.owner.goal, goalKey: "other" },
        };
      expect(() =>
        queueCompletionIntents(h.mock.api, h.ctx, "negative", [{ id: "t-1.1", type: "advance" }]),
      ).toThrow(/actual current owner and known candidate version/);
      expect(h.mock.appendEntry).not.toHaveBeenCalled();
    },
  );
  it.each([
    "runtime",
    "manager",
    "session",
    "path",
    "owner",
    "no-owner",
    "human",
    "goal-token",
    "stopping",
    "tasks",
    "mode-ref",
  ])("rejects a changed %s frame", (kind) => {
    const h = setup();
    if (kind === "runtime") h.frame.runtime = { ...h.runtime };
    if (kind === "manager") h.frame.manager = createMockContext().sessionManager;
    if (kind === "session") h.frame.sessionId = "changed";
    if (kind === "path") h.frame.path = "/different-owned-negative";
    if (kind === "owner" && h.frame.owner.kind === "goal")
      h.frame.owner = { kind: "goal", goal: { ...h.frame.owner.goal, goalKey: "other" } };
    if (kind === "no-owner") h.runtime.management!.activeWorkOwner = null;
    if (kind === "human") h.frame.humanEpoch++;
    if (kind === "goal-token") h.frame.goalToken = "other";
    if (kind === "stopping") h.runtime.management!.state = "stopping-with-attention";
    if (kind === "tasks") h.runtime.management!.mode = "tasks";
    if (kind === "mode-ref") h.frame.modeRef = { entryId: "untrusted", digest: "0".repeat(64) };
    expect(invocationFrameCurrent(h.ctx, h.frame)).toBe(false);
    expect(h.query().eligible).toBe(false);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it("keeps recorded qualification history false when no current inputs can be verified", () => {
    const h = setup();
    expect(h.query().eligible).toBe(false);
    const projection = qualificationProjection(h.ctx, [h.receipt], h.q.data.epoch);
    expect(projection[0]).toMatchObject({
      eligible: false,
      originalEligible: false,
      originalDigest: h.receipt.digest,
    });
    expect(qualificationProjection(h.ctx, [], h.q.data.epoch)).toEqual([]);
    expect(
      qualifiedEvidence(h.receipt, h.q.data.taskId, h.q.data.taskDigest, h.q.data.epoch).eligible,
    ).toBe(false);
  });
  it.each([
    "failed",
    "nonzero",
    "missing-exit",
    "raw-eligible",
    "journal",
    "pending",
    "active",
    "missing-node",
    "missing-frame",
    "receipt-digest",
    "task-digest",
    "epoch",
    "missing-qualification",
  ])("does not accept %s projection", (kind) => {
    const h = setup();
    if (kind === "failed") h.receipt.ok = false;
    if (kind === "nonzero") h.receipt.exitCode = 3;
    if (kind === "missing-exit") delete h.receipt.exitCode;
    if (kind === "raw-eligible") h.receipt.eligible = true;
    if (kind === "journal") h.runtime.journalFault = "Unknown original append";
    if (kind === "pending") {
      h.runtime.receiptStore = new ReceiptStore(
        undefined,
        h.ctx,
        h.ctx.sessionManager.getSessionId(),
      );
      vi.spyOn(h.runtime.receiptStore, "pendingCount", "get").mockReturnValue(1);
    }
    if (kind === "active") h.graph.active.add("untrusted-negative");
    if (kind === "missing-node") h.graph.nodes.delete(h.node.operationId);
    if (kind === "missing-frame") h.runtime.invocation!.frames.clear();
    if (kind === "receipt-digest") h.receipt.digest = "0".repeat(64);
    if (kind === "task-digest") h.q.data.taskDigest = "0".repeat(64);
    if (kind === "epoch") h.q.data.epoch++;
    if (kind === "missing-qualification") h.graph.qualifications.clear();
    expect(h.query(originalQ.data.epoch).eligible).toBe(false);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it.each(["journal", "messages", "busy"])("cannot repair across %s hold", (kind) => {
    const h = setup();
    if (kind === "journal") h.runtime.journalFault = "unknown";
    if (kind === "messages") vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    if (kind === "busy") vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    expect(() => {
      repairCompletionMetadata(h.mock.api, h.ctx, "untrusted");
    }).toThrow(/confirmed quiet journal/);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it("does not qualify a receipt with a missing current root frame", () => {
    const h = setup();
    h.runtime.invocation!.frames.clear();
    expect(() =>
      attestManagedReceipt(
        h.mock.api,
        h.ctx,
        h.node.rootId,
        h.receipt.id,
        h.q.data.taskId,
        h.q.data.taskDigest,
      ),
    ).toThrow(/no current live host root frame/);
  });
  it("ignores missing/closed end callbacks and quarantines a changed carrier without publishing", () => {
    const h = setup(),
      event = {
        type: "tool_execution_end",
        toolCallId: "negative",
        toolName: "owned_check",
        isError: false,
        args: {},
        result: { content: [], details: {} },
      } as ToolExecutionEndEvent;
    observeManagedInvocationEnd(h.mock.api, h.ctx, event);
    h.runtime.invocation!.live.set("negative", {
      operationId: "unknown",
      rootId: h.node.rootId,
      frame: h.frame,
      allowed: false,
    });
    observeManagedInvocationEnd(h.mock.api, h.ctx, event);
    h.runtime.invocation!.live.set("negative", {
      operationId: h.node.operationId,
      rootId: h.node.rootId,
      frame: h.frame,
      allowed: false,
    });
    observeManagedInvocationEnd(h.mock.api, h.ctx, event);
    h.frame.path = "changed";
    expect(invocationCarrierCurrent(h.ctx, h.frame)).toBe(false);
    observeManagedInvocationEnd(h.mock.api, h.ctx, event);
    expect(h.runtime.invocation!.attention).toMatch(/Historical invocation end/);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it("rejects an unadmitted result and keeps incomplete current observations non-authoritative", () => {
    const h = setup(),
      event = {
        type: "tool_result",
        toolCallId: "negative",
        toolName: "owned_check",
        input: {},
        content: [],
        isError: false,
        details: undefined,
      } as ToolResultEvent;
    h.runtime.invocation!.live.set("negative", {
      operationId: "unknown",
      rootId: h.node.rootId,
      frame: h.frame,
      allowed: false,
    });
    expect(() => {
      observeManagedInvocationResult(h.ctx, event, undefined);
    }).toThrow(/no admitted node/);
    h.runtime.invocation!.live.set("negative", {
      operationId: h.node.operationId,
      rootId: h.node.rootId,
      frame: h.frame,
      allowed: false,
    });
    h.frame.humanEpoch++;
    observeManagedInvocationResult(h.ctx, event, undefined);
    expect(h.runtime.invocation!.results.get("negative")).toMatchObject({
      receiptId: null,
      receiptDigest: null,
      receiptRef: null,
      version: null,
      effects: "unqualified",
    });
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it("blocks task-only nested done on the SDK's unavailable original-check surface", () => {
    const h = setup(),
      board = createEmptyBoard();
    board.tasks = [createTask({ id: "t-1.1", status: "reviewing" })];
    setBoard(board);
    h.runtime.management!.activeWorkOwner = null;
    const event = {
      type: "tool_call",
      toolCallId: "negative",
      parentToolCallId: "opaque",
      toolName: "advance_tasks",
      input: { transitions: [{ id: "t-1.1" }] },
    } as ToolCallEvent;
    expect(() => {
      admitManagedInvocation(h.mock.api, h.ctx, event);
    }).toThrow(/Task-only container completion has no qualified original host check/);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
  it("does not partly queue mixed reviewing/implementing transitions", () => {
    const h = setup(),
      board = createEmptyBoard();
    board.tasks = [
      createTask({ id: "t-1.1", status: "reviewing" }),
      createTask({ id: "t-1.2", status: "implementing" }),
    ];
    setBoard(board);
    h.runtime.invocation!.live.set("negative", {
      operationId: h.node.operationId,
      rootId: h.node.rootId,
      frame: h.frame,
      allowed: false,
    });
    expect(queueCompletionIntents(h.mock.api, h.ctx, "unadmitted", [])).toBeUndefined();
    expect(queueCompletionIntents(h.mock.api, h.ctx, "negative", [])).toBeUndefined();
    expect(() =>
      queueCompletionIntents(h.mock.api, h.ctx, "negative", [
        { id: "t-1.1", type: "advance" },
        { id: "t-1.2", type: "advance" },
      ]),
    ).toThrow(/no mixed partial transition/);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
});
