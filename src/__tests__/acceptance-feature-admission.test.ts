import { startSupervisor } from "../supervisor";
import { enableSessionScope } from "../scope";
import { adoptSupervisedMode } from "../management-policy";
// P7 adjacency: strict feature/owner admission never upgrades borrowed wire values.
// Source rows came from owned SDK producers; rebinding copies below is exclusively
// a NEGATIVE probe. No copy is an actual invocation, execution or permission.
import { readFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { preflightLifecycle } from "./helpers/preflight";
import { resetState } from "../state";
import {
  appendControlFact,
  currentWorkOwner,
  type ControlFact,
  type WorkOwnerKey,
  readControlJournal,
  appendAcceptanceFact,
  appendContractProposal,
} from "../control-journal";
import type { AcceptanceFact } from "../acceptance-journal";
import type { ContractProposalRecord } from "../acceptance-planning";
beforeEach(resetState);
const facts = new Map<string, Record<string, unknown>>();
for (const name of ["acceptance-check-sdk.jsonl", "progress-task-only-sdk.jsonl"]) {
  for (const line of readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trimEnd()
    .split("\n")) {
    const row = JSON.parse(line) as { customType?: string; data?: Record<string, unknown> };
    if (
      row.customType === "continuous-tasks:control-facts" &&
      typeof row.data?.kind === "string" &&
      !facts.has(row.data.kind)
    )
      facts.set(row.data.kind, row.data);
  }
}
const kinds = [
  "invocation-started",
  "invocation-ended",
  "invocation-root-sealed",
  "eligibility-attested",
  "completion-intent-queued",
  "completion-intent-disposed",
  "progress-definition",
  "progress-observed",
  "batch-advice-observed",
  "review-attempt-started",
  "review-attempt-observed",
  "advisor-call-started",
  "advisor-call-observed",
];
it.each(kinds)("rejects borrowed %s before persistence without its actual source", async (kind) => {
  const h = preflightLifecycle();
  startSupervisor(h.mock.api, h.ctx, "Owned feature admission");
  enableSessionScope(h.mock.api);
  adoptSupervisedMode(h.mock.api, h.ctx);
  const owner = currentWorkOwner(h.ctx.sessionManager.getSessionId()),
    original = facts.get(kind);
  if (!owner || !original) throw Error("Actual owner/owned source unavailable");
  const value = {
      ...structuredClone(original),
      owner,
      recordId: `negative-${kind}`,
    } as unknown as ControlFact,
    before = readFileSync(h.path, "utf8");
  expect(() => appendControlFact(h.mock.api, h.ctx, value)).toThrow();
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
});
it.each(kinds)(
  "requires the explicit native feature before admitting borrowed %s on an unowned Session",
  (kind) => {
    const h = preflightLifecycle(),
      original = facts.get(kind);
    if (!original) throw Error("Owned wire source missing");
    const copy = structuredClone(original),
      owner = copy.owner as WorkOwnerKey;
    if (owner.kind === "goal") owner.goal.sessionId = h.ctx.sessionManager.getSessionId();
    else owner.board.sessionId = h.ctx.sessionManager.getSessionId();
    // This is deliberately NOT a real owner in this Session, and must never append.
    const before = readFileSync(h.path, "utf8");
    expect(() => appendControlFact(h.mock.api, h.ctx, copy as unknown as ControlFact)).toThrow(
      /CONTROL_FACT_UNSUPPORTED/,
    );
    expect(readFileSync(h.path, "utf8")).toBe(before);
  },
);
it("rejects unsupported acceptance/proposal values before append, never guessing a source grant", async () => {
  const h = preflightLifecycle();
  startSupervisor(h.mock.api, h.ctx, "Owned unsupported values");
  enableSessionScope(h.mock.api);
  adoptSupervisedMode(h.mock.api, h.ctx);
  const before = readFileSync(h.path, "utf8");
  expect(() =>
    appendAcceptanceFact(h.mock.api, h.ctx, { trusted: true } as unknown as AcceptanceFact),
  ).toThrow(/CONTROL_FACT_UNSUPPORTED/);
  expect(() =>
    appendContractProposal(h.mock.api, h.ctx, {
      trusted: true,
    } as unknown as ContractProposalRecord),
  ).toThrow(/CONTROL_FACT_UNSUPPORTED/);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
