import type { UiSummary } from "./ui-view";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

const MAX_STATUSBAR_WIDTH = 64;

function escapeBidiControls(text: string): string {
  return text.replace(/\p{Bidi_Control}/gu, (ch) => {
    const code = ch.charCodeAt(0);
    const hex = code.toString(16).padStart(4, "0");
    return `\\u${hex}`;
  });
}

function sanitizeText(text: string): string {
  return escapeBidiControls(stripTerminalSequences(text))
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One plain entry: current state first, secondary task counts when space permits. */
export function formatStatusbar(summary: UiSummary): string | undefined {
  if (!summary.visible) return undefined;
  const { counts } = summary;
  const segments = [
    sanitizeText(summary.headline.text),
    `已完成 ${counts.done}/${counts.total}`,
    ...(counts.abandoned > 0 ? [`放弃 ${counts.abandoned}`] : []),
  ].filter(Boolean);
  // Native truncation preserves the left-hand state before secondary progress.
  return stripTerminalSequences(truncateToWidth(segments.join(" · "), MAX_STATUSBAR_WIDTH, "…"));
}
