import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPreflight, PREFLIGHT_ENTRY, restorePreflight } from "../preflight";
import {
  approvePreflight,
  repairPreflightProjection,
  startApprovedPreflight,
  submitAndPresentPreflight,
} from "../preflight-human";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { createSubmitPreflightTool } from "../tools";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import { localProposal } from "./helpers/preflight";

const dirs: string[] = [];

beforeEach(() => {
  resetState();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-recovery-"));
  dirs.push(dir);
  return dir;
}

type Entry = {
  type: "custom";
  id: string;
  parentId: string | null;
  customType: string;
  data: unknown;
  digest?: string;
};

function fixture() {
  const dir = makeDir();
  const path = join(dir, "session.jsonl");
  const entries: Entry[] = [];
  let leaf: string | null = null;
  let count = 0;
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx.sessionManager, {
    getSessionFile: () => path,
    getLeafId: () => leaf,
    getBranch: () => entries,
  });
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
  mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const entry: Entry = {
      type: "custom",
      id: `e${++count}`,
      parentId: leaf,
      customType,
      data: structuredClone(data),
      digest: randomUUID(),
    };
    entries.push(entry);
    leaf = entry.id;
    appendFileSync(path, JSON.stringify(entry) + "\n");
  });
  vi.mocked(ctx.ui.select).mockResolvedValue("允许上述范围");
  return { ...mock, ctx, path, entries };
}

async function submitted(h: ReturnType<typeof fixture>) {
  const planning = beginPreflight(h.api, h.ctx, "Local fixture");
  return createSubmitPreflightTool(h.api).execute(
    "submit",
    { preflightId: planning.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
}

describe("approvePreflight edge cases", () => {
  it("throws when journal fault exists", async () => {
    const h = fixture();
    await submitted(h);
    currentRuntime().journalFault = "Test fault";
    await expect(approvePreflight(h.api, h.ctx)).rejects.toThrow("Test fault");
  });

  it("throws when not idle", async () => {
    const h = fixture();
    await submitted(h);
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    await expect(approvePreflight(h.api, h.ctx)).rejects.toThrow(
      "Wait for Main and pending messages before preflight control",
    );
  });

  it("throws when has pending messages", async () => {
    const h = fixture();
    await submitted(h);
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    await expect(approvePreflight(h.api, h.ctx)).rejects.toThrow(
      "Wait for Main and pending messages before preflight control",
    );
  });

  it("throws when no current-session preflight", async () => {
    const h = fixture();
    await expect(approvePreflight(h.api, h.ctx)).rejects.toThrow("No current-session preflight");
  });

  it("throws when preflight session does not match", async () => {
    const h = fixture();
    await submitted(h);
    vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("other-session");
    await expect(approvePreflight(h.api, h.ctx)).rejects.toThrow("No current-session preflight");
  });

  it("throws when planIdHint does not match", async () => {
    const h = fixture();
    await submitted(h);
    await expect(approvePreflight(h.api, h.ctx, "wrong-plan-id")).rejects.toThrow(
      "Preflight plan ID is stale",
    );
  });

  it("throws when no complete preflight proposal", async () => {
    const h = fixture();
    currentRuntime().preflight = {
      sessionId: "test-session",
      preflightId: "p1",
      goal: "Test",
      revision: 1,
    } as any;
    await expect(approvePreflight(h.api, h.ctx)).rejects.toThrow("No complete preflight proposal");
  });
});

describe("startApprovedPreflight edge cases", () => {
  it("throws when journal fault exists", async () => {
    const h = fixture();
    await submitted(h);
    await approvePreflight(h.api, h.ctx);
    currentRuntime().journalFault = "Test fault";
    await expect(startApprovedPreflight(h.api, h.ctx)).rejects.toThrow("Test fault");
  });

  it("throws when not idle", async () => {
    const h = fixture();
    await submitted(h);
    await approvePreflight(h.api, h.ctx);
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    await expect(startApprovedPreflight(h.api, h.ctx)).rejects.toThrow(
      "Wait for Main and pending messages before preflight control",
    );
  });

  it("throws when has pending messages", async () => {
    const h = fixture();
    await submitted(h);
    await approvePreflight(h.api, h.ctx);
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    await expect(startApprovedPreflight(h.api, h.ctx)).rejects.toThrow(
      "Wait for Main and pending messages before preflight control",
    );
  });

  it("does not turn an unsupported approval attempt into startup rights", async () => {
    const h = fixture();
    await submitted(h);
    await approvePreflight(h.api, h.ctx);
    expect(currentRuntime().preflight?.approval).toBeUndefined();
    const count = h.appendEntry.mock.calls.length;
    await expect(startApprovedPreflight(h.api, h.ctx)).rejects.toThrow(
      "Preflight authorization is absent or revoked",
    );
    expect(h.appendEntry).toHaveBeenCalledTimes(count);
  });
});

describe("submitAndPresentPreflight edge cases", () => {
  it("throws when toolCallId is empty", async () => {
    const h = fixture();
    await expect(submitAndPresentPreflight(h.api, h.ctx, "", "p1", localProposal)).rejects.toThrow(
      "Preflight submission cancelled",
    );
  });

  it("throws when signal is aborted", async () => {
    const h = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      submitAndPresentPreflight(h.api, h.ctx, "call-1", "p1", localProposal, controller.signal),
    ).rejects.toThrow("Preflight submission cancelled");
  });

  it("returns already_saved when revision unchanged", async () => {
    const h = fixture();
    await submitted(h);
    const before = currentRuntime().preflight!.revision;
    const result = await submitAndPresentPreflight(
      h.api,
      h.ctx,
      "call-1",
      currentRuntime().preflight!.preflightId,
      localProposal,
    );
    expect(result.status).toBe("already_saved");
    expect(currentRuntime().preflight!.revision).toBe(before);
  });
});

describe("repairPreflightProjection edge cases", () => {
  it("throws when not idle", () => {
    const h = fixture();
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    expect(() => {
      repairPreflightProjection(h.api, h.ctx);
    }).toThrow("Wait for Main and pending messages before repair");
  });

  it("throws when has pending messages", () => {
    const h = fixture();
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    expect(() => {
      repairPreflightProjection(h.api, h.ctx);
    }).toThrow("Wait for Main and pending messages before repair");
  });

  it("throws when no pending repair", () => {
    const h = fixture();
    expect(() => {
      repairPreflightProjection(h.api, h.ctx);
    }).toThrow("No pending preflight projection repair");
  });

  it("throws when repair session does not match", () => {
    const h = fixture();
    currentRuntime().preflightRepair = {
      sessionId: "other-session",
      controlEntryId: "e1",
      projectedDigest: "digest",
      faultMessage: "fault",
      ownsJournalFault: true,
    };
    expect(() => {
      repairPreflightProjection(h.api, h.ctx);
    }).toThrow("No pending preflight projection repair");
  });
});

describe("restorePreflight edge cases", () => {
  it("handles leaf customType mismatch gracefully", async () => {
    const h = fixture();
    await submitted(h);
    const state = currentRuntime().preflight!;
    // Manually append a wrong-type entry
    h.api.appendEntry("continuous-tasks:other", state);
    expect(() => {
      restorePreflight(h.ctx);
    }).not.toThrow();
    expect(currentRuntime().preflight).toEqual(state);
    expect(currentRuntime().preflight?.approval).toBeUndefined();
  });

  it("throws when leaf data digest does not match state", async () => {
    const h = fixture();
    await submitted(h);
    const state = currentRuntime().preflight!;
    // Modify state and re-append
    const modified = { ...state, revision: state.revision + 999 };
    h.api.appendEntry(PREFLIGHT_ENTRY, modified);
    expect(() => {
      restorePreflight(h.ctx);
    }).toThrow(/preflight proposal identity/i);
    expect(currentRuntime().preflight?.approval).toBeUndefined();
  });
});
