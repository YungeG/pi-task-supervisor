import { Type, type Static } from "typebox";
import { isReceiptLedgerRecord, digest as receiptDigest, type HostReceipt } from "./receipt-store";
import { Check } from "typebox/value";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

export interface SessionJournalView {
  path: string | undefined;
  sessionId: string;
  leafId: string | null;
}
export interface JournalReceiptProof {
  kind: "intent" | "receipt";
  sessionId: string;
  goalId: string;
  sequence: number;
  ledgerEpoch: number;
  captureId: string;
  captureDigest: string;
  inputDigest?: string;
  receipt?: Pick<
    HostReceipt,
    "id" | "tool" | "epoch" | "ok" | "exitCode" | "eligible" | "reviews" | "digest"
  >;
}
export interface JournalSupervisorProof {
  sessionId: string;
  goalText?: string;
  preflightId?: string;
  preflightBinding?: { preflightId: string; planId: string; planDigest: string };
  goalKey?: string;
  lifecycleCommitId?: string;
  epoch: number;
  reviews: number;
  status: string;
  bindingsDigest: string;
  taskBindings?: Array<{ taskId: string; digest: string; refsDigest: string }>;
  authorityDigest?: string;
}
export interface JournalNode {
  id: string;
  parentId: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  digest: string;
  wireVersion?: number;
  toolCallIds?: string[];
  toolCalls?: Array<{ id: string; name?: string; inputDigest?: string }>;
  toolResultProof?: { id: string; tool: string; ok: boolean; exitCode?: number };
  toolCallsIncomplete?: true;
  receiptGoalId?: string;
  receiptSessionId?: string;
  receiptProof?: JournalReceiptProof;
  supervisorProof?: JournalSupervisorProof;
}
export interface SessionJournal {
  sessionId: string;
  cwd?: string;
  nodes: ReadonlyMap<string, JournalNode>;
  branch: readonly JournalNode[];
}
const frameId = Type.String({ minLength: 1, maxLength: 200 });
const frameHash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const ReadbackFrameSchema = Type.Object(
  {
    version: Type.Literal(1),
    owner: Type.Union([Type.Literal("board"), Type.Literal("preflight")]),
    sessionId: frameId,
    requestId: frameId,
    presentationId: frameId,
    scopeDigest: frameHash,
    baseSnapshotEntryId: frameId,
    baseSnapshotDigest: frameHash,
  },
  { additionalProperties: false },
);
export type ReadbackFrame = Static<typeof ReadbackFrameSchema>;
export const GoalReadbackFrameSchema = Type.Object(
  {
    version: Type.Literal(2),
    owner: Type.Literal("goal"),
    sessionId: frameId,
    requestId: frameId,
    presentationId: frameId,
    scopeDigest: frameHash,
    baseEntryId: frameId,
    baseEntryDigest: frameHash,
  },
  { additionalProperties: false },
);
export type GoalReadbackFrame = Static<typeof GoalReadbackFrameSchema>;
export type NativeReadbackFrame = ReadbackFrame | GoalReadbackFrame;
export function isGoalReadbackFrame(value: unknown): value is GoalReadbackFrame {
  return Check(GoalReadbackFrameSchema, value);
}
export type GoalReadbackProof =
  | { status: "missing" }
  | { status: "unconfirmed"; control: JournalNode; frame: GoalReadbackFrame }
  | {
      status: "confirmed";
      control: JournalNode;
      witness: JournalNode;
      base: JournalNode;
      frame: GoalReadbackFrame;
    };
export interface ReadbackWitness {
  version: 1;
  controlEntryId: string;
  controlDigest: string;
  frame: ReadbackFrame;
}
export type ReadbackProof =
  | { status: "missing" }
  | { status: "unconfirmed"; control: JournalNode; frame: ReadbackFrame }
  | {
      status: "confirmed";
      control: JournalNode;
      witness: JournalNode;
      base: JournalNode;
      frame: ReadbackFrame;
    };
export type JournalErrorCode =
  | "JOURNAL_UNAVAILABLE"
  | "JOURNAL_LIMIT"
  | "JOURNAL_INVALID"
  | "JOURNAL_BRANCH_INVALID"
  | "READBACK_INVALID"
  | "READBACK_CONFLICT";
export type JournalLimitMetric = "fileBytes" | "lineBytes" | "entries" | "configuration";
export interface JournalLimitDetail {
  readonly metric: JournalLimitMetric;
  readonly observed?: number;
  readonly limit?: number;
}
const LIMIT_METRICS = new Set<JournalLimitMetric>([
  "fileBytes",
  "lineBytes",
  "entries",
  "configuration",
]);
export class JournalReadError extends Error {
  readonly limitDetail?: Readonly<JournalLimitDetail>;
  constructor(
    readonly code: JournalErrorCode,
    detail?: JournalLimitDetail,
  ) {
    super(code);
    this.name = "JournalReadError";
    if (code === "JOURNAL_LIMIT" && detail && LIMIT_METRICS.has(detail.metric)) {
      this.limitDetail = Object.freeze({
        metric: detail.metric,
        ...(Number.isSafeInteger(detail.observed) && (detail.observed ?? -1) >= 0
          ? { observed: detail.observed }
          : {}),
        ...(Number.isSafeInteger(detail.limit) && (detail.limit ?? -1) >= 0
          ? { limit: detail.limit }
          : {}),
      });
    }
  }
}

/** Display diagnostics only: no source text, path, ID, or arbitrary exception message. */
export function formatJournalReadError(error: unknown): string | undefined {
  if (!(error instanceof JournalReadError)) return undefined;
  if (
    ![
      "JOURNAL_UNAVAILABLE",
      "JOURNAL_LIMIT",
      "JOURNAL_INVALID",
      "JOURNAL_BRANCH_INVALID",
      "READBACK_INVALID",
      "READBACK_CONFLICT",
    ].includes(error.code)
  )
    return undefined;
  if (error.code !== "JOURNAL_LIMIT") return error.code;
  const detail = error.limitDetail;
  return `${error.code} metric=${detail?.metric ?? "UNKNOWN"} observed=${detail?.observed ?? "UNKNOWN"} limit=${detail?.limit ?? "UNKNOWN"}`;
}
export function journalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
function fail(code: JournalErrorCode, detail?: JournalLimitDetail): never {
  throw new JournalReadError(code, detail);
}
const RETAINED = new Set([
  "continuous-tasks:event",
  "continuous-tasks:preflight-control",
  "continuous-tasks:human-readback",
  "continuous-tasks:snapshot",
  "continuous-tasks:preflight",
  "continuous-tasks:control-facts",
  "continuous-tasks:acceptance-facts",
  "continuous-tasks:acceptance-proposal",
]);
export interface JournalLimits {
  maxBytes: number;
  maxLineBytes: number;
  maxEntries: number;
}
const LIMITS: JournalLimits = {
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  maxEntries: 500_000,
};

function validateLimits(limits: JournalLimits): void {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
    fail("JOURNAL_LIMIT", { metric: "configuration" });
}

function retainedData(value: Record<string, unknown>): boolean {
  if (typeof value.customType === "string" && RETAINED.has(value.customType)) return true;
  if (value.customType !== "continuous-tasks:supervisor" || !record(value.data)) return false;
  if (value.data.version === 6) return true;
  return (
    value.data.version === 5 &&
    value.data.protocol === "goal-lifecycle-v1" &&
    ["transition-control", "transition-committed", "goal-state"].includes(String(value.data.kind))
  );
}

function receiptProof(data: unknown): JournalReceiptProof | undefined {
  if (!isReceiptLedgerRecord(data) || data.kind === "close_unknown") return undefined;
  const proof: JournalReceiptProof = {
    kind: data.kind,
    sessionId: data.sessionId,
    goalId: data.goalId,
    sequence: data.sequence,
    ledgerEpoch: data.epoch,
    captureId: data.capture.id,
    captureDigest: receiptDigest(data.capture),
  };
  if (data.kind === "receipt") {
    const { id, tool, epoch, ok, exitCode, eligible, reviews, digest } = data.receipt;
    proof.inputDigest = receiptDigest(data.receipt.input);
    proof.receipt = { id, tool, epoch, ok, exitCode, eligible, reviews, digest };
  }
  return proof;
}
function supervisorIdentity(
  data: Record<string, unknown>,
  payload: Record<string, unknown>,
): Pick<JournalSupervisorProof, "goalKey" | "lifecycleCommitId"> {
  const ledger = record(payload.receiptLedger) ? payload.receiptLedger : undefined;
  const scope = data.version === 5 && record(data.scope) ? data.scope : undefined;
  const goalKey = scope?.goalRunId ?? ledger?.goalId;
  return {
    ...(typeof goalKey === "string" ? { goalKey } : {}),
    ...(typeof scope?.lifecycleCommitId === "string"
      ? { lifecycleCommitId: scope.lifecycleCommitId }
      : {}),
  };
}
function taskBindingMetadata(bindings: unknown[]): JournalSupervisorProof["taskBindings"] {
  if (bindings.length > 100) return undefined;
  const result: NonNullable<JournalSupervisorProof["taskBindings"]> = [];
  for (const value of bindings) {
    if (
      !record(value) ||
      typeof value.taskId !== "string" ||
      value.taskId.length > 100 ||
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      !Array.isArray(value.refs) ||
      value.refs.length > 20 ||
      !value.refs.every((ref) => typeof ref === "string" && ref.length <= 300)
    )
      return undefined;
    result.push({
      taskId: value.taskId,
      digest: value.digest,
      refsDigest: receiptDigest(value.refs),
    });
  }
  return result;
}
function supervisorPreflightProof(
  payload: Record<string, unknown>,
): Pick<JournalSupervisorProof, "preflightId" | "preflightBinding"> {
  const binding = payload.preflightBinding;
  if (
    !record(binding) ||
    typeof binding.preflightId !== "string" ||
    binding.preflightId.length > 200
  )
    return {};
  return {
    preflightId: binding.preflightId,
    ...(typeof binding.planId === "string" &&
    binding.planId.length <= 120 &&
    typeof binding.planDigest === "string" &&
    /^[a-f0-9]{64}$/.test(binding.planDigest)
      ? {
          preflightBinding: {
            preflightId: binding.preflightId,
            planId: binding.planId,
            planDigest: binding.planDigest,
          },
        }
      : {}),
  };
}
function supervisorProof(data: unknown): JournalSupervisorProof | undefined {
  if (!record(data)) return undefined;
  const scoped = data.version === 5 && record(data.scope) && record(data.supervisor);
  const payload = scoped ? data.supervisor : data;
  if (
    !record(payload) ||
    typeof payload.sessionId !== "string" ||
    typeof payload.epoch !== "number" ||
    typeof payload.reviews !== "number" ||
    typeof payload.status !== "string" ||
    !Array.isArray(payload.bindings)
  )
    return undefined;
  return {
    sessionId: payload.sessionId,
    ...(typeof payload.goal === "string" && Buffer.byteLength(payload.goal) <= 4000
      ? { goalText: payload.goal }
      : {}),
    ...supervisorPreflightProof(payload),
    ...supervisorIdentity(data, payload),
    epoch: payload.epoch,
    reviews: payload.reviews,
    status: payload.status,
    bindingsDigest: journalDigest(payload.bindings),
    taskBindings: taskBindingMetadata(payload.bindings),
    authorityDigest: journalDigest([
      "host-authority-v1",
      payload.goal,
      payload.model,
      payload.preflightBinding ?? null,
    ]),
  };
}
function ownerMetadata(
  value: Record<string, unknown>,
): Pick<
  JournalNode,
  "wireVersion" | "receiptGoalId" | "receiptSessionId" | "receiptProof" | "supervisorProof"
> {
  const data = value.data;
  if (value.customType === "continuous-tasks:supervisor")
    return {
      wireVersion: record(data) && typeof data.version === "number" ? data.version : -1,
      supervisorProof: supervisorProof(data),
    };
  if (value.customType === "continuous-tasks:receipt-ledger" && record(data))
    return {
      receiptGoalId: typeof data.goalId === "string" ? data.goalId : undefined,
      receiptSessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
      receiptProof: receiptProof(data),
    };
  return {};
}

function nativeBoundedName(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}
function nativeToolResult(
  value: Record<string, unknown>,
): Pick<JournalNode, "toolResultProof"> | undefined {
  const message = value.message;
  if (
    value.type === "message" &&
    record(message) &&
    message.role === "toolResult" &&
    nativeBoundedName(message.toolCallId, 2000) &&
    nativeBoundedName(message.toolName, 200)
  ) {
    const structured = message.structuredContent;
    return {
      toolResultProof: {
        id: message.toolCallId,
        tool: message.toolName,
        ok:
          message.isError === false &&
          (!record(structured) || !("exit_code" in structured) || structured.exit_code === 0),
        ...(record(structured) && Number.isInteger(structured.exit_code)
          ? { exitCode: structured.exit_code as number }
          : {}),
      },
    };
  }
  return undefined;
}
function nativeToolCalls(
  value: Record<string, unknown>,
): Pick<JournalNode, "toolCalls" | "toolCallsIncomplete" | "toolResultProof"> {
  const result = nativeToolResult(value);
  if (result) return result;
  const message = value.message;
  if (value.type !== "message" || !record(message) || message.role !== "assistant") return {};
  // Uninspected content is not evidence that no duplicate call exists.
  if (!Array.isArray(message.content) || message.content.length > 1000)
    return { toolCallsIncomplete: true };
  return {
    toolCalls: message.content.flatMap((block) =>
      record(block) &&
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      block.id.length <= 2000
        ? [
            {
              id: block.id,
              inputDigest: record(block.arguments)
                ? journalDigest(JSON.stringify(block.arguments))
                : undefined,
              name:
                typeof block.name === "string" && block.name.length > 0 && block.name.length <= 200
                  ? block.name
                  : undefined,
            },
          ]
        : [],
    ),
  };
}

const decodedNodeCache = new Map<string, { node: JournalNode; bytes: number }>();
const DECODE_CACHE_ENTRIES = 8192,
  DECODE_CACHE_BYTES = 32 * 1024 * 1024;
let decodedNodeBytes = 0,
  decodedNodes = 0;
/** Pure decoding diagnostics, never source/owner/permission or persistence evidence. */
export function journalDecodeStats() {
  return { entries: decodedNodeCache.size, bytes: decodedNodeBytes, decodedNodes };
}
function freezeDecodedNode(node: JournalNode): JournalNode {
  const stack: object[] = [node],
    seen = new WeakSet();
  while (stack.length) {
    const value = stack.pop();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>))
      if (child !== null && typeof child === "object") stack.push(child);
    Object.freeze(value);
  }
  return node;
}
function rememberDecodedNode(key: string, node: JournalNode): void {
  const bytes = Buffer.byteLength(JSON.stringify(node)) + key.length;
  if (bytes > DECODE_CACHE_BYTES) return;
  while (
    decodedNodeCache.size >= DECODE_CACHE_ENTRIES ||
    decodedNodeBytes + bytes > DECODE_CACHE_BYTES
  ) {
    const first = decodedNodeCache.entries().next().value;
    if (!first) break;
    decodedNodeCache.delete(first[0]);
    decodedNodeBytes -= first[1].bytes;
  }
  decodedNodeCache.set(key, { node: freezeDecodedNode(structuredClone(node)), bytes });
  decodedNodeBytes += bytes;
}
function isolatedDecodedNode(source: JournalNode): JournalNode {
  const node = { ...source };
  for (const [key, original] of Object.entries(source)) {
    if (original === null || typeof original !== "object") continue;
    let copied = false,
      value: unknown;
    Object.defineProperty(node, key, {
      enumerable: true,
      configurable: true,
      get() {
        if (!copied) {
          value = structuredClone(original);
          copied = true;
        }
        return value;
      },
      set(replacement: unknown) {
        value = replacement;
        copied = true;
      },
    });
  }
  return node;
}
function parseNativeLine(
  text: string,
  nodes: Map<string, JournalNode>,
  entries: number,
  maxEntries: number,
  immutable: boolean,
): void {
  if (entries > maxEntries)
    fail("JOURNAL_LIMIT", { metric: "entries", observed: entries, limit: maxEntries });
  const key = createHash("sha256").update(text).digest("hex"),
    cached = decodedNodeCache.get(key);
  if (cached) {
    if (nodes.has(cached.node.id)) fail("JOURNAL_INVALID");
    decodedNodeCache.delete(key);
    decodedNodeCache.set(key, cached);
    const node = immutable ? cached.node : isolatedDecodedNode(cached.node);
    nodes.set(node.id, node);
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return fail("JOURNAL_INVALID");
  }
  if (!record(value)) fail("JOURNAL_INVALID");
  const node = parseEntry(value, nodes, entries, maxEntries);
  decodedNodes = Math.min(Number.MAX_SAFE_INTEGER, decodedNodes + 1);
  if (node) {
    rememberDecodedNode(key, node);
    if (immutable) nodes.set(node.id, decodedNodeCache.get(key)?.node ?? freezeDecodedNode(node));
  }
}
function parseEntry(
  value: Record<string, unknown>,
  nodes: Map<string, JournalNode>,
  entries: number,
  maxEntries: number,
): JournalNode | null {
  if (entries > maxEntries)
    fail("JOURNAL_LIMIT", { metric: "entries", observed: entries, limit: maxEntries });
  if (
    !identifier(value.id) ||
    (value.parentId !== null && !identifier(value.parentId)) ||
    typeof value.type !== "string" ||
    nodes.has(value.id)
  )
    fail("JOURNAL_INVALID");
  const calls = nativeToolCalls(value);
  const node: JournalNode = {
    id: value.id,
    parentId: value.parentId,
    type: value.type,
    ...(typeof value.customType === "string" ? { customType: value.customType } : {}),
    ...(retainedData(value) ? { data: value.data } : {}),
    digest: journalDigest(value),
    ...ownerMetadata(value),
    toolCallIds: calls.toolCalls?.map((call) => call.id),
    ...calls,
  };
  nodes.set(value.id, node);
  return node;
}

function checkComplete(line: string, fd: number, originalSize: number, headerSeen: boolean): void {
  if (!headerSeen || line !== "" || fstatSync(fd).size !== originalSize) fail("JOURNAL_INVALID");
}

function readAllLines(
  fd: number,
  limits: JournalLimits,
  consume: (text: string) => void,
  getHeaderSeen: () => boolean,
): void {
  const stat = fstatSync(fd);
  if (!stat.isFile()) fail("JOURNAL_UNAVAILABLE");
  if (stat.size > limits.maxBytes)
    fail("JOURNAL_LIMIT", { metric: "fileBytes", observed: stat.size, limit: limits.maxBytes });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let line = "";
  let bytes = 0;
  const buffer = Buffer.alloc(64 * 1024);
  let count: number;
  while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
    bytes += count;
    if (bytes > limits.maxBytes)
      fail("JOURNAL_LIMIT", { metric: "fileBytes", observed: bytes, limit: limits.maxBytes });
    line += decoder.decode(buffer.subarray(0, count), { stream: true });
    let end: number;
    while ((end = line.indexOf("\n")) !== -1) {
      const physicalLine = line.slice(0, end);
      if (Buffer.byteLength(physicalLine) > limits.maxLineBytes)
        fail("JOURNAL_LIMIT", {
          metric: "lineBytes",
          observed: Buffer.byteLength(physicalLine),
          limit: limits.maxLineBytes,
        });
      consume(physicalLine.endsWith("\r") ? physicalLine.slice(0, -1) : physicalLine);
      line = line.slice(end + 1);
    }
    if (Buffer.byteLength(line) > limits.maxLineBytes)
      fail("JOURNAL_LIMIT", {
        metric: "lineBytes",
        observed: Buffer.byteLength(line),
        limit: limits.maxLineBytes,
      });
  }
  line += decoder.decode();
  checkComplete(line, fd, stat.size, getHeaderSeen());
}

function buildBranch(nodes: Map<string, JournalNode>, leafId: string | null): JournalNode[] {
  const branch: JournalNode[] = [];
  const seen = new Set<string>();
  let id = leafId;
  while (id !== null) {
    const node = nodes.get(id);
    if (!node || seen.has(id)) fail("JOURNAL_BRANCH_INVALID");
    seen.add(id);
    branch.push(node);
    id = node.parentId;
  }
  branch.reverse();
  return branch;
}

/** Reads only; never calls the native loader that can silently repair an incomplete tail. */
export function inspectSessionJournal(
  view: SessionJournalView,
  limits: JournalLimits = LIMITS,
  immutable = false,
): SessionJournal {
  if (!view.path) fail("JOURNAL_UNAVAILABLE");
  validateLimits(limits);
  let fd: number;
  try {
    fd = openSync(view.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("JOURNAL_UNAVAILABLE");
  }
  const nodes = new Map<string, JournalNode>();
  let headerSeen = false;
  let cwd: string | undefined;
  let entries = 0;
  function consume(text: string): void {
    if (!text) fail("JOURNAL_INVALID");
    if (headerSeen) {
      entries++;
      parseNativeLine(text, nodes, entries, limits.maxEntries, immutable);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return fail("JOURNAL_INVALID");
    }
    if (!record(value)) fail("JOURNAL_INVALID");
    if (value.type !== "session" || value.version !== 3 || value.id !== view.sessionId)
      fail("JOURNAL_INVALID");
    if (
      typeof value.cwd === "string" &&
      value.cwd &&
      Buffer.byteLength(value.cwd) <= 4096 &&
      !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.cwd)
    )
      cwd = value.cwd;
    headerSeen = true;
  }
  try {
    readAllLines(fd, limits, consume, () => headerSeen);
  } catch (error) {
    if (error instanceof JournalReadError) throw error;
    return fail("JOURNAL_INVALID");
  } finally {
    closeSync(fd);
  }
  const branch = buildBranch(nodes, view.leafId);
  return { sessionId: view.sessionId, ...(cwd ? { cwd } : {}), nodes, branch };
}

function frame(value: unknown): value is ReadbackFrame {
  return Check(ReadbackFrameSchema, value);
}

function matchesOwner(
  binding: ReadbackFrame,
  node: { customType?: string; data?: unknown },
): boolean {
  if (binding.owner === "board") {
    return (
      node.customType === "continuous-tasks:event" &&
      record(node.data) &&
      node.data.type === "resolve_decision"
    );
  }
  return (
    node.customType === "continuous-tasks:preflight-control" &&
    record(node.data) &&
    ["approve", "revoke", "reject", "start", "define", "decline-definition"].includes(
      String(node.data.kind),
    )
  );
}

function findControl(
  branch: readonly JournalNode[],
  sessionId: string,
  owner: ReadbackFrame["owner"],
  requestId: string,
): { control: JournalNode; frame: ReadbackFrame } | undefined {
  const candidates: Array<{ control: JournalNode; frame: ReadbackFrame }> = [];
  for (const node of branch) {
    if (node.type !== "custom" || !record(node.data)) continue;
    if (!Object.hasOwn(node.data, "humanInteraction")) continue;
    if (isGoalReadbackFrame(node.data.humanInteraction)) {
      validateGoalControl(node, sessionId);
      continue;
    }
    if (!frame(node.data.humanInteraction)) fail("READBACK_INVALID");
    const binding = node.data.humanInteraction;
    if (binding.sessionId !== sessionId) fail("READBACK_INVALID");
    if (!matchesOwner(binding, node)) fail("READBACK_INVALID");
    if (binding.owner === owner && binding.requestId === requestId)
      candidates.push({ control: node, frame: binding });
  }
  if (candidates.length > 1) fail("READBACK_CONFLICT");
  return candidates[0];
}

function validateWitnessData(data: Record<string, unknown>): void {
  if (
    Object.keys(data).length !== 4 ||
    data.version !== 1 ||
    !identifier(data.controlEntryId) ||
    typeof data.controlDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.controlDigest) ||
    !(frame(data.frame) || isGoalReadbackFrame(data.frame))
  )
    fail("READBACK_INVALID");
}

function collectWitnesses(branch: readonly JournalNode[], controlId: string): JournalNode[] {
  const witnesses: JournalNode[] = [];
  for (const node of branch) {
    if (node.type !== "custom" || node.customType !== "continuous-tasks:human-readback") continue;
    const { data } = node;
    if (!record(data)) fail("READBACK_INVALID");
    validateWitnessData(data);
    if (data.controlEntryId === controlId) witnesses.push(node);
  }
  if (witnesses.length > 1) fail("READBACK_CONFLICT");
  return witnesses;
}

function validateWitness(
  witness: JournalNode,
  found: { control: JournalNode; frame: ReadbackFrame },
  branch: readonly JournalNode[],
  nodes: ReadonlyMap<string, JournalNode>,
  owner: ReadbackFrame["owner"],
): JournalNode {
  const data = witness.data as ReadbackWitness;
  const base = nodes.get(found.frame.baseSnapshotEntryId);
  const controlIndex = branch.indexOf(found.control);
  const witnessIndex = branch.indexOf(witness);
  const baseIndex = base ? branch.indexOf(base) : -1;
  if (!base) fail("READBACK_INVALID");
  const baseType = owner === "board" ? "continuous-tasks:snapshot" : "continuous-tasks:preflight";
  if (
    data.controlDigest !== found.control.digest ||
    journalDigest(data.frame) !== journalDigest(found.frame) ||
    witnessIndex <= controlIndex ||
    baseIndex < 0 ||
    baseIndex >= controlIndex ||
    base.type !== "custom" ||
    base.customType !== baseType ||
    journalDigest(base.data) !== found.frame.baseSnapshotDigest
  )
    fail("READBACK_INVALID");
  return base;
}

function validateGoalControl(node: JournalNode, sessionId: string): GoalReadbackFrame {
  const data = node.data;
  if (!record(data) || !isGoalReadbackFrame(data.humanInteraction)) fail("READBACK_INVALID");
  const binding = data.humanInteraction;
  if (
    node.customType !== "continuous-tasks:supervisor" ||
    data.version !== 5 ||
    data.protocol !== "goal-lifecycle-v1" ||
    data.kind !== "transition-control" ||
    data.transitionId !== binding.requestId ||
    binding.sessionId !== sessionId
  )
    fail("READBACK_INVALID");
  return binding;
}
function goalProofBase(
  journal: SessionJournal,
  control: JournalNode,
  witness: JournalNode,
  binding: GoalReadbackFrame,
): JournalNode {
  const base = journal.nodes.get(binding.baseEntryId);
  const data = witness.data as ReadbackWitness;
  const branch = journal.branch;
  if (
    !base ||
    base.type !== "custom" ||
    !["continuous-tasks:supervisor", "continuous-tasks:snapshot", "phased-tasks:snapshot"].includes(
      base.customType ?? "",
    ) ||
    base.digest !== binding.baseEntryDigest ||
    data.controlDigest !== control.digest ||
    journalDigest(data.frame) !== journalDigest(binding) ||
    branch.indexOf(base) < 0 ||
    branch.indexOf(base) >= branch.indexOf(control) ||
    branch.indexOf(witness) <= branch.indexOf(control)
  )
    fail("READBACK_INVALID");
  return base;
}
/** Goal frame2 uses the complete native base node, never a fabricated legacy snapshot. */
export function findGoalReadbackProof(
  journal: SessionJournal,
  requestId: string,
): GoalReadbackProof {
  const candidates = journal.branch.filter(
    (node) =>
      record(node.data) &&
      node.data.kind === "transition-control" &&
      node.customType === "continuous-tasks:supervisor",
  );
  const matching = candidates.flatMap((control) => {
    const binding = validateGoalControl(control, journal.sessionId);
    return binding.requestId === requestId ? [{ control, frame: binding }] : [];
  });
  if (matching.length > 1) fail("READBACK_CONFLICT");
  const found = matching[0];
  if (!found) return { status: "missing" };
  const witness = collectWitnesses(journal.branch, found.control.id)[0];
  if (!witness) return { status: "unconfirmed", ...found };
  const base = goalProofBase(journal, found.control, witness, found.frame);
  return { status: "confirmed", ...found, witness, base };
}

/** Structural disk evidence only; the owner must separately verify source, scope and action. */
export function findReadbackProof(
  journal: SessionJournal,
  owner: ReadbackFrame["owner"],
  requestId: string,
): ReadbackProof {
  const found = findControl(journal.branch, journal.sessionId, owner, requestId);
  if (!found) return { status: "missing" };
  const witnesses = collectWitnesses(journal.branch, found.control.id);
  const witness = witnesses[0];
  if (!witness) return { status: "unconfirmed", ...found };
  const base = validateWitness(witness, found, journal.branch, journal.nodes, owner);
  return { status: "confirmed", ...found, witness, base };
}
