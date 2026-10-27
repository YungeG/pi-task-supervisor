import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validWorkOwner, type WorkOwnerKey } from "./control-journal";
import { redact } from "./receipt-store";

export interface ArtifactScope {
  readonly scopeId: string;
  readonly owner: WorkOwnerKey;
  readonly root: string;
  readonly inputs: readonly string[];
  readonly artifacts: readonly string[];
  readonly environmentKeys: readonly string[];
}
export interface ArtifactFileDigest {
  path: string;
  bytes: number;
  sha256: string;
}
export interface ArtifactVersionV1 {
  version: 1;
  scopeId: string;
  workspace: { root: string; device: string; inode: string };
  scopeDigest: string;
  inputs: ArtifactFileDigest[];
  artifacts: ArtifactFileDigest[];
  inputsDigest: string;
  artifactDigest: string;
  environmentDigest: string;
  versionId: string;
}
export type ArtifactVersionResult =
  | { status: "known"; version: ArtifactVersionV1 }
  | { status: "unknown"; reason: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function versionDigest(value: Omit<ArtifactVersionV1, "versionId">): string {
  const files = (entries: ArtifactFileDigest[]) =>
    entries.map((entry) => [entry.path, entry.bytes, entry.sha256]);
  return hash([
    "artifact-version-v1",
    value.version,
    value.scopeId,
    [value.workspace.root, value.workspace.device, value.workspace.inode],
    value.scopeDigest,
    files(value.inputs),
    files(value.artifacts),
    value.inputsDigest,
    value.artifactDigest,
    value.environmentDigest,
  ]);
}
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
class CaptureFault extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function boundedDigest(fd: number, limit: number): { bytes: number; sha256: string } {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const digest = createHash("sha256");
  let bytes = 0;
  for (;;) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit - bytes + 1), null);
    if (!count) break;
    bytes += count;
    if (bytes > limit) throw new CaptureFault("RESOURCE_LIMIT");
    digest.update(buffer.subarray(0, count));
  }
  return { bytes, sha256: digest.digest("hex") };
}
// The host supplies an explicit nonsecret allowlist; never enumerate process.env.
function captureEnvironment(
  keys: readonly string[],
  environment: Readonly<Record<string, string>>,
): (readonly [string, string])[] {
  if (keys.length > 64 || new Set(keys).size !== keys.length)
    throw new CaptureFault("INVALID_ENVIRONMENT");
  return [...keys].sort().map((key) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(key) ||
      /secret|token|password|auth|credential|private.?key|api.?key|cookie/i.test(key)
    )
      throw new CaptureFault("INVALID_ENVIRONMENT");
    const value: unknown = Object.getOwnPropertyDescriptor(environment, key)?.value;
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) > 1000 ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    )
      throw new CaptureFault("INVALID_ENVIRONMENT");
    if (value && redact(value, 1001) !== value) throw new CaptureFault("INVALID_ENVIRONMENT");
    return [key, value] as const;
  });
}
function ownerTuple(owner: WorkOwnerKey): unknown[] {
  return owner.kind === "goal"
    ? [
        "goal",
        owner.goal.sessionId,
        owner.goal.goalKey,
        owner.goal.goalRunId,
        owner.goal.lifecycleCommitId,
      ]
    : ["board", owner.board.sessionId, owner.board.boardRunId, owner.board.seedEntryId];
}
function validPaths(paths: readonly string[]): boolean {
  return (
    new Set(paths).size === paths.length &&
    paths.every(
      (path) =>
        typeof path === "string" &&
        Buffer.byteLength(path) <= 4096 &&
        !/[\\\\\p{Cc}\p{Cf}\p{Cs}]/u.test(path) &&
        !/^[A-Za-z]:/.test(path) &&
        path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    )
  );
}
const stamp = (stat: BigIntStats): string =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
function remember(sources: Map<string, string>, path: string, stat: BigIntStats): void {
  const observed = stamp(stat);
  const previous = sources.get(path);
  if (previous !== undefined && previous !== observed) throw new CaptureFault("SOURCE_CHANGED");
  sources.set(path, observed);
}
function assertSources(sources: Map<string, string>): void {
  for (const [path, expected] of sources) {
    if (stamp(lstatSync(path, { bigint: true })) !== expected)
      throw new CaptureFault("SOURCE_CHANGED");
  }
}
function validScope(scope: Omit<ArtifactScope, "owner">): boolean {
  return (
    scope.scopeId.trim().length > 0 &&
    Buffer.byteLength(scope.scopeId) <= 200 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(scope.scopeId) &&
    isAbsolute(scope.root) &&
    scope.inputs.length + scope.artifacts.length > 0 &&
    validPaths([...scope.inputs, ...scope.artifacts])
  );
}
function regularPath(root: string, path: string, sources: Map<string, string>): string {
  let full = root;
  const parts = path.split("/");
  parts.forEach((part, index) => {
    full = join(full, part);
    const stat = lstatSync(full, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
    )
      throw Error("UNSAFE_SOURCE");
    remember(sources, full, stat);
  });
  return full;
}
function captureFiles(
  root: string,
  paths: readonly string[],
  budget: { bytes: number },
  sources: Map<string, string>,
): ArtifactFileDigest[] {
  return [...paths].sort().map((path) => {
    const full = regularPath(root, path, sources);
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) throw Error("UNSAFE_SOURCE");
      if (sources.get(full) !== stamp(stat)) throw new CaptureFault("SOURCE_CHANGED");
      const limit = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - budget.bytes);
      if (stat.size < 0n || stat.size > BigInt(limit)) throw new CaptureFault("RESOURCE_LIMIT");
      const result = boundedDigest(fd, limit);
      if (
        result.bytes !== Number(stat.size) ||
        stamp(fstatSync(fd, { bigint: true })) !== stamp(stat)
      )
        throw new CaptureFault("SOURCE_CHANGED");
      budget.bytes += result.bytes;
      return { path, ...result };
    } finally {
      closeSync(fd);
    }
  });
}
export interface UnownedArtifactInputs {
  scopeId: string;
  workspace: { root: string; device: string; inode: string };
  inputs: ArtifactFileDigest[];
  artifacts: ArtifactFileDigest[];
  environmentDigest: string;
}
/** Read-only planning inventory, intentionally not an ArtifactVersion or owner/grant.
 * The existing owned v1 producer/preimage below remains unchanged. */
export function captureUnownedArtifactInputs(
  scope: Omit<ArtifactScope, "owner">,
  environment: Readonly<Record<string, string>>,
): { status: "known"; snapshot: UnownedArtifactInputs } | { status: "unknown"; reason: string } {
  try {
    if (scope.inputs.length + scope.artifacts.length > 10000)
      throw new CaptureFault("RESOURCE_LIMIT");
    if (!validScope(scope)) return { status: "unknown", reason: "INVALID_SCOPE" };
    const root = resolve(scope.root),
      stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || realpathSync(root) !== root) throw Error("UNSAFE_SOURCE");
    const environmentEntries = captureEnvironment(scope.environmentKeys, environment),
      budget = { bytes: 0 },
      sources = new Map<string, string>();
    remember(sources, root, stat);
    const inputs = captureFiles(root, scope.inputs, budget, sources),
      artifacts = captureFiles(root, scope.artifacts, budget, sources);
    assertSources(sources);
    return {
      status: "known",
      snapshot: {
        scopeId: scope.scopeId,
        workspace: { root, device: String(stat.dev), inode: String(stat.ino) },
        inputs,
        artifacts,
        environmentDigest: hash(environmentEntries),
      },
    };
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof CaptureFault ? error.code : "SOURCE_UNAVAILABLE",
    };
  }
}
export function captureArtifactVersion(
  scope: ArtifactScope,
  environment: Readonly<Record<string, string>>,
): ArtifactVersionResult {
  try {
    if (!validWorkOwner(scope.owner)) return { status: "unknown", reason: "INVALID_OWNER" };
    if (scope.inputs.length + scope.artifacts.length > 10_000)
      throw new CaptureFault("RESOURCE_LIMIT");
    if (!validScope(scope)) return { status: "unknown", reason: "INVALID_SCOPE" };
    const root = resolve(scope.root);
    const stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || realpathSync(root) !== root) throw Error("UNSAFE_SOURCE");
    const workspace = { root, device: String(stat.dev), inode: String(stat.ino) };
    const environmentEntries = captureEnvironment(scope.environmentKeys, environment);
    const budget = { bytes: 0 };
    const sources = new Map<string, string>();
    remember(sources, root, stat);
    const inputs = captureFiles(root, scope.inputs, budget, sources);
    const artifacts = captureFiles(root, scope.artifacts, budget, sources);
    assertSources(sources);
    const scopeDigest = hash([
      "artifact-scope-v1",
      ownerTuple(scope.owner),
      scope.scopeId,
      workspace,
      inputs.map((x) => x.path),
      artifacts.map((x) => x.path),
      environmentEntries.map((x) => x[0]),
    ]);
    const inputsDigest = hash(inputs);
    const artifactDigest = hash(artifacts);
    const environmentDigest = hash(environmentEntries);
    const body: Omit<ArtifactVersionV1, "versionId"> = {
      version: 1,
      scopeId: scope.scopeId,
      workspace,
      scopeDigest,
      inputs,
      artifacts,
      inputsDigest,
      artifactDigest,
      environmentDigest,
    };
    return { status: "known", version: { ...body, versionId: versionDigest(body) } };
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof CaptureFault ? error.code : "SOURCE_UNAVAILABLE",
    };
  }
}
export function verifyArtifactVersion(
  expected: Omit<ArtifactVersionV1, "version"> & { version: number },
  scope: ArtifactScope,
  environment: Readonly<Record<string, string>>,
): "same" | "changed" | "unknown" {
  try {
    if (expected.version !== 1 || expected.versionId !== versionDigest({ ...expected, version: 1 }))
      return "unknown";
  } catch {
    return "unknown";
  }
  const current = captureArtifactVersion(scope, environment);
  return current.status === "unknown"
    ? "unknown"
    : current.version.versionId === expected.versionId
      ? "same"
      : "changed";
}

/** Fixed host policy: Git-visible workspace source, never a model-supplied path manifest. */
function workspaceFiles(root: string, sessionFile: string | undefined): string[] {
  const output = execFileSync(
    "git",
    [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const paths = output
    .split("\0")
    .filter(Boolean)
    .filter((name) => !sessionFile || resolve(root, name) !== resolve(sessionFile))
    .sort();
  if (!paths.length || paths.length > 10000 || new Set(paths).size !== paths.length)
    throw new CaptureFault("WORKSPACE_SCOPE_UNAVAILABLE");
  if (
    paths.some((name) =>
      /(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials(?:\.[^/]*)?|id_(?:rsa|ed25519))$/i.test(
        name,
      ),
    )
  )
    throw new CaptureFault("WORKSPACE_PRIVATE_INPUT_UNDECLARED");
  return paths;
}
export function captureWorkspaceArtifactVersion(
  root: string,
  owner: WorkOwnerKey,
  sessionFile?: string,
): ArtifactVersionResult {
  try {
    if (!validWorkOwner(owner)) throw new CaptureFault("INVALID_OWNER");
    const absolute = resolve(root);
    if (realpathSync(absolute) !== absolute) throw new CaptureFault("WORKSPACE_SCOPE_UNAVAILABLE");
    const inputs = workspaceFiles(absolute, sessionFile);
    const sdkRoot = dirname(
      dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    );
    const sdk = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof sdk.version !== "string") throw new CaptureFault("WORKSPACE_SCOPE_UNAVAILABLE");
    const result = captureArtifactVersion(
      {
        scopeId: "git-visible-workspace-v1",
        owner,
        root: absolute,
        inputs,
        artifacts: [],
        environmentKeys: ["NODE_VERSION", "SDK_VERSION"],
      },
      { NODE_VERSION: process.version, SDK_VERSION: sdk.version },
    );
    if (JSON.stringify(workspaceFiles(absolute, sessionFile)) !== JSON.stringify(inputs))
      throw new CaptureFault("SOURCE_CHANGED");
    return result;
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof CaptureFault ? error.code : "WORKSPACE_SCOPE_UNAVAILABLE",
    };
  }
}
