// Host SDK metadata observation only, not approval or qualified execution.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type * as SDK from "@earendil-works/pi-coding-agent";
const host = vi.hoisted((): { version: unknown } => ({ version: "host-version-from-runtime" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof SDK>()),
  get VERSION() {
    return host.version;
  },
}));
import { captureArtifactVersion, captureWorkspaceArtifactVersion } from "../artifact-version";
import type { WorkOwnerKey } from "../control-journal";
const roots: string[] = [];
afterEach(() => {
  host.version = "host-version-from-runtime";
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace() {
  const root = mkdtempSync("/tmp/artifact-host-version-");
  roots.push(root);
  execFileSync("git", ["init", "--quiet", root], { timeout: 2000, stdio: "ignore" });
  writeFileSync(join(root, "input.txt"), "declared");
  return root;
}
const owner: WorkOwnerKey = {
  kind: "goal",
  goal: { sessionId: "owned", goalKey: "owned", goalRunId: null, lifecycleCommitId: null },
};
it("captures the SDK-provided host version, independent of a physically resolvable peer package", () => {
  const root = workspace();
  const actual = captureWorkspaceArtifactVersion(root, owner);
  const expected = captureArtifactVersion(
    {
      scopeId: "git-visible-workspace-v1",
      owner,
      root,
      inputs: ["input.txt"],
      artifacts: [],
      environmentKeys: ["NODE_VERSION", "SDK_VERSION"],
    },
    { NODE_VERSION: process.version, SDK_VERSION: "host-version-from-runtime" },
  );
  expect(actual.status).toBe("known");
  expect(actual).toEqual(expected);
});
it("retains unknown rather than inventing a host version when the SDK does not supply one", () => {
  host.version = undefined;
  expect(captureWorkspaceArtifactVersion(workspace(), owner)).toMatchObject({
    status: "unknown",
    reason: "WORKSPACE_SCOPE_UNAVAILABLE",
  });
});
