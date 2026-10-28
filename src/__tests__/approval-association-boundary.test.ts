// Native scoped-Goal metadata and boundary mechanics, not a successful SDK admission.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture, completeGoalProposal } from "./helpers/goal";
import { BOUNDARY } from "./helpers/lifecycle";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { submitAndPresentPreflight } from "../preflight-human";
import { PREFLIGHT_ENTRY } from "../preflight";
import { preflightAssociationIssue } from "../acceptance-runtime";
import { reviewSupervisor } from "../supervisor";
import { readControlJournal } from "../control-journal";
const fixtures: Awaited<ReturnType<typeof goalFixture>>[] = [];
beforeEach(resetState);
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
const budget = () => {
  const s = currentRuntime().supervisor;
  if (!s) throw Error("No actual Supervisor");
  return {
    reviews: s.reviews,
    continuations: s.continuations,
    stagnant: s.stagnant,
    tokens: s.tokens,
    cost: s.cost,
    epoch: s.epoch,
  };
};
it.each(["review", "settle"])(
  "holds the scoped %s boundary after Start projection repair, before advisor accounting or continuation",
  async (route) => {
    const advisor = vi.fn(async () => ({
      advice: {
        action: "guide" as const,
        message: "Inspect the approved original work",
        taskIds: [],
        evidenceRefs: [],
      },
    }));
    const f = await goalFixture({ gitWorkspace: true, advisor });
    fixtures.push(f);
    await f.command("supervise Scoped association boundary");
    await f.fire("agent_start");
    vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
    await submitAndPresentPreflight(
      f.api,
      f.ctx,
      "scoped-proposal",
      currentRuntime().preflight!.preflightId,
      await completeGoalProposal(f),
    );
    await f.fire("agent_settled", { type: "agent_settled", aborted: false });
    let failed = false;
    f.fail((type, data) => {
      const row = data as { phase?: unknown; snapshot?: { phase?: unknown } };
      if (!failed && type === PREFLIGHT_ENTRY && (row.snapshot ?? row).phase === "started") {
        failed = true;
        return "before";
      }
      return undefined;
    });
    vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
    await f.command("start");
    expect(failed).toBe(true);
    expect(currentRuntime().preflightRepair).toBeDefined();
    await f.command("repair-preflight");
    expect(currentRuntime().preflightRepair).toBeUndefined();
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentRuntime().supervisor?.status).toBe("active");
    expect(currentRuntime().management?.activeWorkOwner?.kind).toBe("goal");
    expect(currentRuntime().goal?.current?.scope.goalRunId).toBeTruthy();
    expect(readControlJournal(f.ctx).acceptance?.contracts ?? []).toHaveLength(0);
    expect(preflightAssociationIssue(f.ctx)).toContain("association repair");
    const before = budget(),
      dispatches = f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn).length;
    const result =
      route === "review"
        ? await reviewSupervisor(f.api, f.ctx, new AbortController().signal, advisor)
        : await f.fire("agent_before_settle", BOUNDARY);
    expect(advisor).not.toHaveBeenCalled();
    expect(budget()).toEqual(before);
    expect(result).toBeUndefined();
    expect(f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(
      dispatches,
    );
    await f.command("repair-preflight");
    expect(readControlJournal(f.ctx).acceptance?.contracts).toHaveLength(1);
    expect(preflightAssociationIssue(f.ctx)).toBeUndefined();
    expect(budget()).toEqual(before);
  },
);
