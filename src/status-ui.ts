import { taskViewCountsUnknown, type UiSummary } from "./ui-view";
import type { SupervisorState } from "./supervisor";
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

/** Legacy clients share the same owner/attention rules on every refresh. Display only. */
export function formatLegacySupervisorStatus(
  state: Readonly<SupervisorState> | undefined,
  sessionId: string,
  attention?: string,
): string | undefined {
  if (attention)
    return stripTerminalSequences(
      truncateToWidth(`Supervisor: fault — ${sanitizeText(attention)}`, MAX_STATUSBAR_WIDTH, "…"),
    );
  if (!state || state.sessionId !== sessionId || (state.status === "stopped" && !state.pending))
    return undefined;
  return state.status === "reviewing"
    ? `Supervisor: checking ${state.reviews}/40`
    : `Supervisor: ${state.status} (${state.continuations}/20 resumes)`;
}

/** One plain entry: current state first, secondary task counts when space permits. */
export function formatStatusbar(summary: UiSummary): string | undefined {
  if (!summary.visible) return undefined;
  const { counts } = summary;
  const segments = [
    sanitizeText(summary.headline.text),
    taskViewCountsUnknown(summary)
      ? "任务视图未恢复（数量未知）"
      : `已完成 ${counts.done}/${counts.total}`,
    ...(counts.abandoned > 0 ? [`放弃 ${counts.abandoned}`] : []),
  ].filter(Boolean);
  // Native truncation preserves the left-hand state before secondary progress.
  return stripTerminalSequences(truncateToWidth(segments.join(" · "), MAX_STATUSBAR_WIDTH, "…"));
}
