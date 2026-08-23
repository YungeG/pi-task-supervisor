import { describe, it, expect, beforeEach } from "vitest";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import {
  createWriteTasksTool,
  createEditTasksTool,
  createCompileTasksTool,
  createGetReadyTasksTool,
  createAdvanceTasksTool,
} from "../tools";
import { resetState } from "../state";
import * as configModule from "../config";
import type { TaskBoardSnapshot } from "../types";

// ── Helpers ──

/** Call a tool's execute function with minimal boilerplate. */
async function callExecute(tool: any, params: any, ctx: any): Promise<any> {
  return await tool.execute("test-call-id", params, undefined, undefined, ctx);
}

function advance(...ids: string[]) {
  return { transitions: ids.map((id) => ({ id })) };
}

function complete(...ids: string[]) {
  return {
    transitions: ids.map((id) => ({
      id,
      evidence: {
        summary: "Reviewed and validated",
        refs: [
          {
            kind: "review" as const,
            label: "integration review",
            status: "passed" as const,
            ref: "test://integration-review",
          },
        ],
      },
    })),
  };
}

/** Extract the snapshot from a tool result. */
function snapshot(result: any): TaskBoardSnapshot {
  return result.details.snapshot as TaskBoardSnapshot;
}

/** Find a task by id on the board. */
function findTask(board: TaskBoardSnapshot, id: string) {
  return board.tasks.find((t) => t.id === id)!;
}

/** Get a phase record by phase number. */
function findPhase(board: TaskBoardSnapshot, phase: number) {
  return board.phases.find((p) => p.phase === phase)!;
}

// ═══════════════════════════════════════════
// Full Lifecycle Integration Test
// ═══════════════════════════════════════════

describe("full lifecycle integration", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let ctx: ReturnType<typeof createMockContext>;
  let writeTool: ReturnType<typeof createWriteTasksTool>;
  let editTool: ReturnType<typeof createEditTasksTool>;
  let compileTool: ReturnType<typeof createCompileTasksTool>;
  let getReadyTool: ReturnType<typeof createGetReadyTasksTool>;
  let advanceTool: ReturnType<typeof createAdvanceTasksTool>;

  beforeEach(() => {
    resetState();
    configModule.resetConfig();
    const mockApi = createMockAPI();
    api = mockApi.api;
    ctx = createMockContext();

    writeTool = createWriteTasksTool(api);
    editTool = createEditTasksTool(api);
    compileTool = createCompileTasksTool(api);
    getReadyTool = createGetReadyTasksTool(api);
    advanceTool = createAdvanceTasksTool(api);
  });

  it("exercises the complete write→edit→compile→claim→advance lifecycle", async () => {
    // ── Step 1: write_tasks (replace): 3 phases with 2 tasks each ──
    const writeResult = await callExecute(
      writeTool,
      {
        mode: "replace",
        phases: [
          {
            title: "Phase 1",
            tasks: [
              { title: "Task A", prompt: "Do A", profile: "coder" },
              { title: "Task B", prompt: "Do B", profile: "coder" },
            ],
          },
          {
            title: "Phase 2",
            tasks: [
              { title: "Task C", prompt: "Do C", profile: "coder" },
              { title: "Task D", prompt: "Do D", profile: "coder" },
            ],
          },
          {
            title: "Phase 3",
            tasks: [
              { title: "Task E", prompt: "Do E", profile: "coder" },
              { title: "Task F", prompt: "Do F", profile: "coder" },
            ],
          },
        ],
      },
      ctx,
    );

    expect(writeResult.details.error).toBeUndefined();
    const afterWrite = snapshot(writeResult);
    expect(afterWrite.tasks).toHaveLength(6);
    // Verify IDs
    expect(afterWrite.tasks[0]!.id).toBe("t-1.1"); // Task A
    expect(afterWrite.tasks[1]!.id).toBe("t-1.2"); // Task B
    expect(afterWrite.tasks[2]!.id).toBe("t-2.1"); // Task C
    expect(afterWrite.tasks[3]!.id).toBe("t-2.2"); // Task D
    expect(afterWrite.tasks[4]!.id).toBe("t-3.1"); // Task E
    expect(afterWrite.tasks[5]!.id).toBe("t-3.2"); // Task F
    // All tasks should be draft
    for (const t of afterWrite.tasks) {
      expect(t.status).toBe("draft");
    }

    // ── Step 2: edit_tasks — set C's blockers to ["t-1.1"], E's blockers to ["t-2.1"] ──
    const editResult = await callExecute(
      editTool,
      {
        tasks: [
          { id: "t-2.1", type: "blockers", data: { dependencies: ["t-1.1"] } },
          { id: "t-3.1", type: "blockers", data: { dependencies: ["t-2.1"] } },
        ],
      },
      ctx,
    );

    expect(editResult.details.error).toBeUndefined();
    const afterEdit = snapshot(editResult);
    expect(findTask(afterEdit, "t-2.1").dependencies).toEqual(["t-1.1"]);
    expect(findTask(afterEdit, "t-3.1").dependencies).toEqual(["t-2.1"]);
    // Structural edit resets non-terminal non-active tasks to draft
    for (const t of afterEdit.tasks) {
      expect(t.status).toBe("draft");
    }

    // ── Step 3: compile_tasks — verify readiness ──
    const compileResult1 = await callExecute(compileTool, {}, ctx);

    expect(compileResult1.details.error).toBeUndefined();
    const afterCompile1 = snapshot(compileResult1);
    // Phase 1 tasks: A (t-1.1) and B (t-1.2) should be ready (no deps, first active phase)
    expect(findTask(afterCompile1, "t-1.1").status).toBe("ready");
    expect(findTask(afterCompile1, "t-1.2").status).toBe("ready");
    // Phase 2: D (t-2.2) should be ready (no deps, but gated by phase 1)
    // Actually: Phase 2 is "pending" because Phase 1 is active. So D is "configured".
    // C (t-2.1) has a dependency on t-1.1, so it's configured (blocked)
    expect(findTask(afterCompile1, "t-2.1").status).toBe("configured"); // blocked by dep on t-1.1
    expect(findTask(afterCompile1, "t-2.2").status).toBe("configured"); // gated by phase
    // Phase 3: all configured/gated
    expect(findTask(afterCompile1, "t-3.1").status).toBe("configured"); // blocked by dep on t-2.1
    expect(findTask(afterCompile1, "t-3.2").status).toBe("configured"); // gated by phase
    // Phases
    expect(findPhase(afterCompile1, 1).status).toBe("active");
    expect(findPhase(afterCompile1, 2).status).toBe("pending");
    expect(findPhase(afterCompile1, 3).status).toBe("pending");

    // ── Step 4: get_ready_tasks (count 2) — claim A and B ──
    const claimResult1 = await callExecute(getReadyTool, { count: 2 }, ctx);

    expect(claimResult1.details.error).toBeUndefined();
    const afterClaim1 = snapshot(claimResult1);
    expect(claimResult1.content[0].text).toContain("Claimed 2 task(s)");
    expect(findTask(afterClaim1, "t-1.1").status).toBe("implementing");
    expect(findTask(afterClaim1, "t-1.2").status).toBe("implementing");

    // ── Step 5: advance_tasks A and B to reviewing ──
    const advanceResult1 = await callExecute(advanceTool, advance("t-1.1", "t-1.2"), ctx);

    expect(advanceResult1.details.error).toBeUndefined();
    const afterReview1 = snapshot(advanceResult1);
    expect(findTask(afterReview1, "t-1.1").status).toBe("reviewing");
    expect(findTask(afterReview1, "t-1.2").status).toBe("reviewing");

    // ── Step 6: advance_tasks A and B to done ──
    const advanceResult2 = await callExecute(advanceTool, complete("t-1.1", "t-1.2"), ctx);

    expect(advanceResult2.details.error).toBeUndefined();
    const afterDone1 = snapshot(advanceResult2);
    expect(findTask(afterDone1, "t-1.1").status).toBe("done");
    expect(findTask(afterDone1, "t-1.2").status).toBe("done");

    // ── Step 7: Verify Phase 1 completed ──
    expect(findPhase(afterDone1, 1).status).toBe("completed");
    // Phase 2 should now be active (recomputed by advance)
    expect(findPhase(afterDone1, 2).status).toBe("active");
    // C (t-2.1) depends on t-1.1 which is now done, so C should be ready
    expect(findTask(afterDone1, "t-2.1").status).toBe("ready");
    // D (t-2.2) has no deps, in active phase → ready
    expect(findTask(afterDone1, "t-2.2").status).toBe("ready");

    // ── Step 8: compile_tasks again (re-resolve deps) ──
    // Phase 2 tasks are already ready from the recompute in advance, but let's compile anyway
    // Note: compile will fail if there are active tasks — but there aren't now
    const compileResult2 = await callExecute(compileTool, {}, ctx);

    expect(compileResult2.details.error).toBeUndefined();
    const afterCompile2 = snapshot(compileResult2);
    // C should still be ready after compile
    expect(findTask(afterCompile2, "t-2.1").status).toBe("ready");
    expect(findTask(afterCompile2, "t-2.2").status).toBe("ready");
    // Phase 3 tasks still blocked
    expect(findTask(afterCompile2, "t-3.1").status).toBe("configured"); // depends on t-2.1
    expect(findTask(afterCompile2, "t-3.2").status).toBe("configured"); // gated by phase

    // ── Step 9: get_ready_tasks (count 2) — claim C and D ──
    const claimResult2 = await callExecute(getReadyTool, { count: 2 }, ctx);

    expect(claimResult2.details.error).toBeUndefined();
    const afterClaim2 = snapshot(claimResult2);
    expect(claimResult2.content[0].text).toContain("Claimed 2 task(s)");
    expect(findTask(afterClaim2, "t-2.1").status).toBe("implementing");
    expect(findTask(afterClaim2, "t-2.2").status).toBe("implementing");

    // ── Step 10: advance C and D through reviewing → done ──
    await callExecute(advanceTool, advance("t-2.1", "t-2.2"), ctx); // → reviewing

    const advanceResult4 = await callExecute(advanceTool, complete("t-2.1", "t-2.2"), ctx); // → done

    expect(advanceResult4.details.error).toBeUndefined();
    const afterDone2 = snapshot(advanceResult4);
    expect(findTask(afterDone2, "t-2.1").status).toBe("done");
    expect(findTask(afterDone2, "t-2.2").status).toBe("done");

    // ── Step 11: Verify Phase 2 completed ──
    expect(findPhase(afterDone2, 2).status).toBe("completed");
    // Phase 3 should now be active
    expect(findPhase(afterDone2, 3).status).toBe("active");
    // E (t-3.1) depends on t-2.1 which is now done → should be ready
    expect(findTask(afterDone2, "t-3.1").status).toBe("ready");
    // F (t-3.2) has no deps, in active phase → ready
    expect(findTask(afterDone2, "t-3.2").status).toBe("ready");

    // ── Step 12: compile_tasks again ──
    const compileResult3 = await callExecute(compileTool, {}, ctx);

    expect(compileResult3.details.error).toBeUndefined();
    const afterCompile3 = snapshot(compileResult3);
    expect(findTask(afterCompile3, "t-3.1").status).toBe("ready");
    expect(findTask(afterCompile3, "t-3.2").status).toBe("ready");

    // ── Step 13: get_ready_tasks (count 2) — claim E and F ──
    const claimResult3 = await callExecute(getReadyTool, { count: 2 }, ctx);

    expect(claimResult3.details.error).toBeUndefined();
    const afterClaim3 = snapshot(claimResult3);
    expect(claimResult3.content[0].text).toContain("Claimed 2 task(s)");
    expect(findTask(afterClaim3, "t-3.1").status).toBe("implementing");
    expect(findTask(afterClaim3, "t-3.2").status).toBe("implementing");

    // ── Step 14: advance both through reviewing → done ──
    await callExecute(advanceTool, advance("t-3.1", "t-3.2"), ctx); // → reviewing

    const advanceResult6 = await callExecute(advanceTool, complete("t-3.1", "t-3.2"), ctx); // → done

    expect(advanceResult6.details.error).toBeUndefined();
    const afterDone3 = snapshot(advanceResult6);
    expect(findTask(afterDone3, "t-3.1").status).toBe("done");
    expect(findTask(afterDone3, "t-3.2").status).toBe("done");

    // ── Step 15: Verify all phases completed, all tasks done ──
    expect(findPhase(afterDone3, 1).status).toBe("completed");
    expect(findPhase(afterDone3, 2).status).toBe("completed");
    expect(findPhase(afterDone3, 3).status).toBe("completed");
    for (const t of afterDone3.tasks) {
      expect(t.status).toBe("done");
    }

    // ── Step 16: get_ready_tasks (count 1) — should return "All tasks resolved" error ──
    const finalClaimResult = await callExecute(getReadyTool, { count: 1 }, ctx);

    expect(finalClaimResult.details.error).toBeDefined();
    expect(finalClaimResult.content[0].text).toContain("All tasks resolved");
  });
});
