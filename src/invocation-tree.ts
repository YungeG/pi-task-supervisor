import { createHash } from "node:crypto";
import { createCodemodeExtension, type ToolInfo } from "@earendil-works/pi-coding-agent";
import type { WorkOwnerKey } from "./control-journal";
import type { ReviewVersionV1 } from "./final-review";

export const INVOCATION_LIMITS = { active: 512, depth: 16 } as const;
export const SDK_TOOL_ONLY_CAPABILITY = "sdk-codemode-1.1.0-tools-only-v1" as const;
export type InvocationEffect = "container" | "readonly" | "metadata" | "write" | "unknown";
export type InvocationOutcome = "returned" | "error" | "cancelled" | "unknown";
export type InvocationReference = { entryId: string; digest: string };
export interface InvocationStartedV1 {
  version: 1;
  kind: "invocation-started";
  recordId: string;
  owner: WorkOwnerKey;
  operationId: string;
  toolCallId: string;
  parentId: string | null;
  rootId: string;
  sequence: number;
  toolName: string;
  effect: InvocationEffect;
  capability: typeof SDK_TOOL_ONLY_CAPABILITY | null;
  inputDigest: string;
  sourceRef: InvocationReference | null;
  modeRef: InvocationReference | null;
}
export interface InvocationEndedV1 {
  version: 1;
  kind: "invocation-ended";
  recordId: string;
  owner: WorkOwnerKey;
  operationId: string;
  sequence: number;
  outcome: InvocationOutcome;
  receiptId: string | null;
  receiptDigest: string | null;
  receiptRef: InvocationReference | null;
  exitCode: number | null;
  effects: "tool-only" | "unqualified";
  reasons: string[];
  artifactVersion: ReviewVersionV1 | null;
}
export interface InvocationRootSealedV1 {
  version: 1;
  kind: "invocation-root-sealed";
  recordId: string;
  owner: WorkOwnerKey;
  rootId: string;
  endRef: InvocationReference;
  messageRef: InvocationReference;
  started: number;
  ended: number;
  historyDigest: string;
  epoch: number;
  artifactVersion: ReviewVersionV1 | null;
  outcome: "qualified" | "held" | "unknown";
  reason: string;
}
/** A direct SDK call observation is never a container eligibility attestation. */
export interface InvocationRootSealedV2 extends Omit<
  InvocationRootSealedV1,
  "version" | "outcome"
> {
  version: 2;
  rootKind: "direct";
  outcome: "observed" | "held" | "unknown";
}
export type InvocationRootSeal = InvocationRootSealedV1 | InvocationRootSealedV2;
export interface EligibilityAttestedV1 {
  version: 1;
  kind: "eligibility-attested";
  recordId: string;
  owner: WorkOwnerKey;
  operationId: string;
  receiptId: string;
  receiptDigest: string;
  rootSealRef: InvocationReference;
  taskId: string;
  taskDigest: string;
  epoch: number;
  artifactVersion: ReviewVersionV1;
  justification: "parent-only-overlap-v1";
}
export interface EligibilityView {
  data: EligibilityAttestedV1;
  ref: InvocationReference;
}
export interface InvocationSealView {
  data: InvocationRootSeal;
  ref: InvocationReference;
}
export interface InvocationNodeV1 {
  operationId: string;
  toolCallId: string;
  parentId: string | null;
  rootId: string;
  owner: WorkOwnerKey;
  depth: number;
  toolName: string;
  effect: InvocationEffect;
  capability: typeof SDK_TOOL_ONLY_CAPABILITY | null;
  inputDigest: string;
  sourceRef: InvocationReference | null;
  modeRef: InvocationReference | null;
  start: { sequence: number; ref: InvocationReference };
  end?: {
    sequence: number;
    ref: InvocationReference;
    outcome: InvocationOutcome;
    receiptId: string | null;
    receiptDigest: string | null;
    receiptRef: InvocationReference | null;
    exitCode: number | null;
    effects: "tool-only" | "unqualified";
    reasons: string[];
    artifactVersion: ReviewVersionV1 | null;
  };
}
export interface InvocationRootIndex {
  started: number;
  ended: number;
  digest: string;
  sealed?: InvocationReference;
}
/** Linear compact journal index, not a cache of raw args/results or recursive subtrees. */
export interface InvocationGraph {
  sequence: number;
  records: Set<string>;
  nodes: Map<string, InvocationNodeV1>;
  calls: Map<string, string>;
  active: Set<string>;
  roots: Map<string, InvocationRootIndex>;
  seals: Map<string, InvocationSealView>;
  qualifications: Map<string, EligibilityView>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function invocationOwnerKey(owner: WorkOwnerKey): string {
  return hash(
    owner.kind === "goal"
      ? [
          "goal",
          owner.goal.sessionId,
          owner.goal.goalKey,
          owner.goal.goalRunId,
          owner.goal.lifecycleCommitId,
        ]
      : ["board", owner.board.sessionId, owner.board.boardRunId, owner.board.seedEntryId],
  );
}
export function invocationCallKey(owner: WorkOwnerKey, id: string): string {
  return `${invocationOwnerKey(owner)}/${id}`;
}
export function emptyInvocationGraph(): InvocationGraph {
  return {
    sequence: 0,
    records: new Set(),
    nodes: new Map(),
    calls: new Map(),
    active: new Set(),
    roots: new Map(),
    seals: new Map(),
    qualifications: new Map(),
  };
}
function assertNext(graph: InvocationGraph, sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence !== graph.sequence + 1)
    throw Error("Invocation sequence is not the next actual host observation");
}
export function invocationParent(
  graph: InvocationGraph,
  owner: WorkOwnerKey,
  parentToolCallId: string | undefined,
): InvocationNodeV1 | undefined {
  if (parentToolCallId === undefined) return undefined;
  const operation = graph.calls.get(invocationCallKey(owner, parentToolCallId)),
    node = operation ? graph.nodes.get(operation) : undefined;
  if (!node || !graph.active.has(node.operationId) || node.end)
    throw Error("Invocation parent is not a current live host-admitted node");
  return node;
}
export function assertInvocationCapacity(graph: InvocationGraph, parent?: InvocationNodeV1): void {
  if (graph.active.size >= INVOCATION_LIMITS.active)
    throw Error("Invocation active-node limit reached; no active parent is evicted");
  if ((parent?.depth ?? 0) + 1 > INVOCATION_LIMITS.depth)
    throw Error("Invocation depth limit reached before execution");
}
function startedParent(
  graph: InvocationGraph,
  fact: InvocationStartedV1,
): InvocationNodeV1 | undefined {
  const parent = fact.parentId === null ? undefined : graph.nodes.get(fact.parentId);
  if (
    fact.parentId !== null &&
    (!parent ||
      parent.end ||
      !graph.active.has(fact.parentId) ||
      invocationOwnerKey(parent.owner) !== invocationOwnerKey(fact.owner))
  )
    throw Error("Invocation parent/owner is invalid or no longer active");
  return parent;
}
export function admitInvocation(
  graph: InvocationGraph,
  fact: InvocationStartedV1,
  ref: InvocationReference,
): InvocationNodeV1 {
  assertNext(graph, fact.sequence);
  if (graph.records.has(fact.recordId)) throw Error("Duplicate invocation record identity");
  if (
    graph.nodes.has(fact.operationId) ||
    graph.calls.has(invocationCallKey(fact.owner, fact.toolCallId))
  )
    throw Error("Invocation identity was already admitted; do not replay");
  const parent = startedParent(graph, fact);
  assertInvocationCapacity(graph, parent);
  if (fact.rootId !== (parent?.rootId ?? fact.operationId))
    throw Error("Invocation root does not match its actual parent");
  const node: InvocationNodeV1 = {
    operationId: fact.operationId,
    toolCallId: fact.toolCallId,
    parentId: fact.parentId,
    rootId: fact.rootId,
    owner: structuredClone(fact.owner),
    depth: (parent?.depth ?? 0) + 1,
    toolName: fact.toolName,
    effect: fact.effect,
    capability: fact.capability,
    inputDigest: fact.inputDigest,
    sourceRef: fact.sourceRef,
    modeRef: fact.modeRef,
    start: { sequence: fact.sequence, ref },
  };
  graph.records.add(fact.recordId);
  graph.nodes.set(node.operationId, node);
  graph.calls.set(invocationCallKey(node.owner, node.toolCallId), node.operationId);
  graph.active.add(node.operationId);
  const root = graph.roots.get(node.rootId) ?? {
    started: 0,
    ended: 0,
    digest: hash(["invocation-history-v1", invocationOwnerKey(node.owner), node.rootId]),
  };
  root.started++;
  root.digest = hash(["invocation-history-v1", root.digest, ref]);
  graph.roots.set(node.rootId, root);
  graph.sequence = fact.sequence;
  return node;
}
export function observeInvocationEnd(
  graph: InvocationGraph,
  fact: InvocationEndedV1,
  ref: InvocationReference,
): InvocationNodeV1 {
  assertNext(graph, fact.sequence);
  if (graph.records.has(fact.recordId)) throw Error("Duplicate invocation record identity");
  const node = graph.nodes.get(fact.operationId);
  if (
    !node ||
    node.end ||
    !graph.active.has(node.operationId) ||
    invocationOwnerKey(node.owner) !== invocationOwnerKey(fact.owner)
  )
    throw Error("Invocation end is missing, duplicate, foreign or conflicting");
  const liveChildren = [...graph.active].some(
    (id) => graph.nodes.get(id)?.parentId === node.operationId,
  );
  if (liveChildren && fact.outcome !== "unknown")
    throw Error("Invocation kernel end has live descendants; retain unknown instead of sealing");
  graph.records.add(fact.recordId);
  node.end = {
    sequence: fact.sequence,
    ref,
    outcome: fact.outcome,
    receiptId: fact.receiptId,
    receiptDigest: fact.receiptDigest,
    receiptRef: fact.receiptRef,
    exitCode: fact.exitCode,
    effects: fact.effects,
    reasons: [...fact.reasons],
    artifactVersion: fact.artifactVersion,
  };
  if (!liveChildren && fact.outcome !== "unknown") graph.active.delete(node.operationId);
  const root = graph.roots.get(node.rootId);
  if (!root) throw Error("Invocation root index is missing");
  root.ended++;
  root.digest = hash(["invocation-history-v1", root.digest, ref]);
  graph.sequence = fact.sequence;
  return node;
}
export function invocationSealIssue(graph: InvocationGraph, rootId: string): string | undefined {
  const root = graph.nodes.get(rootId),
    index = graph.roots.get(rootId);
  if (!root || root.parentId !== null || !index || !root.end || index.started !== index.ended)
    return "Invocation root is not kernel-ended with a complete tree";
  if (root.capability !== SDK_TOOL_ONLY_CAPABILITY)
    return "Container source/effects capability is unqualified";
  const nodes = [...graph.nodes.values()].filter((node) => node.rootId === rootId);
  if (
    nodes.some(
      (node) =>
        !node.end ||
        node.end.outcome !== "returned" ||
        node.end.effects !== "tool-only" ||
        node.effect === "unknown",
    )
  )
    return "Invocation has failed, unknown, unfinished or unqualified effects";
  return undefined;
}
export function directInvocationIssue(graph: InvocationGraph, rootId: string): string | undefined {
  const root = graph.nodes.get(rootId),
    index = graph.roots.get(rootId);
  if (!root?.end || root.parentId !== null || !index || index.started !== index.ended)
    return "Direct SDK call has no complete kernel end";
  if (root.toolName === "codemode" || index.started !== 1)
    return "Direct SDK call has unexplained container/descendant effects";
  if (
    root.end.outcome !== "returned" ||
    root.end.effects !== "tool-only" ||
    root.effect === "unknown"
  )
    return "Direct SDK tool failed or has unknown effects";
  return undefined;
}
function validateSealOutcome(
  graph: InvocationGraph,
  fact: InvocationRootSeal,
  root: InvocationNodeV1,
): void {
  if (fact.version === 2) {
    if (root.toolName === "codemode")
      throw Error("Container roots cannot use a direct SDK observation seal");
    if (fact.outcome === "observed" && directInvocationIssue(graph, fact.rootId))
      throw Error("Direct SDK observation has no closed original tool result");
    return;
  }
  if (
    fact.outcome === "qualified" &&
    (invocationSealIssue(graph, fact.rootId) || !fact.artifactVersion)
  )
    throw Error("Invocation root effects/version are not qualified");
}
export function sealInvocationRoot(
  graph: InvocationGraph,
  fact: InvocationRootSeal,
  ref: InvocationReference,
): void {
  const root = graph.nodes.get(fact.rootId),
    index = graph.roots.get(fact.rootId);
  if (graph.records.has(fact.recordId) || graph.seals.has(fact.rootId))
    throw Error("Invocation seal is immutable; do not republish it");
  if (
    !root?.end ||
    root.parentId !== null ||
    !index ||
    invocationOwnerKey(root.owner) !== invocationOwnerKey(fact.owner)
  )
    throw Error("Invocation seal has no matching actual root end");
  if (
    hash(root.end.ref) !== hash(fact.endRef) ||
    index.started !== fact.started ||
    index.ended !== fact.ended ||
    index.digest !== fact.historyDigest
  )
    throw Error("Invocation seal does not match the complete causal journal aggregate");
  validateSealOutcome(graph, fact, root);
  graph.records.add(fact.recordId);
  graph.seals.set(fact.rootId, { data: fact, ref });
  index.sealed = ref;
}
export function qualificationKey(owner: WorkOwnerKey, receiptId: string, taskId: string): string {
  return hash(["eligibility-key-v1", invocationOwnerKey(owner), receiptId, taskId]);
}
function attestationMatchesNode(
  node: InvocationNodeV1,
  seal: InvocationSealView,
  data: EligibilityAttestedV1,
): boolean {
  return (
    !!node.end &&
    node.end.receiptId === data.receiptId &&
    node.end.receiptDigest === data.receiptDigest &&
    hash(node.end.artifactVersion) === hash(data.artifactVersion) &&
    hash(seal.data.artifactVersion) === hash(data.artifactVersion)
  );
}
export function attestInvocation(
  graph: InvocationGraph,
  data: EligibilityAttestedV1,
  ref: InvocationReference,
): void {
  const node = graph.nodes.get(data.operationId),
    seal = node && graph.seals.get(node.rootId),
    key = qualificationKey(data.owner, data.receiptId, data.taskId);
  if (!node || !seal || graph.records.has(data.recordId) || graph.qualifications.has(key))
    throw Error("Eligibility identity is missing, duplicate or already attested");
  if (
    seal.data.outcome !== "qualified" ||
    hash(seal.ref) !== hash(data.rootSealRef) ||
    seal.data.epoch !== data.epoch ||
    invocationOwnerKey(node.owner) !== invocationOwnerKey(data.owner)
  )
    throw Error("Eligibility is not bound to its actual qualified owner/root seal");
  if (
    !attestationMatchesNode(node, seal, data) ||
    invocationValidationIssue(graph, node.operationId)
  )
    throw Error("Eligibility has stale versions, unsafe order or no actual validation");
  graph.records.add(data.recordId);
  graph.qualifications.set(key, { data, ref });
}
function ignoredAncestor(
  graph: InvocationGraph,
  node: InvocationNodeV1,
  candidate: InvocationNodeV1,
): boolean {
  let parent = node.parentId;
  while (parent) {
    const ancestor = graph.nodes.get(parent);
    if (!ancestor) return false;
    if (parent === candidate.operationId)
      return ancestor.effect === "container" && ancestor.capability === SDK_TOOL_ONLY_CAPABILITY;
    parent = ancestor.parentId;
  }
  return false;
}
function writerIssue(
  graph: InvocationGraph,
  node: InvocationNodeV1,
  other: InvocationNodeV1,
  checkEnd: number,
  rootEnd: number,
): string | undefined {
  if (
    other.operationId === node.operationId ||
    ["readonly", "metadata"].includes(other.effect) ||
    ignoredAncestor(graph, node, other) ||
    other.start.sequence > rootEnd
  )
    return undefined;
  if (other.start.sequence <= checkEnd && (other.end?.sequence ?? Infinity) >= node.start.sequence)
    return "Validation overlapped a non-ancestor potential writer";
  return other.start.sequence > checkEnd
    ? "A potential writer followed validation before root quiescence"
    : undefined;
}
export function invocationValidationIssue(
  graph: InvocationGraph,
  operationId: string,
): string | undefined {
  const node = graph.nodes.get(operationId);
  if (
    !node?.end ||
    node.end.outcome !== "returned" ||
    node.end.exitCode !== 0 ||
    !node.end.receiptId ||
    !node.end.receiptDigest
  )
    return "Invocation validation has no original successful structured zero-exit receipt";
  const sealIssue = invocationSealIssue(graph, node.rootId);
  if (sealIssue) return sealIssue;
  const rootEnd = graph.nodes.get(node.rootId)?.end?.sequence;
  if (rootEnd === undefined) return "Invocation root end is unknown";
  for (const other of graph.nodes.values()) {
    const issue = writerIssue(graph, node, other, node.end.sequence, rootEnd);
    if (issue) return issue;
  }
  return undefined;
}
export function invocationGraphIssue(
  graph: InvocationGraph | undefined,
  attention?: string,
): string | undefined {
  return (
    attention ??
    (graph?.active.size
      ? "Actual invocation nodes remain active/unknown; inspect without replay"
      : undefined)
  );
}
export function invocationUnknownIssue(
  graph: InvocationGraph | undefined,
  liveRoots: ReadonlySet<string>,
  attention?: string,
): string | undefined {
  if (attention) return attention;
  return graph &&
    [...graph.active].some((id) => {
      const node = graph.nodes.get(id);
      return !node || !!node.end || !liveRoots.has(node.rootId);
    })
    ? "Restored or uncertain invocation is not current live SDK work; no replay"
    : undefined;
}
let prototype: { parameters: unknown; description: string } | undefined;
function codemodePrototype() {
  if (!prototype)
    void createCodemodeExtension({ models: false })({
      registerTool: (tool) => {
        prototype = tool;
      },
    } as Parameters<ReturnType<typeof createCodemodeExtension>>[0]);
  return prototype;
}
/** SDK schema identity and trusted original source metadata, never script text or a model field. */
export function codemodeCapability(
  tool: ToolInfo | undefined,
): typeof SDK_TOOL_ONLY_CAPABILITY | undefined {
  const expected = codemodePrototype();
  return tool?.name === "codemode" &&
    tool.exposure === "model-only" &&
    tool.sourceInfo.path === "builtin:codemode" &&
    tool.sourceInfo.source === "builtin" &&
    tool.parameters === expected?.parameters &&
    tool.description === expected.description
    ? SDK_TOOL_ONLY_CAPABILITY
    : undefined;
}
export function invocationEffect(tool: ToolInfo | undefined): InvocationEffect {
  if (codemodeCapability(tool)) return "container";
  if (
    tool &&
    ["read", "ls", "grep", "find"].includes(tool.name) &&
    tool.sourceInfo.path === `builtin:${tool.name}` &&
    tool.sourceInfo.source === "builtin"
  )
    return "readonly";
  return "write";
}
