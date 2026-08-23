import { describe, expect, it } from "vitest";
import { registerMessageRenderers } from "../renderers";
import { createMockAPI, createMockTheme } from "./helpers/mocks";

function rendererFor(type: string) {
  const mock = createMockAPI();
  registerMessageRenderers(mock.api);
  const call = mock.registerMessageRenderer.mock.calls.find(
    (candidate: unknown) => (candidate as [string, unknown])[0] === type,
  );
  return {
    mock,
    renderer: (call as [string, (...args: unknown[]) => unknown])[1],
  };
}

describe("registerMessageRenderers", () => {
  it("registers context and notice renderers", () => {
    const mock = createMockAPI();
    registerMessageRenderers(mock.api);

    expect(mock.registerMessageRenderer.mock.calls.map(([type]) => type)).toEqual([
      "continuous-tasks:context",
      "continuous-tasks:notice",
    ]);
  });

  it.each([
    ["Board context here", "Board context here"],
    [{ foo: "bar" }, JSON.stringify({ foo: "bar" })],
  ])("renders context content: %j", (content, expected) => {
    const { renderer } = rendererFor("continuous-tasks:context");
    const theme = createMockTheme();
    const result = renderer({ content }, {}, theme) as { toString(): string };

    expect(theme.fg).toHaveBeenCalledWith("accent", "📋 ");
    expect(theme.fg).toHaveBeenCalledWith("dim", expected);
    expect(result.toString()).toBe(`[accent]📋 [dim]${expected}`);
  });

  it.each([
    ["Limit reached!", "Limit reached!"],
    [{ count: 5 }, JSON.stringify({ count: 5 })],
  ])("renders notice content: %j", (content, expected) => {
    const { renderer } = rendererFor("continuous-tasks:notice");
    const theme = createMockTheme();
    const result = renderer({ content }, {}, theme) as { toString(): string };

    expect(theme.fg).toHaveBeenCalledWith("warning", "⚠ ");
    expect(theme.fg).toHaveBeenCalledWith("text", expected);
    expect(result.toString()).toBe(`[warning]⚠ [text]${expected}`);
  });
});
