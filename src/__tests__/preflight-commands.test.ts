import { preflightNotice } from "../human-presentation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetState, getBoard } from "../state";
import { setSessionScopeEnabled } from "../scope";
import { supervisorState } from "../supervisor";
import { createSubmitPreflightTool } from "../tools";
import { preflightLifecycle, localProposal } from "./helpers/preflight";

function latest(h: ReturnType<typeof preflightLifecycle>) {
  return [...h.entries]
    .reverse()
    .find((entry) => entry.customType === "continuous-tasks:preflight")!.data as {
    preflightId: string;
    planId: string;
  };
}

describe("opt-in human preflight commands", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(false);
  });

  it("starts only read-only planning, not supervision or an execution board", async () => {
    const h = preflightLifecycle();
    await h.command("preflight Implement the local fixture");
    await h.command("status");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Preflight: planning"),
      "info",
    );
    expect(h.mock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "continuous-tasks:preflight-planning",
        display: false,
        content: expect.stringContaining("read-only"),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(supervisorState()).toBeUndefined();
    expect(getBoard().tasks).toEqual([]);
    expect(h.entries.some((entry) => entry.customType === "continuous-tasks:preflight")).toBe(true);
  });

  it("records a model proposal without accepting model-supplied approval", async () => {
    const h = preflightLifecycle();
    await h.command("preflight Implement the local fixture");
    const planning = latest(h);
    const tool = createSubmitPreflightTool(h.mock.api);
    const forged = await tool.execute(
      "forged",
      { preflightId: planning.preflightId, proposal: localProposal, approved: true } as never,
      undefined,
      undefined,
      h.ctx,
    );
    expect(forged.isError).toBe(true);
    const submitted = await tool.execute(
      "submit",
      { preflightId: planning.preflightId, proposal: localProposal },
      undefined,
      undefined,
      h.ctx,
    );
    expect(submitted.isError).not.toBe(true);
    await h.command("status");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Preflight: awaiting_authorization"),
      "info",
    );
    expect(supervisorState()).toBeUndefined();
  });

  it("keeps partial user approval blocked and never starts from approve itself", async () => {
    const h = preflightLifecycle();
    await h.command("preflight Implement the local fixture");
    await createSubmitPreflightTool(h.mock.api).execute(
      "submit",
      { preflightId: latest(h).preflightId, proposal: localProposal },
      undefined,
      undefined,
      h.ctx,
    );
    const proposal = latest(h);
    h.mock.sendMessage.mockClear();
    await h.command(`approve ${proposal.planId} A2`);
    await h.command("status");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("missing required: A1"),
      "info",
    );
    await h.command(`start ${proposal.planId}`);
    expect(supervisorState()).toBeUndefined();
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
    await h.command(`approve ${proposal.planId} A1`);
    await h.command("status");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Preflight: approved"),
      "info",
    );
    expect(supervisorState()).toBeUndefined();
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts no-ID native start but rejects prefix-only start IDs", async () => {
    const h = preflightLifecycle();
    await h.command("preflight Implement the local fixture");
    await createSubmitPreflightTool(h.mock.api).execute(
      "submit",
      { preflightId: latest(h).preflightId, proposal: localProposal },
      undefined,
      undefined,
      h.ctx,
    );
    const plan = latest(h);
    await h.command(`approve ${plan.planId} A1`);
    h.mock.sendMessage.mockClear();
    await h.command(`start ${plan.preflightId}`);
    expect(supervisorState()).toBeUndefined();
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
    await h.command("start");
    expect(supervisorState()?.status).toBe("active");
  });

  it("requires exact trusted approval and a separate start before binding supervision", async () => {
    const h = preflightLifecycle();
    const goal = "Implement the local fixture";
    await h.command(`preflight ${goal}`);
    await createSubmitPreflightTool(h.mock.api).execute(
      "submit",
      { preflightId: latest(h).preflightId, proposal: localProposal },
      undefined,
      undefined,
      h.ctx,
    );
    const plan = latest(h);
    h.mock.sendMessage.mockClear();
    await h.command(`supervise ${goal}`);
    expect(supervisorState()).toBeUndefined();
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
    await h.command(`approve ${plan.planId} A1`);
    expect(supervisorState()).toBeUndefined();
    await h.command(`start ${plan.planId}`);
    expect(supervisorState()).toMatchObject({
      status: "active",
      goal,
      preflightBinding: { preflightId: plan.preflightId, planId: plan.planId },
    });
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      1,
    );
    await h.command(`start ${plan.planId}`);
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      1,
    );
  });
});

it.each(["tui", "rpc", "print"] as const)(
  "adds the command details entry only in TUI (%s)",
  async (mode) => {
    resetState();
    setSessionScopeEnabled(false);
    const h = preflightLifecycle();
    await h.command("preflight Local fixture");
    await createSubmitPreflightTool(h.mock.api).execute(
      "submit",
      {
        preflightId: latest(h).preflightId,
        proposal: localProposal,
      },
      undefined,
      undefined,
      h.ctx,
    );
    Object.assign(h.ctx, { mode });
    await h.command("approve");
    h.ui.assertNoScriptErrors();
    const message = vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0];
    if (mode === "tui") expect(message).toContain("详情：/task-supervisor tasks → 确认与回应");
    else expect(message).toBe(preflightNotice({ status: "unsupported" }).message);
    expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
  },
);
