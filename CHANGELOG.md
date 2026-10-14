# Changelog

## Unreleased source revision

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
