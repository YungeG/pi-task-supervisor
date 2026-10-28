// Public native component mechanics only. A selection is never a grant/NativeAnswer.
import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ApprovalReview, isApprovalSelection } from "../approval-review";
import { requireNativeAnswer, type NativeQuestion } from "../human-ui";
import { createMockContext, createMockTheme } from "./helpers/mocks";

const down = "\u001b[B",
  up = "\u001b[A",
  next = "\u001b[6~",
  previous = "\u001b[5~",
  enter = "\r";
function fixture(definitionsOnly = false, permissions = 5) {
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, value) => value);
  vi.mocked(theme.bold).mockImplementation((value) => value);
  let rows = 24;
  const env = {
    theme,
    rows: () => rows,
    requestRender: vi.fn(),
    keybindings: new KeybindingsManager(),
  };
  const question: NativeQuestion = {
    kind: "authorization",
    purpose: "approval-bundle",
    title: "明确范围与定义",
    body: "完整对象、风险、限制和替代方案\n".repeat(70),
    frame: {
      version: 1,
      owner: "preflight",
      sessionId: "owned",
      requestId: "r",
      presentationId: "p",
      scopeDigest: "a".repeat(64),
      baseSnapshotEntryId: "base",
      baseSnapshotDigest: "b".repeat(64),
    },
    approval: {
      permissions: Array.from({ length: permissions }, (_, index) => ({
        id: `A${index + 1}`,
        label: `范围 ${index + 1}`,
        required: index === 0,
      })),
      selectedIds: definitionsOnly ? ["A1"] : [],
      definitionsOnly,
    },
  };
  const done = vi.fn();
  const card = new ApprovalReview(question, env, done);
  const render = (width = 80) => card.render(width).join("\n");
  const readAll = (width = 80) => {
    for (let index = 0; index < 200; index++) {
      if (render(width).includes("完整材料已核对")) return;
      card.handleInput(next);
    }
    throw Error("Actual approval pages did not finish");
  };
  return {
    question,
    card,
    env,
    done,
    render,
    readAll,
    rows: (value: number) => {
      rows = value;
    },
  };
}
it("keeps drafts local, requires all rendered pages and registers only the original frozen selection", () => {
  const h = fixture();
  h.card.handleInput(enter);
  expect(h.done).not.toHaveBeenCalled();
  h.render();
  h.card.handleInput(enter);
  expect(h.render()).toContain("请先用 PgDn");
  h.card.handleInput(previous);
  h.card.handleInput(up);
  h.card.handleInput(" ");
  h.card.handleInput(" ");
  h.card.handleInput("a");
  h.card.handleInput(down);
  h.card.handleInput(" ");
  for (let i = 0; i < 8; i++) h.card.handleInput(down);
  expect(h.render()).toContain("范围 5");
  h.card.handleInput("unknown");
  h.readAll();
  h.card.handleInput(enter);
  const selection: unknown = h.done.mock.calls[0]?.[0];
  expect(selection).toMatchObject({ outcome: "approve", permissionIds: ["A1", "A2"] });
  expect(isApprovalSelection(selection, h.question)).toBe(true);
  expect(isApprovalSelection(Object.freeze({ ...(selection as object) }), h.question)).toBe(false);
  expect(isApprovalSelection(selection, { ...h.question })).toBe(false);
  expect(isApprovalSelection(null, h.question)).toBe(false);
  expect(() => requireNativeAnswer(createMockContext(), selection, h.question.frame)).toThrow();
  h.card.handleInput("r");
  h.card.handleInput(enter);
  expect(h.done).toHaveBeenCalledOnce();
  expect(h.card.render(80)).toEqual([]);
});
it("invalidates reading coverage after resize while preserving the permission draft", () => {
  const h = fixture();
  h.render();
  h.card.handleInput("a");
  h.readAll();
  h.rows(14);
  expect(h.render(24)).toContain("材料未完整核对");
  h.card.handleInput(enter);
  expect(h.done).not.toHaveBeenCalled();
  expect(h.render(24)).toContain("[x]");
  h.rows(28);
  h.readAll(65);
  const lines = h.card.render(65);
  expect(lines.length).toBeLessThanOrEqual(28);
  expect(lines.every((line) => visibleWidth(line) <= 65)).toBe(true);
  h.card.invalidate();
  h.card.handleInput(enter);
  expect(h.done).not.toHaveBeenCalled();
  h.readAll(65);
  h.card.handleInput(enter);
  expect(h.done.mock.calls[0]?.[0]).toMatchObject({ permissionIds: ["A1"] });
});
it.each([
  [23, 24],
  [80, 13],
  [0, 24],
  [80, 0],
])("never approves a viewport of %s columns by %s rows", (width, rows) => {
  const h = fixture();
  h.rows(rows);
  const screen = h.render(width);
  if (width && rows) {
    expect(screen).toContain("空间不足");
    expect(visibleWidth(screen)).toBeLessThanOrEqual(width);
  } else expect(screen).toBe("");
  h.card.handleInput(next);
  h.card.handleInput(enter);
  expect(h.done).not.toHaveBeenCalled();
  h.card.handleInput("\u001b");
  expect(h.done).toHaveBeenCalledWith(undefined);
});
it("does not alter the original business selection in definition-only mode", () => {
  const h = fixture(true);
  h.render();
  h.card.handleInput(" ");
  h.card.handleInput("a");
  h.card.handleInput(down);
  h.card.handleInput(" ");
  h.readAll();
  h.card.handleInput(enter);
  expect(h.done.mock.calls[0]?.[0]).toMatchObject({ permissionIds: ["A1"] });
});
it.each(["r", "\u001b"])(
  "allows rejection/deferral without pretending full material was approved (%s)",
  (key) => {
    const h = fixture();
    h.render();
    h.card.handleInput(key);
    expect(h.done).toHaveBeenCalledOnce();
    if (key === "r") expect(h.done.mock.calls[0]?.[0]).toMatchObject({ outcome: "reject" });
    else expect(h.done).toHaveBeenCalledWith(undefined);
  },
);
it("only defers a defensive empty metadata view; it does not synthesize a native answer", () => {
  const h = fixture(),
    done = vi.fn();
  const question = { ...h.question, approval: undefined };
  const card = new ApprovalReview(question, h.env, done);
  expect(card.render(80).join("\n")).toContain("无额外权限");
  card.handleInput("\u001b");
  expect(done).toHaveBeenCalledWith(undefined);
});
it("supports no extra permissions without creating a NativeAnswer", () => {
  const h = fixture(false, 0);
  expect(h.render()).toContain("无额外权限");
  h.card.handleInput(" ");
  h.card.handleInput("a");
  h.readAll();
  h.card.handleInput(enter);
  expect(h.done.mock.calls[0]?.[0]).toMatchObject({ permissionIds: [] });
});
