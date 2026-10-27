import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspaceArtifactVersion } from "../artifact-version";
import type { WorkOwnerKey } from "../control-journal";
const owner: WorkOwnerKey = {
  kind: "goal",
  goal: {
    sessionId: "owned-session",
    goalKey: "owned-goal",
    goalRunId: "owned-goal",
    lifecycleCommitId: "owned-lifecycle",
  },
};
it("captures actual declared Git-visible inputs, not the mutable Session journal, and detects source changes", () => {
  const root = mkdtempSync(join(tmpdir(), "review-workspace-"));
  try {
    execFileSync("git", ["init", "--quiet", root], { timeout: 2000, stdio: "ignore" });
    writeFileSync(join(root, "input.ts"), "export const value = 1;\n");
    const session = join(root, "session.jsonl");
    writeFileSync(session, "synthetic current journal\n");
    const first = captureWorkspaceArtifactVersion(root, owner, session);
    expect(first.status).toBe("known");
    if (first.status !== "known") return;
    expect(first.version.inputs.map((file) => file.path)).toEqual(["input.ts"]);
    appendFileSync(session, "own control append\n");
    const ownAppend = captureWorkspaceArtifactVersion(root, owner, session);
    expect(ownAppend.status).toBe("known");
    if (ownAppend.status !== "known") return;
    expect(ownAppend.version.versionId).toBe(first.version.versionId);
    writeFileSync(join(root, "input.ts"), "export const value = 2;\n");
    const changed = captureWorkspaceArtifactVersion(root, owner, session);
    expect(changed.status).toBe("known");
    if (changed.status !== "known") return;
    expect(changed.version.versionId).not.toBe(first.version.versionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
