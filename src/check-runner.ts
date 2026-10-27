import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  captureArtifactVersion,
  type ArtifactScope,
  type ArtifactVersionResult,
  type ArtifactVersionV1,
} from "./artifact-version";

/** Native finite-check mechanics only. No caller of this function obtains a trusted
 * contract, permission, source qualification, task completion or acceptance. */
export interface NativeCheckInvocation {
  scope: ArtifactScope;
  script: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
}
export interface NativeCheckExecution {
  invocation: { executable: string; args: string[]; cwd: string; environmentDigest: string };
  pid: number | null;
  closed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  termination: "exited" | "cancelled" | "timed_out" | "output_limit" | "spawn_error" | "unknown";
  stdout: string;
  stderr: string;
  outputDigest: string;
  before: ArtifactVersionV1;
  beforeGeneration: string;
  after: CheckVersionResult;
}
export type CheckVersionResult =
  | { status: "known"; version: ArtifactVersionV1; inputGeneration: string }
  | Extract<ArtifactVersionResult, { status: "unknown" }>;
function inputGeneration(version: ArtifactVersionV1): string {
  const root = version.workspace.root,
    rootStat = lstatSync(root, { bigint: true });
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    String(rootStat.dev) !== version.workspace.device ||
    String(rootStat.ino) !== version.workspace.inode
  )
    throw Error("Input workspace identity changed");
  const entries: unknown[] = [
    [root, String(rootStat.dev), String(rootStat.ino), String(rootStat.mode)],
  ];
  const paths = [...version.inputs, ...version.artifacts].map((file) => file.path).sort();
  for (const path of paths) {
    let full = root;
    const parts = path.split("/");
    parts.forEach((part, index) => {
      full = join(full, part);
      const stat = lstatSync(full, { bigint: true }),
        last = index === parts.length - 1;
      if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory()))
        throw Error("Input generation source is unsafe");
      entries.push([
        full,
        String(stat.dev),
        String(stat.ino),
        String(stat.mode),
        ...(last ? [String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)] : []),
      ]);
    });
  }
  return createHash("sha256")
    .update(JSON.stringify(["check-input-generation-v1", version.scopeDigest, entries]))
    .digest("hex");
}
/** Separate generation observations preserve the old P0 byte/hash contract. They are
 * not an OS-atomic snapshot, progress credit, a durable receipt or an authority token. */
export function captureCheckVersion(
  scope: ArtifactScope,
  environment: Readonly<Record<string, string>>,
): CheckVersionResult {
  const before = captureArtifactVersion(scope, environment);
  if (before.status !== "known") return before;
  try {
    const first = inputGeneration(before.version),
      after = captureArtifactVersion(scope, environment);
    if (after.status !== "known") return after;
    const last = inputGeneration(after.version);
    if (first !== last || before.version.versionId !== after.version.versionId)
      return { status: "unknown", reason: "CHECK_INPUT_CHANGED" };
    return { status: "known", version: after.version, inputGeneration: last };
  } catch {
    return { status: "unknown", reason: "CHECK_INPUT_GENERATION_UNAVAILABLE" };
  }
}
const originalExecutions = new WeakMap<object, NativeCheckExecution>();
/** An SDK/JSON copy is deliberately not an actual execution in this process. */
export function nativeCheckExecution(value: unknown): NativeCheckExecution | undefined {
  return value && typeof value === "object" ? originalExecutions.get(value) : undefined;
}
function freezeExecution<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeExecution(child);
    Object.freeze(value);
  }
  return value;
}
function invocationArguments(input: NativeCheckInvocation, root: string): string[] {
  const paths = [...input.scope.inputs, ...input.scope.artifacts];
  if (
    !input.scope.inputs.includes(input.script) ||
    paths.length > 512 ||
    paths.some((path) => /[*?{},[\]]/.test(resolve(root, path)))
  )
    throw Error("Native check needs an exact bounded captured script/read-file inventory");
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 30000 ||
    input.args.length > 64 ||
    input.args.some(
      (arg) =>
        typeof arg !== "string" ||
        Buffer.byteLength(arg) > 1000 ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(arg),
    )
  )
    throw Error("Native check invocation exceeds its declared finite bounds");
  if (
    input.scope.environmentKeys.some((key) =>
      /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/i.test(
        key,
      ),
    )
  )
    throw Error("Native check environment may not inject another execution profile");
  return [
    "--permission",
    ...paths.map((path) => `--allow-fs-read=${resolve(root, path)}`),
    resolve(root, input.script),
    ...input.args,
  ];
}
interface ProcessResult {
  pid: number | null;
  closed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  termination: NativeCheckExecution["termination"];
  stdout: string;
  stderr: string;
  outputDigest: string;
}
function executeFiniteNode(
  executable: string,
  args: string[],
  cwd: string,
  environment: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (signal?.aborted)
    return Promise.resolve({
      pid: null,
      closed: true,
      exitCode: null,
      signal: null,
      termination: "cancelled",
      stdout: "",
      stderr: "",
      outputDigest: createHash("sha256").digest("hex"),
    });
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let termination: ProcessResult["termination"] = "exited",
      finished = false,
      bytes = 0;
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] },
      digest = createHash("sha256");
    const timers: NodeJS.Timeout[] = [];
    const finish = (
      closed: boolean,
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveResult({
        pid: child.pid ?? null,
        closed,
        exitCode,
        signal: exitSignal,
        termination: closed ? termination : "unknown",
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        outputDigest: digest.digest("hex"),
      });
    };
    const stop = (reason: ProcessResult["termination"]) => {
      if (finished || termination !== "exited") return;
      termination = reason;
      child.kill("SIGTERM");
      timers.push(
        setTimeout(() => {
          if (!finished) child.kill("SIGKILL");
        }, 100),
      );
    };
    const abort = () => {
      stop("cancelled");
    };
    const output = (kind: "stdout" | "stderr", data: Buffer) => {
      if (finished) return;
      digest.update(`${kind}:${data.length}:`).update(data);
      const remaining = Math.max(0, 65536 - bytes);
      if (remaining) chunks[kind].push(data.subarray(0, remaining));
      bytes += data.length;
      if (bytes > 65536) stop("output_limit");
    };
    child.stdout.on("data", (data: Buffer) => {
      output("stdout", data);
    });
    child.stderr.on("data", (data: Buffer) => {
      output("stderr", data);
    });
    child.once("error", () => {
      termination = "spawn_error";
    });
    child.once("close", (code, exitSignal) => {
      finish(true, code, exitSignal);
    });
    timers.push(
      setTimeout(() => {
        stop("timed_out");
      }, timeoutMs),
    );
    // A signal/timeout/kill ACK is never close proof. Missing actual close stays unknown.
    timers.push(
      setTimeout(() => {
        finish(false, null, null);
      }, timeoutMs + 2000),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
/** Metadata preview shares the real argument encoder; it does not execute or grant trust. */
export function nativeCheckDescriptor(
  input: NativeCheckInvocation,
  version: ArtifactVersionV1,
): NativeCheckExecution["invocation"] {
  if (process.version !== "v25.9.0" || process.platform !== "linux")
    throw Error("Native check process capability is unqualified on this runtime");
  return {
    executable: process.execPath,
    args: invocationArguments(input, version.workspace.root),
    cwd: version.workspace.root,
    environmentDigest: version.environmentDigest,
  };
}
/** Initial capability is fixed Node25.9/Linux, read-only files and no child/worker/addon
 * permission. It is for recognized benign frozen checkers, not a hostile-code sandbox. */
export async function runNativeCheck(
  input: NativeCheckInvocation,
  signal?: AbortSignal,
): Promise<NativeCheckExecution> {
  if (process.version !== "v25.9.0" || process.platform !== "linux")
    throw Error("Native check process capability is unqualified on this runtime");
  const before = captureCheckVersion(input.scope, input.environment);
  if (before.status !== "known")
    throw Error(`Native check input capture is unknown: ${before.reason}`);
  const invocation = nativeCheckDescriptor(input, before.version);
  const environment = Object.fromEntries(
    input.scope.environmentKeys.map((key) => {
      const value: unknown = Object.getOwnPropertyDescriptor(input.environment, key)?.value;
      if (typeof value !== "string") throw Error("Native check environment changed after capture");
      return [key, value] as const;
    }),
  );
  const execution = await executeFiniteNode(
    invocation.executable,
    invocation.args,
    invocation.cwd,
    environment,
    input.timeoutMs,
    signal,
  );
  const result = freezeExecution({
    ...execution,
    invocation,
    before: before.version,
    beforeGeneration: before.inputGeneration,
    after: captureCheckVersion(input.scope, input.environment),
  });
  originalExecutions.set(result, result);
  return result;
}
