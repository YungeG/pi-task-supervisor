// Negative child-event boundary simulation only. No actual process/close or native
// positive qualification is claimed; real process probes live in check-runner.test.
import { EventEmitter } from "node:events";
import type * as NativeChild from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof NativeChild>()),
  spawn: vi.fn(),
}));
import { spawn } from "node:child_process";
import { runNativeCheck, type NativeCheckInvocation } from "../check-runner";
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "owned-p7-negative-events-"));
  roots.push(root);
  writeFileSync(join(root, "check.mjs"), "0;");
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => false),
    pid: undefined,
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const input: NativeCheckInvocation = {
    scope: {
      scopeId: "negative-events",
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
    timeoutMs: 10,
  };
  return { child, input };
}
it.each(["timeout", "overflow", "abort-during-spawn"])(
  "keeps %s without a close unknown, even after kill acknowledgement",
  async (kind) => {
    const { child, input } = setup(),
      controller = new AbortController();
    vi.useFakeTimers();
    if (kind === "abort-during-spawn")
      vi.mocked(spawn).mockImplementation(() => {
        controller.abort();
        return child as unknown as ReturnType<typeof spawn>;
      });
    const pending = runNativeCheck(input, controller.signal);
    if (kind === "overflow") {
      child.stdout.emit("data", Buffer.alloc(65537, 120));
      child.stderr.emit("data", Buffer.alloc(100, 121));
    }
    await vi.advanceTimersByTimeAsync(2010);
    const result = await pending;
    expect(result).toMatchObject({
      termination: "unknown",
      closed: false,
      exitCode: null,
      pid: null,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.stdout.emit("data", Buffer.from("late"));
    child.emit("close", 0, null);
    expect(result.closed).toBe(false);
  },
);
it("retains a native spawn-error event with null exit and ignores later output after closure", async () => {
  const { child, input } = setup(),
    pending = runNativeCheck(input);
  child.emit("error", new Error("Owned simulated spawn failure"));
  child.emit("close", null, null);
  const result = await pending;
  expect(result).toMatchObject({
    termination: "spawn_error",
    closed: true,
    exitCode: null,
    pid: null,
  });
  child.stderr.emit("data", Buffer.from("late"));
  expect(result.stderr).toBe("");
});
it("does not manufacture an execution result when the native dispatch itself throws", async () => {
  const { input } = setup();
  vi.mocked(spawn).mockImplementation(() => {
    throw Error("Owned simulated dispatch throw");
  });
  await expect(runNativeCheck(input)).rejects.toThrow(/dispatch throw/);
});
