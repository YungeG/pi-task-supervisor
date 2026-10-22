import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { resetState, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import { captureUiSummary } from "../ui-capture";
import { TASK_WIDGET_KEY } from "../board-ui";

const fixtures: Awaited<ReturnType<typeof goalFixture>>[] = [];
beforeEach(() => {
  resetState();
});
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

it("shows the selected planning goal and explicit current-goal controls, then clears stopped-unstarted chrome without deleting history", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Visible scoped goal");
  const planning = captureUiSummary(f.ctx, getBoard());
  expect(planning.goals.some((goal) => goal.text === "Visible scoped goal")).toBe(true);
  expect(planning.goals.some((goal) => goal.text === "Synthetic old goal")).toBe(false);
  expect(planning.headline.text).toContain("只读规划");
  expect(planning.next.text).toContain("preflight");
  await f.command("stop");
  const stopped = captureUiSummary(f.ctx, getBoard());
  expect(stopped.visible).toBe(false);
  expect(currentRuntime().goal?.archives).toHaveLength(1);
  expect(
    vi
      .mocked(f.ctx.ui.setStatus)
      .mock.calls.filter(([key]) => key === "til-done")
      .at(-1)?.[1],
  ).toBeUndefined();
  expect(
    vi
      .mocked(f.ctx.ui.setWidget)
      .mock.calls.filter(([key]) => key === TASK_WIDGET_KEY)
      .at(-1)?.[1],
  ).toBeUndefined();
  currentRuntime().journalFault = "Independent integrity fault";
  expect(captureUiSummary(f.ctx, getBoard()).visible).toBe(true);
});

it("keeps an A-only uncertainty visible even when the retained legacy Supervisor is stopped", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  f.fail((type, data) =>
    type === "continuous-tasks:supervisor" &&
    (data as { kind?: string }).kind === "transition-control"
      ? "after"
      : undefined,
  );
  await f.command("supervise Uncertain goal");
  const summary = captureUiSummary(f.ctx, getBoard());
  expect(summary.visible).toBe(true);
  expect(summary.blockers.some((line) => line.source === "goal")).toBe(true);
});
