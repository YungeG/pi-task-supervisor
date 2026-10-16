import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_RECEIPT_CACHE, type ReceiptCacheConfig } from "./receipt-store";

export interface ContinuousTasksConfig {
  /** Legacy setting, parsed for compatibility; native boundaries do not use a countdown. */
  countdownMs: number;
  maxStagnantSettles: number;
  requireCompletionEvidence: boolean;
  phaseCompletionPromptTemplate?: string;
  receiptCache?: ReceiptCacheConfig;
}

export const DEFAULT_CONFIG: ContinuousTasksConfig = {
  countdownMs: 3000,
  maxStagnantSettles: 5,
  requireCompletionEvidence: true,
  receiptCache: { ...DEFAULT_RECEIPT_CACHE },
};

let cachedConfig: ContinuousTasksConfig | null = null;

function configPath(): string {
  const root = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(root, "continuous-tasks.json");
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  const candidate = value ?? fallback;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= min &&
    candidate <= max
    ? candidate
    : null;
}

function decodeConfig(value: unknown): ContinuousTasksConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  const countdownMs = boundedInteger(input.countdownMs, DEFAULT_CONFIG.countdownMs, 0, 60_000);
  const maxStagnantSettles = boundedInteger(
    input.maxStagnantSettles,
    DEFAULT_CONFIG.maxStagnantSettles,
    1,
    20,
  );
  const requireCompletionEvidence =
    input.requireCompletionEvidence ?? DEFAULT_CONFIG.requireCompletionEvidence;
  const phaseCompletionPromptTemplate = input.phaseCompletionPromptTemplate;
  const cache = input.receiptCache === undefined ? DEFAULT_RECEIPT_CACHE : input.receiptCache;
  if (typeof cache !== "object" || cache === null) return null;
  const cacheInput = cache as Record<string, unknown>;
  const maxEntries = boundedInteger(
    cacheInput.maxEntries,
    DEFAULT_RECEIPT_CACHE.maxEntries,
    1,
    4096,
  );
  const maxBytes = boundedInteger(
    cacheInput.maxBytes,
    DEFAULT_RECEIPT_CACHE.maxBytes,
    16_384,
    67_108_864,
  );
  if (
    countdownMs === null ||
    maxStagnantSettles === null ||
    maxEntries === null ||
    maxBytes === null ||
    typeof requireCompletionEvidence !== "boolean" ||
    (phaseCompletionPromptTemplate !== undefined &&
      (typeof phaseCompletionPromptTemplate !== "string" ||
        phaseCompletionPromptTemplate.length > 4000))
  ) {
    return null;
  }

  return {
    countdownMs,
    maxStagnantSettles,
    requireCompletionEvidence,
    phaseCompletionPromptTemplate,
    receiptCache: { maxEntries, maxBytes },
  };
}

/** Load the global, default-deny configuration once per extension runtime. */
export async function loadConfig(): Promise<ContinuousTasksConfig> {
  if (cachedConfig !== null) return cachedConfig;
  try {
    const decoded = decodeConfig(JSON.parse(await readFile(configPath(), "utf8")) as unknown);
    if (decoded) {
      cachedConfig = decoded;
      return cachedConfig;
    }
  } catch {
    // Default-deny on missing, malformed, or unreadable configuration.
  }
  cachedConfig = { ...DEFAULT_CONFIG };
  return cachedConfig;
}

export function resolvePhasePrompt(
  template: string | undefined,
  phase: number,
): string | undefined {
  if (!template) return undefined;
  return template.replace(/\{phase\}/g, String(phase));
}

export function resetConfig(): void {
  cachedConfig = null;
}
