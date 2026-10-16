# Local supervisor validation report

## Receipt integration candidate — LOCAL PASS (not merged or installed)

The V2/V3 semantic integration has fresh local validation at code/test/config fingerprint `09641ecbc4b44d590ae8b8d5fc083d117c19e56ab9c349a8f29ba71b88a96d40`: **768 tests / 36 files PASS; 90.20% branches with unchanged 90% gates**, lint complexity maximum 15, and twelve development SDK smoke modes. Its frozen source passed twelve dependency-free package cold modes on each of SDK 1.1/1.2 and six refusal checks using old v1/v2/V3-only readers. Cross-batch v2 migration, exact sibling-branch rejection and unacknowledged committed recovery are covered. Resource samples 100→1000→5000 passed; the raw cache stayed at 128 entries at 5000, while index/session memory still grows with history.

Fresh integration evidence is recorded in [receipt-integration-acceptance.md](./docs/receipt-integration-acceptance.md). Historical results below are baseline evidence only, not integration acceptance. Original main/V2/V3/human-interaction trees and selected settings were preserved; no commit, original-tree merge, publication, installation, credential/model change or second external formal review is claimed. Faux-provider/UI-stub tests do not certify business execution or interactive TUI quality.

## Baseline V3-only receipt-storage candidate (historical)

The implementation is isolated on `docs/supervisor-receipt-retention-plan`, based on `f6d3c7f6cab37bae2f0cb4b63024cb5eae8053ce`. Local source acceptance is **737 tests / 35 files PASS, 90.14% branches with unchanged 90% gates**, plus eleven development SDK smoke modes. The same code fingerprint (`e2578137d0aca2bf91ab7adc2071ef8cc31c7dd647bde5b596e5f33b4fc3e48c`) passed eleven no-package-local-dependency cold modes on each of SDK 1.1 and 1.2, and both old-reader refusal checks. Resource samples at 100/1000/5000 receipts passed. It is not committed, published or installed. Current validation status, raw evidence and remaining gaps are maintained in [the receipt acceptance record](./docs/supervisor-receipt-storage-acceptance.md), not inferred from the historical results below.

The candidate replaces lifetime receipt counts with append-only evidence and bounded raw caching; new persisted checkpoints are v3, with explicit v1 recovery/migration. It does not implement working-directory permissions, automatic new-goal approval, old-version write compatibility or real-business/TUI certification. At that V3-only acceptance, the other worktree's v2 candidate had not been integrated; the current integration separately verifies the actually configured v2 wire format. No new independent formal review is claimed.

## Previously validated source: opt-in preflight and safe continuation (historical)

- Accepted local implementation: **696 tests / 34 files PASS**, **91.06% branch coverage**, unchanged 90% thresholds; TypeScript, lint, formatting and eight isolated SDK/faux-provider modes pass.
- Opt-in proposal, exact current-branch human approval, separately guarded startup, revision invalidation, fail-closed persistence/lifecycle and retained revocation gates are covered. Legacy supervision, owner-confirmed async waiting and legitimate human-decision waiting remain compatible.
- The single authorized fresh-context read-only implementation review completed in about 221 seconds. Its original `BLOCK` report identified two concrete issues; Main reproduced both red, fixed them and obtained passing targeted/full validation. The report is not rewritten and no second independent review is claimed.
- Source acceptance evidence is recorded under `/tmp/pi-supervisor-preflight-impl-y6cVye/`, including `check-final-t3-2.log`, `final-acceptance-verification.json`, the original CLI review and `review-resolutions.md`. These are local evidence artifacts, not portable files included in this repository.
- After local acceptance, the user separately authorized **commit, push and installation**. Delivery targets the current fork branch and an exact-commit local package snapshot; registry publication, business deployment, credential changes and live business-session activation remain unapproved.
- Prior installation was recovery-hotfix snapshot `273cc792f350a5a833adcfd918de9871a9c8449c`; it lacks preflight. The subsequently selected installation must be verified against its exact commit/configuration, not inferred from this document. Cold snapshot/host checks are separate delivery evidence.
- The repository SDK/faux matrix uses existing Pi 1.1 peers and Node 25.9.0. Delivery additionally cold-loads the exact source snapshot without package-local `node_modules` against the installed Pi 1.2 host peers. Real-model use was confined to the authorized independent code review; this does not certify live-model product adherence, real executor/business integration or the user's interactive TUI.
- Pi 1.2 checks compaction thresholds between assistant turns. The original automatic-compaction fixture crossed its 4096-token threshold immediately after draft-board creation, before its required validation proof existed, then fell into real summarization and consumed the scripted faux queue. The fixture now arms automatic compaction only after the first task's host validation is bound. Context window, threshold, evidence checks and production code are unchanged; the red scenario and corrected Pi 1.1/1.2 scenario are retained as delivery evidence.

## Previous async integration and bounded evidence packet candidate (historical)

- Source baseline: `9933feaee451046168fb1384b7276fe1ad78c787`; uncommitted candidate on `local/supervisor-async-integration`, not published or installed.
- `npm run check`: **600 tests / 30 files PASS**, branches **91.14% (1410/1547)**, statements 95.07%, functions 97.81%, lines 97.17%; unchanged 90% coverage gates. TypeScript, ESLint and source formatting pass.
- All **seven** isolated real-SDK/faux-provider modes pass, including ordinary pause with retained counters and owner-confirmed asynchronous waiting followed by executor-fixture result delivery and fresh Main validation. Real settings remained unchanged.
- The merged packet fix adds four public-boundary regressions: ASCII/CJK excerpt bounding, oversized bound-evidence refusal, and UTF-8 byte limits. Goal, task board, selected receipt identities/validation metadata and bound receipts remain intact; only explicitly marked unbound/transcript excerpts shrink, never durable history.
- Evidence: `/tmp/pi-supervisor-merge-review-check.log`; the review's file list/hash is in `/tmp/pi-supervisor-merge-review-baseline.json`. The twelve candidate files and HEAD did not drift during that review. Subsequent documentation-only synchronization does not change the tested source.
- Active LSP checks of the merged implementation/test reported no errors: one path confirmed clean, one push-only path unconfirmed. Full `tsc --noEmit` passes; this is not an all-LSP-clean claim.
- No live inference, real child/workflow execution, business-session activation, new packed-install validation, independent implementation review, publication or installation. The executor owner is a fixture; it does not certify real-process liveness or live executor integration.

The frozen scope and failure precedence are in [the async integration contract](./docs/supervisor-async-integration-packet.md). Earlier snapshots below remain historical evidence, not fresh results for this candidate.

## Native-board appearance validation snapshot (historical)

- Validated: 2026-10-11 (UTC)
- Candidate: `pi-task-supervisor/`, native-board appearance validation snapshot on `local/continuous-tasks`, based on published/installed `e6725ba74d2d01e2cb586ba6a823a62b6471d41f`
- Public name/command: **Pi Task Supervisor**, `/task-supervisor`; `/continuous-tasks` remains an alias
- Pi: `1.1.0` (`pi-ai`, `pi-coding-agent`, `pi-tui`); `typebox@1.3.7`
- Node: `25.9.0`
- Result: local acceptance checks pass, subject to the limitations below; **not production certification**
- Installed/deployed plugins, business sessions, and global settings changed during this polish validation: **no**
- Live model calls: **none**; all advisor/Main responses are local mocks or faux-provider fixtures

This replaces the earlier Pi 0.84.2 board-only canary. Historical results are retained in `UPSTREAM.md` and are not current validation evidence.

## Native-board appearance checks (historical)

`npm run check` passed after theme-aware appearance changes. Only `src/board-ui.ts` production code changed: task ordering, read-only list/details, activation, gates, execution, persistence, and evidence semantics remain unchanged. The widget uses built-in theme roles, monochrome status glyphs, aligned status/ID columns, bold active titles, and a subtle left rail. Display IDs are capped at 14 columns; the full list retains exact IDs. Empty overflow/fold counts are omitted. Session-derived strings and row data are still captured before deferred rendering.

| Check                                         | Result                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| TypeScript, ESLint, source formatting         | PASS                                                                                                          |
| Unit/integration suite                        | **525 tests, 27 files PASS**                                                                                  |
| Branch coverage                               | **90.79% (1124/1238)**; unchanged 90% threshold                                                               |
| Statement / function / line coverage          | 95.52% / 97.83% / 97.57%                                                                                      |
| Five isolated real-Pi SDK smokes with UI stub | PASS                                                                                                          |
| Native theme rendering                        | PASS: `system`, `dark`, `light`; widths 0, 1, 2, 35, 72, 120; identical plain content/alignment across themes |
| Native preview fixtures                       | PASS: three themes at 35, 72, 120 columns, including CJK titles                                               |
| Package dry-run manifest                      | PASS: 23 files, all 16 production TypeScript files; tests and dependencies excluded                           |
| `git diff --check`                            | PASS                                                                                                          |

Active LSP probes covered both changed TypeScript files and the SDK smoke script: no errors; three auxiliary warnings remain for the existing extensionless-relative-import convention. This is not a zero-warning claim. Full TypeScript checking passed.

Focused tests passed (28 tests across board UI and commands), including color-role calls, glyph/status cues, CJK column alignment, long-ID truncation, ANSI/control safety, overflow, gate visibility, deferred-session capture, read-only commands, and unchanged evidence. The five SDK modes retain all prior lifecycle, restoration, isolation, gate, and no-live-inference checks while rendering with actual built-in themes instead of an undefined theme stub.

The temporary preview HTML contains actual widget output and native theme colors, not an independently designed UI. Browser screenshot inspection was unavailable: the installed agent-browser version is unsupported by its Pi tool. No browser/extension upgrade was attempted. Theme/text/width checks are **not human visual acceptance in the user's real terminal**, and no business session was reloaded. At this local validation point, the candidate had not been committed, pushed, or installed. Publication and installation are separate user-authorized follow-up operations, not evidence of real-terminal visual acceptance.

## Previous visible-board checks (historical)

`npm run check` passed after the visible-board changes and final empty-paused-board regression fix. The existing snapshot remains the sole task store; no task schema, completion gate, dependency, or activation contract changed. At this validation point, the UI changes had not been committed, published, or installed. Subsequent publication or installation does not constitute live-model or production certification.

| Check                                         | Result                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| TypeScript, ESLint, source formatting         | PASS                                                                                                          |
| Unit/integration suite                        | **523 tests, 27 files PASS**                                                                                  |
| Branch coverage                               | **90.69% (1101/1214)**; unchanged 90% threshold                                                               |
| Statement / function / line coverage          | 95.47% / 97.81% / 97.55%                                                                                      |
| Five isolated real-Pi SDK smokes with UI stub | PASS                                                                                                          |
| Package dry-run manifest                      | PASS: 23 files, all 16 production TypeScript files; includes `board-ui.ts`, excludes tests and `node_modules` |
| `git diff --check`                            | PASS                                                                                                          |

Focused tests cover unfinished states, ordering, dependency/phase blockers, execution references, decisions, pauses, faults, completed evidence retention, all 100 tasks in the full list, and overflow counts. The widget is bounded to eight single terminal lines with actual Pi width/control-sequence utilities, including narrow and CJK text. An empty fresh board clears the widget, while an empty paused board retains its pause reason. Deferred rendering and modal selection capture the session view before asynchronous context changes. Both command aliases provide read-only inspection even when disabled or journal-faulted; inspection neither mutates task state/history nor starts Main.

The existing five SDK modes now also observe live implementing/reviewing/supervisor-review updates, completed folding, full-list evidence, shutdown clearing, resume restoration, fork isolation, and fresh independent clearing. These are real SDK callbacks with a **UI stub**, not a real interactive terminal or human visual certification. No live inference, executor tools, business-session reload, settings changes, or installed-extension coexistence tests were added.

Fresh LSP probes of all nine changed TypeScript paths reported no errors, but auxiliary heuristic warnings/hints remain (including the repository's extensionless relative-import convention). A final two-path recheck reported no errors with one clean result and one **inconclusive** push-only result. This is not an all-LSP-clean or zero-warning claim; full TypeScript checking passed. The new UI candidate was checked by package dry-run only, not by a new actual packed-source load or clean dependency installation.

## Previous subtraction-review checks (historical)

The following checks apply to the earlier subtraction-review snapshot, not the current UI package. `npm run check` passed after the scoped subtraction review. The review removed two unused, non-persisted legacy fields (`autoContinueCount`, `lastToolWasAdvance`), their accessors/resets, and the redundant `setBoardQuiet` setter. Eleven obsolete or duplicate internal-state tests were removed; actual budget, stagnation, cancellation, evidence, recovery, cloning, and compatibility regressions remain. The existing phase-prompt test now also checks generation advancement and legacy snapshot persistence. No automation, dependency, public behavior, or journal/config contract was added or changed.

| Check                                                         | Result                                          |
| ------------------------------------------------------------- | ----------------------------------------------- |
| TypeScript (`tsc --noEmit`)                                   | PASS                                            |
| ESLint                                                        | PASS                                            |
| Source formatting                                             | PASS                                            |
| Unit/integration suite                                        | **510 tests, 26 files PASS**                    |
| Branch coverage                                               | **90.38% (1043/1154)**; unchanged 90% threshold |
| Statement / function / line coverage                          | 95.27% / 97.68% / 97.49%                        |
| Five isolated real-Pi SDK smokes                              | PASS                                            |
| Package dry-run manifest                                      | PASS                                            |
| Actual packed source loaded by Pi 1.1 `DefaultResourceLoader` | PASS, without installation                      |
| `git diff --check`                                            | PASS                                            |

The packed-source check included all 15 production TypeScript files, including `runtime.ts` and `supervisor.ts`; tests and `node_modules` were excluded. It registered all seven task tools, verified default-disabled activation and explicit human enablement, and left real settings unchanged. Extracted source resolved the checkout's existing local peer dependencies: this was **not** a clean dependency installation test. Temporary packaging artifacts were removed after the process exited.

Active error-level LSP probes covered all five TypeScript paths changed by the subtraction review and reported no errors. Some paths remained **inconclusive** because the push-only server did not publish a fresh clean result; they are not certified clean by LSP. The full TypeScript check passed after these changes. This is not a zero-warning report.

## Real SDK scenarios (local faux provider only)

| Mode                     | Result and observed behavior                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board-only               | Two agent runs, one hidden native continuation, one original user message; board completes                                                                                                     |
| `--supervised`           | Two agent runs, two advisor checks, one native advisor continuation; two tasks have host-bound validation                                                                                      |
| `--compaction`           | One real automatic threshold compaction before settlement; three agent runs; durable goal and actual receipt survive a deliberately lossy fixture summary                                      |
| `--interrupt-compaction` | Human pause cancels an in-flight advisor even when the faux provider ignores cancellation; real manual compaction follows; stale guidance is discarded; explicit resume/recover completes work |
| `--native-abort`         | Native manual compaction waits for the boundary; a late advisor draft cannot restart Main; settlement visibly pauses supervision; explicit resume/recover completes work                       |
| `--ordinary-pause`       | Human pause cancels an in-flight advisor; one resume restores board/Supervisor with retained counters and evidence; fresh Main validation completes the goal                                   |
| `--async-execution`      | Exact run binding waits without advisor calls; only the executor fixture wakes Main, which clears the reference and validates both tasks.                                                      |

All seven modes exercised the primary `/task-supervisor` command and legacy `/continuous-tasks enable` alias without duplicate activation. Interrupted-compaction modes also recovered a primary-created supervisor through the legacy alias. Existing `continuous-tasks:*` journal/message identifiers and `continuous-tasks.json` fixture configuration remained unchanged.

All supervised modes verified zero forged user messages, one typed activation entry, restored activation and verified acceptance after reopening, no supervisor inheritance on fork, and default denial in independent sessions. All seven modes verified that real settings were unchanged. Smokes use temporary agent directories and no builtin executor tools; validation tools and the async owner produce deterministic local fixture results, not live external execution.

## Policy and recovery regressions

The public command, task-tool/event, and native boundary seams cover:

- Primary/legacy commands share one board, supervisor, and idempotent activation; cross-alias pause/resume/recovery preserves the recorded goal and legacy journal formats.
- Normal assistant-ended settlement (`canContinue: false`) becoming runnable through returned hidden guidance; no countdown or scheduling from notification-only `agent_settled`.
- Per-instance session isolation, sequential task tools, immediate human pause cancellation, and asynchronous board identity checks before commit.
- Human decisions, pauses, stops, holds, budgets, and explicit recovery; advisor text cannot grant approval or bypass board gates.
- Visible provider/JSON/schema/timeout faults, stale branch rejection, malformed-journal activation denial, and interrupted restart without automatic replay or an active-but-idle badge.
- Full final dependency coverage and host-bound completion: fabricated refs, failed/missing structured exit status, changed review-task digests, stale mutation epochs, abandonment, unresolved execution receipts, and unbound acceptance citations fail.
- Acceptance revocation after potentially mutating tools, frozen completed tasks, durable evidence across compaction, and restored/forked/shutdown status reconciliation.
- Common credential-pattern redaction before JSON encoding, nested sensitive input keys, preserved structured tool results, receipt deduplication, and invalid usage accounting rejection.
- At most **100 supervised tasks**, matching the durable binding limit: start, write/append, and recovery reject oversized plans; exact-boundary plans remain allowed.

Review limits are 30 seconds, 64KB of structured input, 2048 output tokens, 40 checks, 20 resumes, three non-progress continuations, and 500 receipts in that historical candidate (the current repair removes this cumulative limit). Mocked-time tests cover a provider ignoring cancellation; the real SDK interruption scenarios use controlled faux replies rather than waiting for a live provider.

## Native abort/compaction limitation

Pi 1.1 `AgentSession.compact()` aborts and waits for idle **before** emitting `session_before_compact`. During an awaited before-settle advisor check there is no public immediate native-abort signal available to the extension. Native abort/manual compaction may therefore wait for the check to return, bounded by the extension's 30-second review deadline. Pi may persist an aborted guidance draft, but does not execute it; notification reconciliation makes the board/supervisor visibly paused.

For immediate advisor cancellation, use **`/task-supervisor pause` before manual compaction**. A qualified ordinary human pause can resume both board and Supervisor with one `resume`, retaining counters, usage and evidence. Stronger or unknown holds still require inspection and explicit recovery after board gates are resolved; `resolve` answers only the exact decision gate. Compaction during external waiting invalidates that wait and requires explicit recovery. Automatic pre-boundary compaction is covered and preserves the durable journal. No SDK monkeypatching is used.

## Validation boundaries and next authority

- No live provider quality, real business-session canary, deployment, or installed-extension coexistence test was run. Goal-coverage judgment remains model-dependent; deterministic host receipts do not establish the truth of arbitrary tool output.
- No fresh dependency advisory-service audit was performed after the Pi upgrade. Offline lock refresh is not a security audit; historical audit results are not current evidence.
- Node 24 and clean peer-dependency installation were not retested for this candidate. Current execution evidence is Node 25.9.0 with existing local dependencies.
- Redaction is not general DLP, and task gates are not an OS/tool permission sandbox. Other Main tools retain host controls.

The controlling agent completed the authorized local validation. This report records local validation snapshots; committing, publishing and installing the current candidate require separate explicit authorization and do not constitute additional validation evidence. npm publication remains paused. No user action is needed for these checks. Live/business validation, credential changes, and business-session activation remain outside this validation scope.
