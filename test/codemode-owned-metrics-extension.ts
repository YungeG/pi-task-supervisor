// Isolated fixture wrapper: same candidate implementation and one SDK loader module graph.
// Diagnostics are not qualifications, permission or business-completion evidence.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hostModuleFixture from "./host-module-extension";
import { journalDecodeStats } from "../src/human-journal";
import { controlReadStats } from "../src/control-journal";
export default function ownedMetrics(pi: ExtensionAPI): void {
  hostModuleFixture(pi);
  pi.on("agent_end", () => {
    pi.events.emit("owned-p6-cache-metrics", {
      decode: journalDecodeStats(),
      fold: controlReadStats(),
    });
  });
}
