import { beforeAll, describe, expect, it } from "vitest";
import { ownedCodemode } from "./helpers/owned-codemode";
import { ownedRecovery } from "./helpers/owned-codemode-recovery";
let source: string;
beforeAll(async () => {
  source = (await ownedCodemode("normal")).source;
}, 20000);
describe("actual SDK cold prefixes keep completion and metadata recovery separate", () => {
  // Negative source mutants, never positive SDK outcome proof.
  it.each(["missing-sealed-outcome", "changed-bindings"] as const)(
    "does not restore %s as accepted merely from a completed checkpoint",
    async (kind) => {
      const rows = source
        .trimEnd()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              id: string;
              parentId?: string | null;
              type: string;
              customType?: string;
              data?: { kind?: string; status?: string; bindings?: Array<{ digest: string }> };
            },
        );
      if (kind === "missing-sealed-outcome") {
        const index = rows.findIndex((row) => row.data?.kind === "review-attempt-observed");
        if (index < 1) throw Error("Owned outcome missing");
        const parent = rows[index - 1]!.id;
        rows.splice(index, 1);
        rows[index]!.parentId = parent;
      } else {
        const completed = [...rows]
          .reverse()
          .find(
            (row) =>
              row.customType === "continuous-tasks:supervisor" && row.data?.status === "completed",
          );
        if (!completed?.data?.bindings?.[0]) throw Error("Owned binding missing");
        completed.data.bindings[0].digest = "0".repeat(64);
      }
      const result = await ownedRecovery(
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "accepted",
      );
      expect(result.modelCalls).toBe(0);
      const latest = [...result.branch]
        .reverse()
        .find((row) => row.type === "custom" && row.customType === "continuous-tasks:supervisor");
      expect(
        latest?.type === "custom" ? (latest.data as { status: string }).status : undefined,
      ).toBe("fault");
    },
    20000,
  );
  it("retains a real sealed accepted outcome without rewriting it or manufacturing a current check", async () => {
    const result = await ownedRecovery(source, "accepted");
    expect(result.initial).toBe(result.before);
    expect(result.before).toBe(result.after);
    expect(result.after).toBe(result.repeated);
    expect(result.modelCalls).toBe(0);
    const latest = [...result.branch]
      .reverse()
      .find((row) => row.type === "custom" && row.customType === "continuous-tasks:supervisor");
    expect(latest?.type === "custom" ? (latest.data as { status: string }).status : undefined).toBe(
      "completed",
    );
  }, 20000);
  it("cannot reapply an actually invalidated native intent after cold restoration", async () => {
    const producer = await ownedCodemode("store"),
      result = await ownedRecovery(producer.source, "invalidated");
    expect(result.before).toBe(result.after);
    expect(result.after).toBe(result.repeated);
    expect(result.modelCalls).toBe(0);
    expect(result.appendedRows).toBe(0);
    expect(
      result.notices.some((text) => text.includes("invalidated intent cannot be reapplied")),
    ).toBe(true);
  }, 20000);
  it.each(["done", "binding", "applied"] as const)(
    "repairs only the confirmed %s group, then appends nothing on repetition",
    async (stage) => {
      const result = await ownedRecovery(source, stage);
      expect(result.errors).toEqual([]);
      expect(result.modelCalls).toBe(0);
      expect(result.after).toBe(result.repeated);
      expect(result.appendedRows).toBe(stage === "done" ? 2 : stage === "binding" ? 1 : 0);
      const facts = result.branch.flatMap((row) =>
        row.type === "custom" && row.customType === "continuous-tasks:control-facts"
          ? [row.data as { kind: string; outcome?: string }]
          : [],
      );
      expect(
        facts.filter(
          (row) => row.kind === "completion-intent-disposed" && row.outcome === "applied",
        ),
      ).toHaveLength(1);
      expect(facts.some((row) => row.kind === "review-attempt-started")).toBe(false);
    },
    20000,
  );
  it("does not turn an uncommitted cold intent into done or buy fresh validation", async () => {
    const result = await ownedRecovery(source, "queued");
    expect(result.before).toBe(result.after);
    expect(result.repeated).toBe(result.before);
    expect(result.modelCalls).toBe(0);
    expect(result.appendedRows).toBe(0);
    expect(result.errors).toEqual([]);
    expect(
      result.notices.some((text) => text.includes("no exact confirmed original done snapshot")),
    ).toBe(true);
  }, 20000);
});
