import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ReceiptSchema, digest, type HostReceipt } from "./receipt-store";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const natural = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const V2_RECEIPTS_ENTRY = "continuous-tasks:supervisor-receipts";
export const V2CursorSchema = Type.Object({
  id: text(100),
  count: natural,
  head: Type.Union([text(64), Type.Null()]),
});
export type V2Cursor = Static<typeof V2CursorSchema>;
const BatchSchema = Type.Object({
  version: Type.Literal(1),
  sessionId: text(200),
  journalId: text(100),
  previousHead: Type.Union([text(64), Type.Null()]),
  first: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  receipts: Type.Array(ReceiptSchema, { minItems: 1, maxItems: 500 }),
  head: text(64),
});
type Batch = Static<typeof BatchSchema>;
export interface V2Location {
  entryId: string;
  slot: number;
  sequence: number;
  batchHead: string;
}
export interface V2Archive {
  entryId: string;
  digest: string;
  epoch: number;
  cursor: V2Cursor;
  locations: ReadonlyMap<string, V2Location>;
  read: (id: string) => HostReceipt | undefined;
}
type Journal = {
  count: number;
  head: string | null;
  epoch: number;
  identity?: string;
  locations: Map<string, V2Location>;
};
type Header = { entryId: string; digest: string; epoch: number; cursor: V2Cursor };

function validBatch(data: unknown): data is Batch {
  if (!Check(BatchSchema, data)) return false;
  const { head, ...payload } = data;
  return digest(payload) === head;
}

function readArchive(
  ctx: ExtensionContext,
  header: Header,
  journal: Journal,
  id: string,
): HostReceipt | undefined {
  const anchor = ctx.sessionManager.getEntry(header.entryId);
  if (anchor?.type !== "custom" || digest(anchor.data) !== header.digest)
    throw new Error("Changed v2 archive checkpoint");
  const location = journal.locations.get(id);
  if (!location) return undefined;
  const entry = ctx.sessionManager.getEntry(location.entryId);
  if (entry?.type !== "custom" || entry.customType !== V2_RECEIPTS_ENTRY)
    throw new Error("Missing v2 archive batch");
  const batch = entry.data;
  if (
    !validBatch(batch) ||
    batch.sessionId !== ctx.sessionManager.getSessionId() ||
    batch.journalId !== header.cursor.id ||
    batch.head !== location.batchHead
  )
    throw new Error("Changed v2 archive batch");
  const receipt = batch.receipts[location.slot];
  if (!receipt || receipt.id !== id || batch.first + location.slot !== location.sequence)
    throw new Error("Changed v2 receipt position");
  return structuredClone(receipt);
}

/** The installed v2 wire contract. Stores locators, never a second raw receipt history. */
export class V2ReceiptHistory {
  private readonly journals = new Map<string, Journal>();
  private readonly headers = new Map<string, Header>();
  private readonly uncommitted = new Set<string>();
  constructor(private readonly ctx: ExtensionContext) {}
  private journal(id: string): Journal {
    let journal = this.journals.get(id);
    if (!journal) {
      journal = { count: 0, head: null, epoch: 0, locations: new Map() };
      this.journals.set(id, journal);
    }
    return journal;
  }
  observeBatch(entry: SessionEntry): void {
    if (entry.type !== "custom" || entry.customType !== V2_RECEIPTS_ENTRY)
      throw new Error("Invalid v2 batch entry type");
    const data = entry.data;
    if (!validBatch(data)) throw new Error("Invalid v2 receipt batch/schema/digest");
    if (data.sessionId !== this.ctx.sessionManager.getSessionId()) return;
    const journal = this.journal(data.journalId);
    if (data.first !== journal.count + 1 || data.previousHead !== journal.head)
      throw new Error("Invalid v2 receipt batch order");
    for (const [slot, receipt] of data.receipts.entries()) {
      if (journal.locations.has(receipt.id)) throw new Error("Duplicate v2 receipt identity");
      journal.count++;
      if (!Number.isSafeInteger(journal.count)) throw new Error("V2 receipt count overflow");
      journal.epoch = Math.max(journal.epoch, receipt.epoch);
      journal.locations.set(receipt.id, {
        entryId: entry.id,
        slot,
        sequence: journal.count,
        batchHead: data.head,
      });
    }
    journal.head = data.head;
    this.uncommitted.add(data.journalId);
  }
  acknowledge(entryId: string, cursor: V2Cursor, epoch: number, identity: string): void {
    if (!Check(V2CursorSchema, cursor) || !Number.isSafeInteger(epoch) || epoch < 0)
      throw new Error("Invalid v2 checkpoint cursor/epoch");
    const journal = this.journal(cursor.id);
    if (journal.count !== cursor.count || journal.head !== cursor.head || epoch < journal.epoch)
      throw new Error("Incomplete or stale v2 checkpoint");
    if (journal.identity !== undefined && journal.identity !== identity)
      throw new Error("V2 journal changed goal scope");
    journal.identity = identity;
    journal.epoch = epoch;
    const entry = this.ctx.sessionManager.getEntry(entryId);
    if (entry?.type !== "custom" || entry.customType !== "continuous-tasks:supervisor")
      throw new Error("Missing v2 checkpoint identity");
    this.headers.set(entryId, {
      entryId,
      digest: digest(entry.data),
      epoch,
      cursor: structuredClone(cursor),
    });
    this.uncommitted.delete(cursor.id);
  }
  finish(): void {
    if (this.uncommitted.size)
      throw new Error("Uncommitted v2 receipt journal needs inspection; no automatic replay");
  }
  archive(entryId: string, expectedDigest?: string): V2Archive {
    this.finish();
    const header = this.headers.get(entryId);
    if (!header || (expectedDigest !== undefined && expectedDigest !== header.digest))
      throw new Error("Missing/changed v2 checkpoint anchor");
    const journal = this.journal(header.cursor.id);
    if (header.cursor.count !== journal.count || header.cursor.head !== journal.head)
      throw new Error("Stale v2 migration anchor");
    const ctx = this.ctx;
    return {
      ...structuredClone(header),
      locations: journal.locations,
      read: (id) => readArchive(ctx, header, journal, id),
    };
  }
}
