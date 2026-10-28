// OS-boundary failures only; these synthetic observations never certify a runtime.
import { afterEach, expect, it, vi } from "vitest";
import type { NativeCheckPlan } from "../check-profile";
import type * as NativeFS from "node:fs";
import type * as NativeChildProcess from "node:child_process";
const fault = vi.hoisted(() => ({ kind: "", stats: 0, read: false, observed: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof NativeFS>();
  const snapshot = (value: NativeFS.BigIntStats) => ({
    ...value,
    isFile: () => value.isFile(),
    isDirectory: () => value.isDirectory(),
    isSymbolicLink: () => value.isSymbolicLink(),
  });
  return {
    ...fs,
    fstatSync: (...args: any[]) => {
      const stat = snapshot(Reflect.apply(fs.fstatSync, fs, args) as NativeFS.BigIntStats);
      fault.stats++;
      if (fault.kind === "not-file") return { ...stat, isFile: () => false };
      if (fault.kind === "empty-file") return { ...stat, size: 0n };
      if (fault.kind === "large-file") return { ...stat, size: 33554433n };
      if (fault.kind === "fd-generation" && fault.stats === 2)
        return { ...stat, mtimeNs: stat.mtimeNs + 1n };
      return stat;
    },
    readFileSync: (...args: any[]) => {
      fault.read = true;
      return fault.kind === "short-read"
        ? Buffer.alloc(0)
        : Reflect.apply(fs.readFileSync, fs, args);
    },
    lstatSync: (...args: any[]) => {
      const stat = snapshot(Reflect.apply(fs.lstatSync, fs, args) as NativeFS.BigIntStats),
        path = String(args[0]);
      if (fault.kind === "path-generation" && fault.read && path.endsWith("python3.13"))
        return { ...stat, mtimeNs: stat.mtimeNs + 1n };
      if (path === "/usr/lib/python3.13") {
        if (fault.kind === "stdlib-not-directory") return { ...stat, isDirectory: () => false };
        if (fault.kind === "stdlib-symlink")
          return { ...stat, isDirectory: () => true, isSymbolicLink: () => true };
        if (fault.kind === "stdlib-device") return { ...stat, dev: stat.dev + 1n };
        if (fault.kind === "stdlib-inode") return { ...stat, ino: stat.ino + 1n };
      }
      if (
        fault.observed &&
        ((fault.kind === "post-binary" && path.endsWith("python3.13")) ||
          (fault.kind === "post-bootstrap" && path.endsWith("bootstrap.py")))
      )
        return { ...stat, mtimeNs: stat.mtimeNs + 1n };
      return stat;
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof NativeChildProcess>();
  return {
    ...cp,
    execFileSync: (...args: any[]) => {
      if (fault.kind.startsWith("observed-")) {
        const value: Record<string, unknown> = {
          version: "3.13.5",
          stdlib: "/usr/lib/python3.13",
          sqlite: "3.46.1",
          uid: process.geteuid?.(),
        };
        const field = fault.kind.slice(9);
        value[field] = field === "version" ? "3.12.9" : field === "uid" ? 0 : null;
        return JSON.stringify(value);
      }
      const result = Reflect.apply(cp.execFileSync, cp, args);
      fault.observed = true;
      return result;
    },
  };
});
afterEach(() => {
  fault.kind = "";
  fault.stats = 0;
  fault.read = false;
  fault.observed = false;
});
async function preview() {
  const { prepareNativePlan } = await import("../check-profile");
  const root = process.cwd();
  const input: NativeCheckPlan = {
    scope: {
      scopeId: "metadata-only",
      root,
      inputs: ["test_scope.py"],
      artifacts: [],
      environmentKeys: [],
    },
    script: "test_scope.py",
    runtime: "python-unittest-v1",
    tests: ["test_scope.Scope.test_owned"],
    args: [],
    environment: {},
    timeoutMs: 1000,
  };
  return () =>
    prepareNativePlan(
      input,
      { root, device: "not-authority", inode: "not-authority" },
      "a".repeat(64),
    );
}
it.each([
  "not-file",
  "empty-file",
  "large-file",
  "short-read",
  "fd-generation",
  "path-generation",
  "observed-version",
  "observed-stdlib",
  "observed-sqlite",
  "observed-uid",
  "stdlib-not-directory",
  "stdlib-symlink",
  "post-binary",
  "post-bootstrap",
])("refuses profile capture when system observations fail: %s", async (kind) => {
  vi.resetModules();
  const call = await preview();
  fault.kind = kind;
  fault.stats = 0;
  fault.read = false;
  fault.observed = false;
  expect(call).toThrow(/Finite profile|Python unittest/);
});
it.each(["stdlib-not-directory", "stdlib-symlink", "stdlib-device", "stdlib-inode"])(
  "does not reuse a cache with changed %s observations",
  async (kind) => {
    vi.resetModules();
    const call = await preview();
    const first = call();
    fault.kind = kind;
    if (kind === "stdlib-device" || kind === "stdlib-inode") {
      // A changed but stable directory needs a fresh probe, never the cached identity.
      const current = call();
      expect(current.invocation.profile?.stdlib).not.toEqual(first.invocation.profile?.stdlib);
    } else expect(call).toThrow(/Python unittest runtime changed/);
  },
);
