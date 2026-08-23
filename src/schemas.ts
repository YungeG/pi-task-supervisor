import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ── Schemas ──

export const WriteTasksParams = Type.Object({
  mode: StringEnum(["replace", "append"], {
    description: "'replace' clears the board before writing; 'append' adds to existing tasks",
  }),
  phases: Type.Array(
    Type.Object({
      title: Type.String({ description: "Short phase title" }),
      tasks: Type.Array(
        Type.Object({
          title: Type.String({ description: "Short task title" }),
          prompt: Type.String({ description: "Detailed implementation instructions" }),
          profile: Type.String({ description: "Agent profile name for task delegation" }),
        }),
        { description: "Tasks in this phase (at least 1)", minItems: 1 },
      ),
    }),
    { description: "Phases to write to the board", minItems: 1 },
  ),
});

export const EditTasksParams = Type.Object({
  tasks: Type.Array(
    Type.Union([
      Type.Object({
        id: Type.String(),
        type: StringEnum(["data"]),
        data: Type.Object({
          title: Type.Optional(Type.String()),
          prompt: Type.Optional(Type.String()),
          profile: Type.Optional(Type.String()),
          phase: Type.Optional(Type.Integer()),
        }),
      }),
      Type.Object({
        id: Type.String(),
        type: StringEnum(["blockers"]),
        data: Type.Object({
          dependencies: Type.Array(Type.String()),
        }),
      }),
      Type.Object({
        id: Type.String(),
        type: StringEnum(["abandon"]),
      }),
    ]),
    { maxItems: 50 },
  ),
});

export const CompileTasksParams = Type.Object({
  finalAcceptanceTaskId: Type.String({
    description: "Task id in the final phase that owns final acceptance",
    minLength: 1,
    maxLength: 100,
  }),
});

export const ClearTasksParams = Type.Object({});

export const GetReadyTasksParams = Type.Object({
  count: Type.Integer({ description: "Number of tasks to claim (>= 1)", minimum: 1 }),
});

const EvidenceRefParams = Type.Object({
  kind: StringEnum(["command", "review", "artifact", "diff"] as const),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  status: StringEnum(["passed", "fixed", "deferred"] as const),
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  exitCode: Type.Optional(Type.Integer()),
  digest: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

const CompletionEvidenceParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
  refs: Type.Array(EvidenceRefParams, { minItems: 1, maxItems: 20 }),
  residualRisks: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
  ),
});

export const AdvanceTasksParams = Type.Object({
  transitions: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 100 }),
      evidence: Type.Optional(CompletionEvidenceParams),
    }),
    { minItems: 1, maxItems: 50 },
  ),
});
