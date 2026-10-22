import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";

/** Native UI capabilities only; no task, owner or permission type dependencies. */
export type UiViewEnvironment = Readonly<{
  theme: Theme;
  keybindings: KeybindingsManager;
  requestRender: () => void;
  rows: () => number;
  openHistory?: () => void;
}>;
