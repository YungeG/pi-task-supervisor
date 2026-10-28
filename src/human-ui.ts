import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isGoalReadbackFrame, type NativeReadbackFrame } from "./human-journal";
import { isSafeBoundedText } from "./validation";
import { createScopeReview } from "./human-scope-view";
import { materialLine, type HumanMaterial } from "./human-material-view";
import { suspendTaskWidget } from "./board-ui";
import { closeReadOnlyView } from "./ui-view-lifecycle";
import { DecisionCard, isDecisionDraft, type DecisionDraft } from "./human-decision-card";
import {
  ApprovalReview,
  isApprovalSelection,
  type ApprovalOption,
  type ApprovalSelection,
} from "./approval-review";
import type { UiViewEnvironment } from "./ui-environment";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, truncateToWidth, stripTerminalSequences } from "@earendil-works/pi-tui";

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
  readonly frame: NativeReadbackFrame;
  readonly kind: "authorization" | "choice" | "information";
  readonly title: string;
  readonly body: string;
  /** Optional Markdown material; canonical scope is reviewed once, never replaced by this preview. */
  readonly material?: HumanMaterial;
  readonly options?: readonly string[];
  /** Display-only labels aligned with canonical options; never persisted as answers. */
  readonly displayOptions?: readonly string[];
  readonly informationValidator?: (value: string) => boolean;
  /** Display-only metadata; never grants authority or replaces the owner validator. */
  readonly purpose?:
    | "authorization"
    | "business-choice"
    | "contract-definition"
    | "first-start"
    | "information"
    | "approval-bundle";
  readonly approval?: Readonly<{
    permissions: readonly ApprovalOption[];
    selectedIds: readonly string[];
    definitionsOnly?: boolean;
  }>;
  readonly informationFormat?: "text" | "integer" | "date";
}

/** Opaque answer recognized only by private WeakMap. */
export interface NativeAnswer {
  readonly outcome: "approve" | "reject" | "answer";
  readonly value: string | undefined;
  readonly answeredAt: number;
}

interface AnswerMetadata {
  readonly sessionManager: object;
  readonly frame: NativeReadbackFrame;
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly sessionId: string;
  readonly branchAnchor: string;
}

const answerRegistry = new WeakMap<object, AnswerMetadata>();
const activeQuestions = new WeakMap<object, Promise<NativeAnswer | undefined>>();

/** Queries the original operation lock without creating an answer or admission. */
export function hasActiveNativeQuestion(ctx: ExtensionContext): boolean {
  return activeQuestions.has(ctx.sessionManager);
}

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
  if (!nativeFrameVersion(question.frame) || question.frame.sessionId !== sessionId)
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
  // Establish the original lock before closeReadOnlyView can synchronously abort
  // a reader whose cleanup reenters this seam.
  let displayToken: ReturnType<typeof suspendTaskWidget>;
  const answerPromise = Promise.resolve().then(() => {
    if (
      !interactionCurrent(ctx, sessionId, leafId, isCurrent, operationSignal) ||
      !purposeFor(clonedQuestion) ||
      !validDisplayMetadata(clonedQuestion)
    )
      return undefined;
    displayToken = suspendTaskWidget(ctx);
    if (!displayToken) return undefined;
    return performNativeInteraction(
      ctx,
      clonedQuestion,
      sessionId,
      leafId,
      isCurrent,
      operationSignal,
    );
  });
  activeQuestions.set(sessionKey, answerPromise);

  try {
    const answer = await answerPromise;
    if (!interactionCurrent(ctx, sessionId, leafId, isCurrent, operationSignal)) return undefined;
    return answer;
  } finally {
    activeQuestions.delete(sessionKey);
    displayToken?.release();
  }
}

function cloneQuestion(question: NativeQuestion): NativeQuestion {
  return {
    frame: structuredClone(question.frame),
    kind: question.kind,
    title: question.title,
    body: question.body,
    material: question.material ? structuredClone(question.material) : undefined,
    options: question.options ? [...question.options] : undefined,
    displayOptions: question.displayOptions ? [...question.displayOptions] : undefined,
    informationValidator: question.informationValidator,
    purpose: question.purpose,
    approval: question.approval ? structuredClone(question.approval) : undefined,
    informationFormat: question.informationFormat,
  };
}

function interactionCurrent(
  ctx: ExtensionContext,
  sessionId: string,
  leafId: string,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): boolean {
  return (
    ctx.sessionManager.getSessionId() === sessionId &&
    branchContains(ctx, leafId) &&
    isCurrent() &&
    !signal?.aborted
  );
}

async function performNativeInteraction(
  ctx: ExtensionContext,
  question: NativeQuestion,
  sessionId: string,
  leafId: string,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<NativeAnswer | undefined> {
  const current = () => interactionCurrent(ctx, sessionId, leafId, isCurrent, signal);
  const result = await invokeUI(ctx, question, current, signal);
  if (result === undefined) return undefined;

  // Re-check session identity and active branch after UI
  if (ctx.sessionManager.getSessionId() !== sessionId || !branchContains(ctx, leafId)) {
    return undefined;
  }

  // Re-check isCurrent and signal after UI
  if (!isCurrent() || signal?.aborted) return undefined;

  // Map result to answer
  const answer =
    question.purpose === "approval-bundle"
      ? approvalAnswer(result, question)
      : mapResultToAnswer(question.kind, result, question.options);
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

type Purpose = NonNullable<NativeQuestion["purpose"]>;
const REVIEW_AGAIN = Symbol("review-again");
const RETRY_INPUT = Symbol("retry-input");
const REVIEW_LABEL = "重新核对全文";
// Non-overlay custom replaces only the editor. Same explicit host budget as C0.
const HOST_CHROME_ROWS = 10;

function canonicalLaterStart(question: NativeQuestion): boolean {
  return (
    question.frame.owner === "preflight" &&
    question.options?.length === 2 &&
    question.options[0] === "Later" &&
    question.options[1] === "Start execution"
  );
}

function canonicalContractDefinition(question: NativeQuestion): boolean {
  return (
    question.kind === "choice" &&
    isGoalReadbackFrame(question.frame) &&
    question.options?.length === 2 &&
    question.options[0] === "绑定此契约" &&
    question.options[1] === "不绑定"
  );
}
function purposeFor(question: NativeQuestion): Purpose | undefined {
  // Only absent metadata selects a default; null/unknown purposes must stay invalid.
  const defaults = {
    choice: "business-choice",
    authorization: "authorization",
    information: "information",
  } as const;
  const purpose = question.purpose === undefined ? defaults[question.kind] : question.purpose;
  if (purpose === "approval-bundle" && question.kind === "authorization" && question.approval)
    return purpose;
  if ((purpose === "authorization" || purpose === "information") && purpose === question.kind)
    return purpose;
  if (purpose === "business-choice" && question.kind === "choice") return purpose;
  if (purpose === "contract-definition" && canonicalContractDefinition(question)) return purpose;
  if (purpose === "first-start" && canonicalLaterStart(question)) return purpose;
  return undefined;
}

function validDefinitionBody(body: string): boolean {
  return (
    Buffer.byteLength(body, "utf8") <= 64000 &&
    !Array.from(body).some((char) => char !== "\n" && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(char))
  );
}
function validDisplayMetadata(question: NativeQuestion): boolean {
  if (question.purpose === "approval-bundle" && !validApprovalMetadata(question)) return false;
  if (question.purpose === "contract-definition" && !validDefinitionBody(question.body))
    return false;
  if (question.approval && question.purpose !== "approval-bundle") return false;
  if (question.informationFormat !== undefined) {
    if (question.kind !== "information") return false;
    if (!["text", "integer", "date"].includes(question.informationFormat)) return false;
  }
  if (question.kind !== "choice") return true;
  if (!question.options?.length) return false;
  // Validate the original mapping even though final business labels are indexed.
  const labels = question.displayOptions ?? question.options;
  return labels.length === question.options.length && new Set(labels).size === labels.length;
}

function formatHint(question: NativeQuestion): string {
  if (question.informationFormat === "integer") return "整数";
  if (question.informationFormat === "date") return "日期 YYYY-MM-DD";
  return "文本，最多1000字";
}

/** Escape non-ASCII/control/bidi code points in requestId to printable ASCII. */
function escapeRequestId(raw: string): string {
  let result = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      result += char;
    } else if (code > 0xffff) {
      result += `\\u{${code.toString(16)}}`;
    } else {
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return result;
}

/** Build a final native title: purpose/format hint + captured requestId identity, ≤64 cols. */
function finalTitle(base: string, question: NativeQuestion): string {
  const escaped = escapeRequestId(question.frame.requestId);
  const full = `${base} — 请求 ${escaped}`;
  if (visibleWidth(full) <= 64) return full;
  return stripTerminalSequences(truncateToWidth(full, 64, "…"));
}

function promptTitle(base: string, question: NativeQuestion): string {
  const identity = finalTitle(base, question);
  if (!question.material) return identity;
  const context = question.material.context || question.title;
  return `${identity}\n${materialLine(`问题：${context}`, 64)}`;
}

function reviewText(question: NativeQuestion, purpose: Purpose): string {
  const contents = [question.title, question.body];
  if (question.kind === "choice") {
    contents.push(...(question.options ?? []).map((value, index) => `选项 ${index + 1}\n${value}`));
  }
  if (purpose === "information") contents.push(`格式：${formatHint(question)}`);
  return contents.join("\n\n");
}

/** Same lifecycle and actual completion handshake for readonly review and draft cards. */
async function questionView<T>(
  ctx: ExtensionContext,
  current: () => boolean,
  signal: AbortSignal | undefined,
  create: (
    env: UiViewEnvironment,
    done: (value: T | undefined) => void,
  ) => Component & { dispose(): void },
  expanded = false,
): Promise<T | undefined> {
  if (!current()) return undefined;
  let component: (Component & { dispose(): void }) | undefined;
  let abort: (() => void) | undefined;
  const completion: { done: boolean; value: T | undefined } = { done: false, value: undefined };
  try {
    const result = await ctx.ui.custom<T | undefined>(
      (tui, theme, keybindings, done) => {
        const validBeforeFactory = current();
        const finish = (value: T | undefined) => {
          if (completion.done) return;
          completion.done = true;
          completion.value = value;
          done(value);
        };
        component = create(
          {
            theme,
            keybindings,
            requestRender: () => {
              tui.requestRender();
            },
            rows: () =>
              Math.max(
                0,
                expanded
                  ? Math.floor(tui.terminal.rows * 0.9) - 2
                  : tui.terminal.rows - HOST_CHROME_ROWS,
              ),
          },
          finish,
        );
        abort = () => {
          component?.dispose();
          finish(undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (!validBeforeFactory || !current()) abort();
        return component;
      },
      expanded
        ? { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } }
        : undefined,
    );
    return current() && completion.done && result === completion.value
      ? completion.value
      : undefined;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    component?.dispose();
  }
}
async function reviewScope(
  ctx: ExtensionContext,
  text: string,
  current: () => boolean,
  signal?: AbortSignal,
  material?: HumanMaterial,
): Promise<boolean> {
  const result = await questionView<"reviewed" | "cancelled">(ctx, current, signal, (env, done) =>
    createScopeReview(text, env, done, material),
  );
  return result === "reviewed";
}
function validDraftInformation(question: NativeQuestion, value: string): boolean {
  return (
    question.kind !== "information" ||
    (isSafeBoundedText(value, 1000) &&
      (!question.informationValidator || question.informationValidator(value)))
  );
}
function decisionDraftValue(question: NativeQuestion, draft: DecisionDraft): string | undefined {
  if (question.kind === "authorization")
    return draft.index === 1 ? "Approve" : draft.index === 2 ? "Reject" : undefined;
  if (question.kind === "choice") return question.options?.[(draft.index ?? 0) - 1];
  return draft.value !== undefined && validDraftInformation(question, draft.value)
    ? draft.value
    : undefined;
}
function draftConfirmation(
  question: NativeQuestion,
  purpose: Purpose,
  value: string,
  index?: number,
): { title: string; label: string } {
  const names = {
    authorization: "范围确认（全文已核对）",
    "first-start": "首次启动（全文已核对）",
    "business-choice": "业务选择（全文已核对）",
    information: "补充信息（全文已核对）",
    "approval-bundle": "集中审核（完整材料已核对）",
    "contract-definition": "契约定义审核（完整材料已核对）",
  };
  let label = "确认提交所选方案";
  if (question.kind === "authorization") label = value === "Approve" ? "允许上述范围" : "不允许";
  else if (purpose === "first-start") label = "开始执行";
  else if (question.kind === "information") label = "确认提交信息";
  const detail =
    question.kind === "authorization"
      ? label
      : question.kind === "choice"
        ? `选项 ${index ?? 0} · ${JSON.stringify(value)}`
        : JSON.stringify(value);
  return {
    label,
    title: promptTitle(names[purpose], question) + "\n" + materialLine("草稿：" + detail, 64),
  };
}
async function confirmDecisionDraft(
  ctx: ExtensionContext,
  question: NativeQuestion,
  purpose: Purpose,
  draft: DecisionDraft,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string | typeof REVIEW_AGAIN | typeof RETRY_INPUT | undefined> {
  const value = decisionDraftValue(question, draft);
  if (value === undefined) return undefined;
  const confirmation = draftConfirmation(question, purpose, value, draft.index);
  const later =
    purpose === "first-start" ? "稍后启动" : purpose === "information" ? "稍后输入" : "稍后决定";
  const index = await selectOffered(
    ctx,
    confirmation.title,
    [later, confirmation.label, "返回修改", REVIEW_LABEL],
    current,
    signal,
  );
  if (!current()) return undefined;
  if (index === 2) return RETRY_INPUT;
  if (index === 3) return REVIEW_AGAIN;
  if (index !== 1 || !validDraftInformation(question, value)) return undefined;
  return value;
}
async function invokeDecisionCard(
  ctx: ExtensionContext,
  question: NativeQuestion,
  purpose: Purpose,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let initial: DecisionDraft | undefined;
  let recheck = false;
  while (current()) {
    const draft = await questionView<DecisionDraft>(
      ctx,
      current,
      signal,
      (env, done) =>
        new DecisionCard(question, reviewText(question, purpose), env, done, initial, recheck),
    );
    if (!current() || !isDecisionDraft(draft, question)) return undefined;
    const result = await confirmDecisionDraft(ctx, question, purpose, draft, current, signal);
    if (!current()) return undefined;
    if (result !== REVIEW_AGAIN && result !== RETRY_INPUT) return result;
    initial = draft;
    recheck = result === REVIEW_AGAIN;
  }
  return undefined;
}

function validApprovalMetadata(question: NativeQuestion): boolean {
  const approval = question.approval;
  if (
    !approval ||
    question.kind !== "authorization" ||
    approval.permissions.length > 20 ||
    Array.from(question.body).some((char) => char !== "\n" && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(char))
  )
    return false;
  const ids = approval.permissions.map((option) => option.id);
  return (
    new Set(ids).size === ids.length &&
    approval.permissions.every(
      (option) =>
        isSafeBoundedText(option.id, 64) &&
        isSafeBoundedText(option.label, 500) &&
        typeof option.required === "boolean",
    ) &&
    new Set(approval.selectedIds).size === approval.selectedIds.length &&
    approval.selectedIds.every((id) => ids.includes(id))
  );
}
function approvalAnswer(value: string, question: NativeQuestion): NativeAnswer | undefined {
  try {
    const selected: unknown = JSON.parse(value);
    if (
      !Array.isArray(selected) ||
      !selected.every((id) => typeof id === "string") ||
      new Set(selected).size !== selected.length ||
      !selected.every((id) => question.approval?.permissions.some((option) => option.id === id))
    )
      return undefined;
    return Object.freeze({
      outcome: "approve",
      value: JSON.stringify([...selected].sort()),
      answeredAt: Date.now(),
    });
  } catch {
    return value === "Reject"
      ? Object.freeze({ outcome: "reject", value: undefined, answeredAt: Date.now() })
      : undefined;
  }
}
async function invokeApprovalReview(
  ctx: ExtensionContext,
  question: NativeQuestion,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const selected = await questionView<ApprovalSelection>(
    ctx,
    current,
    signal,
    (env, done) => new ApprovalReview(question, env, done),
    true,
  );
  if (!current() || !isApprovalSelection(selected, question)) return undefined;
  if (question.purpose === "contract-definition")
    return selected.permissionIds.length
      ? undefined
      : question.options?.[selected.outcome === "approve" ? 0 : 1];
  return selected.outcome === "reject" ? "Reject" : JSON.stringify(selected.permissionIds);
}
async function invokeLegacyQuestion(
  ctx: ExtensionContext,
  question: NativeQuestion,
  purpose: Purpose,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const text = reviewText(question, purpose);
  let needsReview = true;
  while (current()) {
    if (needsReview) {
      const reviewed = await reviewScope(ctx, text, current, signal, question.material);
      if (!current() || !reviewed) return undefined;
    }
    if (!current()) return undefined;
    const result = await invokeFinalUI(ctx, question, purpose, current, signal);
    if (!current()) return undefined;
    if (result === REVIEW_AGAIN || result === RETRY_INPUT) needsReview = result === REVIEW_AGAIN;
    else return result;
  }
  return undefined;
}
async function invokeUI(
  ctx: ExtensionContext,
  question: NativeQuestion,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const purpose = purposeFor(question);
    if (!purpose || !validDisplayMetadata(question) || !current()) return undefined;
    await closeReadOnlyView(ctx);
    if (!current()) return undefined;
    if (purpose === "approval-bundle" || purpose === "contract-definition")
      return await invokeApprovalReview(ctx, question, current, signal);
    if (question.material) return await invokeDecisionCard(ctx, question, purpose, current, signal);
    return await invokeLegacyQuestion(ctx, question, purpose, current, signal);
  } catch {
    // No custom fallback, summary approval, or implicit retry after UI failure.
    return undefined;
  }
}

async function selectOffered(
  ctx: ExtensionContext,
  title: string,
  labels: string[],
  current: () => boolean,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (!current()) return undefined;
  const selected = await ctx.ui.select(title, [...labels], { signal });
  if (!current() || selected === undefined) return undefined;
  const index = labels.indexOf(selected);
  return index < 0 ? undefined : index;
}

async function invokeFinalUI(
  ctx: ExtensionContext,
  question: NativeQuestion,
  purpose: Purpose,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string | typeof REVIEW_AGAIN | typeof RETRY_INPUT | undefined> {
  if (purpose === "information") return invokeInformation(ctx, question, current, signal);
  if (purpose === "authorization") {
    const index = await selectOffered(
      ctx,
      promptTitle("范围确认（全文已核对）", question),
      ["稍后决定", "允许上述范围", "不允许", REVIEW_LABEL],
      current,
      signal,
    );
    if (!current()) return undefined;
    return index === 3 ? REVIEW_AGAIN : ["Defer", "Approve", "Reject"][index ?? -1];
  }
  if (purpose === "first-start") {
    const index = await selectOffered(
      ctx,
      promptTitle("首次启动（全文已核对）", question),
      ["稍后启动", "开始执行", REVIEW_LABEL],
      current,
      signal,
    );
    if (!current()) return undefined;
    if (index === 2) return REVIEW_AGAIN;
    return index === 1 ? question.options?.[1] : undefined;
  }
  return invokeBusinessChoice(ctx, question, current, signal);
}

function choiceLabel(question: NativeQuestion, value: string, index: number): string {
  const ordinal = `选项 ${index + 1}`;
  if (!question.material) return ordinal;
  const text = /[\r\n\t]|^\s|\s$| {2}/u.test(value) ? JSON.stringify(value) : value;
  return materialLine(`${ordinal} · ${text}`, 32);
}

async function invokeBusinessChoice(
  ctx: ExtensionContext,
  question: NativeQuestion,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string | typeof REVIEW_AGAIN | undefined> {
  const labels = [
    "稍后决定（不提交）",
    ...(question.options ?? []).map((value, i) => choiceLabel(question, value, i)),
    REVIEW_LABEL,
  ];
  const index = await selectOffered(
    ctx,
    promptTitle("业务选择（全文已核对）", question),
    labels,
    current,
    signal,
  );
  if (!current() || index === undefined || index === 0) return undefined;
  if (index === labels.length - 1) return REVIEW_AGAIN;
  return question.options?.[index - 1];
}

async function invokeInformation(
  ctx: ExtensionContext,
  question: NativeQuestion,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string | typeof REVIEW_AGAIN | typeof RETRY_INPUT | undefined> {
  if (!current()) return undefined;
  const result = await ctx.ui.input(
    promptTitle(`补充信息：${formatHint(question)}`, question),
    undefined,
    { signal },
  );
  if (!current() || result === undefined) return undefined;

  // Original bounded-text check precedes the unchanged owner validator. Never
  // trim, convert, prefill, or echo rejected input through any UI transport.
  const safe = isSafeBoundedText(result, 1000);
  if (safe && (!question.informationValidator || question.informationValidator(result)))
    return result;
  if (!current()) return undefined;
  const title = promptTitle(
    safe ? `未保存：需要${formatHint(question)}` : "未保存：需要安全且不超过1000字的信息",
    question,
  );
  const index = await selectOffered(
    ctx,
    title,
    ["稍后输入", "重新输入", REVIEW_LABEL],
    current,
    signal,
  );
  if (!current()) return undefined;
  if (index === 1) return RETRY_INPUT;
  return index === 2 ? REVIEW_AGAIN : undefined;
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
  expectedFrame: NativeReadbackFrame,
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
  if (!nativeFrameVersion(expectedFrame)) {
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

function nativeFrameVersion(frame: NativeReadbackFrame): boolean {
  return (frame.version as number) === 1 || isGoalReadbackFrame(frame);
}
function framesEqual(a: NativeReadbackFrame, b: NativeReadbackFrame): boolean {
  const common = (f: NativeReadbackFrame) => [
    f.version,
    f.owner,
    f.sessionId,
    f.requestId,
    f.presentationId,
    f.scopeDigest,
  ];
  if (JSON.stringify(common(a)) !== JSON.stringify(common(b))) return false;
  if (a.version === 2 && b.version === 2)
    return a.baseEntryId === b.baseEntryId && a.baseEntryDigest === b.baseEntryDigest;
  return (
    a.version === 1 &&
    b.version === 1 &&
    a.baseSnapshotEntryId === b.baseSnapshotEntryId &&
    a.baseSnapshotDigest === b.baseSnapshotDigest
  );
}
