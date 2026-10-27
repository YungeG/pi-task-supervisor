import { describe, it, expect } from "vitest";
import {
  WriteTasksParams,
  EditTasksParams,
  CompileTasksParams,
  ClearTasksParams,
  GetReadyTasksParams,
  AdvanceTasksParams,
  WorkflowGateParams,
} from "../schemas";

// TypeBox schemas are plain objects at runtime but the TypeScript types
// don't expose all properties (minItems, maxItems, enum, etc.).
// We cast through `any` to inspect schema structure directly.

// ═══════════════════════════════════════════
// 1. WriteTasksParams
// ═══════════════════════════════════════════

describe("WriteTasksParams", () => {
  it("is an object schema", () => {
    expect(WriteTasksParams.type).toBe("object");
  });

  it("has mode as a required property", () => {
    expect(WriteTasksParams.properties.mode).toBeDefined();
    expect(WriteTasksParams.required).toContain("mode");
  });

  it("mode is a string enum with replace and append options", () => {
    const mode = WriteTasksParams.properties.mode as any;
    expect(mode.type).toBe("string");
    expect(mode.enum).toBeDefined();
    expect(mode.enum).toEqual(["replace", "append"]);
  });

  it("has phases as a required array property with minItems: 1", () => {
    const phases = WriteTasksParams.properties.phases as any;
    expect(phases.type).toBe("array");
    expect(phases.minItems).toBe(1);
    expect(WriteTasksParams.required).toContain("phases");
  });

  it("phase object has title and tasks properties", () => {
    const phase = (WriteTasksParams.properties.phases as any).items;
    expect(phase.type).toBe("object");
    expect(phase.properties.title).toBeDefined();
    expect(phase.properties.tasks).toBeDefined();
    expect(phase.required).toContain("title");
    expect(phase.required).toContain("tasks");
  });

  it("phase title is a string schema", () => {
    const title = (WriteTasksParams.properties.phases as any).items.properties.title;
    expect(title.type).toBe("string");
  });

  it("tasks array within a phase has minItems: 1", () => {
    const tasks = (WriteTasksParams.properties.phases as any).items.properties.tasks;
    expect(tasks.type).toBe("array");
    expect(tasks.minItems).toBe(1);
  });

  it("task object has title, prompt, and profile string fields", () => {
    const task = (WriteTasksParams.properties.phases as any).items.properties.tasks.items;
    expect(task.type).toBe("object");
    expect(task.properties.title.type).toBe("string");
    expect(task.properties.prompt.type).toBe("string");
    expect(task.properties.profile.type).toBe("string");
    expect(task.required).toContain("title");
    expect(task.required).toContain("prompt");
    expect(task.required).toContain("profile");
  });
});

// ═══════════════════════════════════════════
// 2. EditTasksParams
// ═══════════════════════════════════════════

describe("EditTasksParams", () => {
  it("is an object schema with tasks property", () => {
    expect(EditTasksParams.type).toBe("object");
    expect(EditTasksParams.properties.tasks).toBeDefined();
    expect(EditTasksParams.required).toContain("tasks");
  });

  it("tasks is an array schema with maxItems: 50", () => {
    const tasks = EditTasksParams.properties.tasks as any;
    expect(tasks.type).toBe("array");
    expect(tasks.maxItems).toBe(50);
  });

  it("tasks items is a union of three variants (data, blockers, abandon)", () => {
    const union = (EditTasksParams.properties.tasks as any).items;
    expect(union.anyOf).toBeDefined();
    expect(union.anyOf).toHaveLength(3);
  });

  it("first variant is the 'data' type", () => {
    const variant = (EditTasksParams.properties.tasks as any).items.anyOf[0];
    expect(variant.properties.id).toBeDefined();
    expect(variant.properties.type.enum).toEqual(["data"]);
    expect(variant.properties.data).toBeDefined();
  });

  it("'data' variant has optional title, prompt, profile, and phase fields", () => {
    const data = (EditTasksParams.properties.tasks as any).items.anyOf[0].properties.data;
    expect(data.type).toBe("object");
    expect(data.properties.title).toBeDefined();
    expect(data.properties.prompt).toBeDefined();
    expect(data.properties.profile).toBeDefined();
    expect(data.properties.phase).toBeDefined();
    // All fields are optional — no required array (undefined, not [])
    expect(data.required).toBeUndefined();
  });

  it("second variant is the 'blockers' type", () => {
    const variant = (EditTasksParams.properties.tasks as any).items.anyOf[1];
    expect(variant.properties.id).toBeDefined();
    expect(variant.properties.type.enum).toEqual(["blockers"]);
    expect(variant.properties.data).toBeDefined();
    expect(variant.properties.data.properties.dependencies.type).toBe("array");
  });

  it("third variant is the 'abandon' type with no data property", () => {
    const variant = (EditTasksParams.properties.tasks as any).items.anyOf[2];
    expect(variant.properties.id).toBeDefined();
    expect(variant.properties.type.enum).toEqual(["abandon"]);
    expect("data" in variant.properties).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 3. GetReadyTasksParams
// ═══════════════════════════════════════════

describe("GetReadyTasksParams", () => {
  it("is an object schema with count property", () => {
    expect(GetReadyTasksParams.type).toBe("object");
    expect(GetReadyTasksParams.properties.count).toBeDefined();
    expect(GetReadyTasksParams.required).toContain("count");
  });

  it("count is an integer with minimum: 1", () => {
    const count = GetReadyTasksParams.properties.count as any;
    expect(count.type).toBe("integer");
    expect(count.minimum).toBe(1);
  });
});

// ═══════════════════════════════════════════
// 4. AdvanceTasksParams
// ═══════════════════════════════════════════

describe("AdvanceTasksParams", () => {
  it("requires per-task transitions", () => {
    expect(AdvanceTasksParams.type).toBe("object");
    expect(AdvanceTasksParams.properties.transitions).toBeDefined();
    expect(AdvanceTasksParams.required).toContain("transitions");
  });

  it("bounds transitions and completion evidence", () => {
    const transitions = AdvanceTasksParams.properties.transitions as any;
    expect(transitions.type).toBe("array");
    expect(transitions.minItems).toBe(1);
    expect(transitions.maxItems).toBe(50);
    expect(transitions.items.properties.id.type).toBe("string");
    const evidence = transitions.items.properties.evidence;
    expect(evidence.properties.summary.maxLength).toBe(1000);
    expect(evidence.properties.refs.minItems).toBe(1);
    expect(evidence.properties.refs.maxItems).toBe(20);
  });
});

// ═══════════════════════════════════════════
// 5. CompileTasksParams / ClearTasksParams
// ═══════════════════════════════════════════

describe("CompileTasksParams", () => {
  it("requires the final acceptance task id", () => {
    expect(CompileTasksParams.type).toBe("object");
    expect(CompileTasksParams.properties.finalAcceptanceTaskId).toBeDefined();
    expect(CompileTasksParams.required).toContain("finalAcceptanceTaskId");
  });
});

describe("WorkflowGateParams", () => {
  it("exposes bounded decision and execution receipt fields", () => {
    expect(WorkflowGateParams.required).toContain("action");
    expect((WorkflowGateParams.properties.action as any).enum).toEqual([
      "wait_for_decision",
      "bind_execution",
      "clear_execution",
      "resolve_execution",
    ]);
    expect((WorkflowGateParams.properties.decision as any).properties.question.maxLength).toBe(
      1000,
    );
    expect((WorkflowGateParams.properties.executionRef as any).properties.runId.maxLength).toBe(
      200,
    );
    const resolution = WorkflowGateParams.properties.resolution;
    expect(Reflect.get(resolution, "additionalProperties")).toBe(false);
    expect(Reflect.get(resolution.properties.validationRefs, "minItems")).toBe(1);
    expect(Reflect.get(resolution.properties.validationRefs, "maxItems")).toBe(20);
    expect(Reflect.get(resolution.properties.settlementId, "maxLength")).toBe(100);
    expect(resolution.properties).not.toHaveProperty("proof");
  });
});

describe("ClearTasksParams", () => {
  it("is an object schema with no required fields", () => {
    expect(ClearTasksParams.type).toBe("object");
    expect(ClearTasksParams.properties).toBeDefined();
    expect(ClearTasksParams.required).toBeUndefined();
  });
});
