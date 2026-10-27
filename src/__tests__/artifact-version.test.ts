import {
  appendFileSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});
import { captureArtifactVersion, verifyArtifactVersion } from "../artifact-version";

const directories: string[] = [];
afterEach(() => {
  vi.mocked(readSync).mockReset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "artifact-version-"));
  directories.push(root);
  writeFileSync(join(root, "input.txt"), "hello\n");
  writeFileSync(join(root, "output.txt"), "result\n");
  const scope = {
    scopeId: "approved-local-inputs",
    owner: {
      kind: "goal" as const,
      goal: {
        sessionId: "synthetic-session",
        goalKey: "goal-1",
        goalRunId: "goal-1",
        lifecycleCommitId: "commit-1",
      },
    },
    root,
    inputs: ["input.txt"],
    artifacts: ["output.txt"],
    environmentKeys: ["node", "sdk"],
  };
  return { root, scope, environment: { node: "25.9.0", sdk: "1.1.0" } };
}
it.each(["empty scope id", "no declared files"])(
  "rejects an unusable artifact definition: %s",
  (kind) => {
    const h = fixture();
    if (kind === "empty scope id") h.scope.scopeId = "";
    else {
      h.scope.inputs = [];
      h.scope.artifacts = [];
    }
    expect(captureArtifactVersion(h.scope, h.environment).status).toBe("unknown");
    expect(readSync).not.toHaveBeenCalled();
  },
);
it("streams multiple chunks with the same declared file checksum", () => {
  const h = fixture();
  const bytes = Buffer.alloc(70_001, 97);
  writeFileSync(join(h.root, "input.txt"), bytes);
  const result = captureArtifactVersion(h.scope, h.environment);
  if (result.status !== "known") throw Error("No captured version");
  expect(result.version.inputs[0]?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(verifyArtifactVersion(result.version, h.scope, h.environment)).toBe("same");
});
it("canonicalizes declaration order and ignores undeclared environment values", () => {
  const h = fixture();
  writeFileSync(join(h.root, "second.txt"), "second");
  h.scope.inputs.push("second.txt");
  const first = captureArtifactVersion(h.scope, h.environment);
  const second = captureArtifactVersion(
    {
      ...h.scope,
      inputs: [...h.scope.inputs].reverse(),
      environmentKeys: [...h.scope.environmentKeys].reverse(),
    },
    Object.defineProperty({ sdk: "1.1.0", node: "25.9.0" }, "IGNORED_SECRET", {
      get: () => {
        throw Error("Must not enumerate ambient secrets");
      },
    }),
  );
  expect(first.status).toBe("known");
  expect(second).toEqual(first);
});
it.each(["input", "environment", "owner", "scope"])(
  "detects a changed %s independently of product bytes",
  (kind) => {
    const h = fixture();
    const result = captureArtifactVersion(h.scope, h.environment);
    if (result.status !== "known") throw Error("No captured version");
    if (kind === "input") writeFileSync(join(h.root, "input.txt"), "new input");
    if (kind === "environment") h.environment.sdk = "different-installed-version";
    if (kind === "owner") {
      h.scope.owner.goal.goalKey = "goal-2";
      h.scope.owner.goal.goalRunId = "goal-2";
    }
    if (kind === "scope") h.scope.scopeId = "new-contract-revision";
    expect(verifyArtifactVersion(result.version, h.scope, h.environment)).toBe("changed");
  },
);
it("does not interpret missing inputs as an empty successful tree", () => {
  const h = fixture();
  const result = captureArtifactVersion(h.scope, h.environment);
  if (result.status !== "known") throw Error("No captured version");
  rmSync(join(h.root, "input.txt"));
  expect(verifyArtifactVersion(result.version, h.scope, h.environment)).toBe("unknown");
});
it("closes its descriptor when an actual read boundary fails", () => {
  const h = fixture();
  vi.mocked(readSync).mockImplementationOnce(() => {
    throw Error("synthetic EIO");
  });
  expect(captureArtifactVersion(h.scope, h.environment).status).toBe("unknown");
  const fd = vi.mocked(readSync).mock.calls[0]?.[0];
  if (fd === undefined) throw Error("No read attempted");
  expect(() => fstatSync(fd)).toThrow();
});
it.each(["", "/input.txt", "a/../input.txt", "./input.txt", "a\\\\input.txt", "input.txt\u0000"])(
  "rejects a noncanonical declared path %j before data reads",
  (path) => {
    const h = fixture();
    expect(captureArtifactVersion({ ...h.scope, inputs: [path] }, h.environment).status).toBe(
      "unknown",
    );
    expect(readSync).not.toHaveBeenCalled();
  },
);
it("rejects duplicate declarations before data reads", () => {
  const h = fixture();
  expect(
    captureArtifactVersion({ ...h.scope, inputs: ["input.txt", "input.txt"] }, h.environment)
      .status,
  ).toBe("unknown");
  expect(readSync).not.toHaveBeenCalled();
});
it("bounds declaration count before probing nonexistent input paths", () => {
  const h = fixture();
  expect(
    captureArtifactVersion(
      { ...h.scope, inputs: Array.from({ length: 10_001 }, (_, index) => `missing-${index}`) },
      h.environment,
    ),
  ).toEqual({ status: "unknown", reason: "RESOURCE_LIMIT" });
  expect(readSync).not.toHaveBeenCalled();
});
it("rejects altered version metadata even when its copied version ID still matches", () => {
  const h = fixture();
  const result = captureArtifactVersion(h.scope, h.environment);
  if (result.status !== "known") throw Error("No captured version");
  expect(
    verifyArtifactVersion({ ...result.version, scopeId: "altered" }, h.scope, h.environment),
  ).toBe("unknown");
});
it("classifies an unsupported version as unknown", () => {
  const h = fixture();
  const result = captureArtifactVersion(h.scope, h.environment);
  if (result.status !== "known") throw Error("No captured version");
  expect(verifyArtifactVersion({ ...result.version, version: 2 }, h.scope, h.environment)).toBe(
    "unknown",
  );
});
it("does not confuse an explicit empty environment value with a missing one", () => {
  const h = fixture();
  expect(captureArtifactVersion(h.scope, { ...h.environment, sdk: "" }).status).toBe("known");
});
it("rejects an invalid scoped owner before reading data", () => {
  const h = fixture();
  h.scope.owner.goal.goalKey = "not-this-run";
  expect(captureArtifactVersion(h.scope, h.environment).status).toBe("unknown");
  expect(readSync).not.toHaveBeenCalled();
});
it("detects a concurrent same-content write rather than trusting equal byte hashes", async () => {
  const h = fixture();
  const fs = await vi.importActual<typeof Fs>("node:fs");
  vi.mocked(readSync).mockImplementationOnce((...args: Parameters<typeof readSync>) => {
    const count = fs.readSync(...args);
    writeFileSync(join(h.root, "input.txt"), "hello\n");
    utimesSync(join(h.root, "input.txt"), 1, 2);
    return count;
  });
  expect(captureArtifactVersion(h.scope, h.environment)).toEqual({
    status: "unknown",
    reason: "SOURCE_CHANGED",
  });
});
it("treats a missing declared environment input as unknown, not an empty value", () => {
  const h = fixture();
  expect(captureArtifactVersion(h.scope, { node: h.environment.node }).status).toBe("unknown");
});
it("does not accept sensitive environment names as artifact inputs", () => {
  const h = fixture();
  expect(
    captureArtifactVersion(
      { ...h.scope, environmentKeys: ["API_TOKEN"] },
      { API_TOKEN: "synthetic-nonsecret-fixture" },
    ).status,
  ).toBe("unknown");
});
it.each([1, 2])(
  "refuses a mutation during data chunk %s, including an already-read input",
  async (chunk) => {
    const h = fixture();
    const fs = await vi.importActual<typeof Fs>("node:fs");
    let chunks = 0;
    vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
      const count = fs.readSync(...args);
      if (count && ++chunks === chunk) appendFileSync(join(h.root, "input.txt"), "late mutation");
      return count;
    });
    expect(captureArtifactVersion(h.scope, h.environment)).toEqual({
      status: "unknown",
      reason: "SOURCE_CHANGED",
    });
    expect(chunks).toBeGreaterThanOrEqual(chunk);
  },
);
it("enforces the shared 64 MiB quota across individually legal files", () => {
  const h = fixture();
  h.scope.inputs = Array.from({ length: 5 }, (_, index) => `quota-${index}.txt`);
  h.scope.artifacts = [];
  h.scope.inputs.forEach((path, index) => {
    writeFileSync(join(h.root, path), "");
    truncateSync(join(h.root, path), index < 4 ? 16 * 1024 * 1024 : 1);
  });
  expect(captureArtifactVersion(h.scope, h.environment)).toEqual({
    status: "unknown",
    reason: "RESOURCE_LIMIT",
  });
  const readBytes = vi
    .mocked(readSync)
    .mock.results.reduce((sum, result) => sum + (result.type === "return" ? result.value : 0), 0);
  expect(readBytes).toBe(64 * 1024 * 1024);
});
it("refuses an oversized file before treating the capture as a known version", () => {
  const h = fixture();
  truncateSync(join(h.root, "input.txt"), 16 * 1024 * 1024 + 1);
  expect(captureArtifactVersion(h.scope, h.environment)).toEqual({
    status: "unknown",
    reason: "RESOURCE_LIMIT",
  });
});
it.each(["file", "parent", "root"])(
  "refuses a symbolic-link %s rather than qualifying its target",
  (kind) => {
    const h = fixture();
    if (kind === "file") {
      symlinkSync("input.txt", join(h.root, "alias.txt"));
      h.scope.inputs = ["alias.txt"];
    } else if (kind === "parent") {
      mkdirSync(join(h.root, "dir"));
      writeFileSync(join(h.root, "dir", "input.txt"), "nested fixture");
      symlinkSync("dir", join(h.root, "alias"));
      h.scope.inputs = ["alias/input.txt"];
    } else {
      symlinkSync(h.root, join(h.root, "alias"));
      h.scope.root = join(h.root, "alias");
    }
    expect(captureArtifactVersion(h.scope, h.environment).status).toBe("unknown");
  },
);
it("refuses traversal outside the declared artifact root instead of fingerprinting it", () => {
  const h = fixture();
  const outside = mkdtempSync(join(tmpdir(), "artifact-outside-"));
  directories.push(outside);
  writeFileSync(join(outside, "outside.txt"), "owned fixture outside the declared scope");
  const result = captureArtifactVersion(
    { ...h.scope, inputs: [relative(h.root, join(outside, "outside.txt"))] },
    h.environment,
  );
  expect(result.status).toBe("unknown");
});
it("captures declared bytes and detects a later product change without changing the files", () => {
  const h = fixture();
  const first = captureArtifactVersion(h.scope, h.environment);
  expect(first.status).toBe("known");
  if (first.status !== "known") throw Error("No captured version");
  expect(first.version.inputs[0]?.sha256).toBe(
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  );
  expect(verifyArtifactVersion(first.version, h.scope, h.environment)).toBe("same");
  writeFileSync(join(h.root, "output.txt"), "changed\n");
  expect(verifyArtifactVersion(first.version, h.scope, h.environment)).toBe("changed");
});
