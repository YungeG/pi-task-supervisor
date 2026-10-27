import { describe, it, expect } from "vitest";
import { ownedCodemode } from "./helpers/owned-codemode";

describe("actual owned SDK only-mode producer in instrumented candidate modules", () => {
  it("seals actual parents before once-only deferred completion and consumes the qualification in final review", async () => {
    const result = await ownedCodemode("normal");
    expect(result.checks).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.state?.status).toBe("completed");
    const facts = result.branch.flatMap((row) =>
      row.type === "custom" && row.customType === "continuous-tasks:control-facts"
        ? [row.data as { kind: string; outcome?: string }]
        : [],
    );
    expect(
      facts.filter((row) => row.kind === "completion-intent-disposed" && row.outcome === "applied"),
    ).toHaveLength(1);
    expect(facts.some((row) => row.kind === "eligibility-attested")).toBe(true);
    expect(result.modelCalls).toBe(6);
  }, 20000);
  it.each([
    "late-write",
    "store",
    "image",
    "root-error",
    "capability-unavailable",
    "spill",
  ] as const)(
    "holds %s without rewriting eligibility or applying the queued done",
    async (kind) => {
      const result = await ownedCodemode(kind);
      expect(result.checks).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.state?.status).toBe("fault");
      const facts = result.branch.flatMap((row) =>
        row.type === "custom" && row.customType === "continuous-tasks:control-facts"
          ? [row.data as { kind: string; outcome?: string }]
          : [],
      );
      expect(
        facts.filter(
          (row) => row.kind === "completion-intent-disposed" && row.outcome === "invalidated",
        ),
      ).toHaveLength(1);
      expect(
        facts.some((row) => row.kind === "completion-intent-disposed" && row.outcome === "applied"),
      ).toBe(false);
      expect(result.modelCalls).toBe(5);
    },
    20000,
  );
  it("qualifies a real earlier write followed by validation, not by treating the container as readonly", async () => {
    const result = await ownedCodemode("write-then-check");
    expect(result.state?.status).toBe("completed");
    expect(result.errors).toEqual([]);
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" &&
          row.customType === "continuous-tasks:control-facts" &&
          (row.data as { kind: string; toolName?: string; effect?: string }).kind ===
            "invocation-started" &&
          (row.data as { toolName: string }).toolName === "owned_write" &&
          (row.data as { effect: string }).effect === "write",
      ),
    ).toBe(true);
  }, 20000);
  it("observes actual parallel writer/check overlap and cannot apply done", async () => {
    const result = await ownedCodemode("parallel");
    expect(result.overlapObserved).toBe(true);
    expect(result.checks).toBe(1);
    expect(result.state?.status).not.toBe("completed");
    expect(result.errors).toEqual([]);
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" &&
          (row.data as { kind?: string; outcome?: string }).kind === "completion-intent-disposed" &&
          (row.data as { outcome?: string }).outcome === "applied",
      ),
    ).toBe(false);
  }, 20000);
  it("retains an unfinished/cancelled actual child as unknown even after SDK idle, without completion", async () => {
    const result = await ownedCodemode("unfinished");
    expect(result.checks).toBe(1);
    expect(result.state?.status).not.toBe("completed");
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" &&
          (row.data as { kind?: string; outcome?: string }).kind === "invocation-ended" &&
          (row.data as { outcome?: string }).outcome === "unknown",
      ),
    ).toBe(true);
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" &&
          (row.data as { kind?: string; outcome?: string }).kind === "completion-intent-disposed" &&
          (row.data as { outcome?: string }).outcome === "applied",
      ),
    ).toBe(false);
  }, 20000);
  it("preserves an actual native pause during a deferred root and never publishes done", async () => {
    const result = await ownedCodemode("pause");
    expect(result.checks).toBe(1);
    expect(result.state?.status).toBe("paused");
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" &&
          (row.data as { kind?: string; outcome?: string }).kind === "completion-intent-disposed" &&
          (row.data as { outcome?: string }).outcome === "applied",
      ),
    ).toBe(false);
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" &&
          (row.data as { kind?: string }).kind === "completion-intent-queued",
      ),
    ).toBe(true);
  }, 20000);
  it("does not promote even physically present qualification bytes after an unknown append result", async () => {
    const result = await ownedCodemode("journal-uncertain");
    expect(result.injected).toBe(true);
    expect(result.checks).toBe(1);
    expect(result.state?.status).not.toBe("completed");
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" && (row.data as { kind?: string }).kind === "eligibility-attested",
      ),
    ).toBe(true);
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" &&
          (row.data as { kind?: string; outcome?: string }).kind === "completion-intent-disposed" &&
          (row.data as { outcome?: string }).outcome === "applied",
      ),
    ).toBe(false);
  }, 20000);
  it("reuses the exact queued intent on a repeated actual nested done without a second completion", async () => {
    const result = await ownedCodemode("duplicate-done");
    expect(result.state?.status).toBe("completed");
    expect(result.checks).toBe(1);
    const facts = result.branch.flatMap((row) =>
      row.type === "custom" && row.customType === "continuous-tasks:control-facts"
        ? [row.data as { kind: string; outcome?: string }]
        : [],
    );
    expect(facts.filter((row) => row.kind === "completion-intent-queued")).toHaveLength(1);
    expect(
      facts.filter((row) => row.kind === "completion-intent-disposed" && row.outcome === "applied"),
    ).toHaveLength(1);
  }, 20000);
  it.each(["conflicting-done", "task-change"] as const)(
    "invalidates %s instead of reinterpreting or replaying the original request",
    async (kind) => {
      const result = await ownedCodemode(kind);
      expect(result.state?.status).toBe("fault");
      expect(result.checks).toBe(1);
      const facts = result.branch.flatMap((row) =>
        row.type === "custom" && row.customType === "continuous-tasks:control-facts"
          ? [row.data as { kind: string; outcome?: string }]
          : [],
      );
      expect(facts.filter((row) => row.kind === "completion-intent-queued")).toHaveLength(1);
      expect(
        facts.filter(
          (row) => row.kind === "completion-intent-disposed" && row.outcome === "invalidated",
        ),
      ).toHaveLength(1);
      expect(
        facts.some((row) => row.kind === "completion-intent-disposed" && row.outcome === "applied"),
      ).toBe(false);
    },
    20000,
  );
  it.each(["bad-ref", "early-check", "nonzero-check"] as const)(
    "never queues %s as a successful original review receipt",
    async (kind) => {
      const result = await ownedCodemode(kind);
      expect(result.checks).toBe(1);
      expect(result.state?.status).not.toBe("completed");
      expect(
        result.branch.some(
          (row) =>
            row.type === "custom" &&
            (row.data as { kind?: string }).kind === "completion-intent-queued",
        ),
      ).toBe(false);
      expect(
        result.branch.some(
          (row) =>
            row.type === "custom" &&
            (row.data as { kind?: string; outcome?: string }).kind ===
              "completion-intent-disposed" &&
            (row.data as { outcome?: string }).outcome === "applied",
        ),
      ).toBe(false);
    },
    20000,
  );
  it("rechecks actual inputs after the root seal instead of laundering a later host write", async () => {
    const result = await ownedCodemode("after-seal-write");
    expect(result.injected).toBe(true);
    expect(result.checks).toBe(1);
    expect(result.state?.status).toBe("fault");
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" && (row.data as { kind?: string }).kind === "eligibility-attested",
      ),
    ).toBe(true);
    expect(
      result.branch.some(
        (row) =>
          row.type === "custom" &&
          (row.data as { kind?: string; outcome?: string }).kind === "completion-intent-disposed" &&
          (row.data as { outcome?: string }).outcome === "applied",
      ),
    ).toBe(false);
  }, 20000);
});
