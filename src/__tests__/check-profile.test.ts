// Descriptor validation only. No process/permission/acceptance qualification is inferred.
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { prepareNativePlan, type NativeCheckPlan } from "../check-profile";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function plan() {
  const root = mkdtempSync("/tmp/check-profile-boundary-");
  roots.push(root);
  const stat = lstatSync(root, { bigint: true });
  const workspace = { root, device: String(stat.dev), inode: String(stat.ino) };
  const input: NativeCheckPlan = {
    scope: {
      scopeId: "finite-preview",
      root,
      inputs: [],
      artifacts: [],
      environmentKeys: [],
      checkerScopes: [{ checkId: "py", root, inputs: ["test_scope.py"] }],
    },
    checkId: "py",
    script: "test_scope.py",
    args: [],
    environment: {},
    timeoutMs: 1000,
    runtime: "python-unittest-v1",
    tests: ["test_scope.Scope.test_owned"],
  };
  const preview = () => prepareNativePlan(input, workspace, "a".repeat(64));
  return { input, preview };
}
it("previews the finite Python profile without inventing files, execution or a grant", () => {
  const h = plan();
  const value = h.preview();
  expect(value.invocation.args.slice(0, 3)).toEqual(["-I", "-S", "-B"]);
  expect(value.python?.tests).toEqual(["test_scope.Scope.test_owned"]);
});
it.each([
  "relative-product",
  "relative-checker",
  "noncanonical-checker",
  "wrong-check",
  "unlisted-script",
  "traversal",
  "glob",
  "unknown-runtime",
  "node-with-tests",
  "not-python",
  "python-args",
  "missing-tests",
  "empty-tests",
  "many-tests",
  "duplicate-tests",
  "long-test",
  "foreign-module",
  "test-factory",
  "native-extension",
  "temporary-env",
  "sqlite-env",
  "manifest-capacity",
])("rejects %s at the shared metadata/execution boundary", (kind) => {
  const h = plan(),
    p = h.input;
  const selected = p.scope.checkerScopes?.[0];
  if (!selected) throw Error("Fixture has no original checker scope");
  if (kind === "relative-product") p.scope = { ...p.scope, root: "relative" };
  if (kind === "relative-checker")
    p.scope = { ...p.scope, checkerScopes: [{ ...selected, root: "relative" }] };
  if (kind === "noncanonical-checker")
    p.scope = { ...p.scope, checkerScopes: [{ ...selected, root: `${selected.root}/../checker` }] };
  if (kind === "wrong-check") p.checkId = "other";
  if (kind === "unlisted-script") p.script = "other.py";
  if (kind === "traversal") p.scope = { ...p.scope, inputs: ["../secret"] };
  if (kind === "glob") p.scope = { ...p.scope, inputs: ["literal?.txt"] };
  if (kind === "unknown-runtime") p.runtime = "shell" as typeof p.runtime;
  if (kind === "node-with-tests") p.runtime = undefined;
  if (kind === "not-python") {
    p.script = "test_scope.js";
    p.scope = { ...p.scope, checkerScopes: [{ ...selected, inputs: [p.script] }] };
  }
  if (kind === "python-args") p.args = ["--discover"];
  if (kind === "missing-tests") p.tests = undefined;
  if (kind === "empty-tests") p.tests = [];
  if (kind === "many-tests")
    p.tests = Array.from({ length: 33 }, (_, i) => `test_scope.Scope.test_${i}`);
  if (kind === "duplicate-tests")
    p.tests = ["test_scope.Scope.test_owned", "test_scope.Scope.test_owned"];
  if (kind === "long-test") p.tests = [`test_scope.Scope.test_${"x".repeat(201)}`];
  if (kind === "foreign-module") p.tests = ["other.Scope.test_owned"];
  if (kind === "test-factory") p.tests = ["test_scope.test_owned"];
  if (kind === "native-extension") p.scope = { ...p.scope, inputs: ["plugin.so.1"] };
  if (kind === "temporary-env") p.scope = { ...p.scope, environmentKeys: ["TMPDIR"] };
  if (kind === "sqlite-env") p.scope = { ...p.scope, environmentKeys: ["SQLITE_TMPDIR"] };
  if (kind === "manifest-capacity")
    p.scope = {
      ...p.scope,
      inputs: Array.from({ length: 500 }, (_, i) => `${i}${"x".repeat(160)}.txt`),
    };
  expect(h.preview).toThrow();
});
it.each([0, undefined])(
  "does not qualify Python when its actual effective UID is unavailable/nonpositive (%s)",
  (uid) => {
    const h = plan();
    vi.spyOn(process, "geteuid").mockReturnValue(uid as number);
    expect(h.preview).toThrow(/non-root Linux/);
  },
);
it("also enforces runtime qualification for a direct shared descriptor preview", () => {
  const h = plan(),
    descriptor = Object.getOwnPropertyDescriptor(process, "version");
  if (!descriptor) throw Error("No actual runtime descriptor");
  try {
    Object.defineProperty(process, "version", { value: "unqualified", configurable: true });
    expect(h.preview).toThrow(/unqualified/);
  } finally {
    Object.defineProperty(process, "version", descriptor);
  }
});
