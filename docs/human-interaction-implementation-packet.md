# Human Interaction r2 — Recovery / staged implementation packet (historical input)

Current integration: the user separately approved fixed receipt integration commit `d1199c24fa70941ad3a9244594fcf4ecd24cb7c9` as the new isolated base. Its combined candidate has passed the current checks in [`CANARY.md`](../CANARY.md); original-directory write-back, staging, commits, publication, installation and business operations remain unauthorized. The detailed execution packet and final handoff are under `/home/ygguo/.pi/agent/worktrees-artifacts/pi-task-supervisor-human-interaction-r2-receipt-v3-20261016/`. All older worktree identities and results below describe the preserved r2 input, not the combined candidate.

Historical status: **Implementation and required old-pin checks complete; independent review P1 corrected and narrowly re-reviewed OK. Concurrent-source integration had not yet been authorized or verified at that checkpoint.**

This records the controlling agent's implementation choices after two failed readiness-child attempts. A failed child is not accepted evidence. The user approved implementation in an isolated worktree, not commit/merge/install or business-session actions.

## Authority and protected state

- C1: reviewed r2 design, §§1–10, immutable reviewed SHA `62b1c6a4ed0c67784999a308b4c1f7c54f0c9032d290c5ba53b5724fd347f8b7`.
- C2: user explicitly approved implementation after that review; current worktree only.
- S1: real Pi 1.1 loader parses a complete trailing JSON without LF and appends LF. Parent independently reproduced byte-identical post-load journals from originally different files: `lf-boundary-smoke.mjs/result.json` in the artifact directory.
- S2: parent independently checked a derived readback-witness protocol: unsealed orphan remains unconfirmed, sealed pair survives missing cache, corrupt digest rejected, malformed tail rejected. `readback-witness-smoke.mjs/result.json` is synthetic feasibility evidence, not UI authenticity or feature acceptance.
- S3: public extension context exposes a readonly session manager. In-memory branch/leaf is not disk acknowledgment.

Source root is read-only. Worktree: `/home/ygguo/.pi/agent/worktrees/pi-task-supervisor-human-interaction-r2-20261014`, branch `fix/human-interaction-r2-20261014`, HEAD `9933feaee451046168fb1384b7276fe1ad78c787` plus an immutable read-only prerequisite snapshot. Artifact directory: `/home/ygguo/.pi/agent/worktrees-artifacts/pi-task-supervisor-human-interaction-r2-20261014`.

Imported baseline: 81 files, 1,057,504 bytes. Manifest/tar are authoritative for the imported bytes; they are not accepted implementations. Original workspace has a concurrent writer. Dependency copies are isolated, not shared symlinks. Baseline typecheck and 70 focused preflight/workflow tests passed. Parent subsequently observed 800 whole-suite tests passing, then full typecheck/lint and 113 affected tests after final validator cleanup. These are not native-path or whole-feature acceptance.

## Why bounded vertical slices

The attempted whole packet mixed source admission, dialog timing, owner projection and filesystem recovery and twice produced no deliverable (30m and 10m timeouts). Split by independently verifiable outcomes, not arbitrary files. One active writer: controlling agent. No more automatic child retries.

```text
N1 disk/readback proof contract -> N2 native producer + board decision -> N3 preflight/control + final acceptance
```

- N1 produces a strict read-only journal inspection and proof-query result. It never approves, changes workflow state, repairs a file, regenerates witnesses, or schedules a run.
- N2 consumes N1's frozen identity/closure types; produces real TUI board interaction and typed legacy replacement with source admission. Its exact carrier/capability and projection interfaces must be frozen before writing those callers.
- N3 consumes N2 and existing preflight owner contracts; integrates separate approval/start, recovery projections and the full V1–V18 validation. Whole-feature completion requires all nodes and independent review.

## Final pinned-source validation

Controlling agent completed N1/N2/N3, owner cache-only repair, immutable restoration, explicit continuation scope, and fail-closed physical ancestry before any no-owner fast path. Independent broad review found one P1; actual SDK C-failure/tool-result/reopen regression was red then green and targeted re-review closed the finding. Final `npm run check` passed: 933 tests/45 files, 90.18% branches (unchanged 90% gate), full typecheck/lint/format and eight SDK/faux smoke arms. Separate actual offline CLI/PTY production-factory/tool/command pilots passed on Pi 1.1/1.2 and ordinary SDK custom-TUI rejection passed in a real double TTY. Synthetic keystrokes/source-boundary simulations do not prove human identity or live business behavior.

Evidence and final feature-only delta/handoff are under `/home/ygguo/.pi/agent/worktrees-artifacts/pi-task-supervisor-human-interaction-r2-20261014/`. Concurrent source receipt-journal v2 and related command/smoke changes were only observed, not imported. This completed pin is not accepted as compatible with that new format; reconcile the final stable source contract before merge/install. No source working files, global settings or business sessions were changed.

## N3 accepted execution contract

Controlling agent accepted the bounded preflight packet at `/home/ygguo/.pi/agent/worktrees-artifacts/pi-task-supervisor-human-interaction-r2-20261014/preflight-native-packet.accepted.md`. It freezes exact native/legacy schemas, permission replacement, source/callback capabilities, independent first-start A/B/S/C ordering, missing-projection restoration/repair, downgrade handling, write set and sentinel. The assigned strong worker is the sole worktree writer during that implementation; parent reviews and independently validates afterwards. No source-decision authority is delegated beyond that packet, and no commit/install/business-session action is authorized. Original N1/N2 interfaces remain fixed except explicitly listed frame-schema/start-kind extensions.

## N1 Full packet — exact seam

Write set: `src/human-journal.ts`, `src/__tests__/human-journal.test.ts`, this packet. Existing workflow, owner, runtime, tool, command and provider files remain unchanged in N1.

Symbols:

| Symbol | Contract | Consumer |
| --- | --- | --- |
| `ReadbackFrame` | version 1; owner board/preflight; sessionId; requestId; presentationId; scopeDigest; baseSnapshotEntryId; baseSnapshotDigest | Future live owner publisher, witness and query |
| `ReadbackWitness` | version 1; controlEntryId; controlDigest; identical frame | Same owner derived proof; no independent permission or outcome |
| `SessionJournalView` | path/sessionId/leafId captured from real readonly session context | `inspectSessionJournal` |
| `JournalNode` | persisted id/parent/type/customType, full entry digest; data only for known owner/proof/snapshot types | Strict file index |
| `SessionJournal` | immutable file index and verified active branch | Proof query, future owner projection |
| `JournalReadError` | stable code; no raw journal contents in error | UI/owner callers must hold on errors |
| `journalDigest(value)` | SHA256 of JSON.stringify(value), no secret logging | Publisher and verifier identity |
| `inspectSessionJournal(view, limits?)` | readonly, strict complete-LF UTF8 JSONL, correct header/session, unique IDs, bounded regular file; active file parent chain for leaf; no native repair | Future publisher/recovery |
| `findReadbackProof(journal, owner, requestId)` | discriminated missing / unconfirmed / confirmed; duplicate/conflicting control or witness fails closed | Future owner projector validates semantic action separately |

Limits: 256 MiB file, 8 MiB physical line, 200,000 entries; 64 KiB streaming read chunks. Limits may be reduced in tests. Whole malformed file/tail fails closed; no silent line skipping. Reject symlink file, missing/nonregular file, unsupported header, wrong session, duplicate IDs, absent active leaf, absent/cyclic parent chain. Parent chain may contain multiple roots, but only current leaf's ancestry can prove an event. Never inspect abandoned branches as current permission.

## N1 identities and domain boundaries

A live owner control has `data.humanInteraction: ReadbackFrame`. Allowed owner prefixes: board `continuous-tasks:event` with `type: resolve_decision`; preflight `continuous-tasks:preflight-control`. The control's owner-specific action is **not** authenticated or approved by this reader; future owner code must validate its schema, captured real native responder, exact scope and state transition.

Witness custom type: `continuous-tasks:human-readback`; data contains only `ReadbackWitness`. It is derived proof, not another permission ledger. It must be on the current branch, descend from the control and bind its complete persisted entry digest. Its frame must be exactly equal. Base snapshot must be an earlier ancestor, have the proper owner snapshot type and match the bound data digest.

The only future production witness generator may run during the original live native response, after raw control LF/content/identity/ancestry readback succeeded. Recovery may read proof, never manufacture it for a lone control. This prerequisite is a mandatory N2/N3 publisher invariant; N1 read-only parsing alone cannot certify a producer.

A = sole owner control; B = its derived readback witness; C = ordinary state cache:

1. Control-only record is unconfirmed for recovery even when native loader later supplies LF.
2. A+B with verified closure provides disk/readback evidence; does not by itself grant permission or run anything.
3. B's complete body may remain useful after native normalization of B's own trailing LF because only a trusted live publisher can generate B after original A readback. Missing B has no such evidence.
4. A+B then C fails: future owner code retains original result, holds execution and repairs projection using exact validated owner semantics; no reapproval of a known confirmed result.
5. An unconfirmed candidate cannot be called approved; any fresh human reconfirmation must be explicit, with new logical identity and supersedes relation. Ordinary resolve/resume/recover cannot certify the old candidate.

The proof query must not treat an arbitrary `human: true`, old snapshot or entry label as B. It returns evidence only. This is not an OS sandbox or an authentication service.

## N1 failure precedence / sentinel

1. Unsafe/unavailable file or resource limit -> `JOURNAL_UNAVAILABLE` / `JOURNAL_LIMIT`.
2. Incomplete LF, invalid UTF8/JSON/header/session/duplicate ID -> `JOURNAL_INVALID`.
3. Missing/cyclic active file ancestry -> `JOURNAL_BRANCH_INVALID`.
4. Unknown/malformed current human frame/witness -> `READBACK_INVALID`.
5. Conflicting outcomes/control identities/witness identities -> `READBACK_CONFLICT`.
6. No candidate -> `missing`; candidate without valid witness -> `unconfirmed` (no permission).
7. Complete matching original control/base/witness closure -> `confirmed` (readback evidence only).

First focused sentinel: `npm test -- src/__tests__/human-journal.test.ts`. It must fail for treating a normalized orphan as confirmed and for using a foreign branch witness. Cover sealed missing-cache recovery evidence, digest/frame/base mismatch, duplicate/conflicting control, missing LF, invalid JSON/UTF8/header, memory leaf absent from disk, symlink/nonregular/missing file, limits and cyclic ancestry. Synthetic fixtures are created under owned temporary directories; never mutate live sessions.

Run baseline-adjacent typecheck after focused green. Full suite is deferred to complete-feature fan-in, not repeated for every fixture edit. N1 may be independently validated but is not the requested user-visible feature's completion.

## Remaining N2/N3 freeze requirements

- Actual trusted local CLI producer, opaque answer capability and stale/cancel guards; ordinary SDK/RPC/chat cannot manufacture a receipt.
- Structured kind/scope/prohibitions and choice/information rules; only replacement decision metadata permitted through taskGate and tool's own guard while waiting; no bind/clear/execution exemption.
- Exact owner control schemas, live A->readback->B->readback->C order, and projection from immutable base. Strict post-failure handling of in-memory phantom leaf; missing C and old/new journal version behavior.
- Submission eligibility vs independent fault/budget execution eligibility; negative outcome retains waiting, changes use new logical identity.
- Preflight permission replacement semantics and no-ID separate start; default exactly declared required set, no optional rights inferred.
- One legal native tool-result carrier or one idle continuation, never both; no agent_settled scheduling; unknown execution dispatch stays held.
- V1–V18 real paths, whole static/coverage/native faux-provider gates, independent review, original-tree protection and own-delta identity against imported baseline.

These pending contracts do not revoke the user's approval; they prevent unsafe caller code from being written before its seam is defined. No publication, installation, business-session recovery or unrelated evidence-ref relaxation is authorized by this packet.

## N1 accepted checks

Controlling agent reviewed the bounded Spark diffs and independently reran 27 journal tests, the adjacent baseline (97 tests total), typecheck, and the two new files' eslint/prettier checks. All passed. This is not UI, state projection, full coverage or feature acceptance. Imported baseline files remained unchanged.

## N2a exact native-transport slice — READY

Source contract was independently reviewed in `native-source-seam-review.md`: OK with notes. Trusted host assumption, not human identity authentication. No new model-callable tool or permission writer is added in this slice.

Write set only: `src/human-ui.ts`, `src/__tests__/human-ui.test.ts`, owned synthetic CLI/SDK smoke fixture if needed. No command, owner, state or runtime wiring until N2b is frozen.

- `trustedCliRoots(): string[]`: derive only real, verified `@earendil-works/pi-coding-agent` installations from (1) this module's actual package resolution and (2) current Node execPath's npm installation prefix. Verify package name and canonical root. Do not scan arbitrary argv ancestors or accept a suffix/fake package. Handle absent install as unsupported, not a default allow. Support full canonical `<root>/dist/cli.js` and `<root>/dist/bundle/cli.js`, not arbitrary script paths. Compiled/bun/custom hosts are outside this first route.
- `isTrustedLocalTui(ctx: ExtensionContext): boolean`: `ctx.mode === tui`, hasUI, both real process stdin/stdout are TTY, actual argv[1] realpath is an existing CLI entry under one of those trusted roots. No caller/config DTO supplies roots, tty, mode or `human=true`. Merely binding an SDK UI to tui cannot pass.
- `NativeQuestion`: frozen `frame: ReadbackFrame`, `kind: authorization|choice|information`, title/body, optional exact string options, optional information validator callback supplied only by trusted owner code. Body/frame are cloned before awaiting. No permission interpretation of choice/information.
- `NativeAnswer`: opaque object with readonly outcome approve|reject|answer, value and answeredAt. Real answers are recognized only by a private WeakMap; JSON copies/objects/lookalikes are invalid. Not a model-callable schema parameter.
- `requestNativeAnswer(ctx, question, isCurrent, signal?): Promise<NativeAnswer|undefined>`: deny unsupported source before UI call. Check session identity/current request and active branch before and after UI; signal abort or false isCurrent returns undefined without receipt. Display complete body through native UI and await actual select/input, no LLM and no dispatch. Authorization choices: defer, approve exactly displayed scope, reject. Choice maps only exact displayed options; information applies safety/validator. Unknown/invalid/cancel returns undefined. One outstanding question per real sessionManager object; release in finally; no repeating popup loop.
- `requireNativeAnswer(ctx, answer, expectedFrame): NativeAnswer`: check private identity, original sessionManager/session, unchanged frame binding, isCurrent and cancellation. Throw a fixed error on mismatch; no raw data in errors. No grant or state changes. Future publisher must call it before I/O and bind owner output to immutable request/result.

Tests go through this public transport seam, mocking only native UI and process/FS system boundaries where needed; explicitly describe positive mocked cases as mechanism simulation, not real human proof. Sentinel must demonstrate ordinary SDK script in double TTY is rejected despite tui/custom-UI returning approve, with no UI call or receipt. Also test RPC/print, no TTY, wrong CLI root, cancel, stale request/session/branch, aborted signal, unknown selection, DTO copy, frame mismatch and concurrent presentation. No `allowTests` or user-supplied trust flag in production.

N2a acceptance: focused tests, typecheck, its file lint/format plus the real double-TTY SDK negative smoke. Parent has now independently run 66 combined transport/journal tests, typecheck/lint, and the actual SDK custom-tui automatic-approve probe in a real double TTY: rejected before UI with zero receipt/approval. It fixed the root-walk termination, propagated the combined abort signal and checked branch ancestry instead of rejecting benign same-branch append. Positive production CLI still pending.

## N2b board owner contract — READY for implementation and focused validation

One writer is controlling agent. Exact board write set: board-human.ts, human-control.ts, decision-spec.ts, types.ts, schemas.ts, validation.ts, runtime.ts, tools.ts, events.ts, commands.ts, flow.ts, new board-human tests; no preflight approval logic in this slice.

The controlling agent has selected/started these exact interfaces:
- DecisionRecord optional spec (version1 authorization scope/prohibitions, choice, or information text/integer/date), response rejected and supersedes. Missing spec is legacy_unknown. Unknown/malformed spec must not deserialize as an active authorization. WorkflowGateParams accepts proposal metadata only; no human/source/approval field.
- decisionScope(decision) hashes complete immutable question/task/options/spec/supersedes. New typed IDs are UUIDs; replacement must name current decision ID and same task, and supply valid full spec.
- projectBoardAnswer(base,control) is pure: authorize approve clears only decision/workflow waiting, reject preserves waiting and marks rejected, choice must match captured options, information must match declared format. No task status/evidence/executionRef changes. Generation increments once; supervisor counters are untouched.
- answerBoardDecision(pi,ctx,signal?) captures real persisted base/frame, uses private native answer registry, validates same runtime epoch/request after await, publishes A->raw readback->B->raw readback then C. Returns {status, confirmed?}; confirmed binds the original DecisionRecord (including scope), outcome, submitted value, and control entry ID. The tool includes this payload in its one result; the idle command includes it in its one continuation. A session-bound derived runtime context cache is populated only from confirmed live/proven restored results and injected through before_agent_start, so answers saved under an independent hold are delivered when Main next legitimately runs. This cache grants nothing. Failure holds with visible journalFault; no dispatch from this function. Defer/unsupported/legacy never clear gate. Runtime humanAbort and humanEpoch cancel stale UI via the existing controller cancel path.
- Review corrections: recognized invalid/unknown/downgraded/non-monotonic board snapshots throw before any fallback and lifecycle restore catches them into a visible gate. Any exception during proposal persistence sets journalFault and cancels pending controls; it never leaves an open old runtime eligible for mutation.
- publishReadbackControl(pi,ctx,opaqueAnswer,frame,ownerBody) requires private native identity plus original request/frame/cancel qualification immediately before IO. Generic publisher owns bytes only; trusted board handler owns semantic body. It rejects prior control for same logical ID. No partial-control repair or witness creation from recovery.
- saveReadbackProjection re-queries actual A+B before C, never trusts a passed proof DTO alone. Snapshot/owner semantic body is derived by trusted owner reducer.
- Board completion correction: a confirmed A+B with C failure returns the original structured confirmed response plus projectionPending; the tool marks that result held/error, never drops the value or dispatches. Runtime boardRepair uses the same derived hint shape as preflightRepair (session/control/digest/fault/ownership), not authority. Explicit no-ID /task-supervisor repair-decision re-reads file/proof/base/semantics and latest board, writes only missing C, treats exact existing C as no-op, preserves the hint/fault on every failure and clears only its own unchanged projection fault. It never writes A/B, reapproves, enables scope, resets Supervisor counters or dispatches. This route precedes the blanket journalFault command refusal; idle/no pending messages still required.
- restoreBoardHuman(ctx,board) queries only current file branch, validates A/B/base/scope and pure projection; never dispatches. Unconfirmed A faults; missing C restores a confirmed derived view but keeps projection-pending fault, not ordinary recovery. Later legitimate greater-generation snapshots are not rolled back.
- workflow_gate initially persists the waiting proposal then presents native UI for a new structured request. Its normal native tool return carries the result; never continueNow there. A replacement proposal is metadata only and does not auto-prompt after legacy/denial, preventing nag loops.
- Both taskGate and tool's own guard allow only typed wait_for_decision superseding current same-task decision, when enabled and no journalFault. Bind/clear/execution/finished-task mutations have no exemption.
- Commands resolve(existing name/ID hint) and decide(no ID) both invoke same native handler; bare answer text never constitutes approval. Only idle command path may call continueNow after approved/answered, retaining all other gates.

Before acceptance add focused real-file/mocked-system-boundary tests for approve/reject/defer/info/choice, stale/cancel, owner semantic mismatch, original epoch/counter retention, legacy/supersedes exceptions, orphan/witness/cache recovery. Existing command tests that assumed any nonempty legacy answer could run must be explicitly updated to the reviewed safe contract, not disabled. Whole feature remains incomplete until preflight and final acceptance.

N2a acceptance: focused tests, typecheck, its file lint/format plus the real double-TTY SDK negative smoke. The positive real CLI and publisher/owner integration remain mandatory N2b/N3 checks; N2a passing cannot be called an approval feature. Source review checked Pi 1.1; the actual machine's 1.2 runtime compatibility remains to be verified in the native path.
