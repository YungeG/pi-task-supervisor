import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedCliRoots } from "../../human-ui";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
import { afterEach, vi } from "vitest";
import { lifecycle } from "./lifecycle";

/** SDK persistence boundary: appends have actual unique branch identities, not a fixed fake leaf. */
export function preflightLifecycle() {
  const h = lifecycle();
  // Real-file/native-boundary simulation, never a production source bypass.
  const dir = mkdtempSync(join(tmpdir(), "preflight-fixture-"));
  const path = join(dir, "session.jsonl");
  const oldArgv = process.argv;
  const descriptors = [process.stdin, process.stdout].map((s) =>
    Object.getOwnPropertyDescriptor(s, "isTTY"),
  );
  const root = trustedCliRoots()[0];
  if (!root) throw new Error("Installed Pi peer dependency required");
  process.argv = [process.execPath, join(root, "dist", "cli.js")];
  for (const stream of [process.stdin, process.stdout])
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  cleanups.push(() => {
    process.argv = oldArgv;
    [process.stdin, process.stdout].forEach((stream, i) => {
      if (descriptors[i]) Object.defineProperty(stream, "isTTY", descriptors[i]);
      else Reflect.deleteProperty(stream, "isTTY");
    });
    rmSync(dir, { recursive: true, force: true });
  });
  const header = JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n";
  writeFileSync(path, header);
  Object.assign(h.ctx.sessionManager, { getSessionFile: vi.fn(() => path) });
  vi.mocked(h.ctx.ui.select).mockResolvedValue("Defer");
  const entries: Array<{
    type: "custom";
    id: string;
    parentId: string | null;
    timestamp: string;
    customType: string;
    data: unknown;
  }> = [];
  let leaf: string | null = null;
  vi.mocked(h.ctx.sessionManager.getBranch).mockImplementation(() => entries);
  vi.mocked(h.ctx.sessionManager.getLeafId).mockImplementation(() => leaf);
  h.mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const id = `entry-${entries.length + 1}`;
    entries.push({
      type: "custom",
      id,
      parentId: leaf,
      timestamp: new Date().toISOString(),
      customType,
      data: structuredClone(data),
    });
    leaf = id;
    appendFileSync(path, JSON.stringify(entries.at(-1)) + "\n");
  });
  const command = async (args: string) => {
    vi.mocked(h.ctx.ui.select).mockImplementation(async (_title, options) =>
      options.includes("Start execution") ? "Start execution" : "Approve",
    );
    try {
      await h.command(args);
    } finally {
      vi.mocked(h.ctx.ui.select).mockResolvedValue("Defer");
    }
  };
  return {
    ...h,
    command,
    entries,
    path,
    syncJournal: () => {
      writeFileSync(path, header + entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    },
  };
}

export const localProposal = {
  summary: "Implement the local fixture with a bounded dependency option",
  steps: ["Inspect current code", "Implement approved changes", "Run local validation"],
  acceptance: ["Local validation passes"],
  permissions: [
    {
      id: "A1",
      action: "Modify the approved source and tests",
      target: "Current repository source and tests",
      environment: "Local checkout only",
      required: true,
      limits: "No external changes or new dependencies",
      risks: "Reversible local file changes",
      fallback: "Keep the current implementation if approval is refused",
      reconfirm: "New paths, goals or external effects",
    },
    {
      id: "A2",
      action: "Install a specific optional dependency",
      target: "Approved fixture dependency only",
      environment: "Local checkout only",
      required: false,
      limits: "One explicitly named dependency",
      risks: "Dependency and lock-file change",
      fallback: "Use the documented no-new-dependency route",
      reconfirm: "Package or source changes",
    },
  ],
  prohibitions: ["No push, publication, deployment or credential changes"],
  reconfirm: ["Material scope changes require a new exact proposal"],
};
