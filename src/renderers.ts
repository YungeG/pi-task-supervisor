import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("continuous-tasks:context", (message, _opts, theme) => {
    return new Text(
      theme.fg("accent", "📋 ") +
        theme.fg(
          "dim",
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        ),
      0,
      0,
    );
  });

  pi.registerMessageRenderer("continuous-tasks:notice", (message, _opts, theme) => {
    return new Text(
      theme.fg("warning", "⚠ ") +
        theme.fg(
          "text",
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        ),
      0,
      0,
    );
  });
}
