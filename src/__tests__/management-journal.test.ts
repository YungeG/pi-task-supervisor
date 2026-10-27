import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { executionRegistryFixture, completedReviewFixture } from "./helpers/execution-registry";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BOUNDARY } from "./helpers/lifecycle";
import { currentRuntime } from "../runtime";
import { journalDigest } from "../human-journal";
import { readControlJournal, type SessionModeChangedV1 } from "../control-journal";

it("retains the actual sealed acceptance reference as history without claiming current validity or recapturing unmanaged work", async () => {
  const f = await completedReviewFixture();
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () =>
            fauxAssistantMessage(
              JSON.stringify({
                action: "accept",
                message: "Fixed work reviewed",
                taskIds: ["t-1.1"],
                evidenceRefs: ["tool:repair-proof"],
              }),
            ),
        }),
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    const accepted = currentRuntime().controlJournal?.reviewAttempts?.at(-1)?.result;
    expect(accepted?.data.outcome).toBe("accepted");
    const sealed = JSON.stringify(accepted);
    await f.command("disable");
    expect(currentRuntime().management?.lastGoal).toMatchObject({
      acceptedRef: { entryId: accepted!.entryId, digest: accepted!.digest },
      validity: "needs_verification",
    });
    const count = currentRuntime().receiptStore?.stats.count;
    const call = {
      toolCallId: "unmanaged-after-acceptance",
      toolName: "write",
      input: { path: "independent-fixed-work" },
    };
    expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
    await f.fire("tool_result", {
      type: "tool_result",
      ...call,
      content: [{ type: "text", text: "Unmanaged synthetic result" }],
      isError: false,
    });
    expect(JSON.stringify(currentRuntime().controlJournal?.reviewAttempts?.at(-1)?.result)).toBe(
      sealed,
    );
    expect(currentRuntime().receiptStore?.stats.count).toBe(count);
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentRuntime().management?.lastGoal?.acceptedRef).toEqual({
      entryId: accepted!.entryId,
      digest: accepted!.digest,
    });
  } finally {
    f.close();
  }
});

type Change = (
  data: SessionModeChangedV1,
  fixture: Awaited<ReturnType<typeof executionRegistryFixture>>,
) => void;
const changes: Array<[string, Change]> = [
  [
    "oversized bounded fields",
    (data) => {
      data.attention = Array.from({ length: 32 }, () => ({
        kind: "business_failure" as const,
        ref: null,
        reason: "x".repeat(1000),
      }));
    },
  ],
  [
    "unknown mode",
    (data) => {
      Reflect.set(data, "mode", "model-selected");
    },
  ],
  [
    "extra authority field",
    (data) => {
      Reflect.set(data, "managed", false);
    },
  ],
  [
    "duplicate mode identity",
    (data) => {
      data.recordId = currentRuntime().controlJournal!.modeRecords!.at(-2)!.data.recordId;
    },
  ],
  [
    "erased predecessor",
    (data) => {
      data.previousModeRecord = null;
    },
  ],
  [
    "foreign origin owner",
    (data) => {
      if (data.originOwner?.kind === "goal") data.originOwner.goal.sessionId = "foreign";
    },
  ],
  [
    "different predecessor owner",
    (data) => {
      data.originOwner = structuredClone(
        currentRuntime().controlJournal!.modeRecords![0]!.data.originOwner,
      );
    },
  ],
  [
    "unborn board owner",
    (data) => {
      data.mode = "tasks";
      data.activeWorkOwner = {
        kind: "board",
        board: { sessionId: data.sessionId, boardRunId: "unborn", seedEntryId: "absent-seed" },
      };
    },
  ],
  [
    "task mode borrowing Goal owner",
    (data) => {
      data.mode = "tasks";
      data.activeWorkOwner = structuredClone(data.originOwner);
    },
  ],
  [
    "last Goal with foreign Session",
    (data) => {
      data.lastGoal!.owner!.sessionId = "foreign";
    },
  ],
  [
    "last Goal with inconsistent identity",
    (data) => {
      data.lastGoal!.owner!.goalRunId = null;
    },
  ],
  [
    "last Goal without native birth",
    (data) => {
      const owner = data.lastGoal!.owner!;
      owner.goalKey = owner.goalRunId = "unborn-goal";
      owner.lifecycleCommitId = "absent-commit";
      data.lastGoal!.sourceRef = null;
    },
  ],
  [
    "ownerless source",
    (data) => {
      data.lastGoal!.owner = null;
    },
  ],
  [
    "ownerless acceptance",
    (data) => {
      data.lastGoal!.owner = null;
      data.lastGoal!.sourceRef = null;
      data.lastGoal!.acceptedRef = structuredClone(data.previousModeRecord);
    },
  ],
  [
    "ownerless accepted claim",
    (data) => {
      data.lastGoal = { owner: null, sourceRef: null, acceptedRef: null, validity: "accepted" };
    },
  ],
  [
    "unproven accepted validity",
    (data) => {
      data.lastGoal!.validity = "accepted";
    },
  ],
  [
    "wrong actual Goal source kind",
    (data) => {
      data.lastGoal!.sourceRef = structuredClone(data.previousModeRecord);
    },
  ],
  [
    "wrong actual acceptance kind",
    (data) => {
      data.lastGoal!.acceptedRef = structuredClone(data.lastGoal!.sourceRef);
    },
  ],
  [
    "changed actual source digest",
    (data) => {
      data.lastGoal!.sourceRef!.digest = "0".repeat(64);
    },
  ],
  [
    "future source",
    (data, f) => {
      f.api.appendEntry("synthetic-future-node", { label: "Not past evidence" });
      const future = f.entries().at(-1)!;
      data.lastGoal!.sourceRef = { entryId: future.id, digest: journalDigest(future) };
    },
  ],
  [
    "revision gap",
    (data) => {
      data.revision++;
    },
  ],
  [
    "wrong predecessor",
    (data) => {
      data.previousModeRecord!.digest = "0".repeat(64);
    },
  ],
  [
    "foreign Session",
    (data) => {
      data.sessionId = "foreign-session";
    },
  ],
  [
    "off active owner",
    (data) => {
      data.activeWorkOwner = structuredClone(data.originOwner);
    },
  ],
  [
    "busy Main",
    (data) => {
      data.hostIdle = false;
    },
  ],
  [
    "pending message",
    (data) => {
      data.pendingMessages = true;
    },
  ],
  [
    "writer attention",
    (data) => {
      data.attention = [{ kind: "execution", ref: null, reason: "Writer still unknown" }];
    },
  ],
  [
    "missing board source",
    (data) => {
      data.boardRef = { entryId: "absent-node", digest: "0".repeat(64) };
    },
  ],
  [
    "missing last Goal source",
    (data) => {
      data.lastGoal!.sourceRef = { entryId: "absent-node", digest: "0".repeat(64) };
    },
  ],
  [
    "invented acceptance",
    (data) => {
      data.lastGoal!.acceptedRef = { entryId: "absent-node", digest: "0".repeat(64) };
    },
  ],
];
it.each(changes)(
  "rejects a physically/mirror-matching mode record with %s",
  async (_name, change) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    try {
      await f.command("disable");
      expect(currentRuntime().management?.mode).toBe("off");
      const selected = currentRuntime().management!.record!;
      const lines = readFileSync(f.path, "utf8").trimEnd().split("\n");
      const index = lines.findIndex(
        (line) => (JSON.parse(line) as { id?: string }).id === selected.entryId,
      );
      expect(index).toBeGreaterThan(0);
      const node = JSON.parse(lines[index]!) as { data: SessionModeChangedV1 };
      change(node.data, f);
      // Preserve appended future fixture nodes when checking prefix-only refs.
      const after = readFileSync(f.path, "utf8").trimEnd().split("\n");
      if (after.length > lines.length) lines.push(...after.slice(lines.length));
      lines[index] = JSON.stringify(node);
      writeFileSync(f.path, lines.join("\n") + "\n");
      f.reload();
      expect(() => readControlJournal(f.ctx)).toThrow();
    } finally {
      f.close();
    }
  },
);
