import { Type, type Static } from "typebox";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactScope, ArtifactVersionV1 } from "./artifact-version";

const strict = { additionalProperties: false } as const;
const text = (maxLength = 4096) => Type.String({ minLength: 1, maxLength });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const fileIdentity = Type.Object(
  {
    path: text(),
    bytes: Type.Integer({ minimum: 1, maximum: 33554432 }),
    sha256: hash,
    generation: hash,
  },
  strict,
);
export const PythonProfileSchema = Type.Object(
  {
    id: Type.Literal("python-unittest-v1"),
    interpreterVersion: text(100),
    sqliteVersion: text(100),
    executable: fileIdentity,
    bootstrap: fileIdentity,
    stdlib: Type.Object({ root: text(), device: text(100), inode: text(100) }, strict),
    uid: Type.Integer({ minimum: 1 }),
    temporaryBase: Type.Literal("/tmp"),
    manifestDigest: hash,
  },
  strict,
);
export const NativeInvocationDescriptorSchema = Type.Object(
  {
    executable: text(),
    args: Type.Array(Type.String({ maxLength: 5000 }), { maxItems: 580 }),
    cwd: text(),
    environmentDigest: hash,
    nodeVersion: text(100),
    platform: text(100),
    profile: Type.Optional(PythonProfileSchema),
  },
  strict,
);
export const ExecutionDescriptorSchema = Type.Omit(NativeInvocationDescriptorSchema, [
  "nodeVersion",
  "platform",
]);
export type NativeInvocationDescriptor = Static<typeof NativeInvocationDescriptorSchema>;
export type ExecutionDescriptor = Omit<NativeInvocationDescriptor, "nodeVersion" | "platform">;
export interface NativeCheckPlan {
  scope: Omit<ArtifactScope, "owner">;
  script: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  checkId?: string;
  runtime?: "python-unittest-v1";
  tests?: readonly string[];
}
export interface PythonConfiguration {
  checkerRoot: string;
  checkerFiles: string[];
  script: string;
  module: string;
  tests: string[];
  timeoutMs: number;
  reads: string[];
  stdlibRoot: string;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const generation = (stat: BigIntStats) =>
  digest([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
const PYTHON = "/usr/bin/python3.13";
const BOOTSTRAP = fileURLToPath(new URL("./python-unittest-bootstrap.py", import.meta.url));
let cachedPython:
  | { key: string; profile: Omit<Static<typeof PythonProfileSchema>, "manifestDigest"> }
  | undefined;

function profileFile(path: string): Static<typeof fileIdentity> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 33554432n)
      throw Error("Finite profile runtime file is unavailable or over capacity");
    const bytes = readFileSync(fd);
    if (
      bytes.length !== Number(before.size) ||
      generation(fstatSync(fd, { bigint: true })) !== generation(before) ||
      generation(lstatSync(path, { bigint: true })) !== generation(before)
    )
      throw Error("Finite profile runtime file changed during capture");
    return {
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      generation: generation(before),
    };
  } finally {
    closeSync(fd);
  }
}
function observePythonRuntime(executable: string, uid: number) {
  const output = execFileSync(
    executable,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import json,os,sqlite3,sys,sysconfig;print(json.dumps(dict(version='.'.join(map(str,sys.version_info[:3])),stdlib=sysconfig.get_path('stdlib'),sqlite=sqlite3.sqlite_version,uid=os.geteuid())))",
    ],
    {
      env: {},
      timeout: 2000,
      maxBuffer: 4096,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const observed = JSON.parse(output) as {
    version?: unknown;
    stdlib?: unknown;
    sqlite?: unknown;
    uid?: unknown;
  };
  if (
    typeof observed.version !== "string" ||
    !/^3\.13\.\d+$/u.test(observed.version) ||
    typeof observed.stdlib !== "string" ||
    typeof observed.sqlite !== "string" ||
    observed.uid !== uid
  )
    throw Error("Python unittest runtime capability is unqualified");
  return { version: observed.version, stdlib: observed.stdlib, sqlite: observed.sqlite };
}
function cachedPythonProfile(key: string) {
  if (cachedPython?.key !== key) return;
  const stat = lstatSync(cachedPython.profile.stdlib.root, { bigint: true });
  if (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    String(stat.dev) === cachedPython.profile.stdlib.device &&
    String(stat.ino) === cachedPython.profile.stdlib.inode
  )
    return structuredClone(cachedPython.profile);
  return undefined;
}
function pythonProfile(): Omit<Static<typeof PythonProfileSchema>, "manifestDigest"> {
  const uid = process.geteuid?.();
  if (process.platform !== "linux" || uid === undefined || uid === 0)
    throw Error("Python unittest profile requires its non-root Linux host");
  const executable = realpathSync(PYTHON),
    bootstrap = realpathSync(BOOTSTRAP);
  const key = digest([
    generation(lstatSync(executable, { bigint: true })),
    generation(lstatSync(bootstrap, { bigint: true })),
    uid,
  ]);
  const cached = cachedPythonProfile(key);
  if (cached) return cached;
  const binary = profileFile(executable),
    program = profileFile(bootstrap);
  const observed = observePythonRuntime(executable, uid);
  const root = realpathSync(observed.stdlib),
    stat = lstatSync(root, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    generation(lstatSync(executable, { bigint: true })) !== binary.generation ||
    generation(lstatSync(bootstrap, { bigint: true })) !== program.generation
  )
    throw Error("Python unittest runtime changed during capability capture");
  const profile = {
    id: "python-unittest-v1" as const,
    interpreterVersion: observed.version,
    sqliteVersion: observed.sqlite,
    executable: binary,
    bootstrap: program,
    stdlib: { root, device: String(stat.dev), inode: String(stat.ino) },
    uid,
    temporaryBase: "/tmp" as const,
  };
  cachedPython = { key, profile: structuredClone(profile) };
  return profile;
}
function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !/[\\\p{Cc}\p{Cf}\p{Cs}*?{},[\]]/u.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function selectedFiles(input: NativeCheckPlan) {
  if (input.scope.checkerScopes === undefined)
    return { root: resolve(input.scope.root), inputs: input.scope.inputs };
  const selected = input.scope.checkerScopes.find((scope) => scope.checkId === input.checkId);
  if (!selected) throw Error("Native check needs its exact declared checker scope");
  return selected;
}
function readInventory(input: NativeCheckPlan): string[] {
  if (!isAbsolute(input.scope.root)) throw Error("Native check needs an absolute product root");
  const declarations = [
    { root: resolve(input.scope.root), inputs: [...input.scope.inputs, ...input.scope.artifacts] },
    ...(input.scope.checkerScopes ?? []),
  ];
  const paths: string[] = [];
  for (const declaration of declarations) {
    if (
      !isAbsolute(declaration.root) ||
      resolve(declaration.root) !== declaration.root ||
      !declaration.inputs.every(safePath)
    )
      throw Error("Native check needs exact canonical captured paths");
    paths.push(...declaration.inputs.map((path) => resolve(declaration.root, path)));
  }
  if (paths.length > 512 || paths.some((path) => /[*?{},[\]]/u.test(path)))
    throw Error("Native check needs an exact bounded captured script/read-file inventory");
  return paths;
}
/** Syntax only; the fixed bootstrap still verifies the actual TestCase class/method. */
export function validPythonTestMethod(module: string, id: string): boolean {
  return (
    id.length <= 200 &&
    id.startsWith(module + ".") &&
    id.slice(module.length + 1).includes(".") &&
    /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*\.test_[A-Za-z0-9_]+$/u.test(id)
  );
}
function supportedRuntime(value: unknown): boolean {
  return value === undefined || value === "python-unittest-v1";
}
function validatePlan(input: NativeCheckPlan): void {
  if (process.version !== "v25.9.0" || process.platform !== "linux")
    throw Error("Native check process capability is unqualified on this runtime");
  const maximum = input.runtime === "python-unittest-v1" ? 120000 : 30000;
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > maximum ||
    input.args.length > 64 ||
    input.args.some(
      (arg) =>
        typeof arg !== "string" ||
        Buffer.byteLength(arg) > 1000 ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(arg),
    )
  )
    throw Error("Native check invocation exceeds its declared finite bounds");
  const injected =
    /^(NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHON.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|GCONV_PATH|LOCPATH|GLIBC_TUNABLES|OPENSSL_CONF|OPENSSL_MODULES|SUPERVISOR_.*)$/iu;
  if (
    input.scope.environmentKeys.some(
      (key) =>
        injected.test(key) ||
        (input.runtime === "python-unittest-v1" && /^(TMPDIR|TEMP|TMP|SQLITE_.*)$/iu.test(key)),
    )
  )
    throw Error("Native check environment may not inject another execution profile");
  if (!supportedRuntime(input.runtime)) throw Error("Unknown native check profile is unsupported");
}
export function prepareNativePlan(
  input: NativeCheckPlan,
  workspace: ArtifactVersionV1["workspace"],
  environmentDigest: string,
): { invocation: ExecutionDescriptor; python?: PythonConfiguration } {
  validatePlan(input);
  const selected = selectedFiles(input),
    paths = readInventory(input);
  if (!selected.inputs.includes(input.script) || !safePath(input.script))
    throw Error("Native check needs an exact bounded captured script/read-file inventory");
  if (input.runtime === undefined) {
    if (input.tests) throw Error("Node check cannot silently adopt a Python test selection");
    return {
      invocation: {
        executable: process.execPath,
        args: [
          "--permission",
          ...paths.map((path) => `--allow-fs-read=${path}`),
          resolve(selected.root, input.script),
          ...input.args,
        ],
        cwd: workspace.root,
        environmentDigest,
      },
    };
  }
  const module = input.script.replace(/\.py$/u, "").replaceAll("/", ".");
  if (
    !input.script.endsWith(".py") ||
    input.args.length ||
    !input.tests?.length ||
    input.tests.length > 32 ||
    new Set(input.tests).size !== input.tests.length ||
    input.tests.some((id) => !validPythonTestMethod(module, id)) ||
    paths.some((path) => /\.(so(?:\.\d+)*|dll|pyd|dylib)$/iu.test(path))
  )
    throw Error(
      "Python profile needs only explicit bounded TestCase.test_* methods and declared Python files",
    );
  const profile = pythonProfile();
  const python: PythonConfiguration = {
    checkerRoot: selected.root,
    checkerFiles: [...selected.inputs],
    script: resolve(selected.root, input.script),
    module,
    tests: [...input.tests],
    timeoutMs: input.timeoutMs,
    reads: paths,
    stdlibRoot: profile.stdlib.root,
  };
  if (Buffer.byteLength(JSON.stringify(python)) > 60000)
    throw Error("Python profile input manifest exceeds its finite capacity");
  return {
    invocation: {
      executable: profile.executable.path,
      args: ["-I", "-S", "-B", profile.bootstrap.path],
      cwd: workspace.root,
      environmentDigest,
      profile: { ...profile, manifestDigest: digest(python) },
    },
    python,
  };
}
/** Metadata only, without a pre-execution owner or any execution/approval brand. */
export function nativePlanDescriptor(
  input: NativeCheckPlan,
  workspace: ArtifactVersionV1["workspace"],
  environmentDigest: string,
): ExecutionDescriptor {
  return prepareNativePlan(input, workspace, environmentDigest).invocation;
}
