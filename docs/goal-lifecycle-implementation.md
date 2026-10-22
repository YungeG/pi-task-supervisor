# Goal lifecycle — Full implementation packet

Status: **READY for the user-authorized implementation, not accepted implementation**. One writer/integrator: Main. Worktree `goal-lifecycle`, branch `feat/supervisor-goal-lifecycle`, baseline `974b5ddca57f8c2bf62534a3b14b1a5f23c275ac`.

Authority: user “按照文档修复”; design SHA256 `76180f955f4d701ba89e7a9a61cd69913427bb75dd531dda5994cb85990eb499`; CONTEXT SHA256 `a1593b626c6ba8b07228b870f6cf798e51693cdd87c523f7005dd05d894f14e1`. The first review's BLOCK and revised P1-1 contract remain historical evidence, not independent acceptance of the revision. This scope does not authorize a new CLI reviewer, installation, reload, commit, merge, push, or target-session operations.

## Contract and outcome

- U1: Same Session, sequential GoalRuns; old history/unfinished task records/usage retained, never treated as fresh evidence.
- S1: Native archive-and-plan answer plus physical A/B/C before a new current selection. No hidden clear, quota renewal, replay, business permission or execution start.
- S2: P1-1 same-GoalRun explicit replan and unstarted stop; positive host/queue quiescence, immutable attempts, no fabricated Supervisor or revoke.
- S3: Legacy 1/2/3 and installed v2 archives retain their exact rules/preimages; reject unknown wire4; new checkpoint5/scoped carrier3/goal frame2 are strict and old readers refuse them.
- S4: All task/permission/evidence/callback/UI paths use current GoalRun selection. Fixed 100/40/20/3, 64000-byte packet, complexity15 and coverage90 stay unchanged.

Before: command → legacy single board/preflight/Supervisor → incomplete transition guards. After: command → lifecycle qualification/native commit owner → selected current scope → existing board/preflight/Supervisor owners. Current-owner adapters wrap stored carriers, never replace the real SessionManager for native admission.

## Selected schemas and identities

`goal-records.ts` owns strict wire5 tagged records and scoped carrier3. TypeBox unknown payload slots are not acceptance: the reader must validate board/preflight/Supervisor bodies with the existing owner validators before returning a usable state.

- Common checkpoint: version5, protocol=`goal-lifecycle-v1`, sessionId, kind. Kind is transition-control A, transition-committed C, or goal-state.
- A: transitionId, exact from-source refs/digests, deterministic new seed, optional exact superseded unconfirmed A ref, createdAt, GoalReadbackFrame2. The seed already fixes goalRunId=`rg-UUID`, goal/model, empty board generation=old+1, fresh preflightId/attemptId/attemptNo0 and prepared status. C cannot allocate random identities during repair.
- C: exact control/witness IDs and node digests, unchanged from-source, identical new seed. Current lifecycleCommitId is C's actual native entry ID; it is not guessed in the payload.
- goal-state: current scope, exact previous lifecycle entry ID, action, goal phase, planning attempt, optional new preflight seed only for replan, explicit null or validated Supervisor checkpoint metadata. Planning actions preserve goal/model/board/archive/usage and cannot erase an already created Supervisor. Normal Supervisor updates preserve scope and use one confirmed record.
- Planning actions: prepare-planning, claim-planning-dispatch, observe-planning-dispatch, settle-planning, stop-unstarted; normal Supervisor writes use action=supervisor. Prepared attempts are claimed before send; unknown results never revert to prepared. Pure planning result loss can be closed only after positive native host/queue quiescence and lease invalidation, not by elapsed time or an approval of missing evidence.
- Scoped carrier3: version3, protocol, goalRunId, lifecycleCommitId, snapshot. Board and preflight keep their existing runtime payload types. Consumers validate the carrier, current scope and inner payload. First seed is embedded only in C; no duplicate-generation cache append.
- Source refs use entryId/entryDigest and explicit payload selector (raw owner data, scoped snapshot, C board/preflight seed, or replan preflight seed). Logical data digests independently close the observed runtime state. No old receipt bodies are copied.
- GoalReadbackFrame2 is separate from unchanged legacy ReadbackFrame1. NativeFrame is a strict union; legacy proof overloads retain their legacy frame types. Goal uses baseEntryId/baseEntryDigest; board/preflight use baseSnapshotEntryId/baseSnapshotDigest (physical carrier digest for new scopes).
- Legacy goalIdentity tuple stays byte-for-byte unchanged. New receiptScopeIdentity is digest([protocol, goalRunId, legacyGoalIdentity(state)]). New ledger goalId equals reserved goalRunId; inherited bindings/acceptance/receipts/start tokens are forbidden.

## Owning seams and exact write set

| Module/symbol                                                                                     | Responsibility and consumer                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new `goal-records.ts`                                                                             | Strict schemas/types, runtime selection DTO, pure carrier/protocol helpers; imported by storage/native adapters without importing owner runtimes                                                                    |
| new `goal-scope.ts`                                                                               | Current-scope carrier wrapping/unwrapping, selected branch ranges, goal-bound logical scope and execution holds/leases; existing owners consume these, not another SessionManager                                   |
| new `goal-journal.ts`                                                                             | Physical branch A/B/C/state fold, exact source reference validation and deterministic archive/current projection; lifecycle owner uses it for append confirmation/reopen/history                                    |
| new `goal-lifecycle.ts`                                                                           | inspect/request/restore/history plus replanCurrentGoal/stopCurrentGoal; no Main dispatch inside these owner operations                                                                                              |
| `runtime.ts`, `state.ts`                                                                          | Per-instance lifecycle state; reset lifecycle; selected board seed + monotonic scoped successors; persistEntries and direct board append routed to carrier writer                                                   |
| `human-journal.ts`, `human-control.ts`, `human-ui.ts`                                             | Strict goal frame2/proof/native answer, selective wire5 retention (not all old Supervisor bodies), overloads for legacy frames, current-scope base checks and carrier projection                                    |
| `preflight.ts`, `preflight-human.ts`, `board-human.ts`                                            | Current GoalRun/preflight attempt filtering; physical carrier base versus logical payload; scope-bound answers, strict existing folds/startup closure, all prepare/save/repair appends scoped                       |
| `supervisor.ts`, `receipt-store.ts`                                                               | Read new Supervisor metadata without interpreting A/C as execution; fresh scoped start; wire5 normal writes and new identity, unchanged archive/receipt logic and startup zero invariants                           |
| `commands.ts`, `events.ts`, `flow.ts`                                                             | Route lifecycle first, explicit replan/unstarted stop and one claim-before-send planning helper; restore lifecycle before owners; no board-only fallback for scoped planning/stopped/pending; stale lease rejection |
| `ui-capture.ts`, `ui-view.ts`, `board-ui.ts`, `board-view.ts`, new history presentation if needed | Current-only summary and explicit frozen read-only history; never set runtime to an old goal while rendering                                                                                                        |
| tests/docs/smokes                                                                                 | Public owner/native journal/command/receipt/UI sentinels and existing gates; no private-method assertions or manufactured host success                                                                              |

Source audit: board writes at state.persistEntries, events.consumePhasePrompt and the direct snapshot appends in tools.createEditTasksTool/createAdvanceTasksTool; all use the scoped owner writer. preflight writes at savePreflight, appendControl and preflight-human.prepareRequest; native projections at saveReadbackProjection; Supervisor at saveSupervisor and legacy gap barrier. The barrier stays legacy-only. Reader audit includes reconstructState, restoreBoardHuman/readBoardHumanPresentation, preflight currentControls/cache/startup/folds, readSupervisorHistory/startupContext, ReceiptStore.restore, lifecycle session/tree restore and native frame/proof verification. No direct owner snapshot append is left as a scoped bypass. Ordinary workflow-event records are audit context, not state or authority; native board controls retain their original frame-bound shape. D3 leases additionally distinguish planning from execution: tool callbacks use a bounded metadata-only map plus physical native tool-call identity for rare reopened results; native run starts/settles retain separate GoalRun/attempt leases. Missing association remains unknown, never manufactured current evidence.

## Ordered failure surface

1. Reject unsafe input/unsupported source before new authority writes.
2. Journal/identity/version/conflicting state and independent repair faults remain holds.
3. Reject pending Main/messages/native questions, real decisions, receipt pending/unhealthy and external refs; inspect actual owners, not UI cache.
4. Only terminal old goal or confirmed unstarted-stop can enter archive; only still-unstarted current goal can replan/stop under S2.
5. Answer must still be current before A; A first introduces wire5; B cannot be synthesized after A failure. Existing A+B may repair exact C, without dispatch; A-only needs genuine new superseding native confirmation.
6. Runtime switches only after physical C/state readback. Lost ACK or projection failures retain current failure state; reopen follows actual bytes and never dispatches.
7. Repeated/old/sibling/future conflicting records do not overwrite the first exact committed result. Model/goal/branch/source changes invalidate leases.

## Validation and acceptance allocation

D0 baseline: typecheck + focused policy/journal smoke before unchanged full `npm run check`. D1 tracer first tests GoalReadbackFrame2 proof through public findGoalReadbackProof/native admission; then one owner transition/restart failure at a time. All tested seams come from the user-approved design §§5,7,8,11 and the explicit implementation request, not private implementation hooks.

D2: real registered command route, native opaque answer, cancelled/rejected/unsupported no writes, independent new permissions/start. P1 replan/stop tests preserve GoalRun and quotas and reject actual unknown execution. D3: repeated text/task IDs, stale callbacks/answers/receipts and read-only archived view. At candidate: static checks, existing + new full suite with unchanged90, existing smokes, cold SDKs/native positive + fake-TTY denial, actual old reader refusal, resource small sample then scaling. Preserve failing results.

Final independent blocker review is required. Native launcher is currently absent; do not spawn a CLI reviewer using the consumed design-review approval. Complete independent authorized work first, then report that gate as pending and obtain a fresh review execution authority when necessary. No automatic publication.
