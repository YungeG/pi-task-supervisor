// Actual owned finite-process probes of the approved native check invocation seam.
// These establish runner mechanics, not trusted-contract, human or Goal acceptance.
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  utimesSync,
} from "node:fs";
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
it("runs an actual bounded external Python method with SQLite and FD cleanup", async () => {
  const product = invocation("0;"),
    checker = invocation("0;");
  writeFileSync(
    join(checker.scope.root, "test_checker.py"),
    `import contextlib,os,sqlite3,tempfile,unittest
class Scope(unittest.TestCase):
 def test_owned(self):
  before=len(os.listdir('/proc/self/fd'))
  with tempfile.TemporaryDirectory() as directory:
   with contextlib.closing(sqlite3.connect(os.path.join(directory,'owned.db'))) as connection:
    connection.execute('create table v(x integer)')
    connection.execute('insert into v values (7)')
    self.assertEqual(connection.execute('select x from v').fetchone(),(7,))
   parent=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
   try:
    fd=os.open('owned.txt',os.O_WRONLY|os.O_CREAT,0o600,dir_fd=parent)
    os.write(fd,b'owned');os.close(fd)
   finally: os.close(parent)
  self.assertEqual(len(os.listdir('/proc/self/fd')),before)
`,
  );
  const input = {
    ...product,
    checkId: "python",
    runtime: "python-unittest-v1" as const,
    script: "test_checker.py",
    tests: ["test_checker.Scope.test_owned"],
    scope: {
      ...product.scope,
      checkerScopes: [{ checkId: "python", root: checker.scope.root, inputs: ["test_checker.py"] }],
    },
  };
  const result = await runNativeCheck(input);
  expect(result, result.stderr).toMatchObject({
    closed: true,
    exitCode: 0,
    termination: "exited",
    temporary: { cleanup: "removed" },
  });
  expect(result.pid).toBeGreaterThan(0);
  expect(result.invocation.executable).toBe("/usr/bin/python3.13");
  expect(JSON.parse(result.stdout)).toMatchObject({
    tests: 1,
    passed: 1,
    failed: 0,
    requiredCases: { "test_checker.Scope.test_owned": "passed" },
  });
  expect(result.after.status).toBe("known");
  expect(result.temporary && existsSync(result.temporary.root)).toBe(false);
  expect(nativeCheckExecution(result)).toBe(result);
  expect(nativeCheckExecution(structuredClone(result))).toBeUndefined();
});
it("observes actual finite Python read/write/network/process and SQLite denials", async () => {
  const input = pythonInvocation(`import contextlib,os,pathlib,socket,sqlite3,tempfile,unittest
class Scope(unittest.TestCase):
 def test_owned(self):
  with self.assertRaises(PermissionError): pathlib.Path('undeclared.txt').read_text()
  with self.assertRaises(PermissionError): pathlib.Path('outside.txt').write_text('no')
  with self.assertRaises(PermissionError): os.listdir('.')
  with self.assertRaises(PermissionError): socket.socket()
  with self.assertRaises(PermissionError): os.system('true')
  with self.assertRaises(PermissionError): os.environ['INJECTED']='no'
  with self.assertRaises(PermissionError): os.symlink('missing',tempfile.gettempdir()+'/link')
  with self.assertRaises(PermissionError): __import__('subprocess')
  with contextlib.closing(sqlite3.connect(':memory:')) as db:
   with self.assertRaises(PermissionError): db.set_authorizer(None)
   with self.assertRaises(PermissionError): db.enable_load_extension(True)
   with self.assertRaises(sqlite3.DatabaseError): db.execute("ATTACH DATABASE 'outside.db' AS other")
   with self.assertRaises(sqlite3.DatabaseError): db.execute("VACUUM INTO 'outside.db'")
   with self.assertRaises(sqlite3.DatabaseError): db.execute("PRAGMA temp_store_directory='/tmp'")
`);
  writeFileSync(join(input.scope.root, "undeclared.txt"), "private, not a declared read");
  const result = await runNativeCheck(input);
  expect(result, result.stderr).toMatchObject({
    closed: true,
    exitCode: 0,
    after: { status: "known" },
    temporary: { cleanup: "removed" },
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ tests: 1, passed: 1, failed: 0 });
  expect(existsSync(join(input.scope.root, "outside.txt"))).toBe(false);
  expect(existsSync(join(input.scope.root, "outside.db"))).toBe(false);
});
function pythonInvocation(code: string): NativeCheckInvocation {
  const base = invocation("0;");
  writeFileSync(join(base.scope.root, "test_scope.py"), code);
  return {
    ...base,
    checkId: "python",
    runtime: "python-unittest-v1",
    script: "test_scope.py",
    tests: ["test_scope.Scope.test_owned"],
    scope: {
      ...base.scope,
      checkerScopes: [{ checkId: "python", root: base.scope.root, inputs: ["test_scope.py"] }],
    },
  };
}
it.each([
  "async",
  "generator",
  "async-generator",
  "factory",
  "async-setup",
  "async-cleanup",
  "custom-dispatch",
])("does not count an unsupported %s unittest method as a passing actual test", async (kind) => {
  const method =
    kind === "async-setup"
      ? "def test_owned(self): pass\n async def setUp(self): self.fail('must not be ignored')"
      : kind === "async-cleanup"
        ? "def test_owned(self): self.addCleanup(self.cleanup)\n async def cleanup(self): self.fail('must not be ignored')"
        : kind === "custom-dispatch"
          ? "def test_owned(self): self.fail('must not be ignored')\n def _callTestMethod(self, method): pass"
          : kind === "async"
            ? "async def test_owned(self): self.fail('must not be ignored')"
            : kind === "generator"
              ? "def test_owned(self): yield self.fail('must not be ignored')"
              : kind === "async-generator"
                ? "async def test_owned(self): yield self.fail('must not be ignored')"
                : "def test_owned(self): return unittest.TestSuite()";
  const result = await runNativeCheck(
    pythonInvocation(`import unittest\nclass Scope(unittest.TestCase):\n ${method}\n`),
  );
  expect(result.closed).toBe(true);
  expect(result.exitCode, result.stdout).not.toBe(0);
  expect(result.temporary).toMatchObject({ cleanup: "removed" });
});

it("does not silently skip an asynchronous module fixture before a passing method", async () => {
  const result = await runNativeCheck(
    pythonInvocation(
      "import unittest\nasync def setUpModule(): raise AssertionError('async module must not be ignored')\nclass Scope(unittest.TestCase):\n def test_owned(self): self.assertEqual(7,7)\n",
    ),
  );
  expect(result.closed).toBe(true);
  expect(result.exitCode, result.stdout).not.toBe(0);
  expect(result.temporary).toMatchObject({ cleanup: "removed" });
});

function fixtureChecker(target: string, body: string): string {
  const moduleHook =
    target === "module-setup"
      ? "setUpModule=fixture\n"
      : target === "module-teardown"
        ? "tearDownModule=fixture\n"
        : target === "module-cleanup"
          ? "unittest.addModuleCleanup(fixture)\n"
          : "";
  const classHook =
    target === "class-teardown"
      ? " tearDownClass=staticmethod(fixture)\n"
      : target === "class-cleanup"
        ? " @classmethod\n def setUpClass(cls): cls.addClassCleanup(fixture)\n"
        : "";
  return `import unittest\n${body}\n${moduleHook}class Scope(unittest.TestCase):\n def test_owned(self): self.assertEqual(7,7)\n${classHook}`;
}
it.each(["class-teardown", "module-teardown", "class-cleanup", "module-cleanup"])(
  "does not report successful execution when %s fails after a passing method",
  async (target) => {
    const result = await runNativeCheck(
      pythonInvocation(
        fixtureChecker(
          target,
          "def fixture(): raise AssertionError('fixture-teardown-regression')",
        ),
      ),
    );
    expect(result.closed).toBe(true);
    expect(result.exitCode, result.stdout).not.toBe(0);
    expect(result.stderr).toContain("fixture-teardown-regression");
    expect(result.temporary).toMatchObject({ cleanup: "removed" });
  },
);
it.each(
  ["module-setup", "module-teardown", "class-teardown", "class-cleanup", "module-cleanup"].flatMap(
    (target) => ["async", "generator", "awaitable", "iterator"].map((form) => ({ target, form })),
  ),
)(
  "rejects $form returned through $target rather than ignoring its fixture",
  async ({ target, form }) => {
    const body =
      form === "async"
        ? "async def fixture(): raise AssertionError('must execute')"
        : form === "generator"
          ? "def fixture(): yield 1"
          : form === "awaitable"
            ? "async def pending(): raise AssertionError('must execute')\ndef fixture(): return pending()"
            : "def fixture(): return iter([1])";
    const result = await runNativeCheck(pythonInvocation(fixtureChecker(target, body)));
    expect(result.closed).toBe(true);
    expect(result.exitCode, result.stdout).not.toBe(0);
    expect(result.temporary).toMatchObject({ cleanup: "removed" });
  },
);
it("forwards cleanup keywords named function, cls and method without consuming them as wrapper parameters", async () => {
  const result = await runNativeCheck(
    pythonInvocation(`import unittest
values=dict(function=7,cls=8,method=9)
def cleanup(**kwargs): assert kwargs==values
unittest.addModuleCleanup(cleanup,**values)
class Scope(unittest.TestCase):
 @classmethod
 def setUpClass(cls): cls.addClassCleanup(cleanup,**values)
 def test_owned(self): self.addCleanup(cleanup,**values)
`),
  );
  expect(result, result.stderr).toMatchObject({
    closed: true,
    exitCode: 0,
    temporary: { cleanup: "removed" },
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ tests: 1, passed: 1, failed: 0 });
});

it("preserves standard unittest's explicitly absent optional class hooks", async () => {
  const result = await runNativeCheck(
    pythonInvocation(
      "import unittest\nclass Scope(unittest.TestCase):\n setUpClass=None\n tearDownClass=staticmethod(None)\n def test_owned(self): self.assertEqual(7,7)\n",
    ),
  );
  expect(result, result.stderr).toMatchObject({ closed: true, exitCode: 0 });
});

it("preserves real synchronous module/class fixtures, cleanup arguments and inherited class binding", async () => {
  const input = pythonInvocation(`import unittest
seen=[]
def setUpModule(): seen.append('module')
def module_cleanup(token,*,value):
 assert token=='module' and value==7 and seen==['module','Scope','Scope-cleanup','Child','Child-cleanup','teardown']
def tearDownModule(): seen.append('teardown')
unittest.addModuleCleanup(module_cleanup,'module',value=7)
class Scope(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  seen.append(cls.__name__)
  cls.addClassCleanup(cls.cleanup,cls.__name__,value=7)
 @staticmethod
 def cleanup(token,*,value):
  assert value==7
  seen.append(token+'-cleanup')
 def test_owned(self): self.assertIn(type(self).__name__,seen)
class Child(Scope): pass
`);
  input.tests = ["test_scope.Scope.test_owned", "test_scope.Child.test_owned"];
  const result = await runNativeCheck(input);
  expect(result, result.stderr).toMatchObject({
    closed: true,
    exitCode: 0,
    temporary: { cleanup: "removed" },
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ tests: 2, passed: 2, failed: 0 });
});

it("does not qualify a closed successful Python process whose actual temporary cleanup fails", async () => {
  const input = pythonInvocation(
    "import os,tempfile,unittest\nclass Scope(unittest.TestCase):\n def test_owned(self): os.rmdir(tempfile.gettempdir())\n",
  );
  const result = await runNativeCheck(input);
  expect(result, result.stderr).toMatchObject({
    closed: true,
    exitCode: 0,
    temporary: { cleanup: "failed" },
    after: { status: "unknown", reason: "CHECK_TEMPORARY_CLEANUP_UNAVAILABLE" },
  });
  expect(result.temporary && existsSync(result.temporary.root)).toBe(false);
});
it("cleans Python temporary metadata on pre-dispatch cancellation without inventing a process", async () => {
  const input = pythonInvocation(
    "import unittest\nclass Scope(unittest.TestCase):\n def test_owned(self): self.fail('must not execute')\n",
  );
  const controller = new AbortController();
  controller.abort();
  const result = await runNativeCheck(input, controller.signal);
  expect(result).toMatchObject({
    pid: null,
    closed: true,
    exitCode: null,
    termination: "cancelled",
    temporary: { cleanup: "removed" },
  });
});
it("retains a changed invocation profile after the actual process rather than returning known evidence", async () => {
  const input = invocation("setTimeout(()=>{},30);");
  const pending = runNativeCheck(input);
  input.args = ["not-the-started-invocation"];
  const result = await pending;
  expect(result).toMatchObject({
    closed: true,
    exitCode: 0,
    after: { status: "unknown", reason: "CHECK_PROFILE_CHANGED" },
  });
});
it("retains unavailable runtime qualification after an actual process close", async () => {
  const input = invocation("setTimeout(()=>{},30);"),
    descriptor = Object.getOwnPropertyDescriptor(process, "version");
  if (!descriptor) throw Error("No original runtime capability");
  try {
    const pending = runNativeCheck(input);
    Object.defineProperty(process, "version", { value: "unqualified", configurable: true });
    expect(await pending).toMatchObject({
      closed: true,
      exitCode: 0,
      after: { status: "unknown", reason: "CHECK_PROFILE_UNAVAILABLE" },
    });
  } finally {
    Object.defineProperty(process, "version", descriptor);
  }
});
it("tracks an external checker's actual generation even when its restored bytes hash identically", () => {
  const product = invocation("0;"),
    checker = invocation("0;");
  const scope = {
    ...product.scope,
    inputs: [],
    checkerScopes: [{ checkId: "outside", root: checker.scope.root, inputs: ["check.mjs"] }],
  };
  const before = captureCheckVersion(scope, {});
  expect(before.status).toBe("known");
  writeFileSync(join(checker.scope.root, "check.mjs"), "0;");
  utimesSync(join(checker.scope.root, "check.mjs"), 1, 2);
  const after = captureCheckVersion(scope, {});
  if (before.status !== "known" || after.status !== "known")
    throw Error("No original multi-root versions");
  expect(after.version.versionId).toBe(before.version.versionId);
  expect(after.inputGeneration).not.toBe(before.inputGeneration);
});
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
