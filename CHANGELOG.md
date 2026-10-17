# Changelog

## Isolated structural UI candidate — acceptance pending

- Present owner state, blockers and next-step guidance before a factual task-completion bar; keep done, abandoned and final acceptance distinct.
- Group readonly navigation into collapsible phases, retaining fixed overview/history/acceptance routes and independent status/phase filters. Preserve selected task/filter on return from complete details.
- Use native wide-screen master/detail previews from 100 columns; preserve single-column narrow/full-material views and visible readonly-snapshot labeling. Keep diagnostic JSON and capture IDs in full details rather than the primary peek.
- Navigation changes presentation state only. Native authorization, receipt/history validation, recovery, startup, immutable capture and own-view/widget coordination remain unchanged. No main merge, installation or current-session reload is part of this isolated revision; SDK1.2 remains MISSING.

## Unreleased unified UI integration — final acceptance pending

- Wire `/task-supervisor tasks` to the full readonly board, fixed confirmation/history/acceptance entries even with zero tasks, filtering and two-level return. Historical material and absent/unknown evidence never grant new authority.
- Paginate complete pre-answer scope material; retain short native purpose/request titles, exact canonical business values, explicit invalid-input retry/defer and independent first-start confirmation.
- Coordinate only this extension’s own board/native views and widget, with fresh original publication after release and stale lifecycle cleanup. Preserve text-only status, no footer takeover or cross-extension guarantee, and all machine/owner/proof/carrier gates.
- Full/coverage/all12-smoke/native acceptance is pending for this integrated source; SDK1.2 remains MISSING. Older PASS and dual-version pilots below are historical input, not acceptance of this revision. No commit/install/publication/business operation is claimed.

## Historical UI readability candidate

- Keep current-session preflight state visible on an empty board, with approved-not-started, prior-start reauthorization and held-state wording; no UI-based grants or execution inference.
- Replace raw JSON notifications/tool presentation with human-readable feedback and expandable complete scope. Preserve original machine payloads, canonical answers, owner records and all gates.
- Structure native confirmation material and use safe-first Chinese labels mapped to unchanged internal options. Retain exact business options and significant scope whitespace; no new framework or dependency.
- Local checks: 1082 tests, unchanged 90% coverage gate, twelve SDK smokes, dual-version real CLI/PTY pilots and native-theme/width previews. Not committed, merged, installed or used on a business session.

## Historical native-human / receipt integration candidate

- Native typed board authorization/choice/information and required-only preflight approval, with separate no-ID first start. Bare chat and ordinary SDK/RPC command text do not approve new scope.
- Reuse the Supervisor owner's strict v1/v2/v3 history/ledger validation for physical first-start readback. Keep readonly recovery views, cache-only human repairs, explicit migrations and one continuation carrying the exact execution agreement.
- Preserve pending host-intent holds after saving a human answer; bind lazy V2 archive reads to the already-validated batch head; retain a deferred legacy saturation barrier before explicit recovery/migration. Each correction has a behavioral red/green regression.
- Full local gate: 1044 tests, unchanged 90% coverage threshold, twelve SDK smokes, dual-SDK cold/refusal checks and separate real CLI/PTY pilots. The original V2's 15 regression cases remain meaningful and enabled. Not committed, written back, installed or deployed.

## Unreleased receipt integration candidate

- Integrate the configured v2 format as a strictly validated, bounded archive view; explicit recovery anchors its exact checkpoint before continuing in v3, without copying/replacing historical bodies.
- Retain the v2 safeguard for v1 snapshots saturated at 500: a one-time observation-gap barrier revokes old acceptance while preserving pauses, budgets, usage and completed boards. Below-saturation and stopped historical targets are not indiscriminately reopened.
- Publish recovery active state only after checkpoint confirmation; failed or unacknowledged recovery holds the current runtime without continuing. Reopen reads the checkpoint actually committed, and treats an active checkpoint as interrupted rather than automatically running it.
- Extend native SDK smoke with cross-batch v2 migration. Integration validation is tracked separately in `docs/receipt-integration-acceptance.md`; old V3-only results are not merge acceptance.
- No source-tree cleanup, commit/merge, publication, installation, model or credential changes are part of this local candidate.

## V3-only receipt-storage repair candidate (historical)

- Remove the cumulative 500-receipt failure, using append-only branch-local proof records, small v3 checkpoints and a bounded raw cache instead of repeated full-history snapshots.
- That V3-only candidate preserved evicted current-review/bound proof lookup, exact goal identity, immutable v1 migration anchors, usage and human gates; it did not include the configured v2 compatibility now added by the integration candidate.
- Persist mutation intents and unmatched/late-result freshness barriers; never replay unknown work automatically or accept overlapping validation as fresh evidence.
- Add bounded cache configuration and read-only status. Report current capture errors without repeatedly emitting a stale acceptance warning or dropping host structured results.
- Add native SDK long-history, legacy migration and interrupted-intent smoke modes. Validation evidence and limitations are tracked in `docs/supervisor-receipt-storage-acceptance.md`; this is not a published/installed revision.

## Preflight source revision (historical)

- Opt-in read-only preflight, strict proposal-only submission, exact human permission selection and separately guarded startup; legacy supervision remains compatible.
- Current-session/branch control closure, revision invalidation, protected advisor scope evidence and strong revocation without automatically resuming or changing host tool permissions.
- Isolated real-SDK/faux-provider preflight smoke; synthetic command approvals certify plumbing, not real business authorization.
- Preserve owner-confirmed asynchronous waits and legitimate human-decision waiting at native settlement.
- Exact-revision commit, push and local installation require explicit delivery authorization; npm publication and business deployment are separate.

## 0.1.0-beta.1

First npm beta of Pi Task Supervisor, based on the maintained fork and Pi 1.1.0 validation.

- Session-scoped task board, dependency/phase gates, human decisions, and read-only supervision at the native end-of-run check.
- Host-observed completion evidence, final acceptance coverage, fault/restart protection, and bounded advisor budgets.
- Ordinary human pause can resume the board and supervisor once without resetting counters, usage, epoch, or evidence; legacy and stronger holds retain explicit recovery.
- Soft batch-checkpoint guidance, actionable read-only status, and an eight-line theme-aware unfinished-task widget with a complete task/evidence list.
- Preserve `continuous-tasks:*` journal identifiers and the `/continuous-tasks` alias.
- Owner-confirmed asynchronous execution waits reuse the existing executor's result delivery without repeated advisor calls, with a fixed 30-minute deadline and preserved human gates, budgets and host evidence.
- Supervisor evidence packets use a 64,000-byte UTF-8 cap; only marked unbound receipt/transcript excerpts shrink, while goal, board and bound validation receipts remain intact.
- Validation: 600 tests, 91.14% branch coverage with the unchanged 90% gate, and seven isolated SDK/faux-provider modes. Live-model adherence and real executor/business workflow behavior are not certified.
- Dispatch, parallel scheduling, write permissions and worktree management remain with Main/the existing executor; Supervisor does not implement them.

The history below belongs to the upstream pi-tasks project and is retained for provenance; it does not describe the current supervisor implementation.

## Upstream history: [Unreleased]

### Added

- New `advance_tasks` tool for advancing tasks through implementing → reviewing → done (extracted from `edit_tasks`)
- Double-usage warning: alerts when `advance_tasks` is called twice consecutively without intervening tool usage
- Conditional board rendering: `get_ready_tasks` and `advance_tasks` now show only the active phase
- Truncated claimed task output: shows 3 lines of prompt with `... (ctrl-o to expand)` hint
- Emoji status icons: ⚪🔵🟢▶️🔍✅❌ replace ASCII symbols

### Bug Fixes

- Fixed double auto-continue firing in headless mode due to missing `clearTimeout` on existing timer
- Fixed `pendingPhasePrompt` not being cleared in session history, causing stale phase prompts on session restore

### Changed

- **`write_tasks` schema restructured**: parameter schema changed from a flat `tasks` array (with per-task `phase` field) to a nested `phases` array where each phase has `title` and `tasks` properties; phase numbers are now auto-assigned from array position instead of specified per-task
- **`write_tasks` gains `mode` parameter**: `"replace"` clears the board before writing (rejects if any tasks are `implementing`/`reviewing`), `"append"` adds tasks to the existing board
- **Phase titles**: each phase now carries a short title stored in `PhaseRecord`, persisted in board snapshots, and displayed in the UI and status bar
- Validation error messages from `write_tasks` now include phase context for easier debugging
- Task IDs now use `t-{phase}.{index}` format (e.g., `t-1.1`, `t-2.3`) instead of `task-{N}`
- `edit_tasks` no longer supports `type: "advance"` — use the new `advance_tasks` tool instead
- Board rendering: phase headers use `─── Phase N ───` format, task lines use `{emoji} {id}: {title}` format
- `nextTaskId` field removed from `TaskBoardSnapshot` (backward compatible with old snapshots)
- Consolidated all `cloneBoard()` usage to a single helper, eliminating scattered deep-clone patterns
- Moved `getStatusCounts` from `engine.ts` to `validation.ts` to colocate with other status-related logic
- Replaced all magic status-string literals with the `TERMINAL_STATUSES` constant for consistency
- Renamed `detectPhaseCompletion` → `checkAndSetPhaseCompletion` to better reflect its side-effect nature

### Removed

- Removed dead code: `isValidTaskRecord`, `getActivePhase`, `getReadyTasks` (unexported), `resetAutoContinue`, and several internal helpers that were never called externally
- Removed duplicate and low-value test cases

### Refactored

- Extracted all TypeBox schemas from `engine.ts` into dedicated `schemas.ts` module
- Split monolithic engine.test.ts into 4 focused engine test files (engine-compile.test.ts, engine-edits.test.ts, engine-queries.test.ts, engine-write.test.ts). Added new test files for renderers.ts, index.ts, and config.ts coverage

### CI

- Updated CI pipeline to enforce coverage thresholds (statement and branch)

### Stats

- **Tests:** 278 (was 289 — net reduction from dead-code removal, offset by new coverage tests)
- **Statement coverage:** 95.69% (was 92.1%)
- **Branch coverage:** 93.14%

## 0.1.0 (2025-05-20)

### Added

- Initial release of pi-tasks extension
- 5 tools: `write_tasks`, `edit_tasks`, `compile_tasks`, `clear_tasks`, `get_ready_tasks`
- Strict task status gating with 7 statuses: `draft`, `configured`, `ready`, `implementing`, `reviewing`, `done`, `abandoned`
- Phase-based workflow with hard gating between phases
- Dependency tracking between tasks
- Auto-continue with circuit breaker (max 20 iterations)
- 3-second countdown with interrupt capability
- Session persistence via custom entries (event + snapshot)
- State reconstruction from snapshots on `session_start` and `session_tree`
- Hidden context injection via `before_agent_start`
- Deadlock detection with repair instructions
- Phase completion prompt template via `.pi/phased-tasks.json`
- 289 tests with 92% code coverage
