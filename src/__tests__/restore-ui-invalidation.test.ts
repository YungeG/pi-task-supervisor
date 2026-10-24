import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as flow from "../flow";
import { captureUiSummary } from "../ui-capture";
import { updateUI, resetState } from "../state";
import { currentRuntime } from "../runtime";
import { createEmptyBoard } from "../engine";
import { RestoreReadInvalidated, type RestoreJournalRead } from "../restore-journal";
import { createMockContext } from "./helpers/mocks";

beforeEach(() => {
  resetState();
});
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const ctx = createMockContext();
  Object.assign(ctx, { hasUI: true, mode: "tui" });
  const read: RestoreJournalRead = {
    inspect: () => undefined,
    require: () => {
      throw Error("No physical fixture needed");
    },
    prefix: () => read,
  };
  return { ctx, read, board: createEmptyBoard() };
}
it.each(["epoch", "source"] as const)(
  "propagates %s invalidation before publishing restored UI",
  (reason) => {
    const { ctx, read, board } = fixture();
    const error = new RestoreReadInvalidated(reason);
    vi.spyOn(flow, "flowFacts").mockImplementation(() => {
      throw error;
    });
    expect(() => captureUiSummary(ctx, board, read)).toThrow(error);
    expect(() => {
      updateUI(ctx, board, read);
    }).toThrow(error);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(currentRuntime().journalFault).toBeUndefined();
  },
);
it("does not consume invalidation from capture at the optional transport boundary", () => {
  const { ctx, read, board } = fixture();
  const error = new RestoreReadInvalidated("epoch");
  // Exercise updateUI's catch independently from captureFacts' catch.
  vi.spyOn(ctx.sessionManager, "getSessionId").mockImplementation(() => {
    throw error;
  });
  expect(() => {
    updateUI(ctx, board, read);
  }).toThrow(error);
  expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  expect(ctx.ui.setWidget).not.toHaveBeenCalled();
});
it("retains UI-only degradation for ordinary flow failures", () => {
  const { ctx, read, board } = fixture();
  currentRuntime().journalFault = "Existing owner fault";
  vi.spyOn(flow, "flowFacts").mockImplementation(() => {
    throw Error("Display failure");
  });
  expect(() => {
    updateUI(ctx, board, read);
  }).not.toThrow();
  expect(ctx.ui.setStatus).toHaveBeenCalled();
  expect(currentRuntime().journalFault).toBe("Existing owner fault");
});
