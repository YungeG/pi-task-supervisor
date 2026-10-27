// Approved C2 planning seam: an unowned draft has file facts, never a fabricated owner
// or durable artifact-acceptance/permission fact. Only owned temporary inputs are read.
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureUnownedArtifactInputs, captureArtifactVersion } from "../artifact-version";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "owned-p7-draft-"));
  roots.push(root);
  writeFileSync(join(root, "check.mjs"), "export const owned=true;\n");
  return {
    scopeId: "unowned-draft",
    root,
    inputs: ["check.mjs"],
    artifacts: [],
    environmentKeys: ["LANG"],
  };
}
it("captures draft checker/config/profile bytes without minting an owner or ArtifactVersion", () => {
  const scope = fixture(),
    draft = captureUnownedArtifactInputs(scope, { LANG: "C" });
  expect(draft.status).toBe("known");
  if (draft.status !== "known") throw Error("Owned draft unavailable");
  expect(draft.snapshot.inputs).toMatchObject([{ path: "check.mjs", bytes: 25 }]);
  expect(draft.snapshot).not.toHaveProperty("owner");
  expect(draft.snapshot).not.toHaveProperty("versionId");
  const version = captureArtifactVersion(
    {
      ...scope,
      owner: {
        kind: "goal",
        goal: { sessionId: "owned", goalKey: "owned", goalRunId: null, lifecycleCommitId: null },
      },
    },
    { LANG: "C" },
  );
  expect(version.status).toBe("known");
  if (version.status !== "known") throw Error("Owned byte capture unavailable");
  expect(draft.snapshot.inputs).toEqual(version.version.inputs);
  expect(draft.snapshot.environmentDigest).toBe(version.version.environmentDigest);
});
it.each(["too-many-inputs", "regular-file-root", "missing-root", "symlink-root"])(
  "does not mint a draft snapshot for %s",
  (kind) => {
    let scope = fixture();
    if (kind === "too-many-inputs")
      scope = { ...scope, inputs: Array.from({ length: 10001 }, (_, i) => `f-${i}`) };
    if (kind === "regular-file-root") scope = { ...scope, root: join(scope.root, "check.mjs") };
    if (kind === "missing-root") scope = { ...scope, root: join(scope.root, "missing") };
    if (kind === "symlink-root") {
      const path = join(scope.root, "alias");
      symlinkSync(scope.root, path);
      scope = { ...scope, root: path };
    }
    const result = captureUnownedArtifactInputs(scope, { LANG: "C" });
    expect(result.status).toBe("unknown");
    expect(result).not.toHaveProperty("snapshot");
    expect(result).not.toHaveProperty("owner");
    expect(result).not.toHaveProperty("versionId");
  },
);
it("retains P0 path/environment refusal before any native confirmation", () => {
  const scope = fixture();
  symlinkSync("check.mjs", join(scope.root, "link.mjs"));
  expect(
    captureUnownedArtifactInputs({ ...scope, inputs: ["link.mjs"] }, { LANG: "C" }).status,
  ).toBe("unknown");
  expect(
    captureUnownedArtifactInputs({ ...scope, inputs: ["../other"] }, { LANG: "C" }).status,
  ).toBe("unknown");
  expect(
    captureUnownedArtifactInputs(
      { ...scope, environmentKeys: ["API_TOKEN"] },
      { API_TOKEN: "forbidden" },
    ).status,
  ).toBe("unknown");
});
