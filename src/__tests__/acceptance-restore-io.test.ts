// Actual owned SDK producer bytes + actual SDK manager, measured only during the
// production source-handler restore. Never real sessions or fresh check eligibility.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerEventHandlers } from "../events";
import { currentRuntime } from "../runtime";
import { acceptanceContractIssue } from "../acceptance-runtime";
import { resetState } from "../state";
import { createMockAPI, createMockContext } from "./helpers/mocks";
beforeEach(resetState);
it("restores sealed accepted contract history with one physical scan and no replay", async () => {
  const bytes = fs.readFileSync(new URL("./fixtures/acceptance-check-sdk.jsonl", import.meta.url)),
    header = JSON.parse(bytes.toString().split("\n")[0] ?? "{}") as { cwd: string };
  const dir = fs.mkdtempSync(join(tmpdir(), "owned-p8-contract-io-")),
    file = join(dir, "source.jsonl");
  fs.writeFileSync(file, bytes);
  const manager = SessionManager.open(file),
    mock = createMockAPI(),
    ctx = createMockContext();
  Object.assign(ctx, { sessionManager: manager, cwd: header.cwd, hasUI: false, mode: "rpc" });
  mock.appendEntry.mockImplementation(() => {
    throw Error("Read-only accepted restore cannot append");
  });
  registerEventHandlers(mock.api);
  const handler = mock.on.mock.calls.find(([name]) => name === "session_start")?.[1] as
    | ((event: unknown, context: typeof ctx) => Promise<unknown>)
    | undefined;
  if (!handler) throw Error("Actual source handler missing");
  const open = fs.openSync,
    read = fs.readSync,
    close = fs.closeSync,
    tracked = new Set<number>();
  let scans = 0,
    totalBytes = 0,
    passed = false;
  const opens = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = Reflect.apply(open, fs, args);
    if (resolve(String(args[0])) === file) tracked.add(fd);
    return fd;
  });
  const reads = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    const n = Reflect.apply(read, fs, args);
    if (tracked.has(args[0])) {
      totalBytes += n;
      if (n === 0) scans++;
    }
    return n;
  });
  const closes = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    tracked.delete(fd);
    close(fd);
  });
  syncBuiltinESMExports();
  try {
    await handler({ type: "session_start" }, ctx);
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentRuntime().supervisor?.status).toBe("completed");
    expect(mock.appendEntry).not.toHaveBeenCalled();
    expect(mock.sendUserMessage).not.toHaveBeenCalled();
    expect(scans).toBe(1);
    expect(totalBytes).toBe(bytes.length);
    // A later live applicability request is deliberately fresh, not the restore snapshot.
    expect(typeof acceptanceContractIssue(ctx)).toBe("string");
    expect(scans).toBe(2);
    expect(totalBytes).toBe(bytes.length * 2);
    passed = true;
  } finally {
    opens.mockRestore();
    reads.mockRestore();
    closes.mockRestore();
    syncBuiltinESMExports();
    currentRuntime().cancel();
    if (passed) fs.rmSync(dir, { recursive: true, force: true });
    else console.error("Owned accepted-contract IO failure retained:", dir);
  }
});
