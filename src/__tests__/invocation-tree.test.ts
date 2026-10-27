import { expect, it } from "vitest";
import { createCodemodeExtension, type ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  admitInvocation,
  assertInvocationCapacity,
  codemodeCapability,
  emptyInvocationGraph,
  invocationEffect,
  invocationParent,
  invocationSealIssue,
  invocationValidationIssue,
  invocationUnknownIssue,
  invocationGraphIssue,
  observeInvocationEnd,
  SDK_TOOL_ONLY_CAPABILITY,
  type InvocationEffect,
  type InvocationGraph,
  type InvocationStartedV1,
} from "../invocation-tree";
import type { WorkOwnerKey } from "../control-journal";
const owner: WorkOwnerKey = {
  kind: "goal",
  goal: {
    sessionId: "owned-session",
    goalKey: "owned-goal",
    goalRunId: null,
    lifecycleCommitId: null,
  },
};
const ref = (id: string) => ({ entryId: id, digest: "a".repeat(64) });
// Pure structural inputs, not execution/permission/receipt proof. Real SDK qualification is separate.
function start(
  g: InvocationGraph,
  id: string,
  parentId: string | null = null,
  effect: InvocationEffect = parentId ? "write" : "container",
  extra: Partial<InvocationStartedV1> = {},
) {
  const parent = parentId ? g.nodes.get(parentId) : undefined;
  return admitInvocation(
    g,
    {
      version: 1,
      kind: "invocation-started",
      recordId: `s-${id}`,
      owner,
      operationId: id,
      toolCallId: id,
      parentId,
      rootId: parent?.rootId ?? id,
      sequence: g.sequence + 1,
      toolName: effect === "container" ? "codemode" : "owned-check",
      effect,
      capability: effect === "container" ? SDK_TOOL_ONLY_CAPABILITY : null,
      inputDigest: "a".repeat(64),
      sourceRef: null,
      modeRef: null,
      ...extra,
    },
    ref(`s-${id}`),
  );
}
function end(
  g: InvocationGraph,
  id: string,
  extra: Partial<Parameters<typeof observeInvocationEnd>[1]> = {},
) {
  return observeInvocationEnd(
    g,
    {
      version: 1,
      kind: "invocation-ended",
      recordId: `e-${id}`,
      owner,
      operationId: id,
      sequence: g.sequence + 1,
      outcome: "returned",
      receiptId: `tool:${id}`,
      receiptDigest: "b".repeat(64),
      receiptRef: null,
      exitCode: 0,
      effects: "tool-only",
      reasons: [],
      artifactVersion: null,
      ...extra,
    },
    ref(`e-${id}`),
  );
}
it("rejects replay under a new record or operation identity and a missing root aggregate", () => {
  const g = emptyInvocationGraph();
  start(g, "root");
  expect(() => start(g, "root", null, "container", { recordId: "new-record" })).toThrow(
    /already admitted/,
  );
  expect(() => start(g, "new-operation", null, "container", { toolCallId: "root" })).toThrow(
    /already admitted/,
  );
  g.roots.delete("root");
  expect(() => end(g, "root")).toThrow(/root index is missing/);
});
it("separates current live roots from cold/uncertain nodes and later root intervals", () => {
  const g = emptyInvocationGraph();
  start(g, "root");
  start(g, "check", "root");
  expect(invocationUnknownIssue(g, new Set(["root"]))).toBeUndefined();
  expect(invocationUnknownIssue(g, new Set())).toMatch(/not current live SDK work/);
  end(g, "check");
  end(g, "root");
  start(g, "later");
  start(g, "writer", "later");
  end(g, "writer");
  end(g, "later");
  expect(invocationValidationIssue(g, "check")).toBeUndefined();
  expect(invocationGraphIssue(undefined)).toBeUndefined();
  expect(invocationUnknownIssue(undefined, new Set())).toBeUndefined();
});
it("keeps actual opaque parent identities and a compact ordered history", () => {
  const g = emptyInvocationGraph();
  start(g, "opaque-root");
  expect(invocationParent(g, owner, undefined)).toBeUndefined();
  expect(invocationParent(g, owner, "opaque-root")?.operationId).toBe("opaque-root");
  start(g, "not/a/parent/hint", "opaque-root");
  end(g, "not/a/parent/hint");
  end(g, "opaque-root");
  expect(invocationValidationIssue(g, "not/a/parent/hint")).toBeUndefined();
  expect(g.roots.get("opaque-root")).toMatchObject({ started: 2, ended: 2 });
  expect(g.active.size).toBe(0);
});
it("rejects fake, foreign, duplicate, ended and inconsistent parent identities", () => {
  const g = emptyInvocationGraph();
  start(g, "root");
  start(g, "child", "root");
  end(g, "child");
  expect(() => invocationParent(g, owner, "missing")).toThrow();
  expect(() => invocationParent(g, owner, "child")).toThrow();
  expect(() => start(g, "child", "root")).toThrow(/identity/);
  expect(() => start(g, "wrong-root", "root", "write", { rootId: "invented" })).toThrow(/root/);
  expect(() =>
    start(g, "foreign", "root", "write", {
      owner: { kind: "goal", goal: { ...owner.goal, sessionId: "foreign" } },
    }),
  ).toThrow(/owner/);
  expect(() => start(g, "missing-parent", "missing")).toThrow(/parent/);
  expect(() => start(g, "gap", "root", "write", { sequence: g.sequence + 2 })).toThrow(/sequence/);
  expect(() => end(g, "child")).toThrow(/duplicate/i);
  expect(() =>
    end(g, "root", { owner: { kind: "goal", goal: { ...owner.goal, sessionId: "foreign" } } }),
  ).toThrow(/foreign/);
});
it("never seals live or failed descendants, and does not treat slash IDs as parent metadata", () => {
  const g = emptyInvocationGraph();
  start(g, "r");
  start(g, "r/1");
  expect(g.nodes.get("r/1")?.parentId).toBe(null);
  start(g, "child", "r");
  expect(() => end(g, "r")).toThrow(/live/);
  expect(invocationSealIssue(g, "r")).toMatch(/not kernel-ended/);
  end(g, "child", { outcome: "error" });
  end(g, "r");
  expect(invocationSealIssue(g, "r")).toMatch(/failed/);
  expect(invocationValidationIssue(g, "missing")).toMatch(/no original/);
});
it("retains unknown kernel endings as negative safety references, never quiet proof", () => {
  const g = emptyInvocationGraph();
  start(g, "r");
  start(g, "child", "r");
  end(g, "r", { outcome: "unknown", effects: "unqualified", reasons: ["unawaited child"] });
  expect(g.active.has("r")).toBe(true);
  expect(() => invocationParent(g, owner, "r")).toThrow();
  end(g, "child");
  expect(g.active.has("r")).toBe(true);
  expect(invocationSealIssue(g, "r")).toBeDefined();
});
it.each(["overlap", "late", "readonly", "metadata"])(
  "classifies %s sibling order without hash-equality laundering",
  (kind) => {
    const g = emptyInvocationGraph();
    start(g, "r");
    start(g, "check", "r");
    if (kind === "late") end(g, "check");
    start(
      g,
      "sibling",
      "r",
      kind === "readonly" ? "readonly" : kind === "metadata" ? "metadata" : "write",
    );
    end(g, "sibling");
    if (kind !== "late") end(g, "check");
    end(g, "r");
    const issue = invocationValidationIssue(g, "check");
    if (kind === "overlap") expect(issue).toMatch(/overlapped/);
    else if (kind === "late") expect(issue).toMatch(/followed/);
    else expect(issue).toBeUndefined();
  },
);
it("rejects unsupported source/non-tool effects and failed or nonzero validation", () => {
  for (const kind of ["source", "effect", "failed", "nonzero", "missing-receipt"]) {
    const g = emptyInvocationGraph();
    start(g, "r", null, "container", kind === "source" ? { capability: null } : {});
    start(g, "check", "r");
    end(
      g,
      "check",
      kind === "failed"
        ? { outcome: "cancelled" }
        : kind === "nonzero"
          ? { exitCode: 1 }
          : kind === "missing-receipt"
            ? { receiptId: null }
            : {},
    );
    end(g, "r", kind === "effect" ? { effects: "unqualified", reasons: ["store"] } : {});
    expect(invocationValidationIssue(g, "check")).toBeDefined();
  }
});
it("bounds active nodes/depth but retains over 512 ended sequential nodes", () => {
  const g = emptyInvocationGraph();
  start(g, "root");
  for (let i = 0; i < 1000; i++) {
    start(g, `leaf-${i}`, "root", "readonly");
    end(g, `leaf-${i}`, { exitCode: null });
  }
  expect(g.active.size).toBe(1);
  expect(g.nodes.has("root")).toBe(true);
  expect(g.nodes.size).toBe(1001);
  end(g, "root");
  expect(invocationSealIssue(g, "root")).toBeUndefined();
  const deep = emptyInvocationGraph();
  start(deep, "root");
  for (let i = 1; i < 16; i++) start(deep, `depth-${i}`, i === 1 ? "root" : `depth-${i - 1}`);
  expect(() => start(deep, "too-deep", "depth-15")).toThrow(/depth/);
  const full = emptyInvocationGraph();
  for (let i = 0; i < 512; i++) start(full, `active-${i}`);
  expect(() => {
    assertInvocationCapacity(full);
  }).toThrow(/active-node/);
  expect(full.active.size).toBe(512);
});
it("requires actual SDK schema/source/model-disabled metadata, not a name or readonly hint", () => {
  let definition: Pick<ToolInfo, "parameters" | "description"> | undefined;
  void createCodemodeExtension({ models: false })({
    registerTool: (tool) => {
      definition = tool;
    },
  } as Parameters<ReturnType<typeof createCodemodeExtension>>[0]);
  if (!definition) throw Error("SDK definition missing");
  const tool: ToolInfo = {
    name: "codemode",
    parameters: definition.parameters,
    description: definition.description,
    exposure: "model-only",
    sourceInfo: {
      path: "builtin:codemode",
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
  };
  expect(codemodeCapability(tool)).toBe(SDK_TOOL_ONLY_CAPABILITY);
  expect(
    codemodeCapability({ ...tool, parameters: structuredClone(tool.parameters) }),
  ).toBeUndefined();
  expect(
    codemodeCapability({ ...tool, sourceInfo: { ...tool.sourceInfo, path: "fake:codemode" } }),
  ).toBeUndefined();
  expect(
    codemodeCapability({ ...tool, description: tool.description + "models enabled" }),
  ).toBeUndefined();
  expect(
    invocationEffect({
      ...tool,
      parameters: structuredClone(tool.parameters),
      annotations: { readOnlyHint: true },
    }),
  ).toBe("write");
  expect(
    invocationEffect({
      ...tool,
      name: "read",
      sourceInfo: { ...tool.sourceInfo, path: "builtin:read" },
    }),
  ).toBe("readonly");
  expect(invocationEffect(undefined)).toBe("write");
});
