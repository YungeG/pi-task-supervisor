# Local supervisor validation report

- Validated: 2026-10-11 (UTC)
- Candidate: `pi-task-supervisor/`, validation snapshot before Git publication on `local/continuous-tasks`, based on `e5455d90237bfbdea83d4dc6a58dd0887716e704`
- Public name/command: **Pi Task Supervisor**, `/task-supervisor`; `/continuous-tasks` remains an alias
- Pi: `1.1.0` (`pi-ai`, `pi-coding-agent`, `pi-tui`); `typebox@1.3.7`
- Node: `25.9.0`
- Result: local acceptance checks pass, subject to the limitations below; **not production certification**
- Installed/deployed plugins, business sessions, and global settings changed: **no**
- Live model calls: **none**; all advisor/Main responses are local mocks or faux-provider fixtures

This replaces the earlier Pi 0.84.2 board-only canary. Historical results are retained in `UPSTREAM.md` and are not current validation evidence.

## Current checks

`npm run check` passed from the renamed directory after the final bounds fix and command-compatibility regressions:

| Check                                                         | Result                                          |
| ------------------------------------------------------------- | ----------------------------------------------- |
| TypeScript (`tsc --noEmit`)                                   | PASS                                            |
| ESLint                                                        | PASS                                            |
| Source formatting                                             | PASS                                            |
| Unit/integration suite                                        | **521 tests, 26 files PASS**                    |
| Branch coverage                                               | **90.39% (1045/1156)**; unchanged 90% threshold |
| Statement / function / line coverage                          | 95.37% / 97.7% / 97.5%                          |
| Five isolated real-Pi SDK smokes                              | PASS                                            |
| Package dry-run manifest                                      | PASS                                            |
| Actual packed source loaded by Pi 1.1 `DefaultResourceLoader` | PASS, without installation                      |
| `git diff --check`                                            | PASS                                            |

The packed-source check included all 15 production TypeScript files, including `runtime.ts` and `supervisor.ts`; tests and `node_modules` were excluded. It registered all seven task tools, verified default-disabled activation and explicit human enablement, and left real settings unchanged. Extracted source resolved the checkout's existing local peer dependencies: this was **not** a clean dependency installation test. Temporary packaging artifacts were removed after the process exited.

Active error-level LSP probes covered all 21 changed/new TypeScript paths at the renamed location and reported no errors. The final batch confirmed eleven paths clean; ten were **inconclusive** because the push-only server did not publish a fresh clean result. Those ten paths are not certified clean by LSP. The full TypeScript check passed after these changes. Auxiliary scans reported stylistic warnings/hints, including the repository's extensionless-import convention; this is not a zero-warning report.

## Real SDK scenarios (local faux provider only)

| Mode                     | Result and observed behavior                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board-only               | Two agent runs, one hidden native continuation, one original user message; board completes                                                                                                     |
| `--supervised`           | Two agent runs, two advisor checks, one native advisor continuation; two tasks have host-bound validation                                                                                      |
| `--compaction`           | One real automatic threshold compaction before settlement; three agent runs; durable goal and actual receipt survive a deliberately lossy fixture summary                                      |
| `--interrupt-compaction` | Human pause cancels an in-flight advisor even when the faux provider ignores cancellation; real manual compaction follows; stale guidance is discarded; explicit resume/recover completes work |
| `--native-abort`         | Native manual compaction waits for the boundary; a late advisor draft cannot restart Main; settlement visibly pauses supervision; explicit resume/recover completes work                       |

All five modes exercised the primary `/task-supervisor` command and legacy `/continuous-tasks enable` alias without duplicate activation. Interrupted-compaction modes also recovered a primary-created supervisor through the legacy alias. Existing `continuous-tasks:*` journal/message identifiers and `continuous-tasks.json` fixture configuration remained unchanged.

All supervised modes verified zero forged user messages, one typed activation entry, restored activation and verified acceptance after reopening, no supervisor inheritance on fork, and default denial in independent sessions. All five modes verified that real settings were unchanged. Smokes use temporary agent directories and no builtin executor tools; validation tools produce deterministic local fixture results, not live external execution.

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

Review limits are 30 seconds, 64KB of structured input, 2048 output tokens, 40 checks, 20 resumes, three non-progress continuations, and 500 receipts. Mocked-time tests cover a provider ignoring cancellation; the real SDK interruption scenarios use controlled faux replies rather than waiting for a live provider.

## Native abort/compaction limitation

Pi 1.1 `AgentSession.compact()` aborts and waits for idle **before** emitting `session_before_compact`. During an awaited before-settle advisor check there is no public immediate native-abort signal available to the extension. Native abort/manual compaction may therefore wait for the check to return, bounded by the extension's 30-second review deadline. Pi may persist an aborted guidance draft, but does not execute it; notification reconciliation makes the board/supervisor visibly paused.

For immediate advisor cancellation, use **`/task-supervisor pause` before manual compaction**. After inspection, `resume`/`resolve` restore only board gates; `recover` is a separate explicit human operation. Automatic pre-boundary compaction is covered and preserves the durable journal. No SDK monkeypatching is used.

## Validation boundaries and next authority

- No live provider quality, real business-session canary, deployment, or installed-extension coexistence test was run. Goal-coverage judgment remains model-dependent; deterministic host receipts do not establish the truth of arbitrary tool output.
- No fresh dependency advisory-service audit was performed after the Pi upgrade. Offline lock refresh is not a security audit; historical audit results are not current evidence.
- Node 24 and clean peer-dependency installation were not retested for this candidate. Current execution evidence is Node 25.9.0 with existing local dependencies.
- Redaction is not general DLP, and task gates are not an OS/tool permission sandbox. Other Main tools retain host controls.

The controlling agent completed the authorized local validation; Git publication was separately requested by the user and does not constitute installation or deployment. No user action is needed for these checks. Deployment or live/business validation is outside this authorization and requires a separate explicit decision; nothing here authorizes installation, credential changes, or business-session activation.
