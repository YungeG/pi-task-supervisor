import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { inspectRestorableSession } from "./human-control";
import { JournalReadError, type SessionJournal } from "./human-journal";
import { currentRuntime } from "./runtime";

export interface RestoreJournalRead {
  inspect(ctx: ExtensionContext): SessionJournal | undefined;
  require(ctx: ExtensionContext): SessionJournal;
  prefix(ctx: ExtensionContext, entryId: string): RestoreJournalRead;
}
export interface RestoreJournalCycle {
  readonly read: RestoreJournalRead;
  installGoal(ctx: ExtensionContext, install: () => void): void;
  afterConfirmedAppend(ctx: ExtensionContext, expectedLeaf: string): void;
  runSupervisorRestore(ctx: ExtensionContext, restore: () => void): void;
  assertCurrent(ctx: ExtensionContext): void;
  close(): void;
}
export class RestoreReadInvalidated extends Error {
  constructor(readonly reason: "identity" | "epoch" | "leaf" | "source" | "closed" | "projection") {
    super(`Restore read invalidated: ${reason}`);
    this.name = "RestoreReadInvalidated";
  }
}
interface Stamp {
  kind: "memory" | "missing" | "file";
  value: string;
  identity?: string;
  bytes?: bigint;
}
function stamp(path: string | undefined): Stamp {
  if (!path) return { kind: "memory", value: "memory" };
  try {
    const s = lstatSync(path, { bigint: true });
    const identity = `${s.dev}:${s.ino}:${s.isFile()}`;
    return {
      kind: "file",
      identity,
      bytes: s.size,
      value: `${identity}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { kind: "missing", value: "missing" };
    throw new JournalReadError("JOURNAL_UNAVAILABLE");
  }
}
function synchronous(operation: () => void): void {
  const invoke: () => unknown = operation;
  const value = invoke();
  if (value && typeof value === "object" && "then" in value)
    throw new RestoreReadInvalidated("projection");
}

class Restoration implements RestoreJournalCycle {
  readonly read: RestoreJournalRead;
  private readonly runtime = currentRuntime();
  private readonly manager: ExtensionContext["sessionManager"];
  private readonly sessionId: string;
  private readonly path: string | undefined;
  private leaf: string | null;
  private epoch = this.runtime.goalEpoch;
  private source: Stamp;
  private revision = 0;
  private closed = false;
  private journal: SessionJournal | undefined;

  constructor(private readonly ctx: ExtensionContext) {
    this.manager = ctx.sessionManager;
    this.sessionId = this.manager.getSessionId();
    this.path = this.manager.getSessionFile();
    this.leaf = this.manager.getLeafId();
    this.source = stamp(this.path);
    this.load();
    this.read = this.makeRead(ctx);
  }
  private fail(reason: RestoreReadInvalidated["reason"]): never {
    throw new RestoreReadInvalidated(reason);
  }
  private identity(): void {
    if (this.closed) this.fail("closed");
    if (
      currentRuntime() !== this.runtime ||
      this.ctx.sessionManager !== this.manager ||
      this.manager.getSessionId() !== this.sessionId ||
      this.manager.getSessionFile() !== this.path
    )
      this.fail("identity");
    if (this.runtime.goalEpoch !== this.epoch) this.fail("epoch");
  }
  private current(): void {
    this.identity();
    if (this.manager.getLeafId() !== this.leaf) this.fail("leaf");
    if (stamp(this.path).value !== this.source.value) this.fail("source");
  }
  private load(): void {
    const before = stamp(this.path);
    let value: SessionJournal | undefined;
    try {
      value = inspectRestorableSession(this.ctx);
    } catch (error) {
      this.identity();
      if (this.manager.getLeafId() !== this.leaf) this.fail("leaf");
      if (stamp(this.path).value !== before.value) this.fail("source");
      throw error;
    }
    this.identity();
    if (this.manager.getLeafId() !== this.leaf) this.fail("leaf");
    const after = stamp(this.path);
    if (before.value !== after.value) this.fail("source");
    this.source = after;
    this.journal = value;
  }
  private makeRead(
    bound: ExtensionContext,
    visible?: SessionJournal,
    atRevision?: number,
  ): RestoreJournalRead {
    const manager = bound.sessionManager;
    const leaf = atRevision === undefined ? undefined : manager.getLeafId();
    const inspect = (context: ExtensionContext) => {
      this.current();
      if (
        context !== bound ||
        context.sessionManager !== manager ||
        manager.getSessionId() !== this.sessionId ||
        manager.getSessionFile() !== this.path
      )
        this.fail("identity");
      if (
        atRevision !== undefined &&
        (this.revision !== atRevision || manager.getLeafId() !== leaf)
      )
        this.fail("leaf");
      if (
        visible &&
        JSON.stringify(manager.getBranch().map((node) => node.id)) !==
          JSON.stringify(visible.branch.map((node) => node.id))
      )
        this.fail("leaf");
      return atRevision === undefined ? this.journal : visible;
    };
    return {
      inspect,
      require(context) {
        const value = inspect(context);
        if (!value) throw new JournalReadError("JOURNAL_UNAVAILABLE");
        return value;
      },
      prefix: (context, entryId) => {
        const value = inspect(bound);
        if (!value) throw new JournalReadError("JOURNAL_UNAVAILABLE");
        const index = value.branch.findIndex((node) => node.id === entryId);
        if (index < 0) throw new JournalReadError("JOURNAL_BRANCH_INVALID");
        const prefixManager = context.sessionManager;
        const branch = value.branch.slice(0, index + 1);
        if (
          Object.getPrototypeOf(prefixManager) !== manager ||
          prefixManager.getSessionId() !== this.sessionId ||
          prefixManager.getSessionFile() !== this.path ||
          prefixManager.getLeafId() !== entryId ||
          JSON.stringify(prefixManager.getBranch().map((node) => node.id)) !==
            JSON.stringify(branch.map((node) => node.id))
        )
          this.fail("identity");
        return this.makeRead(
          context,
          {
            sessionId: this.sessionId,
            branch,
            nodes: new Map(branch.map((node) => [node.id, node])),
          },
          this.revision,
        );
      },
    };
  }
  assertCurrent(context: ExtensionContext): void {
    if (context !== this.ctx) this.fail("identity");
    this.current();
  }
  installGoal(context: ExtensionContext, install: () => void): void {
    this.assertCurrent(context);
    const before = this.epoch;
    try {
      synchronous(install);
      if (
        currentRuntime() !== this.runtime ||
        this.ctx.sessionManager !== this.manager ||
        this.manager.getSessionId() !== this.sessionId ||
        this.manager.getSessionFile() !== this.path
      )
        this.fail("identity");
      if (this.runtime.goalEpoch !== before + 1)
        this.fail(this.runtime.goalEpoch === before ? "projection" : "epoch");
      if (this.manager.getLeafId() !== this.leaf) this.fail("leaf");
      if (stamp(this.path).value !== this.source.value) this.fail("source");
      this.epoch = this.runtime.goalEpoch;
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }
  private validateAppend(context: ExtensionContext, expectedLeaf: string): void {
    this.identity();
    if (context !== this.ctx || this.manager.getLeafId() !== expectedLeaf) this.fail("identity");
    if (expectedLeaf === this.leaf) this.fail("leaf");
    const branch = this.manager.getBranch();
    if (
      branch.at(-1)?.id !== expectedLeaf ||
      (this.leaf !== null && !branch.some((node) => node.id === this.leaf))
    )
      this.fail("leaf");
    const next = stamp(this.path);
    if (
      this.source.kind === "file" &&
      (next.identity !== this.source.identity ||
        next.bytes === undefined ||
        this.source.bytes === undefined ||
        next.bytes <= this.source.bytes)
    )
      this.fail("source");
    if (this.source.kind === "memory" && next.kind !== "memory") this.fail("source");
  }
  afterConfirmedAppend(context: ExtensionContext, expectedLeaf: string): void {
    try {
      this.validateAppend(context, expectedLeaf);
      this.leaf = expectedLeaf;
      this.revision++;
      this.load();
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }
  runSupervisorRestore(context: ExtensionContext, restore: () => void): void {
    this.assertCurrent(context);
    try {
      synchronous(restore);
      this.identity();
      const next = this.manager.getLeafId();
      if (next !== this.leaf) {
        if (next === null) this.fail("leaf");
        this.afterConfirmedAppend(context, next);
      } else this.current();
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }
  close(): void {
    this.closed = true;
    this.journal = undefined;
  }
}

/** Internal, restore-scoped read lease. Never an authorization or execution-admission cache. */
export function beginRestoreJournal(ctx: ExtensionContext): RestoreJournalCycle {
  return new Restoration(ctx);
}
