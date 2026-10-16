import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { V2Archive, V2Cursor } from "./receipt-v2";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const natural = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableId = Type.Union([text(300), Type.Null()]);
const ReviewSchema = Type.Object({ taskId: text(100), digest: text(64) });
export const ReceiptSchema = Type.Object({
  id: text(300),
  tool: text(200),
  taskIds: Type.Array(text(100), { maxItems: 100 }),
  reviews: Type.Array(ReviewSchema, { maxItems: 100 }),
  epoch: natural,
  ok: Type.Boolean(),
  exitCode: Type.Optional(Type.Integer()),
  digest: text(64),
  input: text(2000),
  output: text(2000),
  eligible: Type.Optional(Type.Boolean()),
});
export type HostReceipt = Static<typeof ReceiptSchema>;
const CaptureSchema = Type.Object({
  id: text(300),
  tool: text(200),
  epoch: natural,
  reviews: Type.Array(ReviewSchema, { maxItems: 100 }),
  overlap: Type.Boolean(),
  readOnly: Type.Boolean(),
});
type Capture = Static<typeof CaptureSchema>;
export const ReceiptLedgerSchema = Type.Object({
  goalId: text(100),
  sequence: natural,
  head: nullableId,
  receiptCount: natural,
  epoch: natural,
  pending: Type.Array(text(300)),
  legacyBase: Type.Optional(
    Type.Object({ entryId: text(300), digest: text(64), version: Type.Optional(Type.Literal(2)) }),
  ),
});
export type ReceiptLedger = Static<typeof ReceiptLedgerSchema>;
const common = {
  version: Type.Literal(1),
  sessionId: text(200),
  goalId: text(100),
  sequence: natural,
  previous: nullableId,
  epoch: natural,
};
const RecordSchema = Type.Union([
  Type.Object({ ...common, kind: Type.Literal("intent"), capture: CaptureSchema, hash: text(64) }),
  Type.Object({
    ...common,
    kind: Type.Literal("receipt"),
    receipt: ReceiptSchema,
    capture: CaptureSchema,
    hash: text(64),
  }),
  Type.Object({
    ...common,
    kind: Type.Literal("close_unknown"),
    ids: Type.Array(text(300), { minItems: 1 }),
    resultGap: Type.Optional(Type.Boolean()),
    hash: text(64),
  }),
]);
type LedgerRecord = Static<typeof RecordSchema>;
export const RECEIPT_LEDGER_ENTRY = "continuous-tasks:receipt-ledger";
export const DEFAULT_RECEIPT_CACHE = { maxEntries: 128, maxBytes: 1_048_576 };
export type ReceiptCacheConfig = typeof DEFAULT_RECEIPT_CACHE;
type Location = { entryId: string; sequence: number; legacyIndex?: number; v2?: boolean };
type V2Resolver = (entryId: string, expectedDigest: string) => V2Archive;
type CacheItem = { receipt: HostReceipt; bytes: number };

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function redact(value: string, limit = 2000): string {
  return (
    value
      .replace(
        /\bBearer\s+\S+|\b(?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|authorization|client[_-]?secret)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)|\b(?:sk|ghp|pt|dt)_[A-Za-z0-9_-]{8,}/gi,
        "[redacted]",
      )
      .slice(0, limit) || "(empty)"
  );
}
export function redactedJSON(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (
      /^(?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|authorization|client[_-]?secret)$/i.test(
        key,
      )
    )
      return "[redacted]";
    return typeof item === "string" ? redact(item, item.length) : item;
  });
}
function increment(value: number): number {
  if (!Number.isSafeInteger(value + 1)) throw new Error("Receipt ledger integer overflow");
  return value + 1;
}
function recordHash(record: LedgerRecord): string {
  const payload: Partial<LedgerRecord> = { ...record };
  delete payload.hash;
  return digest(payload);
}
export function isReceiptLedgerRecord(value: unknown): value is LedgerRecord {
  return Check(RecordSchema, value) && value.hash === recordHash(value);
}
function exitCode(event: ToolResultEvent): number | undefined {
  const value = event.structuredContent;
  return typeof value === "object" &&
    value !== null &&
    "exit_code" in value &&
    Number.isInteger(value.exit_code)
    ? (value.exit_code as number)
    : undefined;
}

/** Raw proof bodies live in Pi's journal. Only locator metadata grows with its history. */
export class ReceiptStore {
  private meta: ReceiptLedger;
  private readonly index = new Map<string, Location>();
  private readonly cache = new Map<string, CacheItem>();
  private readonly pending = new Map<string, Capture>();
  private readonly calls = new Map<string, Capture>();
  private readonly closed = new Set<string>();
  private recent: string[] = [];
  private bytes = 0;
  private limits = { ...DEFAULT_RECEIPT_CACHE };
  private verifiedLeaf: string | null;
  private failed: string | undefined;
  private v2Base: V2Archive | undefined;
  private legacyView = false;
  private resolveV2: V2Resolver | undefined;

  constructor(
    private pi: ExtensionAPI | undefined,
    private ctx: ExtensionContext,
    readonly sessionId: string,
    goalId = `rg-${randomUUID()}`,
    epoch = 0,
  ) {
    this.meta = { goalId, sequence: 0, head: null, receiptCount: 0, epoch, pending: [] };
    this.verifiedLeaf = ctx.sessionManager.getLeafId();
  }
  get epoch(): number {
    return this.meta.epoch;
  }
  get healthy(): boolean {
    return !this.failed;
  }
  get format(): 2 | 3 {
    return this.legacyView ? 2 : 3;
  }
  get v2Cursor(): V2Cursor | undefined {
    return this.legacyView ? this.v2Base?.cursor : undefined;
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  get cachedReceipts(): HostReceipt[] {
    return [...this.cache.values()].map((item) => item.receipt);
  }
  get stats() {
    return {
      count: this.meta.receiptCount,
      cacheEntries: this.cache.size,
      cacheBytes: this.bytes,
      ...this.limits,
      pending: this.pending.size,
      indexed: this.index.size,
      healthy: this.healthy,
      format: this.format,
    };
  }
  checkpoint(): ReceiptLedger {
    return { ...structuredClone(this.meta), pending: [...this.pending.keys()].sort() };
  }
  configure(limits: ReceiptCacheConfig): void {
    if (
      !Number.isInteger(limits.maxEntries) ||
      limits.maxEntries < 1 ||
      limits.maxEntries > 4096 ||
      !Number.isInteger(limits.maxBytes) ||
      limits.maxBytes < 16_384 ||
      limits.maxBytes > 67_108_864
    )
      throw new Error("Invalid bounded receipt cache configuration");
    this.limits = { ...limits };
    this.evict();
  }
  private fail(message: string): never {
    this.failed = message;
    throw new Error(message);
  }
  private available(): void {
    if (this.failed) throw new Error(this.failed);
    if (this.ctx.sessionManager.getSessionId() !== this.sessionId)
      this.fail("Receipt ledger belongs to another session");
  }
  /** Walk only newly added native entries; tree switches must restore a new store. */
  private syncBranch(): void {
    this.available();
    const leaf = this.ctx.sessionManager.getLeafId();
    let id = leaf;
    const seen = new Set<string>();
    while (id !== this.verifiedLeaf) {
      if (!id || seen.has(id)) this.fail("Receipt branch changed; restore before continuing");
      seen.add(id);
      const entry = this.ctx.sessionManager.getEntry(id);
      if (!entry) this.fail("Missing receipt branch entry");
      if (
        entry.type === "custom" &&
        [RECEIPT_LEDGER_ENTRY, "continuous-tasks:supervisor-receipts"].includes(entry.customType)
      )
        this.fail("Unexpected receipt ledger entry; restore before continuing");
      id = entry.parentId;
    }
    this.verifiedLeaf = leaf;
  }
  appendCheckpoint(customType: string, value: unknown): void {
    this.syncBranch();
    const id = this.appendVisible(customType, value);
    if (this.legacyView && this.v2Base) {
      this.v2Base = { ...this.v2Base, entryId: id, digest: digest(value) };
      this.meta.legacyBase = { entryId: id, digest: digest(value), version: 2 };
    }
  }
  private appendVisible(customType: string, value: unknown): string {
    if (!this.pi) return this.fail("Read-only receipt inspection cannot append");
    const parent = this.ctx.sessionManager.getLeafId();
    try {
      this.pi.appendEntry(customType, value);
      const leaf = this.ctx.sessionManager.getLeafEntry();
      if (
        !leaf ||
        leaf.id === parent ||
        leaf.parentId !== parent ||
        leaf.type !== "custom" ||
        leaf.customType !== customType ||
        digest(leaf.data) !== digest(value) ||
        this.ctx.sessionManager.getEntry(leaf.id)?.id !== leaf.id
      )
        return this.fail(
          "Receipt persistence was not confirmed on the actual branch; inspect journal",
        );
      this.verifiedLeaf = leaf.id;
      return leaf.id;
    } catch (error) {
      return this.fail(
        `Receipt persistence uncertain; tool may have executed; no automatic retry: ${redact(error instanceof Error ? error.message : "append failed")}`,
      );
    }
  }
  private append(payload: Omit<LedgerRecord, "hash">): void {
    this.syncBranch();
    const record = { ...payload, hash: digest(payload) } as LedgerRecord;
    if (!Check(RecordSchema, record))
      this.fail("Invalid bounded receipt ledger record; not appended");
    const id = this.appendVisible(RECEIPT_LEDGER_ENTRY, record);
    this.apply(record, id);
  }
  private base(epoch: number) {
    return {
      version: 1 as const,
      sessionId: this.sessionId,
      goalId: this.meta.goalId,
      sequence: increment(this.meta.sequence),
      previous: this.meta.head,
      epoch,
    };
  }
  private apply(record: LedgerRecord, entryId: string): void {
    if (
      !Check(RecordSchema, record) ||
      record.hash !== recordHash(record) ||
      record.sessionId !== this.sessionId ||
      record.goalId !== this.meta.goalId ||
      record.sequence !== this.meta.sequence + 1 ||
      record.previous !== this.meta.head
    )
      this.fail("Invalid receipt ledger identity/order/digest");
    if (record.kind === "intent") this.applyIntent(record);
    else if (record.kind === "receipt") this.applyReceipt(record, entryId);
    else this.applyUnknown(record);
    this.meta.sequence = record.sequence;
    this.meta.head = entryId;
    this.meta.epoch = record.epoch;
  }
  private applyIntent(record: Extract<LedgerRecord, { kind: "intent" }>): void {
    const c = record.capture;
    if (
      record.epoch !== increment(this.epoch) ||
      c.epoch !== record.epoch ||
      c.readOnly ||
      c.overlap !== this.pending.size > 0 ||
      this.pending.has(c.id) ||
      this.index.has(c.id) ||
      this.closed.has(c.id)
    )
      this.fail("Invalid or conflicting receipt intent");
    this.pending.set(c.id, structuredClone(c));
  }
  private captureMatches(c: Capture, receipt: HostReceipt): boolean {
    return (
      receipt.id === c.id &&
      receipt.tool === c.tool &&
      receipt.epoch === c.epoch &&
      !this.index.has(c.id) &&
      !this.closed.has(c.id) &&
      digest(receipt.reviews) === digest(c.reviews)
    );
  }
  private intentMatches(c: Capture): boolean {
    if (c.readOnly) return c.epoch <= this.epoch;
    const pending = this.pending.get(c.id);
    return pending !== undefined && digest(pending) === digest(c);
  }
  private eligible(c: Capture): boolean {
    return c.epoch === this.epoch && !c.overlap && this.pending.size === (c.readOnly ? 0 : 1);
  }
  private resultEpoch(c: Capture): number {
    return !c.readOnly && this.epoch > c.epoch ? increment(this.epoch) : this.epoch;
  }
  private applyReceipt(record: Extract<LedgerRecord, { kind: "receipt" }>, entryId: string): void {
    const c = record.capture;
    if (
      record.epoch !== this.resultEpoch(c) ||
      !this.captureMatches(c, record.receipt) ||
      !this.intentMatches(c)
    )
      this.fail("Invalid or conflicting host receipt");
    if (record.receipt.eligible !== this.eligible(c))
      this.fail("Invalid receipt validation eligibility");
    this.pending.delete(c.id);
    this.index.set(c.id, { entryId, sequence: record.sequence });
    this.meta.receiptCount = increment(this.meta.receiptCount);
    this.recent.push(c.id);
    this.recent = this.recent.slice(-30);
    this.remember(record.receipt);
  }
  private applyUnknown(record: Extract<LedgerRecord, { kind: "close_unknown" }>): void {
    if (record.epoch !== increment(this.epoch) || new Set(record.ids).size !== record.ids.length)
      this.fail("Invalid unknown-capture closure");
    if (record.resultGap) {
      if (record.ids.length !== 1) this.fail("Invalid unmatched-result barrier");
      for (const id of record.ids) if (!this.pending.has(id)) this.closed.add(id);
      return;
    }
    if (record.ids.length !== this.pending.size || record.ids.some((id) => !this.pending.has(id)))
      this.fail("Invalid unknown-capture closure");
    for (const id of record.ids) {
      this.pending.delete(id);
      this.closed.add(id);
    }
  }
  prepareToolCapture(
    event: ToolCallEvent,
    reviews: HostReceipt["reviews"],
    readOnly: boolean,
  ): void {
    this.syncBranch();
    const id = `tool:${event.toolCallId}`;
    if (this.index.has(id)) return;
    if (this.closed.has(id) || this.calls.has(id)) this.fail("Conflicting or closed tool capture");
    const capture: Capture = {
      id,
      tool: event.toolName,
      epoch: readOnly ? this.epoch : increment(this.epoch),
      reviews: structuredClone(reviews),
      overlap: this.pending.size > 0,
      readOnly,
    };
    if (!readOnly)
      this.append({ ...this.base(capture.epoch), kind: "intent", capture } as Omit<
        LedgerRecord,
        "hash"
      >);
    this.calls.set(id, capture);
  }
  commitToolReceipt(event: ToolResultEvent): HostReceipt {
    this.syncBranch();
    const id = `tool:${event.toolCallId}`;
    const resultDigest = digest({
      input: event.input,
      content: event.content,
      structured: event.structuredContent,
    });
    if (this.index.has(id)) {
      const original = this.readReceipts([id])[0] as HostReceipt;
      if (
        original.digest !== resultDigest ||
        original.ok !== !event.isError ||
        original.tool !== event.toolName
      )
        return this.fail("Conflicting duplicate host receipt");
      return original;
    }
    const capture = this.calls.get(id);
    if (!capture || capture.tool !== event.toolName) {
      this.append({
        ...this.base(increment(this.epoch)),
        kind: "close_unknown",
        ids: [id],
        resultGap: true,
      } as Omit<LedgerRecord, "hash">);
      throw new Error(
        "Unmatched or late host result; tool may have executed. Fresh validation is required; no automatic replay",
      );
    }
    const eligible =
      capture.epoch === this.epoch &&
      !capture.overlap &&
      this.pending.size === (capture.readOnly ? 0 : 1);
    const receipt: HostReceipt = {
      id,
      tool: event.toolName,
      taskIds: capture.reviews.map((r) => r.taskId),
      reviews: capture.reviews,
      epoch: capture.epoch,
      ok: !event.isError,
      exitCode: exitCode(event),
      digest: resultDigest,
      input: redactedJSON(event.input).slice(0, 2000),
      output: redact(event.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n")),
      eligible,
    };
    if (!Check(ReceiptSchema, receipt)) return this.fail("Invalid bounded host receipt");
    const epoch =
      !capture.readOnly && this.epoch > capture.epoch ? increment(this.epoch) : this.epoch;
    this.append({ ...this.base(epoch), kind: "receipt", receipt, capture } as Omit<
      LedgerRecord,
      "hash"
    >);
    this.calls.delete(id);
    return structuredClone(receipt);
  }
  closeUnknown(): void {
    this.syncBranch();
    if (this.pending.size) {
      this.append({
        ...this.base(increment(this.epoch)),
        kind: "close_unknown",
        ids: [...this.pending.keys()],
      } as Omit<LedgerRecord, "hash">);
    }
    this.calls.clear();
  }
  private remember(receipt: HostReceipt): void {
    const old = this.cache.get(receipt.id);
    if (old) {
      this.bytes -= old.bytes;
      this.cache.delete(receipt.id);
    }
    const bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
    if (bytes <= this.limits.maxBytes) {
      this.cache.set(receipt.id, { receipt: structuredClone(receipt), bytes });
      this.bytes += bytes;
    }
    this.evict();
  }
  private evict(): void {
    while (this.cache.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      const [id, item] = this.cache.entries().next().value as [string, CacheItem];
      this.bytes -= item.bytes;
      this.cache.delete(id);
    }
  }
  readReceipts(ids: readonly string[] = [], recent = 0): HostReceipt[] {
    this.syncBranch();
    const selected = new Set([...ids, ...this.recent.slice(-recent || this.recent.length)]);
    if (!recent) {
      selected.clear();
      for (const id of ids) selected.add(id);
    }
    const locations = [...selected].flatMap((id) => {
      const loc = this.index.get(id);
      return loc ? [{ id, loc }] : [];
    });
    locations.sort((a, b) => a.loc.sequence - b.loc.sequence);
    return locations.map(({ id, loc }) => {
      const cached = this.cache.get(id);
      if (cached) {
        this.cache.delete(id);
        this.cache.set(id, cached);
        return structuredClone(cached.receipt);
      }
      const receipt = this.archivedReceipt(id, loc);
      this.remember(receipt);
      return structuredClone(receipt);
    });
  }
  private ledgerReceipt(record: unknown): HostReceipt {
    if (
      !Check(RecordSchema, record) ||
      record.kind !== "receipt" ||
      recordHash(record) !== record.hash ||
      record.sessionId !== this.sessionId ||
      record.goalId !== this.meta.goalId
    )
      return this.fail("Changed archived receipt record");
    return record.receipt;
  }
  private archivedReceipt(id: string, loc: Location): HostReceipt {
    const entry = this.ctx.sessionManager.getEntry(loc.entryId);
    if (!entry || entry.type !== "custom") return this.fail("Missing archived host receipt");
    let receipt: unknown;
    if (loc.v2) {
      try {
        receipt = this.v2Base?.read(id);
      } catch (error) {
        return this.fail(error instanceof Error ? error.message : "V2 archive lookup failed");
      }
    } else if (loc.legacyIndex !== undefined) {
      if (!this.meta.legacyBase || digest(entry.data) !== this.meta.legacyBase.digest)
        return this.fail("Changed legacy receipt anchor");
      receipt = (entry.data as { receipts: HostReceipt[] }).receipts[loc.legacyIndex];
    } else receipt = this.ledgerReceipt(entry.data);
    if (!Check(ReceiptSchema, receipt) || receipt.id !== id)
      return this.fail("Invalid archived host receipt");
    return receipt;
  }
  static fromV2(pi: ExtensionAPI, ctx: ExtensionContext, archive: V2Archive): ReceiptStore {
    const store = new ReceiptStore(
      pi,
      ctx,
      ctx.sessionManager.getSessionId(),
      `v2-${digest([ctx.sessionManager.getSessionId(), archive.cursor.id])}`,
      archive.epoch,
    );
    store.loadV2Archive(archive, true);
    return store;
  }
  private loadV2Archive(archive: V2Archive, readOnly: boolean): void {
    this.v2Base = archive;
    this.legacyView = readOnly;
    this.meta.legacyBase = { entryId: archive.entryId, digest: archive.digest, version: 2 };
    this.meta.receiptCount = archive.cursor.count;
    for (const [id, loc] of archive.locations)
      this.index.set(id, {
        entryId: loc.entryId,
        sequence: loc.sequence - archive.cursor.count - 1,
        v2: true,
      });
    this.recent = [...archive.locations.keys()].slice(-30);
  }
  promoteV2(): void {
    this.syncBranch();
    if (!this.legacyView || !this.v2Base) return;
    const anchor = this.ctx.sessionManager.getEntry(this.v2Base.entryId);
    if (anchor?.type !== "custom" || digest(anchor.data) !== this.v2Base.digest)
      this.fail("Changed v2 migration anchor");
    this.meta.goalId = `legacy-v2-${digest([this.sessionId, this.v2Base.entryId])}`;
    this.meta.epoch = increment(this.epoch);
    this.legacyView = false;
  }
  static migrate(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    legacy: { sessionId: string; epoch: number; receipts: HostReceipt[] },
    entryId: string,
  ): ReceiptStore {
    const entry = ctx.sessionManager.getBranch().find((e) => e.id === entryId);
    if (
      !entry ||
      entry.type !== "custom" ||
      entry.customType !== "continuous-tasks:supervisor" ||
      digest(entry.data) !== digest(legacy)
    )
      throw new Error("Legacy receipt migration anchor changed");
    const store = new ReceiptStore(
      pi,
      ctx,
      legacy.sessionId,
      `legacy-${digest([legacy.sessionId, entryId])}`,
      increment(legacy.epoch),
    );
    store.loadLegacy(entryId, digest(entry.data));
    return store;
  }
  private loadLegacy(entryId: string, expected: string): void {
    const entry = this.ctx.sessionManager.getEntry(entryId);
    if (
      !entry ||
      entry.type !== "custom" ||
      entry.customType !== "continuous-tasks:supervisor" ||
      digest(entry.data) !== expected
    )
      this.fail("Missing/changed legacy receipt anchor");
    const data = entry.data as {
      version?: number;
      sessionId?: string;
      epoch?: number;
      receipts?: unknown;
    };
    if (
      data.version !== 1 ||
      data.sessionId !== this.sessionId ||
      !Array.isArray(data.receipts) ||
      data.receipts.length > 500
    )
      this.fail("Invalid legacy receipt base");
    this.meta.legacyBase = { entryId, digest: expected };
    this.meta.receiptCount = data.receipts.length;
    const receipts = data.receipts;
    receipts.forEach((receipt: unknown, index: number) => {
      if (!Check(ReceiptSchema, receipt) || this.index.has(receipt.id))
        this.fail("Invalid/duplicate legacy receipt");
      this.index.set(receipt.id, {
        entryId,
        sequence: index - receipts.length,
        legacyIndex: index,
      });
      this.recent.push(receipt.id);
      this.recent = this.recent.slice(-30);
      this.remember(receipt);
    });
  }
  private initialiseCheckpoint(meta: ReceiptLedger, available: Set<string>): void {
    if (meta.sequence !== 0 || meta.head !== null || meta.pending.length)
      this.fail("Receipt goal must start with an empty ledger head");
    if (meta.legacyBase) {
      const base = meta.legacyBase;
      if (base.version === 2) {
        if (
          !available.has(base.entryId) ||
          !this.resolveV2 ||
          meta.goalId !== `legacy-v2-${digest([this.sessionId, base.entryId])}`
        )
          return this.fail("Invalid v2 legacy goal/anchor");
        const archive = this.resolveV2(base.entryId, base.digest);
        this.loadV2Archive(archive, false);
        this.meta.epoch = increment(archive.epoch);
        return;
      }
      if (meta.goalId !== `legacy-${digest([this.sessionId, base.entryId])}`)
        this.fail("Invalid legacy goal identity");
      if (!available.has(base.entryId)) this.fail("Foreign legacy receipt anchor");
      this.loadLegacy(base.entryId, base.digest);
      const anchor = this.ctx.sessionManager.getEntry(base.entryId);
      if (anchor?.type !== "custom") return this.fail("Missing legacy checkpoint");
      this.meta.epoch = increment((anchor.data as { epoch: number }).epoch);
    }
  }
  private restoreCheckpoint(
    data: { epoch?: number; receiptLedger?: ReceiptLedger },
    available: Set<string>,
    started: boolean,
  ): void {
    const meta = data.receiptLedger;
    if (!Check(ReceiptLedgerSchema, meta)) return this.fail("Invalid receipt checkpoint");
    if (!started) this.initialiseCheckpoint(meta, available);
    if (digest(this.checkpoint()) !== digest(meta) || data.epoch !== this.epoch)
      this.fail("Receipt checkpoint does not match its ledger head/epoch/pending captures");
  }
  static restore(
    pi: ExtensionAPI | undefined,
    ctx: ExtensionContext,
    metadata: ReceiptLedger,
    supervisorEntry = "continuous-tasks:supervisor",
    resolveV2?: V2Resolver,
  ): ReceiptStore {
    const branch = ctx.sessionManager.getBranch();
    const store = new ReceiptStore(pi, ctx, ctx.sessionManager.getSessionId(), metadata.goalId);
    store.resolveV2 = resolveV2;
    let started = false;
    const available = new Set(branch.map((entry) => entry.id));
    for (const entry of branch) {
      if (entry.type !== "custom") continue;
      if (entry.customType === RECEIPT_LEDGER_ENTRY) {
        const record = entry.data;
        if (!Check(RecordSchema, record)) return store.fail("Invalid receipt ledger record");
        if (record.sessionId !== store.sessionId || record.goalId !== metadata.goalId) continue;
        if (!started) store.fail("Receipt ledger has no goal checkpoint");
        store.apply(record, entry.id);
      } else if (entry.customType === supervisorEntry) {
        const data = entry.data as {
          version?: number;
          sessionId?: string;
          epoch?: number;
          receiptLedger?: ReceiptLedger;
        };
        if (
          data.version !== 3 ||
          data.sessionId !== store.sessionId ||
          data.receiptLedger?.goalId !== metadata.goalId
        )
          continue;
        store.restoreCheckpoint(data, available, started);
        started = true;
      }
    }
    if (!started) store.fail("Missing receipt goal checkpoint");
    store.resolveV2 = undefined;
    return store;
  }
}
