import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { completedReviewFixture } from "./helpers/execution-registry";
import { BOUNDARY, deferred } from "./helpers/lifecycle";
import { currentRuntime } from "../runtime";
import type { AdvisorStartedFact, ReviewAttemptStartedFact } from "../control-journal";

const startChanges: Record<string, (data: ReviewAttemptStartedFact) => void> = {
  "zero-deadline": (data) => {
    data.deadlineAt = data.startedAt;
  },
  "renewed-deadline": (data) => {
    data.deadlineAt = data.startedAt + 30001;
  },
  "review-number": (data) => {
    data.reviewNumber++;
  },
  "board-digest": (data) => {
    data.boardDigest = "0".repeat(64);
  },
  "bindings-digest": (data) => {
    data.bindingsDigest = "0".repeat(64);
  },
  "validation-reference": (data) => {
    data.validationRef.digest = "0".repeat(64);
  },
  "validation-version": (data) => {
    data.artifactVersion.versionId = "0".repeat(64);
  },
  "validation-epoch": (data) => {
    data.epoch++;
  },
  "first-call-view": (data) => {
    data.firstCallViewDigest = "0".repeat(64);
  },
};
it.each([...Object.keys(startChanges), "early-call", "late-call", "foreign-call-owner"])(
  "refuses %s in an actual interrupted attempt instead of trusting labels or replaying review",
  async (scenario) => {
    const f = await completedReviewFixture(),
      requested = deferred<boolean>(),
      reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
    let boundary: Promise<unknown> | undefined,
      calls = 0;
    const accept = () =>
      fauxAssistantMessage(
        JSON.stringify({
          action: "accept",
          message: "Cancelled stale attempt",
          taskIds: ["t-1.1"],
          evidenceRefs: ["tool:repair-proof"],
        }),
      );
    try {
      Object.assign(f.ctx, {
        modelRegistry: {
          find: () => f.ctx.model,
          streamSimple: () => ({
            result: async () => {
              calls++;
              requested.resolve(true);
              return reply.promise;
            },
          }),
        },
      });
      boundary = f.fire("agent_before_settle", BOUNDARY);
      await requested.promise;
      const entries = structuredClone(f.entries());
      const started = entries.find(
        (entry) =>
          entry.customType === "continuous-tasks:control-facts" &&
          (entry.data as { kind?: string }).kind === "review-attempt-started",
      )!;
      const start = started.data as ReviewAttemptStartedFact;
      if (startChanges[scenario]) startChanges[scenario](start);
      else {
        const called = entries.find(
          (entry) =>
            entry.customType === "continuous-tasks:control-facts" &&
            (entry.data as { kind?: string }).kind === "advisor-call-started",
        )!;
        const call = called.data as AdvisorStartedFact;
        if (scenario === "early-call") call.startedAt = start.startedAt - 1;
        if (scenario === "late-call") call.startedAt = start.deadlineAt + 1;
        if (scenario === "foreign-call-owner") {
          call.owner.goal.goalKey = "rg-foreign";
          call.owner.goal.goalRunId = "rg-foreign";
        }
      }
      const header = JSON.parse(readFileSync(f.path, "utf8").split("\n")[0]!);
      writeFileSync(
        f.path,
        [header, ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n",
      );
      f.sendMessage.mockClear();
      f.reload();
      await f.fire("session_tree");
      await boundary;
      expect(currentRuntime().journalFault, scenario).toBeDefined();
      expect(currentRuntime().supervisor?.status).not.toBe("completed");
      expect(calls).toBe(1);
      expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    } finally {
      reply.resolve(accept());
      await boundary;
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      f.close();
    }
  },
);
