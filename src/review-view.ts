import type { GoalOwnerKey, ExecutionRegistryEntry } from "./control-journal";
import type { GoalScope } from "./goal-records";
import type { ArtifactVersionV1 } from "./artifact-version";
import type { FinalValidationObservation } from "./final-review";
import type { AdvisorUsage } from "./advisor-calls";
import type { SupervisorState } from "./supervisor";
import type { TaskBoardSnapshot } from "./types";
import { digest, redact, redactedJSON, type HostReceipt } from "./receipt-store";

export interface ReviewViewInput {
  goal: string;
  owner?: GoalOwnerKey;
  goalScope?: GoalScope;
  planningAttemptId?: string;
  preflight?: unknown;
  board: Readonly<TaskBoardSnapshot>;
  bindings: readonly SupervisorState["bindings"][number][];
  receipts: readonly HostReceipt[];
  recent: readonly { role: string; text: string }[];
  acceptanceBlocker: string | null;
  advisorAccounting?: AdvisorUsage;
  execution?: readonly ExecutionRegistryEntry[];
  artifactVersion?: Omit<ArtifactVersionV1, "inputs" | "artifacts">;
  validationSupplement?: FinalValidationObservation;
  progress?: unknown;
  acceptance?: unknown;
  qualifications?: unknown;
  reviewDelivery?: {
    details?: readonly EvidenceDetailV1[];
    correction?: { allowedActions: readonly string[]; reason: string };
  };
}
export interface ReviewDetailRef {
  id: string;
  sourceId: string;
  field: "input" | "output" | "task-body" | "text";
  sourceDigest: string;
  availableBytes: number;
  viewBytes: number;
  sourceCompleteness: "retained-capture-unknown" | "provided-text";
}
export interface ReviewViewV1 {
  version: 1;
  packet: string;
  bytes: number;
  digest: string;
  shortened: boolean;
  detailRefs: ReviewDetailRef[];
}
export interface ReviewViewError {
  code: "REVIEW_VIEW_TOO_LARGE" | "EVIDENCE_MISSING" | "REVIEW_SOURCE_INVALID";
  message: string;
}
export type ReviewViewResult =
  | { status: "ready"; view: ReviewViewV1 }
  | { status: "error"; error: ReviewViewError };
export interface EvidenceDetailV1 extends ReviewDetailRef {
  version: 1;
  text: string;
  shortened: boolean;
  deliveredDigest: string;
}
interface Material {
  id: string;
  sourceId: string;
  field: ReviewDetailRef["field"];
  sourceDigest: string;
  text: string;
  sourceCompleteness: ReviewDetailRef["sourceCompleteness"];
}
const MAX_BYTES = 64_000;
function material(
  sourceId: string,
  field: Material["field"],
  sourceDigest: string,
  text: string,
  capture = false,
): Material {
  return {
    id: `detail:${digest(["review-detail-v1", sourceId, field])}`,
    sourceId,
    field,
    sourceDigest,
    text: redact(text, text.length + 1),
    sourceCompleteness: capture ? "retained-capture-unknown" : "provided-text",
  };
}
function materials(input: ReviewViewInput): Material[] {
  return [
    ...input.receipts.flatMap((receipt) => [
      material(receipt.id, "input", receipt.digest, receipt.input, true),
      material(receipt.id, "output", receipt.digest, receipt.output, true),
    ]),
    ...input.board.tasks.map((task) =>
      material(
        `task:${task.id}`,
        "task-body",
        digest(task),
        redactedJSON({
          prompt: task.prompt,
          summary: task.completionEvidence?.summary,
          labels: task.completionEvidence?.refs.map((ref) => ref.label),
        }),
      ),
    ),
    ...input.recent.map((entry, index) =>
      material(`transcript:${index}`, "text", digest(entry), entry.text),
    ),
  ];
}
function prefix(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let bytes = 0,
    result = "";
  for (const char of text) {
    const next = Buffer.byteLength(char);
    if (bytes + next > limit) break;
    bytes += next;
    result += char;
  }
  return result;
}
interface BodyLimits {
  bound: number;
  unbound: number;
}
function reference(item: Material, text: string): ReviewDetailRef {
  return {
    id: item.id,
    sourceId: item.sourceId,
    field: item.field,
    sourceDigest: item.sourceDigest,
    availableBytes: Buffer.byteLength(item.text),
    viewBytes: Buffer.byteLength(text),
    sourceCompleteness: item.sourceCompleteness,
  };
}
function excerptTask(
  id: string,
  limit: number,
  byField: ReadonlyMap<string, Material>,
  details: ReviewDetailRef[],
): { prompt: string; summary?: string; labels?: string[] } {
  const item = byField.get(`task:${id}\0task-body`);
  if (!item) throw Error("Unregistered task material");
  const original = JSON.parse(item.text) as {
    prompt: string;
    summary?: string;
    labels?: string[];
  };
  const body = {
    prompt: prefix(original.prompt, limit),
    ...(original.summary === undefined ? {} : { summary: prefix(original.summary, limit) }),
    ...(original.labels ? { labels: original.labels.map((label) => prefix(label, limit)) } : {}),
  };
  const text = JSON.stringify(body);
  if (
    text !== item.text &&
    (body.prompt !== original.prompt ||
      body.summary !== original.summary ||
      JSON.stringify(body.labels) !== JSON.stringify(original.labels))
  )
    details.push(reference(item, text));
  return body;
}
function packetFor(
  input: ReviewViewInput,
  source: readonly Material[],
  limits: BodyLimits,
): { packet: string; details: ReviewDetailRef[] } {
  const bound = new Set(input.bindings.flatMap((binding) => binding.refs));
  if (input.validationSupplement) bound.add(input.validationSupplement.receiptId);
  const byField = new Map(source.map((item) => [`${item.sourceId}\0${item.field}`, item]));
  const details: ReviewDetailRef[] = [];
  const excerpt = (sourceId: string, field: Material["field"], limit: number): string => {
    const item = byField.get(`${sourceId}\0${field}`);
    if (!item) throw Error("Unregistered review material");
    const text = prefix(item.text, limit);
    if (text !== item.text) details.push(reference(item, text));
    return text;
  };
  const board = {
    ...input.board,
    tasks: input.board.tasks.map((task) => {
      const body = excerptTask(task.id, limits.unbound, byField, details);
      return {
        ...task,
        prompt: body.prompt,
        ...(task.completionEvidence
          ? {
              completionEvidence: {
                ...task.completionEvidence,
                summary: body.summary,
                refs: task.completionEvidence.refs.map((ref, index) => ({
                  ...ref,
                  label: body.labels?.[index] ?? ref.label,
                })),
              },
            }
          : {}),
      };
    }),
  };
  const receipts = input.receipts.map((receipt) => ({
    ...receipt,
    input: excerpt(receipt.id, "input", bound.has(receipt.id) ? limits.bound : limits.unbound),
    output: excerpt(receipt.id, "output", bound.has(receipt.id) ? limits.bound : limits.unbound),
  }));
  const recent = input.recent.map((entry, index) => ({
    ...entry,
    text: excerpt(`transcript:${index}`, "text", limits.unbound),
  }));
  const packet = redactedJSON({
    goal: input.goal,
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.goalScope ? { goalScope: input.goalScope } : {}),
    ...(input.planningAttemptId ? { planningAttemptId: input.planningAttemptId } : {}),
    ...(input.preflight ? { preflight: input.preflight } : {}),
    board,
    bindings: input.bindings,
    batch: {
      claimedTaskIds: input.board.tasks
        .filter((task) => ["implementing", "reviewing"].includes(task.status))
        .map((task) => task.id),
      readyTaskIds: input.board.tasks
        .filter((task) => task.status === "ready")
        .map((task) => task.id),
      unresolvedExecutionTaskIds: input.board.tasks
        .filter((task) => task.executionRef)
        .map((task) => task.id),
    },
    receipts,
    recent,
    acceptanceBlocker: input.acceptanceBlocker,
    advisorAccounting: input.advisorAccounting,
    execution: input.execution,
    artifactVersion: input.artifactVersion,
    validationSupplement: input.validationSupplement,
    reviewDelivery: input.reviewDelivery,
    progress: input.progress,
    acceptance: input.acceptance,
    qualifications: input.qualifications,
    excerpts: {
      shortened: details.length > 0,
      boundReceiptBytes: Number.isFinite(limits.bound) ? limits.bound : null,
      unboundReceiptBytes: Number.isFinite(limits.unbound) ? limits.unbound : null,
      captureCompleteness:
        "retained receipts may already be truncated; hashes do not reconstruct omitted text",
      details,
    },
  });
  return { packet, details };
}
export function reviewViewDigest(view: Pick<ReviewViewV1, "packet">): string {
  return digest(["review-view-v1", view.packet]);
}
export function buildReviewView(
  input: ReviewViewInput,
  limits: { maxBytes?: number } = {},
): ReviewViewResult {
  const max = limits.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_BYTES)
    return {
      status: "error",
      error: {
        code: "REVIEW_SOURCE_INVALID",
        message: "Review limit must remain within 64000 UTF-8 bytes",
      },
    };
  if (typeof input.goal !== "string" || !input.goal.trim())
    return {
      status: "error",
      error: { code: "REVIEW_SOURCE_INVALID", message: "Required user-recorded goal is missing" },
    };
  const ids = new Set(input.receipts.map((receipt) => receipt.id));
  if (
    ids.size !== input.receipts.length ||
    input.bindings.some((binding) => binding.refs.some((ref) => !ids.has(ref))) ||
    (input.validationSupplement && !ids.has(input.validationSupplement.receiptId))
  )
    return {
      status: "error",
      error: {
        code: "EVIDENCE_MISSING",
        message: "Required registered retained evidence is missing or ambiguous",
      },
    };
  try {
    const source = materials(input);
    const attempts = [
      ...[Infinity, 2000, 1000, 500, 250, 0].map((unbound) => ({ bound: Infinity, unbound })),
      ...[2000, 1000, 500, 250, 0].map((bound) => ({ bound, unbound: 0 })),
    ];
    for (const attempt of attempts) {
      const candidate = packetFor(input, source, attempt),
        bytes = Buffer.byteLength(candidate.packet);
      if (bytes <= max) {
        const view = {
          version: 1 as const,
          packet: candidate.packet,
          bytes,
          digest: reviewViewDigest(candidate),
          shortened: candidate.details.length > 0,
          detailRefs: candidate.details,
        };
        return { status: "ready", view };
      }
    }
    return {
      status: "error",
      error: {
        code: "REVIEW_VIEW_TOO_LARGE",
        message:
          "Required review metadata exceeds 64KB (64000 UTF-8 bytes); split the plan or reduce required reference metadata before completion",
      },
    };
  } catch {
    return {
      status: "error",
      error: {
        code: "REVIEW_SOURCE_INVALID",
        message: "Review source could not be represented as bounded registered material",
      },
    };
  }
}
export function resolveEvidenceDetail(
  input: ReviewViewInput,
  registeredRef: string,
  limit = 8000,
): EvidenceDetailV1 | ReviewViewError {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16000)
    return {
      code: "REVIEW_SOURCE_INVALID",
      message: "Detail byte limit must be between 1 and 16000",
    };
  const source = materials(input);
  const item =
    source.find((item) => item.id === registeredRef) ??
    source.find((item) => item.sourceId === registeredRef && item.field === "output");
  if (!item)
    return {
      code: "EVIDENCE_MISSING",
      message: "Detail is not registered retained material; paths and commands are forbidden",
    };
  const text = prefix(item.text, limit);
  return {
    version: 1,
    ...reference(item, text),
    text,
    shortened: text !== item.text,
    deliveredDigest: digest(["review-delivery-v1", item.id, item.sourceDigest, text]),
  };
}
