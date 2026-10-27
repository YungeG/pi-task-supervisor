import { expect, it } from "vitest";
import {
  buildReviewView,
  resolveEvidenceDetail,
  reviewViewDigest,
  type ReviewViewInput,
} from "../review-view";
import { activeBoard } from "./helpers/lifecycle";

function input(count = 1): ReviewViewInput {
  const receipts = Array.from({ length: count }, (_, index) => ({
    id: `tool:retained-${index}`,
    tool: "bash",
    taskIds: ["t-1.1"],
    reviews: [{ taskId: "t-1.1", digest: "a".repeat(64) }],
    epoch: 1,
    ok: true,
    exitCode: 0,
    digest: "b".repeat(64),
    input: "fixed validation",
    output: "核🙂".repeat(1000),
    eligible: true,
  }));
  return {
    goal: "Review explicitly retained synthetic material",
    board: activeBoard(),
    bindings: [
      { taskId: "t-1.1", digest: "a".repeat(64), refs: receipts.map((receipt) => receipt.id) },
    ],
    receipts,
    recent: [],
    acceptanceBlocker: "Work is not complete",
  };
}
it("refuses a missing required goal rather than emitting an apparently valid view", () => {
  const value = input();
  value.goal = "";
  expect(buildReviewView(value)).toMatchObject({
    status: "error",
    error: { code: "REVIEW_SOURCE_INVALID" },
  });
});
it("keeps registered native identity and original material while delivering honest codepoint-safe excerpts", () => {
  const value = input(16),
    before = structuredClone(value),
    result = buildReviewView(value);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.view.bytes).toBeLessThanOrEqual(64000);
  expect(result.view.shortened).toBe(true);
  const detailRef = result.view.detailRefs.find(
    (ref) => ref.sourceId === "tool:retained-0" && ref.field === "output",
  );
  expect(detailRef).toBeDefined();
  const detail = resolveEvidenceDetail(value, detailRef!.id, 7);
  expect(detail).toMatchObject({
    version: 1,
    text: "核🙂",
    shortened: true,
    sourceCompleteness: "retained-capture-unknown",
    availableBytes: 7000,
    viewBytes: 7,
  });
  const packet = JSON.parse(result.view.packet);
  expect(packet.receipts[0]).toMatchObject({
    id: "tool:retained-0",
    digest: "b".repeat(64),
    epoch: 1,
    ok: true,
    exitCode: 0,
  });
  expect(value).toEqual(before);
  // Fixed literal from the declared domain/preimage, not a recomputation of the builder.
  expect(reviewViewDigest({ packet: "{}" })).toBe(
    "8b60caaee4b802375a013afd343b40f145a2924848be4b0649858844a761ef2c",
  );
});
it("cannot resolve a local path, command or invented detail ID", () => {
  const value = input();
  for (const ref of ["/etc/passwd", "../hidden", "bash:cat secret", `detail:${"0".repeat(64)}`])
    expect(resolveEvidenceDetail(value, ref)).toMatchObject({ code: "EVIDENCE_MISSING" });
});
it("does not replace missing or ambiguous required receipts with empty success evidence", () => {
  const value = input();
  value.bindings[0]!.refs.push("tool:missing");
  expect(buildReviewView(value)).toMatchObject({
    status: "error",
    error: { code: "EVIDENCE_MISSING" },
  });
  const duplicate = input();
  duplicate.receipts = [...duplicate.receipts, duplicate.receipts[0]!];
  expect(buildReviewView(duplicate)).toMatchObject({
    status: "error",
    error: { code: "EVIDENCE_MISSING" },
  });
});
it("never accepts a caller-raised packet or detail limit", () => {
  expect(buildReviewView(input(), { maxBytes: 64001 })).toMatchObject({
    status: "error",
    error: { code: "REVIEW_SOURCE_INVALID" },
  });
  expect(resolveEvidenceDetail(input(), "anything", 16001)).toMatchObject({
    code: "REVIEW_SOURCE_INVALID",
  });
});
