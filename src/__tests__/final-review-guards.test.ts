import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completedReviewFixture, executionRegistryFixture } from "./helpers/execution-registry";
import { createAdvanceTasksTool } from "../tools";
import { currentRuntime } from "../runtime";
import type { FinalValidationRegistrationFact, FinalValidationFact } from "../control-journal";
import { getBoardRef } from "../state";

async function registeredFixture() {
  const f = await completedReviewFixture();
  try {
    writeFileSync(join(f.dir, "review-input.txt"), "Changed fixed input requiring revalidation\n");
    await f.command("retry-review");
    expect(currentRuntime().controlJournal?.finalValidationRegistrations).toHaveLength(1);
    return f;
  } catch (error) {
    f.close();
    throw error;
  }
}
it.each(["redacted", "truncated"])(
  "never reconstructs a %s original check as a complete validation invocation",
  async (scenario) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    try {
      expect((await f.review()).isError).not.toBe(true);
      const event = {
        toolName: "bash",
        toolCallId: "bounded-original-check",
        input: {
          command:
            scenario === "redacted"
              ? "printf api_key=synthetic-not-a-real-key"
              : "printf " + "x".repeat(2400),
        },
      };
      expect(await f.fire("tool_call", { type: "tool_call", ...event })).toBeUndefined();
      await f.fire("tool_result", {
        type: "tool_result",
        ...event,
        content: [{ type: "text", text: "Actual protocol fixture success" }],
        structuredContent: { exit_code: 0 },
        isError: false,
      });
      const result = await createAdvanceTasksTool(f.api).execute(
        "bounded-input-complete",
        {
          transitions: [
            {
              id: "t-1.1",
              evidence: {
                summary: "Fixed fixture check",
                refs: [
                  {
                    kind: "command",
                    label: "Existing final check",
                    status: "passed",
                    ref: "tool:bounded-original-check",
                    exitCode: 0,
                  },
                ],
              },
            },
          ],
        },
        undefined,
        undefined,
        f.ctx,
      );
      expect(result.isError).not.toBe(true);
      writeFileSync(join(f.dir, "review-input.txt"), "Requires a new applicable check\n");
      await f.command("retry-review");
      expect(currentRuntime().controlJournal?.finalValidationRegistrations ?? []).toHaveLength(0);
      expect(
        await f.fire("tool_call", {
          type: "tool_call",
          ...event,
          toolCallId: "must-not-reconstruct",
        }),
      ).toMatchObject({ block: true });
      expect(currentRuntime().supervisor?.status).not.toBe("completed");
    } finally {
      f.close();
    }
  },
);
const changes: Record<string, (data: FinalValidationRegistrationFact) => void> = {
  cwd: (data) => {
    data.cwd = "/not-the-session-root";
  },
  "version-root": (data) => {
    data.artifactVersion.workspace.root = "/different-version-root";
  },
  "board-digest": (data) => {
    data.boardDigest = "0".repeat(64);
  },
  "bindings-digest": (data) => {
    data.bindingsDigest = "0".repeat(64);
  },
  "task-digest": (data) => {
    data.taskDigest = "0".repeat(64);
  },
  "wrong-task": (data) => {
    data.taskId = "t-missing";
  },
  epoch: (data) => {
    data.epoch++;
  },
  "original-receipt": (data) => {
    data.originalReceiptId = "tool:not-the-bound-check";
  },
  "input-digest": (data) => {
    data.inputDigest = "0".repeat(64);
  },
  "captured-input-digest": (data) => {
    data.capturedInputDigest = "0".repeat(64);
  },
  "input-invalid-json": (data) => {
    data.inputJSON = "not JSON";
  },
  "input-array": (data) => {
    data.inputJSON = "[]";
  },
  "input-missing-command": (data) => {
    data.inputJSON = "{}";
  },
  "input-number-command": (data) => {
    data.inputJSON = '{"command":1}';
  },
  "input-empty-command": (data) => {
    data.inputJSON = '{"command":""}';
  },
  "input-redacted": (data) => {
    data.inputJSON = '{"command":"[redacted]"}';
  },
  "input-noncanonical": (data) => {
    data.inputJSON = '{ "command": "synthetic repair validation" }';
  },
  "input-changed-command": (data) => {
    data.inputJSON = '{"command":"a different command"}';
  },
  "source-order": (data) => {
    data.source.intentRef = { ...data.source.receiptRef };
  },
  "snapshot-kind": (data) => {
    data.snapshotRef = { ...data.supervisorRef };
  },
  "foreign-owner": (data) => {
    data.owner.goal.sessionId = "not-this-session";
  },
};
it.each(Object.keys(changes))(
  "rejects %s registration corruption on actual cold physical restoration",
  async (name) => {
    const f = await registeredFixture();
    try {
      const record = currentRuntime().controlJournal!.finalValidationRegistrations![0]!;
      const entries = structuredClone(f.entries());
      const entry = entries.find((entry) => entry.id === record.entryId)!;
      const data = structuredClone(record.data);
      changes[name]!(data);
      entry.data = data;
      const header = JSON.parse(readFileSync(f.path, "utf8").split("\n")[0]!);
      writeFileSync(
        f.path,
        [header, ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n",
      );
      f.sendMessage.mockClear();
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault, name).toBeDefined();
      expect(currentRuntime().supervisor?.status).not.toBe("completed");
      expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    } finally {
      f.close();
    }
  },
);
const supplementChanges: Record<string, (data: FinalValidationFact) => void> = {
  "missing-registration": (data) => {
    data.validationOnly!.registrationRef.entryId = "not-a-real-registration";
  },
  "registration-digest": (data) => {
    data.validationOnly!.registrationRef.digest = "0".repeat(64);
  },
  "supplement-board": (data) => {
    data.validationOnly!.boardDigest = "0".repeat(64);
  },
  "supplement-bindings": (data) => {
    data.validationOnly!.bindingsDigest = "0".repeat(64);
  },
  "supplement-input": (data) => {
    data.inputDigest = "0".repeat(64);
  },
  "supplement-captured-input": (data) => {
    data.capturedInputDigest = "0".repeat(64);
  },
  "supplement-tool": (data) => {
    data.toolName = "not-the-registered-tool";
  },
  "supplement-version": (data) => {
    data.artifactVersion.versionId = "0".repeat(64);
  },
  "supplement-epoch": (data) => {
    data.epoch++;
  },
  "supplement-task": (data) => {
    data.taskDigest = "0".repeat(64);
  },
  "supplement-receipt": (data) => {
    data.receiptId = "tool:not-the-new-actual-check";
  },
  "supplement-order": (data) => {
    data.source.intentRef = { ...data.source.receiptRef };
  },
};
it.each(Object.keys(supplementChanges))(
  "rejects %s in a new validation supplement without rewriting original evidence",
  async (name) => {
    const f = await registeredFixture();
    try {
      await f.validate("fresh-overlay");
      const record = currentRuntime().controlJournal!.finalValidations!.at(-1)!;
      expect(record.data.validationOnly).toBeDefined();
      const entries = structuredClone(f.entries()),
        entry = entries.find((entry) => entry.id === record.entryId)!;
      const data = structuredClone(record.data);
      supplementChanges[name]!(data);
      entry.data = data;
      const header = JSON.parse(readFileSync(f.path, "utf8").split("\n")[0]!);
      writeFileSync(
        f.path,
        [header, ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n",
      );
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault, name).toBeDefined();
      expect(currentRuntime().supervisor?.status).not.toBe("completed");
    } finally {
      f.close();
    }
  },
);
it.each(["final-validation-registered", "final-validation"] as const)(
  "does not publish or replay an uncertain %s append",
  async (target) => {
    for (const failure of ["before", "memory", "after"] as const) {
      const f =
        target === "final-validation-registered"
          ? await completedReviewFixture()
          : await registeredFixture();
      try {
        if (target === "final-validation-registered")
          writeFileSync(join(f.dir, "review-input.txt"), "Requires registration\n");
        f.fail((type, data) =>
          type === "continuous-tasks:control-facts" && (data as { kind?: string }).kind === target
            ? failure
            : undefined,
        );
        if (target === "final-validation-registered") await f.command("retry-review");
        else await f.validate("uncertain-new-validation");
        expect(currentRuntime().journalFault, `${target}/${failure}`).toBeDefined();
        expect(currentRuntime().supervisor?.status).not.toBe("completed");
        f.fail(undefined);
        f.reload();
        await f.fire("session_tree");
        expect(currentRuntime().journalFault).toBeUndefined();
        const committed = failure === "after";
        if (target === "final-validation-registered")
          expect(currentRuntime().controlJournal?.finalValidationRegistrations ?? []).toHaveLength(
            committed ? 1 : 0,
          );
        else
          expect(
            currentRuntime().controlJournal?.finalValidations?.some(
              (record) => record.data.receiptId === "tool:uncertain-new-validation",
            ),
          ).toBe(committed);
        expect(currentRuntime().supervisor?.status).not.toBe("completed");
      } finally {
        f.close();
      }
    }
  },
);
it("does not duplicate a still-unused registration or accept a duplicate durable registration record", async () => {
  const f = await registeredFixture();
  try {
    const count = f.entries().length;
    await f.command("retry-review");
    expect(f.entries()).toHaveLength(count);
    const record = currentRuntime().controlJournal!.finalValidationRegistrations![0]!;
    f.api.appendEntry("continuous-tasks:control-facts", structuredClone(record.data));
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeDefined();
  } finally {
    f.close();
  }
});
it("restores human review pause and lifts only that pause through native resume, with no business or budget reset", async () => {
  const f = await registeredFixture(),
    board = structuredClone(getBoardRef());
  const reviews = currentRuntime().supervisor!.reviews,
    continuations = currentRuntime().supervisor!.continuations;
  try {
    await f.command("pause");
    expect(currentRuntime().supervisor?.status).toBe("paused");
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().supervisor?.status).toBe("paused");
    await f.command("retry-review");
    expect(currentRuntime().supervisor?.status).toBe("paused");
    await f.command("resume");
    expect(currentRuntime().supervisor).toMatchObject({ status: "fault", reviews, continuations });
    expect(getBoardRef()).toEqual(board);
    expect(currentRuntime().controlJournal?.advisorFacts ?? []).toHaveLength(0);
    await f.validate("after-review-resume");
    expect(currentRuntime().controlJournal?.finalValidations?.at(-1)?.data).toMatchObject({
      receiptId: "tool:after-review-resume",
      validationOnly: expect.any(Object),
    });
    expect(currentRuntime().supervisor?.status).toBe("fault");
  } finally {
    f.close();
  }
});
it.each(["stop", "pause", "revoke", "cwd", "version", "board", "pending"])(
  "does not admit a registered check after %s changes",
  async (scenario) => {
    const f = await registeredFixture();
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "new-registered-check",
      input: { command: "synthetic repair validation" },
    };
    try {
      if (scenario === "stop" || scenario === "pause") await f.command(scenario);
      if (scenario === "revoke") await f.command(`revoke ${currentRuntime().preflight!.planId}`);
      if (scenario === "cwd") Object.assign(f.ctx, { cwd: join(f.dir, "not-the-registered-cwd") });
      if (scenario === "version")
        writeFileSync(join(f.dir, "review-input.txt"), "Changed after registration\n");
      if (scenario === "board") getBoardRef().tasks[0]!.title = "Changed after registration";
      if (scenario === "pending") {
        expect(await f.fire("tool_call", event)).toBeUndefined();
        await f.command("retry-review");
      }
      const before = JSON.stringify({
        board: getBoardRef(),
        validations: currentRuntime().controlJournal?.finalValidations,
        ledger: currentRuntime().receiptStore?.checkpoint,
      });
      const gate = await f.fire("tool_call", { ...event, toolCallId: "must-not-run" });
      if (scenario === "stop") {
        // Off mode permits ordinary unmanaged work, never a registered final check.
        expect(gate).toBeUndefined();
        await f.fire("tool_result", {
          ...event,
          type: "tool_result",
          toolCallId: "must-not-run",
          content: [{ type: "text", text: "Unmanaged synthetic result" }],
          details: { exitCode: 0 },
          isError: false,
        });
        expect(
          JSON.stringify({
            board: getBoardRef(),
            validations: currentRuntime().controlJournal?.finalValidations,
            ledger: currentRuntime().receiptStore?.checkpoint,
          }),
        ).toBe(before);
        expect(currentRuntime().management?.mode).toBe("off");
      } else expect(gate).toMatchObject({ block: true });
      expect(currentRuntime().supervisor?.status).not.toBe("completed");
    } finally {
      f.close();
    }
  },
);
