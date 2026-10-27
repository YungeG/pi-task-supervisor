import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  executionRegistryFixture,
  completedReviewFixture as completedFixture,
} from "./helpers/execution-registry";
import { BOUNDARY, deferred } from "./helpers/lifecycle";
import { createAdvanceTasksTool } from "../tools";
import { currentRuntime } from "../runtime";
import { getBoard, getBoardRef } from "../state";
import { advisorUsageFor } from "../advisor-calls";
import { saveSupervisor } from "../supervisor";

it("does not create a concurrent review attempt when native retry-review is requested during a live attempt", async () => {
  const f = await completedFixture(),
    requested = deferred<boolean>(),
    reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
  let boundary: Promise<unknown> | undefined,
    calls = 0;
  const accept = () =>
    fauxAssistantMessage(
      JSON.stringify({
        action: "accept",
        message: "Existing completed work reviewed",
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
            return calls === 1 ? reply.promise : accept();
          },
        }),
      },
    });
    boundary = f.fire("agent_before_settle", BOUNDARY);
    await requested.promise;
    await f.command("retry-review");
    expect(calls).toBe(1);
    expect(currentRuntime().supervisor?.status).toBe("reviewing");
    reply.resolve(accept());
    await boundary;
    expect(currentRuntime().supervisor?.status).toBe("completed");
  } finally {
    reply.resolve(accept());
    await boundary;
    f.close();
  }
});
it("keeps ordinary writes outside the running final-review context and does not create a mutation intent", async () => {
  const f = await completedFixture(),
    requested = deferred<boolean>(),
    reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
  let boundary: Promise<unknown> | undefined;
  const accept = () =>
    fauxAssistantMessage(
      JSON.stringify({
        action: "accept",
        message: "Read-only final review",
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
            requested.resolve(true);
            return reply.promise;
          },
        }),
      },
    });
    boundary = f.fire("agent_before_settle", BOUNDARY);
    await requested.promise;
    const epoch = currentRuntime().supervisor!.epoch;
    const denied = await f.fire("tool_call", {
      type: "tool_call",
      toolName: "write",
      toolCallId: "write-during-review",
      input: { path: "review-input.txt", content: "must not run" },
    });
    expect(denied).toMatchObject({ block: true });
    expect(currentRuntime().receiptStore?.pendingCount).toBe(0);
    expect(currentRuntime().supervisor!.epoch).toBe(epoch);
    reply.resolve(accept());
    await boundary;
  } finally {
    reply.resolve(accept());
    await boundary;
    f.close();
  }
});
it("does not treat a foreign journal movement followed by 503 as a transport-only retry", async () => {
  const f = await completedFixture();
  let calls = 0;
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () => {
            calls++;
            if (calls === 1) {
              f.api.appendEntry("synthetic-unrelated-observation", { value: "external movement" });
              throw Object.assign(new Error("Structured outage after changed context"), {
                status: 503,
              });
            }
            return fauxAssistantMessage(
              JSON.stringify({
                action: "accept",
                message: "Must not be reached by transport retry",
                taskIds: ["t-1.1"],
                evidenceRefs: ["tool:repair-proof"],
              }),
            );
          },
        }),
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(calls).toBe(1);
    expect(currentRuntime().supervisor?.status).not.toBe("completed");
    expect(currentRuntime().finalReview).toMatchObject({
      status: "blocked",
      failureClass: "control_held",
    });
  } finally {
    f.close();
  }
});
it.each(["message503", "string-status503", "authentication"])(
  "does not automatically retry %s as a numeric transient service failure",
  async (kind) => {
    const f = await completedFixture();
    let calls = 0;
    try {
      const error = new Error("Synthetic text says 503");
      if (kind === "string-status503") Object.assign(error, { status: "503" });
      if (kind === "authentication") Object.assign(error, { status: 401 });
      Object.assign(f.ctx, {
        modelRegistry: {
          find: () => f.ctx.model,
          streamSimple: () => ({
            result: async () => {
              calls++;
              throw error;
            },
          }),
        },
      });
      await f.fire("agent_before_settle", BOUNDARY);
      expect(calls).toBe(1);
      expect(currentRuntime().finalReview).toMatchObject({
        status: kind === "authentication" ? "blocked" : "retryable_error",
        failureClass: kind === "authentication" ? "authentication" : "unknown_model_failure",
      });
    } finally {
      f.close();
    }
  },
);
it("bounds one whole final attempt and records a retryable deadline even when the provider ignores cancellation", async () => {
  const f = await completedFixture(),
    requested = deferred<boolean>(),
    reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
  let boundary: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, ms);
      return controller.signal;
    });
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () => {
            requested.resolve(true);
            return reply.promise;
          },
        }),
      },
    });
    boundary = f.fire("agent_before_settle", BOUNDARY);
    await requested.promise;
    await vi.advanceTimersByTimeAsync(30001);
    await boundary;
    expect(currentRuntime().supervisor?.status).toBe("fault");
    expect(currentRuntime().finalReview).toMatchObject({
      status: "retryable_error",
      failureClass: "deadline",
    });
    reply.resolve(
      fauxAssistantMessage(
        JSON.stringify({
          action: "accept",
          message: "Late advice is not adoption",
          taskIds: ["t-1.1"],
          evidenceRefs: ["tool:repair-proof"],
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(currentRuntime().supervisor?.status).not.toBe("completed");
    expect(f.owner.kind).toBe("goal");
    if (f.owner.kind === "goal")
      expect(advisorUsageFor(f.owner.goal)).toMatchObject({
        providerCalls: 1,
        pendingCalls: 0,
        unknownUsageCalls: 0,
      });
    timeout.mockRestore();
  } finally {
    reply.resolve(fauxAssistantMessage("late"));
    await boundary;
    vi.restoreAllMocks();
    vi.useRealTimers();
    f.close();
  }
});
it("answers a registered evidence request in the same bounded attempt without invoking business tools", async () => {
  const f = await completedFixture();
  let calls = 0;
  const packets: string[] = [];
  const board = structuredClone(getBoardRef()),
    bindings = structuredClone(currentRuntime().supervisor!.bindings),
    continuations = currentRuntime().supervisor!.continuations;
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: (_model: unknown, context: { messages: Array<{ content: string }> }) => ({
          result: async () => {
            packets.push(context.messages[0]!.content);
            calls++;
            return fauxAssistantMessage(
              JSON.stringify(
                calls === 1
                  ? {
                      action: "request_evidence",
                      message: "Need actual retained validation output",
                      taskIds: ["t-1.1"],
                      evidenceRefs: ["tool:repair-proof"],
                      detailIds: ["tool:repair-proof"],
                    }
                  : {
                      action: "accept",
                      message: "Retained detail reviewed",
                      taskIds: ["t-1.1"],
                      evidenceRefs: ["tool:repair-proof"],
                    },
              ),
            );
          },
        }),
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(calls).toBe(2);
    expect(packets.every((packet) => Buffer.byteLength(packet) <= 64000)).toBe(true);
    expect(JSON.parse(packets[1]!).reviewDelivery.details[0]).toMatchObject({
      sourceId: "tool:repair-proof",
      field: "output",
      sourceCompleteness: "retained-capture-unknown",
    });
    expect(currentRuntime().supervisor).toMatchObject({ status: "completed", continuations });
    expect(getBoardRef()).toEqual(board);
    expect(currentRuntime().supervisor!.bindings).toEqual(bindings);
    expect(currentRuntime().controlJournal?.reviewAttempts?.at(-1)?.result?.data).toMatchObject({
      detailRounds: 1,
      corrections: 0,
      transportRetries: 0,
    });
  } finally {
    f.close();
  }
});
it("allows only one bounded action correction rather than reopening completed work", async () => {
  const f = await completedFixture();
  let calls = 0;
  const packets: string[] = [];
  const continuations = currentRuntime().supervisor!.continuations,
    board = structuredClone(getBoardRef());
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: (_model: unknown, context: { messages: Array<{ content: string }> }) => ({
          result: async () => {
            packets.push(context.messages[0]!.content);
            calls++;
            return fauxAssistantMessage(
              JSON.stringify({
                action: calls === 1 ? "guide" : "accept",
                message: calls === 1 ? "Redo the completed business" : "Correct final action",
                taskIds: ["t-1.1"],
                evidenceRefs: ["tool:repair-proof"],
              }),
            );
          },
        }),
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(calls).toBe(2);
    expect(JSON.parse(packets[1]!).reviewDelivery.correction.allowedActions).toEqual([
      "accept",
      "hold",
      "request_evidence",
    ]);
    expect(currentRuntime().supervisor).toMatchObject({ status: "completed", continuations });
    expect(getBoardRef()).toEqual(board);
    expect(currentRuntime().controlJournal?.reviewAttempts?.at(-1)?.result?.data).toMatchObject({
      detailRounds: 0,
      corrections: 1,
    });
  } finally {
    f.close();
  }
});
it.each(["unknown-detail", "repeat-details", "repeat-guide", "mixed-cap"])(
  "keeps %s within material/action/call bounds and never accepts by default",
  async (kind) => {
    const f = await completedFixture();
    let calls = 0;
    try {
      Object.assign(f.ctx, {
        modelRegistry: {
          find: () => f.ctx.model,
          streamSimple: () => ({
            result: async () => {
              calls++;
              if (kind === "mixed-cap" && calls === 1)
                throw Object.assign(new Error("Structured transient"), { status: 503 });
              const guide = kind === "repeat-guide" || (kind === "mixed-cap" && calls === 4);
              return fauxAssistantMessage(
                JSON.stringify({
                  action: guide ? "guide" : "request_evidence",
                  message: "Still need material or wrong final action",
                  taskIds: ["t-1.1"],
                  evidenceRefs: ["tool:repair-proof"],
                  ...(guide
                    ? {}
                    : {
                        detailIds: [
                          kind === "unknown-detail"
                            ? "/not/a/registered/file"
                            : "tool:repair-proof",
                        ],
                      }),
                }),
              );
            },
          }),
        },
      });
      await f.fire("agent_before_settle", BOUNDARY);
      const expectedCalls = {
        "unknown-detail": 1,
        "repeat-details": 3,
        "repeat-guide": 2,
        "mixed-cap": 4,
      }[kind]!;
      expect(calls).toBe(expectedCalls);
      expect(currentRuntime().supervisor?.status).not.toBe("completed");
      const result = currentRuntime().controlJournal?.reviewAttempts?.at(-1)?.result?.data;
      expect(result?.callIds).toHaveLength(expectedCalls);
      if (kind === "mixed-cap")
        expect(result).toMatchObject({
          outcome: "retryable_error",
          failureClass: "budget",
          corrections: 0,
          detailRounds: 2,
          transportRetries: 1,
        });
      else
        expect(result).toMatchObject({
          outcome: "blocked",
          failureClass: kind === "repeat-guide" ? "advice_mismatch" : "evidence_missing",
        });
    } finally {
      f.close();
    }
  },
);
it("restores a failed final attempt as held metadata without network, appends, or business replay", async () => {
  const f = await completedFixture();
  let calls = 0;
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () => {
            calls++;
            throw Object.assign(new Error("Structured outage"), { status: 503 });
          },
        }),
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    const original = structuredClone(currentRuntime().finalReview),
      board = structuredClone(getBoardRef()),
      records = f.entries().length;
    f.sendMessage.mockClear();
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentRuntime().finalReview).toEqual(original);
    expect(getBoardRef()).toEqual(board);
    expect(f.entries()).toHaveLength(records);
    expect(calls).toBe(2);
    expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
  } finally {
    f.close();
  }
});
it.each(["input", "stop"])(
  "keeps %s cancellation authoritative over a late accepting response",
  async (kind) => {
    const f = await completedFixture(),
      requested = deferred<boolean>(),
      reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
    let boundary: Promise<unknown> | undefined,
      calls = 0;
    const accept = () =>
      fauxAssistantMessage(
        JSON.stringify({
          action: "accept",
          message: "Late stale acceptance",
          taskIds: ["t-1.1"],
          evidenceRefs: ["tool:repair-proof"],
        }),
      );
    const board = structuredClone(getBoardRef());
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
      if (kind === "input")
        await f.fire("input", {
          type: "input",
          text: "Inspect only; do not replay work",
          source: "interactive",
        });
      else await f.command("stop");
      await boundary;
      expect(currentRuntime().supervisor?.status).toBe(kind === "input" ? "fault" : "stopped");
      expect(currentRuntime().finalReview).toMatchObject({
        status: "retryable_error",
        failureClass: "interrupted",
      });
      reply.resolve(accept());
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(currentRuntime().supervisor?.status).toBe(kind === "input" ? "fault" : "stopped");
      expect(getBoardRef()).toEqual(board);
      expect(calls).toBe(1);
      if (kind === "stop") {
        await f.command("retry-review");
        expect(calls).toBe(1);
        expect(currentRuntime().supervisor?.status).toBe("stopped");
      }
    } finally {
      reply.resolve(accept());
      await boundary;
      f.close();
    }
  },
);
it("requires new validation when actual workspace inputs change during final review and never adopts the old view", async () => {
  const f = await completedFixture();
  let calls = 0;
  const board = structuredClone(getBoardRef());
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () => {
            calls++;
            writeFileSync(
              join(f.dir, "review-input.txt"),
              "Changed while awaiting the actual provider response\n",
            );
            return fauxAssistantMessage(
              JSON.stringify({
                action: "accept",
                message: "Must not accept changed inputs",
                taskIds: ["t-1.1"],
                evidenceRefs: ["tool:repair-proof"],
              }),
            );
          },
        }),
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(currentRuntime().finalReview).toMatchObject({
      status: "needs_validation",
      failureClass: "validation_stale",
    });
    expect(getBoardRef()).toEqual(board);
    await f.command("retry-review");
    expect(calls).toBe(1);
    expect(currentRuntime().supervisor?.status).toBe("fault");
  } finally {
    f.close();
  }
});
it("registers only the existing final check and accepts new validation without replaying completed tasks or rewriting bindings", async () => {
  const f = await completedFixture();
  let calls = 0;
  const board = structuredClone(getBoardRef()),
    bindings = structuredClone(currentRuntime().supervisor!.bindings);
  const originalReceipt = currentRuntime().receiptStore!.readReceipts(["tool:repair-proof"])[0]!,
    epoch = currentRuntime().supervisor!.epoch;
  try {
    writeFileSync(join(f.dir, "review-input.txt"), "Requires new applicable validation\n");
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () => {
            calls++;
            return fauxAssistantMessage(
              JSON.stringify({
                action: "accept",
                message: "New check covers this version",
                taskIds: ["t-1.1"],
                evidenceRefs: ["tool:new-final-validation"],
              }),
            );
          },
        }),
      },
    });
    await f.command("retry-review");
    expect(calls).toBe(0);
    expect(currentRuntime().controlJournal).toHaveProperty(
      "finalValidationRegistrations",
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            kind: "final-validation-registered",
            originalReceiptId: "tool:repair-proof",
          }),
        }),
      ]),
    );
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolCallId: "not-the-check",
        toolName: "bash",
        input: { command: "a different command" },
      }),
    ).toMatchObject({ block: true });
    const event = {
      toolName: "bash",
      toolCallId: "new-final-validation",
      input: { command: "synthetic repair validation" },
    };
    expect(await f.fire("tool_call", { type: "tool_call", ...event })).toBeUndefined();
    await f.fire("tool_result", {
      type: "tool_result",
      ...event,
      content: [{ type: "text", text: "New actual fixed validation" }],
      structuredContent: { exit_code: 0 },
      isError: false,
    });
    expect(currentRuntime().supervisor?.epoch).toBeGreaterThan(epoch);
    await f.command("retry-review");
    expect(calls).toBe(1);
    expect(currentRuntime().supervisor?.status).toBe("completed");
    expect(getBoardRef()).toEqual(board);
    expect(currentRuntime().supervisor!.bindings).toEqual(bindings);
    expect(currentRuntime().receiptStore!.readReceipts(["tool:repair-proof"])[0]).toEqual(
      originalReceipt,
    );
  } finally {
    f.close();
  }
});
it.each([false, "legacy"] as const)(
  "requires actual new validation for a %s completed layout with no historical version, without generic recovery",
  async (boardOnly) => {
    const f = await completedFixture(boardOnly, "uninitialized");
    let calls = 0;
    const board = structuredClone(getBoardRef()),
      bindings = structuredClone(currentRuntime().supervisor!.bindings);
    try {
      expect(currentRuntime().controlJournal?.finalValidations ?? []).toHaveLength(0);
      execFileSync("git", ["init", "--quiet", f.dir], { timeout: 2000, stdio: "ignore" });
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().finalReview?.status).toBe("needs_validation");
      Object.assign(f.ctx, {
        modelRegistry: {
          find: () => f.ctx.model,
          streamSimple: () => ({
            result: async () => {
              calls++;
              return fauxAssistantMessage(
                JSON.stringify({
                  action: "accept",
                  message: "Actual new check, not an invented old version",
                  taskIds: ["t-1.1"],
                  evidenceRefs: ["tool:historical-new-check"],
                }),
              );
            },
          }),
        },
      });
      await f.command("retry-review");
      expect(calls).toBe(0);
      await f.command("recover");
      expect(currentRuntime().supervisor?.status).toBe("fault");
      await f.validate("historical-new-check");
      await f.command("retry-review");
      expect(calls).toBe(1);
      expect(currentRuntime().supervisor?.status).toBe("completed");
      expect(getBoardRef()).toEqual(board);
      expect(currentRuntime().supervisor!.bindings).toEqual(bindings);
      expect(currentRuntime().controlJournal?.finalValidations).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);
it.each(["review-attempt-started", "review-attempt-observed"] as const)(
  "preserves uncertain %s appends and repairs only already-confirmed acceptance",
  async (target) => {
    for (const failure of ["before", "memory", "after"] as const) {
      const f = await completedFixture();
      let calls = 0;
      const board = structuredClone(getBoardRef()),
        bindings = structuredClone(currentRuntime().supervisor!.bindings);
      try {
        Object.assign(f.ctx, {
          modelRegistry: {
            find: () => f.ctx.model,
            streamSimple: () => ({
              result: async () => {
                calls++;
                return fauxAssistantMessage(
                  JSON.stringify({
                    action: "accept",
                    message: "Actual accepting response",
                    taskIds: ["t-1.1"],
                    evidenceRefs: ["tool:repair-proof"],
                  }),
                );
              },
            }),
          },
        });
        f.fail((type, data) =>
          type === "continuous-tasks:control-facts" && (data as { kind?: string }).kind === target
            ? failure
            : undefined,
        );
        await f.fire("agent_before_settle", BOUNDARY);
        expect(currentRuntime().journalFault, `${target}/${failure}`).toBeDefined();
        expect(currentRuntime().supervisor?.status).not.toBe("completed");
        const initialCalls = calls;
        f.fail(undefined);
        f.reload();
        await f.fire("session_tree");
        expect(currentRuntime().journalFault).toBeUndefined();
        expect(calls).toBe(initialCalls);
        await f.command("retry-review");
        const confirmedAcceptance = target === "review-attempt-observed" && failure === "after";
        expect(calls, `${target}/${failure}`).toBe(initialCalls + (confirmedAcceptance ? 0 : 1));
        expect(currentRuntime().supervisor?.status).toBe("completed");
        expect(getBoardRef()).toEqual(board);
        expect(currentRuntime().supervisor!.bindings).toEqual(bindings);
      } finally {
        f.close();
      }
    }
  },
);
it.each(["accept", "detail", "no-slot"])(
  "retains shared Goal budget at the %s boundary without slot renewal",
  async (scenario) => {
    const f = await completedFixture();
    let calls = 0;
    try {
      const state = currentRuntime().supervisor!;
      state.reviews = scenario === "no-slot" ? 40 : 39;
      saveSupervisor(f.api);
      Object.assign(f.ctx, {
        modelRegistry: {
          find: () => f.ctx.model,
          streamSimple: () => ({
            result: async () => {
              calls++;
              return fauxAssistantMessage(
                JSON.stringify({
                  action: scenario === "detail" ? "request_evidence" : "accept",
                  message: "Bounded last review slot",
                  taskIds: ["t-1.1"],
                  evidenceRefs: ["tool:repair-proof"],
                  ...(scenario === "detail" ? { detailIds: ["tool:repair-proof"] } : {}),
                }),
              );
            },
          }),
        },
      });
      await f.fire("agent_before_settle", BOUNDARY);
      expect(calls).toBe(scenario === "no-slot" ? 0 : 1);
      expect(currentRuntime().supervisor!.reviews).toBe(40);
      if (scenario === "accept") expect(currentRuntime().supervisor?.status).toBe("completed");
      else {
        expect(currentRuntime().supervisor?.status).toBe("paused");
        expect(currentRuntime().finalReview).toMatchObject({
          status: "retryable_error",
          failureClass: "budget",
        });
        f.reload();
        await f.fire("session_tree");
        expect(currentRuntime().finalReview).toMatchObject({
          status: "retryable_error",
          failureClass: "budget",
        });
        await f.command("recover");
        expect(currentRuntime().supervisor!.reviews).toBe(40);
        expect(currentRuntime().supervisor?.status).not.toBe("active");
      }
    } finally {
      f.close();
    }
  },
);
it("shares one deadline across transport retry and detail calls instead of renewing thirty seconds per call", async () => {
  const f = await completedFixture();
  let calls = 0,
    clock = Date.now();
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () => {
            calls++;
            clock += 12000;
            if (calls === 1)
              throw Object.assign(
                new Error("Structured transient consumes part of the same deadline"),
                { status: 503 },
              );
            return fauxAssistantMessage(
              JSON.stringify(
                calls === 2
                  ? {
                      action: "request_evidence",
                      message: "Need retained detail",
                      taskIds: ["t-1.1"],
                      evidenceRefs: ["tool:repair-proof"],
                      detailIds: ["tool:repair-proof"],
                    }
                  : {
                      action: "accept",
                      message: "Too late for this attempt",
                      taskIds: ["t-1.1"],
                      evidenceRefs: ["tool:repair-proof"],
                    },
              ),
            );
          },
        }),
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(calls).toBe(3);
    expect(currentRuntime().finalReview).toMatchObject({
      status: "retryable_error",
      failureClass: "deadline",
    });
    expect(currentRuntime().supervisor?.status).not.toBe("completed");
    expect(currentRuntime().controlJournal?.reviewAttempts?.at(-1)?.result?.data).toMatchObject({
      detailRounds: 1,
      transportRetries: 1,
    });
  } finally {
    now.mockRestore();
    f.close();
  }
});
it("accepts a fourth and final call after one transport retry, one registered detail and one action correction", async () => {
  const f = await completedFixture();
  let calls = 0;
  const continuations = currentRuntime().supervisor!.continuations;
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () => {
            calls++;
            if (calls === 1)
              throw Object.assign(new Error("Structured transient"), { statusCode: 503 });
            const action = calls === 2 ? "request_evidence" : calls === 3 ? "guide" : "accept";
            return fauxAssistantMessage(
              JSON.stringify({
                action,
                message: "Bounded mixed review",
                taskIds: ["t-1.1"],
                evidenceRefs: ["tool:repair-proof"],
                ...(action === "request_evidence" ? { detailIds: ["tool:repair-proof"] } : {}),
              }),
            );
          },
        }),
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(calls).toBe(4);
    expect(currentRuntime().supervisor).toMatchObject({
      status: "completed",
      reviews: 1,
      continuations,
    });
    const starts =
      currentRuntime().controlJournal?.advisorFacts?.flatMap((record) =>
        record.data.kind === "advisor-call-started" ? [record.data] : [],
      ) ?? [];
    expect(starts.map((start) => start.budgetSlot)).toEqual([1, 2, 3, 4]);
    expect(new Set(starts.map((start) => start.attemptId)).size).toBe(1);
    expect(currentRuntime().controlJournal?.reviewAttempts?.at(-1)?.result?.data).toMatchObject({
      outcome: "accepted",
      detailRounds: 1,
      corrections: 1,
      transportRetries: 1,
    });
  } finally {
    f.close();
  }
});
it.each(["busy", "pending", "attempt-id"])(
  "refuses %s native review control before any call or budget reservation",
  async (scenario) => {
    const f = await completedFixture();
    let calls = 0;
    const idle = f.ctx.isIdle,
      pending = f.ctx.hasPendingMessages;
    try {
      Object.assign(f.ctx, {
        modelRegistry: {
          find: () => f.ctx.model,
          streamSimple: () => ({
            result: async () => {
              calls++;
              return fauxAssistantMessage("must not be called");
            },
          }),
        },
      });
      if (scenario === "busy") Object.assign(f.ctx, { isIdle: () => false });
      if (scenario === "pending") Object.assign(f.ctx, { hasPendingMessages: () => true });
      const reviews = currentRuntime().supervisor!.reviews,
        records = f.entries().length;
      await f.command(`retry-review${scenario === "attempt-id" ? " wrong-attempt" : ""}`);
      expect(calls).toBe(0);
      expect(currentRuntime().supervisor!.reviews).toBe(reviews);
      expect(f.entries()).toHaveLength(records);
    } finally {
      Object.assign(f.ctx, { isIdle: idle, hasPendingMessages: pending });
      f.close();
    }
  },
);
it("restores an actually pending read-only attempt without replay and suppresses its late response after explicit retry", async () => {
  const f = await completedFixture(),
    requested = deferred<boolean>(),
    reply = deferred<ReturnType<typeof fauxAssistantMessage>>();
  let calls = 0,
    boundary: Promise<unknown> | undefined;
  const accept = () =>
    fauxAssistantMessage(
      JSON.stringify({
        action: "accept",
        message: "Only the current review may publish",
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
            return calls === 1 ? reply.promise : accept();
          },
        }),
      },
    });
    boundary = f.fire("agent_before_settle", BOUNDARY);
    await requested.promise;
    f.reload();
    await f.fire("session_tree");
    await boundary;
    expect(calls).toBe(1);
    expect(currentRuntime().finalReview).toMatchObject({
      status: "retryable_error",
      failureClass: "interrupted",
    });
    expect(currentRuntime().supervisor?.status).toBe("fault");
    await f.command("retry-review");
    expect(calls).toBe(2);
    expect(currentRuntime().supervisor?.status).toBe("completed");
    const acceptedAttempt = currentRuntime().finalReview?.attemptId;
    reply.resolve(accept());
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(currentRuntime().supervisor?.status).toBe("completed");
    expect(currentRuntime().finalReview?.attemptId).toBe(acceptedAttempt);
    if (f.owner.kind === "goal")
      expect(advisorUsageFor(f.owner.goal)).toMatchObject({ providerCalls: 2, pendingCalls: 0 });
  } finally {
    reply.resolve(accept());
    await boundary;
    f.close();
  }
});
it("records a review with zero provider calls when the configured model is unavailable and retries only after explicit control", async () => {
  const f = await completedFixture();
  let calls = 0;
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => undefined,
        streamSimple: () => {
          calls++;
          throw new Error("Must not reach an unavailable model");
        },
      },
    });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(calls).toBe(0);
    expect(currentRuntime().controlJournal?.reviewAttempts?.at(-1)?.result?.data.callIds).toEqual(
      [],
    );
    expect(currentRuntime().finalReview).toMatchObject({
      status: "retryable_error",
      failureClass: "unknown_model_failure",
    });
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () => {
            calls++;
            return fauxAssistantMessage(
              JSON.stringify({
                action: "accept",
                message: "Only a newly available actual model is called",
                taskIds: ["t-1.1"],
                evidenceRefs: ["tool:repair-proof"],
              }),
            );
          },
        }),
      },
    });
    await f.command("retry-review");
    expect(calls).toBe(1);
    expect(currentRuntime().supervisor).toMatchObject({ status: "completed", reviews: 2 });
  } finally {
    f.close();
  }
});
it("retries only final review after structured503 without reopening work, changing owner or renewing budget", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    expect((await f.review()).isError).not.toBe(true);
    await f.validate();
    const done = await createAdvanceTasksTool(f.api).execute(
      "final-work-done",
      {
        transitions: [
          {
            id: "t-1.1",
            evidence: {
              summary: "Actual fixed fixture validation",
              refs: [
                {
                  kind: "command",
                  label: "Fixed validation",
                  status: "passed",
                  ref: "tool:repair-proof",
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
    expect(done.isError, JSON.stringify(done)).not.toBe(true);
    const completed = getBoard(),
      owner = structuredClone(f.owner),
      bindings = structuredClone(currentRuntime().supervisor!.bindings),
      plan = currentRuntime().preflight!.planId;
    let calls = 0;
    const streamSimple = vi.fn(() => ({
      result: async () => {
        calls++;
        if (calls <= 2)
          throw Object.assign(new Error("Synthetic structured service outage"), { status: 503 });
        return fauxAssistantMessage(
          JSON.stringify({
            action: "accept",
            message: "Same completed work reviewed",
            taskIds: ["t-1.1"],
            evidenceRefs: ["tool:repair-proof"],
          }),
        );
      },
    }));
    Object.assign(f.ctx, { modelRegistry: { find: () => f.ctx.model, streamSimple } });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(calls).toBe(2);
    expect(currentRuntime().supervisor?.status).toBe("fault");
    expect(getBoard()).toEqual(completed);
    expect(currentRuntime().supervisor!.bindings).toEqual(bindings);
    await f.command("retry-review");
    expect(calls).toBe(3);
    expect(currentRuntime().supervisor).toMatchObject({
      status: "completed",
      reviews: 2,
      continuations: 0,
      epoch: 1,
    });
    expect(getBoard()).toEqual(completed);
    expect(currentRuntime().supervisor!.bindings).toEqual(bindings);
    expect(f.owner).toEqual(owner);
    expect(currentRuntime().preflight!.planId).toBe(plan);
    if (owner.kind !== "goal") throw Error("Expected real fixture Goal");
    expect(advisorUsageFor(owner.goal)).toMatchObject({
      providerCalls: 3,
      pendingCalls: 0,
      unknownUsageCalls: 2,
    });
  } finally {
    f.close();
  }
});
