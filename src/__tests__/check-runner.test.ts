// Actual owned finite-process probes of the approved native check invocation seam.
// These establish runner mechanics, not trusted-contract, human or Goal acceptance.
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  runNativeCheck,
  nativeCheckExecution,
  captureCheckVersion,
  type NativeCheckInvocation,
  nativeCheckDescriptor,
} from "../check-runner";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function invocation(code: string, timeoutMs = 1000): NativeCheckInvocation {
  const root = mkdtempSync(join(tmpdir(), "owned-p7-finite-"));
  roots.push(root);
  writeFileSync(join(root, "check.mjs"), code);
  return {
    scope: {
      scopeId: "owned-finite",
      owner: {
        kind: "goal",
        goal: { sessionId: "owned", goalKey: "owned", goalRunId: null, lifecycleCommitId: null },
      },
      root,
      inputs: ["check.mjs"],
      artifacts: [],
      environmentKeys: [],
    },
    script: "check.mjs",
    args: [],
    environment: {},
    timeoutMs,
  };
}
it.each([
  "zero-timeout",
  "long-timeout",
  "nan-timeout",
  "many-args",
  "long-arg",
  "control-arg",
  "nonstring-arg",
  "script-outside-inventory",
  "glob-path",
  "environment-injection",
])("rejects %s before process dispatch", async (kind) => {
  let input = invocation("0;");
  if (kind === "zero-timeout") input = { ...input, timeoutMs: 0 };
  if (kind === "long-timeout") input = { ...input, timeoutMs: 30001 };
  if (kind === "nan-timeout") input = { ...input, timeoutMs: NaN };
  if (kind === "many-args") input = { ...input, args: Array.from({ length: 65 }, () => "x") };
  if (kind === "long-arg") input = { ...input, args: ["x".repeat(1001)] };
  if (kind === "control-arg") input = { ...input, args: ["\u001b"] };
  if (kind === "nonstring-arg") input = { ...input, args: [7 as unknown as string] };
  if (kind === "script-outside-inventory") input = { ...input, script: "other.mjs" };
  if (kind === "glob-path") {
    writeFileSync(join(input.scope.root, "literal*file"), "owned");
    input = {
      ...input,
      scope: { ...input.scope, inputs: [...input.scope.inputs, "literal*file"] },
    };
  }
  if (kind === "environment-injection")
    input = {
      ...input,
      scope: { ...input.scope, environmentKeys: ["NODE_OPTIONS"] },
      environment: { NODE_OPTIONS: "--no-warnings" },
    };
  await expect(runNativeCheck(input)).rejects.toThrow();
});
it("rejects a bounded but over-capacity native read inventory without launching a process", async () => {
  const input = invocation("0;"),
    files = Array.from({ length: 512 }, (_, i) => `f${i}.txt`);
  for (const file of files) writeFileSync(join(input.scope.root, file), "");
  await expect(
    runNativeCheck({
      ...input,
      scope: { ...input.scope, inputs: [...input.scope.inputs, ...files] },
    }),
  ).rejects.toThrow(/bounded/);
});
it("retains pre-dispatch cancellation as null exit/no process, never success", async () => {
  const input = invocation("0;"),
    controller = new AbortController();
  controller.abort();
  expect(await runNativeCheck(input, controller.signal)).toMatchObject({
    termination: "cancelled",
    pid: null,
    exitCode: null,
    closed: true,
  });
});
it("does not execute under an unqualified runtime version", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "version"),
    input = invocation("0;");
  try {
    Object.defineProperty(process, "version", { configurable: true, value: "v0-unqualified" });
    await expect(runNativeCheck(input)).rejects.toThrow(/unqualified/);
  } finally {
    if (descriptor) Object.defineProperty(process, "version", descriptor);
  }
});
it("retains an unavailable post-check input capture rather than inventing a same version", async () => {
  const input = invocation("setTimeout(()=>{},100);"),
    timer = setTimeout(() => {
      unlinkSync(join(input.scope.root, "check.mjs"));
    }, 10);
  try {
    const result = await runNativeCheck(input);
    expect(result.closed).toBe(true);
    expect(result.after.status).toBe("unknown");
  } finally {
    clearTimeout(timer);
  }
});
it("does not advertise a native descriptor on an unsupported runtime", () => {
  const input = invocation("0;"),
    capture = captureCheckVersion(input.scope, input.environment),
    descriptor = Object.getOwnPropertyDescriptor(process, "version");
  if (capture.status !== "known") throw Error("Owned current capture missing");
  try {
    Object.defineProperty(process, "version", { configurable: true, value: "v0-unqualified" });
    expect(() => nativeCheckDescriptor(input, capture.version)).toThrow(/unqualified/);
  } finally {
    if (descriptor) Object.defineProperty(process, "version", descriptor);
  }
});
it("rejects an unsupported OS capability without claiming a real cross-platform run", async () => {
  const input = invocation("0;"),
    capture = captureCheckVersion(input.scope, input.environment),
    descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (capture.status !== "known") throw Error("Owned current capture missing");
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    await expect(runNativeCheck(input)).rejects.toThrow(/unqualified/);
    expect(() => nativeCheckDescriptor(input, capture.version)).toThrow(/unqualified/);
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
});
it("does not recognize primitive or callable copies as actual native executions", () => {
  for (const value of [undefined, null, 0, false, "exit 0", () => ({ closed: true, exitCode: 0 })])
    expect(nativeCheckExecution(value)).toBeUndefined();
});
it("executes a genuine nested checker/config path with bounded directory generations", async () => {
  const base = invocation("0;");
  mkdirSync(join(base.scope.root, "checks"));
  writeFileSync(join(base.scope.root, "checks", "config.json"), '{"answer":42}');
  writeFileSync(
    join(base.scope.root, "checks", "nested.mjs"),
    "import assert from 'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(JSON.parse(readFileSync(new URL('./config.json',import.meta.url),'utf8')).answer,42);console.log('owned nested check');",
  );
  const input = {
    ...base,
    script: "checks/nested.mjs",
    scope: { ...base.scope, inputs: ["checks/nested.mjs", "checks/config.json"] },
  };
  const result = await runNativeCheck(input);
  expect(result).toMatchObject({
    closed: true,
    exitCode: 0,
    termination: "exited",
    after: { status: "known" },
  });
  expect(result.stdout).toContain("owned nested check");
  expect(result.after.status === "known" && result.after.inputGeneration).toBe(
    result.beforeGeneration,
  );
});
it.each(["nonzero", "timeout", "overflow", "cancel"])(
  "retains actual %s without turning it into a successful check",
  async (kind) => {
    const code =
      kind === "overflow"
        ? `process.stdout.write('x'.repeat(100000));`
        : kind === "nonzero"
          ? `process.exitCode=7;`
          : `setInterval(()=>{},1000);`;
    const spec = invocation(code, kind === "timeout" ? 20 : 1000),
      controller = new AbortController();
    const timer =
      kind === "cancel"
        ? setTimeout(() => {
            controller.abort();
          }, 20)
        : undefined;
    try {
      const result = await runNativeCheck(spec, controller.signal);
      expect(result.closed).toBe(true);
      if (kind === "nonzero") expect(result).toMatchObject({ termination: "exited", exitCode: 7 });
      if (kind === "timeout") expect(result.termination).toBe("timed_out");
      if (kind === "cancel") expect(result.termination).toBe("cancelled");
      if (kind === "overflow") {
        expect(result.termination).toBe("output_limit");
        expect(
          Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
        ).toBeLessThanOrEqual(65536);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
);
it("denies native writes and child/worker creation on the actual qualified Node configuration", async () => {
  const spec = invocation(
    `import assert from 'node:assert/strict';import{writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';import{Worker}from'node:worker_threads';for(const action of [()=>writeFileSync('own-output.txt','x'),()=>spawnSync(process.execPath,['-e','0']),()=>new Worker('0',{eval:true})])assert.throws(action,error=>error.code==='ERR_ACCESS_DENIED');console.log('denied:3');`,
  );
  const result = await runNativeCheck(spec);
  expect(result).toMatchObject({ closed: true, termination: "exited", exitCode: 0 });
  expect(result.stdout.trim()).toBe("denied:3");
});
it("distinguishes an observable same-byte write after the actual finite check without changing P0 hashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "owned-p7-generation-"));
  roots.push(root);
  writeFileSync(join(root, "input.txt"), "same");
  writeFileSync(join(root, "check.mjs"), "0;\n");
  const scope = {
    scopeId: "owned-generation",
    owner: {
      kind: "goal" as const,
      goal: { sessionId: "owned", goalKey: "owned", goalRunId: null, lifecycleCommitId: null },
    },
    root,
    inputs: ["input.txt", "check.mjs"],
    artifacts: [],
    environmentKeys: [],
  };
  const before = captureCheckVersion(scope, {});
  const execution = await runNativeCheck({
    scope,
    script: "check.mjs",
    args: [],
    environment: {},
    timeoutMs: 1000,
  });
  expect(execution).toMatchObject({ closed: true, termination: "exited", exitCode: 0 });
  writeFileSync(join(root, "input.txt"), "same");
  const after = captureCheckVersion(scope, {});
  expect(before.status).toBe("known");
  expect(after.status).toBe("known");
  if (before.status !== "known" || after.status !== "known")
    throw Error("Owned input version unavailable");
  expect(before.version.versionId).toBe(after.version.versionId);
  expect(before.inputGeneration).not.toBe(after.inputGeneration);
});
it("executes the exact own-key environment profile rather than inheriting object prototype behavior", async () => {
  const input = invocation(
    `import assert from 'node:assert/strict';assert.equal(process.env['__proto__'],'owned-profile');console.log('profile matched');`,
  );
  const result = await runNativeCheck({
    ...input,
    scope: { ...input.scope, environmentKeys: ["__proto__"] },
    environment: JSON.parse('{"__proto__":"owned-profile"}') as Record<string, string>,
  });
  expect(result).toMatchObject({ closed: true, termination: "exited", exitCode: 0 });
  expect(result.stdout.trim()).toBe("profile matched");
});
it("uses the actual fixed Node invocation, explicit environment and a real close/exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "owned-p7-native-check-"));
  roots.push(root);
  writeFileSync(join(root, "input.txt"), "owned-input");
  writeFileSync(
    join(root, "check.mjs"),
    `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync(new URL('./input.txt',import.meta.url),'utf8'),'owned-input'); assert.equal(process.env.OWNED_P7_PARENT_ONLY,undefined); assert.equal(process.env.LANG,'C'); console.log(JSON.stringify({protocol:'check-result-v1',tests:3,passed:3,failed:0,skipped:0,requiredCases:{input:'passed',environment:'passed',locale:'passed'},skippedIds:[]}));`,
  );
  process.env.OWNED_P7_PARENT_ONLY = "not-inherited";
  try {
    const result = await runNativeCheck({
      scope: {
        scopeId: "owned-native",
        owner: {
          kind: "goal",
          goal: { sessionId: "owned", goalKey: "owned", goalRunId: null, lifecycleCommitId: null },
        },
        root,
        inputs: ["check.mjs", "input.txt"],
        artifacts: [],
        environmentKeys: ["LANG"],
      },
      script: "check.mjs",
      args: [],
      environment: { LANG: "C" },
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ closed: true, exitCode: 0, termination: "exited" });
    expect(JSON.parse(result.stdout)).toMatchObject({ tests: 3, passed: 3, failed: 0, skipped: 0 });
    expect(result.invocation.executable).toBe(process.execPath);
    expect(result.invocation.args).toContain("--permission");
    expect(nativeCheckExecution(result)).toBeDefined();
    expect(nativeCheckExecution(structuredClone(result))).toBeUndefined();
  } finally {
    delete process.env.OWNED_P7_PARENT_ONLY;
  }
});
