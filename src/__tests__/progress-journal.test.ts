import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { currentRuntime } from "../runtime";
import {
  appendControlFact,
  captureControlLease,
  readControlJournal,
  type ProgressObserved,
  type ProgressDefinition,
  type BatchAdviceObserved,
} from "../control-journal";
import { progressSince, registerProgressMilestone } from "../progress-facts";
import { BOUNDARY } from "./helpers/lifecycle";
import { prepareExecutionOwner } from "../execution-settlement";
import { getBoardRef } from "../state";
async function observedFixture() {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  Object.assign(f.ctx, {
    modelRegistry: {
      find: () => f.ctx.model,
      streamSimple: () => ({
        result: async () =>
          fauxAssistantMessage(
            JSON.stringify({
              action: "guide",
              message: "Same authorized implementation",
              taskIds: ["t-1.1"],
              evidenceRefs: [],
            }),
          ),
      }),
    },
  });
  const call = {
    toolName: "write",
    toolCallId: "observed-journal-progress",
    input: { path: join(f.dir, "review-input.txt"), content: "Actual managed input change\n" },
  };
  expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
  writeFileSync(call.input.path, call.input.content);
  await f.fire("tool_result", {
    type: "tool_result",
    ...call,
    content: [{ type: "text", text: "Actual result timestamp is not the progress key" }],
    isError: false,
  });
  await f.fire("agent_before_settle", BOUNDARY);
  expect(progressSince({ owner: f.owner }).keys).toHaveLength(1);
  return f;
}
it("rejects forged native progress identities, source refs, result semantics and duplicates before append", async () => {
  const f = await observedFixture();
  try {
    const original = currentRuntime().controlJournal?.progressFacts?.find(
      (row) => row.data.kind === "progress-observed",
    )?.data as ProgressObserved;
    expect(original).toBeDefined();
    const mutations: Array<(d: ProgressObserved) => void> = [
      (d) => {
        if (d.owner.kind === "goal") d.owner.goal.sessionId = "foreign-session";
      },
      (d) => {
        d.definitionRef.entryId = "missing-definition";
      },
      (d) => {
        d.definitionRef.digest = "0".repeat(64);
      },
      (d) => {
        d.definitionId = "different-definition";
      },
      (d) => {
        d.taskId = "t-999.1";
      },
      (d) => {
        d.sourceRef.entryId = "missing-result";
      },
      (d) => {
        d.sourceRef.digest = "0".repeat(64);
      },
      (d) => {
        d.receiptId = "tool:invented";
      },
      (d) => {
        d.receiptDigest = "0".repeat(64);
      },
      (d) => {
        d.sourceKind = "native-result";
      },
      (d) => {
        d.result = "failure";
      },
      (d) => {
        d.result = "formed";
      },
      (d) => {
        d.result = "success";
      },
      (d) => {
        d.artifactVersion.scopeDigest = "0".repeat(64);
      },
      (d) => {
        d.artifactVersion.scopeId = "wrong-scope";
      },
      (d) => {
        d.artifactVersion.workspace.root = "wrong-root";
      },
      (d) => {
        d.artifactVersion.workspace.device = "wrong-device";
      },
      (d) => {
        d.artifactVersion.workspace.inode = "wrong-inode";
      },
      (d) => {
        d.artifactVersion.environmentDigest = "0".repeat(64);
      },
      (d) => {
        d.artifactVersion.versionId = "malformed";
      },
      () => {},
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(original);
      candidate.recordId = randomUUID();
      mutate(candidate);
      const before = f.ctx.sessionManager.getLeafId();
      expect(() =>
        appendControlFact(f.api, f.ctx, candidate, captureControlLease(f.ctx)),
      ).toThrow();
      expect(f.ctx.sessionManager.getLeafId()).toBe(before);
      expect(currentRuntime().journalFault).toBeUndefined();
    }
    expect(progressSince({ owner: f.owner }).keys).toHaveLength(1);
  } finally {
    f.close();
  }
});
it("strictly verifies definition policy, baseline scope, causal board and unique IDs", async () => {
  const f = await observedFixture();
  try {
    const original = currentRuntime().controlJournal?.progressFacts?.find(
      (row) => row.data.kind === "progress-definition",
    )?.data as ProgressDefinition;
    const mutations: Array<(d: ProgressDefinition) => void> = [
      (d) => {
        d.boardRef.entryId = "missing-board";
      },
      (d) => {
        d.boardRef.digest = "0".repeat(64);
      },
      (d) => {
        d.taskDigest = "0".repeat(64);
      },
      (d) => {
        d.taskId = "t-999.1";
      },
      (d) => {
        d.policy = "declared-v1";
        d.baseline.workspace.root = "wrong-root";
      },
      (d) => {
        d.baseline.scopeId = "declared-artifacts-v1";
      },
      (d) => {
        d.inputs = ["out-of-policy.txt"];
      },
      (d) => {
        d.artifacts = ["out-of-policy.txt"];
      },
      (d) => {
        d.absent = true;
      },
      (d) => {
        d.check = { tool: "bash", inputDigest: "0".repeat(64) };
      },
      (d) => {
        d.milestone = "artifact";
      },
      (d) => {
        d.milestone = "check";
      },
      () => {},
    ];
    for (const [index, mutate] of mutations.entries()) {
      const candidate = structuredClone(original);
      candidate.recordId = randomUUID();
      if (index < mutations.length - 1) candidate.definitionId = `mutated-${index}`;
      mutate(candidate);
      const before = f.ctx.sessionManager.getLeafId();
      expect(() =>
        appendControlFact(f.api, f.ctx, candidate, captureControlLease(f.ctx)),
      ).toThrow();
      expect(f.ctx.sessionManager.getLeafId()).toBe(before);
    }
  } finally {
    f.close();
  }
});
it("retains actual batch advice but rejects invented call/authority/graph/receipt refs", async () => {
  const f = await observedFixture();
  try {
    const original = currentRuntime().controlJournal?.progressFacts?.find(
      (row) => row.data.kind === "batch-advice-observed",
    )?.data as BatchAdviceObserved;
    expect(original).toBeDefined();
    const mutations: Array<(d: BatchAdviceObserved) => void> = [
      (d) => {
        d.callRef.entryId = "missing-call";
      },
      (d) => {
        d.callRef.digest = "0".repeat(64);
      },
      (d) => {
        d.supervisorRef.entryId = "missing-supervisor";
      },
      (d) => {
        d.supervisorRef.digest = "0".repeat(64);
      },
      (d) => {
        d.boardRef.entryId = "missing-board";
      },
      (d) => {
        d.graphDigest = "0".repeat(64);
      },
      (d) => {
        d.authorityDigest = "0".repeat(64);
      },
      (d) => {
        d.valid = false;
      },
      (d) => {
        d.advice.taskIds = ["t-999.1"];
      },
      (d) => {
        d.advice.evidenceRefs = ["tool:invented"];
      },
      (d) => {
        d.advice.message = "x".repeat(8001);
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(original);
      candidate.recordId = randomUUID();
      mutate(candidate);
      expect(() =>
        appendControlFact(f.api, f.ctx, candidate, captureControlLease(f.ctx)),
      ).toThrow();
    }
    expect(
      readControlJournal(f.ctx).progressFacts?.filter(
        (row) => row.data.kind === "batch-advice-observed",
      ),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});
// Native wire limit fixture, not a 100-call registration performance benchmark.
it("keeps trusted milestone definitions bounded without evicting confirmed history", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    const registered = registerProgressMilestone(f.api, f.ctx, {
      id: "bounded-0",
      taskId: "t-1.1",
      milestone: "input_difference",
      policy: "git-visible-workspace-v1",
    });
    expect(registered).toBeDefined();
    if (!registered) throw Error("Actual scope registration missing");
    // Each declaration refers to the same actually captured workspace and native board;
    // these are names/definitions, not invented observations, execution or acceptance proof.
    for (let i = 1; i < 100; i++)
      f.api.appendEntry("continuous-tasks:control-facts", {
        ...structuredClone(registered.data),
        recordId: randomUUID(),
        definitionId: `bounded-${i}`,
      });
    const before = f.ctx.sessionManager.getLeafId();
    expect(
      registerProgressMilestone(f.api, f.ctx, {
        id: "over-limit",
        taskId: "t-1.1",
        milestone: "input_difference",
        inputs: ["review-input.txt"],
      }),
    ).toBeUndefined();
    expect(f.ctx.sessionManager.getLeafId()).toBe(before);
    expect(currentRuntime().progress?.limited).toBe(true);
    expect(
      readControlJournal(f.ctx).progressFacts?.filter(
        (row) => row.data.kind === "progress-definition",
      ),
    ).toHaveLength(100);
  } finally {
    f.close();
  }
});
it("does not pretend SDK task-only native messages retain qualified structured check exits", async () => {
  const f = await executionRegistryFixture(true, { gitWorkspace: true });
  try {
    prepareExecutionOwner(f.api, f.ctx, getBoardRef());
    expect(f.owner.kind).toBe("board");
    const before = f.ctx.sessionManager.getLeafId();
    expect(
      registerProgressMilestone(f.api, f.ctx, {
        id: "unsupported-board-check",
        taskId: "t-1.1",
        milestone: "check",
        inputs: ["review-input.txt"],
        check: { tool: "bash", input: { command: "fixed owned check" } },
      }),
    ).toBeUndefined();
    expect(f.ctx.sessionManager.getLeafId()).toBe(before);
    expect(progressSince({ owner: f.owner }).keys).toEqual([]);
  } finally {
    f.close();
  }
});
it("requires trusted active owner, valid declared scope and a bounded exact check registration", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    const base = {
      id: "declared",
      taskId: "t-1.1",
      milestone: "input_difference" as const,
      inputs: ["review-input.txt"],
    };
    expect(() => registerProgressMilestone(f.api, f.ctx, { ...base, taskId: "t-999.1" })).toThrow();
    expect(
      registerProgressMilestone(f.api, f.ctx, { ...base, inputs: ["../escape"] }),
    ).toBeUndefined();
    expect(() =>
      registerProgressMilestone(f.api, f.ctx, {
        ...base,
        milestone: "check",
        check: { tool: "bash", input: { command: "x".repeat(3000) } },
      }),
    ).toThrow();
    expect(registerProgressMilestone(f.api, f.ctx, base)).toBeDefined();
    expect(registerProgressMilestone(f.api, f.ctx, base)?.data.definitionId).toBe("declared");
    expect(() =>
      registerProgressMilestone(f.api, f.ctx, { ...base, inputs: [".gitignore"] }),
    ).toThrow(/conflict/);
    currentRuntime().journalFault = "owned unknown source";
    expect(registerProgressMilestone(f.api, f.ctx, { ...base, id: "after-fault" })).toBeUndefined();
  } finally {
    f.close();
  }
});
