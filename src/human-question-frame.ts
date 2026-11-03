import type { Theme } from "@earendil-works/pi-coding-agent";
import { isFocusable, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

type QuestionComponent = Component & { dispose(): void };

/** Presentation only: preserve the original component's input, focus and completion. */
export function frameQuestion(
  content: QuestionComponent,
  theme: Theme,
): QuestionComponent & Focusable {
  let closed = false;
  const background = theme.getBgAnsi("userMessageBg"),
    foreground = theme.getFgAnsi("text");
  const paint = (line: string) =>
    theme.bg(
      "userMessageBg",
      theme.fg(
        "text",
        line
          .replaceAll("\u001b[0m", "\u001b[0m" + background + foreground)
          .replaceAll("\u001b[49m", "\u001b[49m" + background)
          .replaceAll("\u001b[39m", "\u001b[39m" + foreground),
      ),
    );
  const edge = (text: string) => theme.fg("borderAccent", text);
  return {
    get focused() {
      return isFocusable(content) && content.focused;
    },
    set focused(value: boolean) {
      if (isFocusable(content)) content.focused = value;
    },
    render(width: number): string[] {
      if (closed) return [];
      width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
      if (width < 6) return content.render(width).map(paint);
      const innerWidth = width - 4;
      const rows = content.render(innerWidth).map((line) => {
        const padding = Math.max(0, innerWidth - visibleWidth(line));
        return paint(`${edge("│")} ${line}${" ".repeat(padding)} ${edge("│")}`);
      });
      return [
        paint(edge("╭" + "─".repeat(width - 2) + "╮")),
        ...rows,
        paint(edge("╰" + "─".repeat(width - 2) + "╯")),
      ];
    },
    handleInput(data: string) {
      if (!closed) content.handleInput?.(data);
    },
    invalidate() {
      content.invalidate();
    },
    dispose() {
      if (!closed) {
        closed = true;
        content.dispose();
      }
    },
  };
}
