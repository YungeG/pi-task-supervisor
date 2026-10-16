import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReadbackFrame } from "./human-journal";
import { isSafeBoundedText } from "./validation";

/**
 * N2a native TUI transport utility.
 * Generates opaque answers only through real trusted CLI + native UI interaction.
 * Trusted host assumption, not cryptographic authentication.
 */

const TRUSTED_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const TRUSTED_CLI_PATHS = ["dist/cli.js", "dist/bundle/cli.js"];

/**
 * Derive verified trusted CLI installation roots from actual package resolution
 * and Node's npm prefix. Returns canonical roots only.
 */
export function trustedCliRoots(): string[] {
  const roots = new Set<string>();

  // 1. This module's actual package resolution
  try {
    const resolved = import.meta.resolve(TRUSTED_PACKAGE_NAME);
    const resolvedPath = resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved;
    const root = findPackageRoot(resolvedPath);
    if (root) roots.add(root);
  } catch {
    // Package not resolvable from this context; skip
  }

  // 2. Current Node execPath's npm prefix
  try {
    const execPath = realpathSync(process.execPath);
    const prefix = dirname(dirname(execPath)); // <prefix>/bin/node -> <prefix>
    const candidate = join(prefix, "lib", "node_modules", TRUSTED_PACKAGE_NAME);
    // Verify candidate is actually the trusted package
    const verifiedRoot = findPackageRoot(candidate);
    if (verifiedRoot) roots.add(verifiedRoot);
  } catch {
    // execPath resolution failed; skip
  }

  return Array.from(roots);
}

function findPackageRoot(entryPath: string): string | undefined {
  let current = resolve(entryPath);

  // Check if entryPath itself is a directory (package root candidate)
  try {
    const stat = statSync(current);
    if (!stat.isDirectory()) {
      current = dirname(current);
    }
  } catch {
    current = dirname(current);
  }

  // Walk up until we find package.json with correct name or hit filesystem root
  while (current !== dirname(current)) {
    const pkgPath = join(current, "package.json");
    try {
      const content = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content) as { name?: string };
      if (pkg.name === TRUSTED_PACKAGE_NAME) {
        return realpathSync(current);
      }
    } catch {
      // Not a package root; continue
    }
    const parent = dirname(current);
    if (parent === current) break; // Hit filesystem root
    current = parent;
  }
  return undefined;
}

/**
 * Check if current execution is a trusted local TUI:
 * - ctx.mode === "tui"
 * - ctx.hasUI === true
 * - stdin/stdout are real TTYs
 * - argv[1] realpath matches trusted CLI entry
 */
export function isTrustedLocalTui(ctx: ExtensionContext): boolean {
  if (ctx.mode !== "tui" || !ctx.hasUI) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const scriptPath = process.argv[1];
  if (!scriptPath) return false;

  let realScript: string;
  try {
    realScript = realpathSync(resolve(scriptPath));
  } catch {
    return false;
  }

  const roots = trustedCliRoots();
  return roots.some((root) =>
    TRUSTED_CLI_PATHS.some((cliPath) => {
      const expected = join(root, cliPath);
      try {
        return realpathSync(expected) === realScript;
      } catch {
        return false;
      }
    }),
  );
}

/** Frozen question structure for native UI interaction. */
export interface NativeQuestion {
  readonly frame: ReadbackFrame;
  readonly kind: "authorization" | "choice" | "information";
  readonly title: string;
  readonly body: string;
  readonly options?: readonly string[];
  readonly informationValidator?: (value: string) => boolean;
}

/** Opaque answer recognized only by private WeakMap. */
export interface NativeAnswer {
  readonly outcome: "approve" | "reject" | "answer";
  readonly value: string | undefined;
  readonly answeredAt: number;
}

interface AnswerMetadata {
  readonly sessionManager: object;
  readonly frame: ReadbackFrame;
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly sessionId: string;
  readonly branchAnchor: string;
}

const answerRegistry = new WeakMap<object, AnswerMetadata>();
const activeQuestions = new WeakMap<object, Promise<NativeAnswer | undefined>>();

/**
 * Request native answer through trusted TUI.
 * Returns undefined if not trusted, cancelled, stale, or invalid.
 */
export async function requestNativeAnswer(
  ctx: ExtensionContext,
  question: NativeQuestion,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<NativeAnswer | undefined> {
  // Deny unsupported source before UI call
  if (!isTrustedLocalTui(ctx)) return undefined;

  // Check session identity and active branch before UI
  const sessionId = ctx.sessionManager.getSessionId();
  const leafId = ctx.sessionManager.getLeafId();
  if (!sessionId || !leafId) return undefined;

  // Check frame.sessionId matches ctx.sessionId before UI
  if ((question.frame.version as number) !== 1 || question.frame.sessionId !== sessionId)
    return undefined;

  const signals = [ctx.signal, signal].filter((item): item is AbortSignal => item !== undefined);
  const operationSignal = signals.length ? AbortSignal.any(signals) : undefined;
  // Check isCurrent and both cancellation sources before UI.
  if (!isCurrent() || operationSignal?.aborted) return undefined;

  // Check no outstanding question for this sessionManager
  const sessionKey = ctx.sessionManager as unknown as object;
  if (activeQuestions.has(sessionKey)) return undefined;

  // Deep clone question before awaiting
  const clonedQuestion = cloneQuestion(question);

  // Create promise and register
  const answerPromise = performNativeInteraction(
    ctx,
    clonedQuestion,
    sessionId,
    leafId,
    isCurrent,
    operationSignal,
  );
  activeQuestions.set(sessionKey, answerPromise);

  try {
    const answer = await answerPromise;
    return answer;
  } finally {
    activeQuestions.delete(sessionKey);
  }
}

function cloneQuestion(question: NativeQuestion): NativeQuestion {
  return {
    frame: structuredClone(question.frame),
    kind: question.kind,
    title: question.title,
    body: question.body,
    options: question.options ? [...question.options] : undefined,
    informationValidator: question.informationValidator,
  };
}

async function performNativeInteraction(
  ctx: ExtensionContext,
  question: NativeQuestion,
  sessionId: string,
  leafId: string,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<NativeAnswer | undefined> {
  const result = await invokeUI(ctx, question, signal);
  if (result === undefined) return undefined;

  // Re-check session identity and active branch after UI
  if (ctx.sessionManager.getSessionId() !== sessionId || !branchContains(ctx, leafId)) {
    return undefined;
  }

  // Re-check isCurrent and signal after UI
  if (!isCurrent() || signal?.aborted) return undefined;

  // Map result to answer
  const answer = mapResultToAnswer(question.kind, result, question.options);
  if (!answer) return undefined;

  // Register answer with metadata
  const metadata: AnswerMetadata = {
    sessionManager: ctx.sessionManager,
    frame: question.frame,
    signal,
    isCurrent,
    sessionId,
    branchAnchor: leafId,
  };
  answerRegistry.set(answer, metadata);

  return answer;
}

async function invokeUI(
  ctx: ExtensionContext,
  question: NativeQuestion,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    if (question.kind === "authorization") {
      return await invokeAuthorization(ctx, question, signal);
    }
    if (question.kind === "choice") {
      return await invokeChoice(ctx, question, signal);
    }
    return await invokeInformation(ctx, question, signal);
  } catch {
    // UI interaction failed or cancelled
    return undefined;
  }
}

async function invokeAuthorization(
  ctx: ExtensionContext,
  question: NativeQuestion,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const displayTitle = question.body ? `${question.title}\n\n${question.body}` : question.title;
  return ctx.ui.select(displayTitle, ["Defer", "Approve", "Reject"], { signal });
}

async function invokeChoice(
  ctx: ExtensionContext,
  question: NativeQuestion,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!question.options || question.options.length === 0) return undefined;
  const displayTitle = question.body ? `${question.title}\n\n${question.body}` : question.title;
  return ctx.ui.select(displayTitle, [...question.options], { signal });
}

async function invokeInformation(
  ctx: ExtensionContext,
  question: NativeQuestion,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await ctx.ui.input(question.title, question.body, { signal });
  if (result === undefined) return undefined;

  // Validate safe bounded text (max 1000 chars, no secrets)
  if (!isSafeBoundedText(result, 1000)) return undefined;

  if (question.informationValidator && !question.informationValidator(result)) {
    return undefined;
  }
  return result;
}

function mapResultToAnswer(
  kind: NativeQuestion["kind"],
  result: string | undefined,
  options?: readonly string[],
): NativeAnswer | undefined {
  if (result === undefined) return undefined;

  if (kind === "authorization") {
    if (result === "Defer") {
      // Defer means no decision, return undefined (not reject)
      return undefined;
    }
    if (result === "Approve") {
      return createAnswer("approve", undefined);
    }
    if (result === "Reject") {
      return createAnswer("reject", undefined);
    }
    return undefined;
  }

  if (kind === "choice") {
    if (!options || !options.includes(result)) return undefined;
    return createAnswer("answer", result);
  }

  // information
  return createAnswer("answer", result);
}

function createAnswer(outcome: NativeAnswer["outcome"], value: string | undefined): NativeAnswer {
  return Object.freeze({
    outcome,
    value,
    answeredAt: Date.now(),
  });
}

/**
 * Validate and extract native answer.
 * Throws on mismatch; does not grant or change state.
 */
export function requireNativeAnswer(
  ctx: ExtensionContext,
  answer: unknown,
  expectedFrame: ReadbackFrame,
): NativeAnswer {
  // Check private identity
  if (!answer || typeof answer !== "object") {
    throw new Error("Invalid native answer");
  }

  const metadata = answerRegistry.get(answer);
  if (!metadata) {
    throw new Error("Unrecognized native answer");
  }

  // Check answer object is frozen (immutable)
  if (!Object.isFrozen(answer)) {
    throw new Error("Answer object is mutable");
  }

  // Check sessionManager matches (same object identity)
  const currentSessionManager = ctx.sessionManager;
  if (metadata.sessionManager !== currentSessionManager) {
    throw new Error("Session mismatch");
  }

  // Check current sessionId matches metadata sessionId (session didn't change)
  const currentSessionId = ctx.sessionManager.getSessionId();
  if (currentSessionId !== metadata.sessionId) {
    throw new Error("Session ID changed");
  }

  // Check frame version at runtime (cannot rely on TS type alone)
  if ((expectedFrame.version as number) !== 1) {
    throw new Error("Invalid frame version");
  }

  // Check frame matches
  if (!framesEqual(metadata.frame, expectedFrame)) {
    throw new Error("Frame mismatch");
  }

  if (!branchContains(ctx, metadata.branchAnchor)) {
    throw new Error("Branch changed");
  }

  // Check isCurrent is still true
  if (!metadata.isCurrent()) {
    throw new Error("Request no longer current");
  }

  // Check cancellation (both answer's signal and ctx's signal)
  if (metadata.signal?.aborted || ctx.signal?.aborted) {
    throw new Error("Request cancelled");
  }

  return answer as NativeAnswer;
}

function branchContains(ctx: ExtensionContext, anchor: string): boolean {
  return (
    ctx.sessionManager.getLeafId() === anchor ||
    ctx.sessionManager.getBranch().some((entry) => entry.id === anchor)
  );
}

function framesEqual(a: ReadbackFrame, b: ReadbackFrame): boolean {
  return (
    (a.version as number) === 1 &&
    (b.version as number) === 1 &&
    a.owner === b.owner &&
    a.sessionId === b.sessionId &&
    a.requestId === b.requestId &&
    a.presentationId === b.presentationId &&
    a.scopeDigest === b.scopeDigest &&
    a.baseSnapshotEntryId === b.baseSnapshotEntryId &&
    a.baseSnapshotDigest === b.baseSnapshotDigest
  );
}
