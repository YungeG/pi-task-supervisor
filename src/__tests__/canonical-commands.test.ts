import { beforeEach, expect, it, vi } from "vitest";
import { resetState, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import { preflightLifecycle } from "./helpers/preflight";
import { goalFixture } from "./helpers/goal";
import { rmSync } from "node:fs";
import { lifecycle } from "./helpers/lifecycle";
import { routeGoalCommand, parseSuperviseArgs } from "../goal-commands";
beforeEach(resetState);
it.each([
  ["goal text", { goal: "goal text", replan: false }],
  ["--replan", { goal: "", replan: true }],
  ["--replan goal text", { goal: "goal text", replan: true }],
  ["-- --replan literal", { goal: "--replan literal", replan: false }],
  ["--replan -- --replan literal", { goal: "--replan literal", replan: true }],
  ["--", { goal: "", replan: false }],
  ["--replan --", { goal: "", replan: true }],
] as const)("parses canonical flags without swallowing literal text: %s", (text, expected) => {
  expect(parseSuperviseArgs(text)).toEqual(expected);
});
it.each(["--wrong", "--replan --wrong"])("rejects an unknown flag before mutation: %s", (text) => {
  expect(() => parseSuperviseArgs(text)).toThrow(/Unknown/);
});
it("has only /task-supervisor, with removed names unable to mutate or dispatch even from off", async () => {
  const h = lifecycle();
  expect(h.mock.registerCommand.mock.calls.map((c) => c[0])).toEqual(["task-supervisor"]);
  for (const command of [
    "preflight Removed path",
    "enable",
    "supervise-legacy Removed path",
    "resolve old-id",
  ]) {
    const before = h.mock.appendEntry.mock.calls.length,
      dispatch = h.mock.api.sendMessage;
    await h.nativeCommand(command);
    expect(h.mock.appendEntry.mock.calls.length, command).toBe(before);
    expect(dispatch, command).not.toHaveBeenCalled();
    expect(currentRuntime().preflight, command).toBeUndefined();
    expect(currentRuntime().supervisor, command).toBeUndefined();
  }
  expect(await routeGoalCommand(h.mock.api, h.ctx, "preflight", "Removed path")).toBe(false);
});
it("tasks stays read-only; tasks-only selects the existing internal tasks mode without Supervisor", async () => {
  const h = lifecycle();
  Object.assign(h.ctx, { hasUI: false });
  const board = getBoard();
  await h.nativeCommand("tasks");
  expect(currentRuntime().management).toBeUndefined();
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(getBoard()).toEqual(board);
  await h.nativeCommand("tasks-only");
  expect(currentRuntime().management).toMatchObject({ mode: "tasks", state: "active" });
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
  const count = h.mock.appendEntry.mock.calls.length;
  await h.nativeCommand("tasks");
  expect(h.mock.appendEntry).toHaveBeenCalledTimes(count);
});
it("supervise repeat is status-only; explicit --replan changes only the same unstarted attempt", async () => {
  const h = preflightLifecycle();
  await h.nativeCommand("supervise Original canonical goal");
  const original = currentRuntime().preflight;
  expect(original).toBeDefined();
  const id = original!.preflightId,
    count = h.entries.length,
    dispatch = h.mock.sendMessage.mock.calls.length;
  await h.nativeCommand("supervise Original canonical goal");
  expect(h.entries).toHaveLength(count);
  expect(h.mock.sendMessage).toHaveBeenCalledTimes(dispatch);
  await h.nativeCommand("supervise --replan Different goal");
  expect(currentRuntime().preflight?.preflightId).toBe(id);
  expect(h.entries).toHaveLength(count);
  await h.nativeCommand("supervise --replan Original canonical goal");
  expect(currentRuntime().preflight?.preflightId).not.toBe(id);
  expect(currentRuntime().preflight?.goal).toBe(original!.goal);
  expect(currentRuntime().management?.activeWorkOwner).toBeNull();
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(h.mock.sendMessage).toHaveBeenCalledTimes(dispatch + 1);
  expect(currentRuntime().supervisor).toBeUndefined();
});
it("keeps lifecycle-scoped replans on the original Goal and rejects other/closed targets", async () => {
  const g = await goalFixture();
  try {
    await g.command("supervise Scoped canonical target");
    const goal = currentRuntime().goal!.current!,
      id = goal.scope.goalRunId;
    const count = g.appendEntry.mock.calls.length;
    await g.command("supervise --replan Other target");
    expect(g.appendEntry).toHaveBeenCalledTimes(count);
    await g.command("supervise --replan Scoped canonical target");
    expect(currentRuntime().goal!.current!.scope.goalRunId).toBe(id);
    expect(currentRuntime().goal!.current!.planning.attemptNo).toBe(1);
    expect(currentRuntime().preflight).toMatchObject({
      phase: "planning",
      approvalFlow: "consolidated-v1",
    });
    await g.command("stop");
    const after = g.appendEntry.mock.calls.length;
    await g.command("supervise --replan Scoped canonical target");
    expect(g.appendEntry).toHaveBeenCalledTimes(after);
    expect(currentRuntime().goal!.current!.scope.goalRunId).toBe(id);
  } finally {
    g.restoreHost();
    rmSync(g.dir, { recursive: true, force: true });
  }
});
it("-- protects literal goal text and a missing --replan target cannot create a Goal", async () => {
  const h = preflightLifecycle();
  await h.nativeCommand("supervise --replan");
  expect(currentRuntime().goal?.current).toBeUndefined();
  expect(currentRuntime().preflight).toBeUndefined();
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  await h.nativeCommand("supervise -- --replan literal goal");
  expect(currentRuntime().preflight?.goal).toBe("--replan literal goal");
  const count = h.entries.length;
  await h.nativeCommand("supervise --unknown");
  expect(h.entries).toHaveLength(count);
  expect(vi.mocked(h.ctx.ui.notify).mock.calls.flat().join(" ")).toMatch(/unknown|--|flag/i);
});
