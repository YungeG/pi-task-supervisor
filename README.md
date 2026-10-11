# Pi Task Supervisor

Package and local directory: `pi-task-supervisor`. Primary human command: `/task-supervisor`.

Local Pi `1.1.0` extension for session-scoped phased work and evidence-driven supervision. It reuses one task board, preserves human approval gates, and continues authorized unfinished work without repeated `continue` prompts.

This is a pinned local fork of [`@harms-haus/pi-tasks`](https://github.com/harms-haus/pi-tasks). See [`UPSTREAM.md`](./UPSTREAM.md) for provenance. This candidate has only been developed and tested locally; it is not a deployed supervisor replacement.

## Human commands

```text
/task-supervisor enable
/task-supervisor supervise <goal>
/task-supervisor status
/task-supervisor tasks
/task-supervisor pause [reason]
/task-supervisor resume
/task-supervisor resolve <decision-id> <answer>
/task-supervisor recover
/task-supervisor stop
```

`/continuous-tasks` remains a legacy alias for every subcommand. Both names control the same board and supervisor; activation is idempotent across aliases. Existing `continuous-tasks:*` journal entries, messages, and renderers retain their identifiers, so saved sessions need no migration.

- `enable` activates task tools for this session without starting a supervisor.
- `supervise` records a bounded, non-secret goal, pins the current session model, activates tools, and starts Main using a hidden custom message. An existing goal must be stopped before replacement. A paused/decision-gated board must be human-resolved first; already completed tasks cannot be reused as proof for a new goal.
- `pause` cancels an advisor immediately and pauses Main/the board. `stop` also stops supervision and prevents silent fallback to board continuation.
- `resume`/`resolve` change only the board gate. They do not reset supervisor holds, faults, or budgets. `recover` explicitly restarts a paused/faulted supervisor after the board gate is resolved; it does not grant approval or restart external writers. Faulted completed boards require stopping and re-planning, not recovery.
- `status` reports board state, supervisor state, review/resume counts, and recorded usage.
- `tasks` opens a scrollable full list, including completed/abandoned tasks; select a task to inspect its details and retained evidence. This read-only view works even when task tools are disabled or the supervisor journal is faulted, and never activates supervision or schedules work.

Activation is a durable session entry. Resuming restores it; independent sessions remain disabled. Forks inherit the board/activation but **not the source session's supervisor**. Any unfinished supervisor restored after restart/tree navigation becomes an interrupted fault requiring inspection and explicit recovery, never an active-but-idle badge.

## Visible task board

In the interactive terminal, a persistent board appears above the editor. It uses the existing session snapshot, not a separate task store:

```text
Tasks: 2/6 done · 4 unfinished
Workflow: active · Phase 2: Implement
[implementing] t-2.1 Login endpoint
[reviewing] t-2.2 Error handling
[configured] t-3.1 Documentation — waiting for t-2.1; waiting for phase 3
[configured] t-3.2 Final acceptance — waiting for t-2.2, t-3.1; waiting for phase 3
/task-supervisor tasks · 0 more unfinished · 2 terminal folded
```

The widget is capped at eight single terminal lines and prioritizes implementing/reviewing tasks, then ready and planned tasks. It shows unmet dependencies, later-phase gates, execution references, pending decisions, pause reasons, and supervisor holds/faults. Long lines are truncated to terminal width; the full list/details remain available through `/task-supervisor tasks` (also `/continuous-tasks tasks`). Completed and abandoned tasks are folded, never auto-deleted; abandoned tasks are counted separately from verified completion. Empty fresh sessions have no widget. RPC/print modes have no custom widget; RPC can use the native list command.

## Closed loop and evidence

1. Main prepares a phased board, implements work, and enters review.
2. Actual host `tool_result` events create bounded evidence receipts (`tool:<call-id>`).
3. When Main stops, Pi's actionable `agent_before_settle` boundary runs after automatic compaction, retries, and queued work drain. The read-only advisor examines the durable goal, board, host receipts, and recent transcript.
4. Valid guidance is returned as a hidden typed boundary entry, and Pi resumes Main automatically. Guidance is **not user approval**. `agent_settled` is notification-only and reconciles native aborts; it never schedules work.
5. Acceptance requires every task to be done, no unresolved execution receipts, final dependency closure covering the whole board, unchanged host-bound task evidence, and fresh final validation. There is no percentage-completion rule.

Under supervision, each review-to-done transition requires a passing **command** reference to a successful host receipt captured during that exact task review, at the current mutation epoch, with observed structured `exit_code: 0`. Main-supplied status/exit codes alone are not proof. Acceptance advice must cite successful receipts bound to completed tasks. Unknown tools (including `bash`) conservatively advance the mutation epoch unless explicitly annotated read-only. Later potentially mutating tools revoke acceptance visibly.

A host tool without structured exit status cannot prove command success; use a host validation tool that exposes it. These receipts establish host observation, not the truth or quality of arbitrary external tool output. The advisor judges goal coverage; the task/evidence gates are deterministic.

## Safety and limits

- Task tools are removed/blocked until a human command activates the session. Supervisor state is isolated per extension instance.
- Supervisor holds/faults, board pauses, and real decision gates block task mutation. Completed supervised tasks are frozen; required tasks cannot be discarded or abandoned.
- The advisor uses the pinned **session runtime** model with no executor tools or separate credential discovery. Common credential patterns are redacted in captured receipt text and advisor packets; this is not a general secret scanner. Do not put credentials in goals, tasks, or tool labels.
- Reviews have a 30-second bound, a 64KB packet cap, and a 2048-token output cap. Limits: 40 reviews, 20 resumes, three non-progress continuations, 500 receipts, and at most 100 supervised tasks/bindings. Oversized plans are rejected on start, write, and recovery. Explicit recovery resets review/resume/stagnation counters, not approvals or recorded usage.
- Malformed journals, model failures, timeouts, stale branches, and exhausted budgets stop visibly. There is no unsupervised fallback after a supervised failure.
- Automatic pre-boundary compaction preserves durable goals/receipts. Compaction hooks cancel in-flight reviews and reject late results.
- **Pi 1.1 native abort/manual compaction during an awaited boundary waits for that boundary to return.** Use `/task-supervisor pause` first for immediate advisor cancellation. Native abort is reconciled as paused after return (bounded by the review timeout); Pi can persist an aborted guidance draft but does not run it. Resume/recovery remain explicit.
- This is not an OS/tool permission sandbox. Other Main tools retain the host's existing permission controls. The extension does not deploy, merge, push, release, manage credentials, or launch subagents itself.
- Do not load together with `@harms-haus/pi-tasks` or `@tintinweb/pi-tasks`: overlapping task tools have different evidence semantics.

## Task lifecycle and tools

```text
draft → configured → ready → implementing → reviewing → done
```

```text
write_tasks → edit_tasks → compile_tasks(finalAcceptanceTaskId)
→ get_ready_tasks → implementation → advance_tasks(→ reviewing)
→ fresh review/validation → advance_tasks(→ done, evidence)
```

Tools: `write_tasks`, `edit_tasks`, `compile_tasks`, `clear_tasks`, `get_ready_tasks`, `advance_tasks`, `workflow_gate`.

`compile_tasks` requires a final acceptance task in the last phase whose dependency closure covers every earlier task. `workflow_gate` creates user-owned decisions and binds/clears exact opaque execution receipts; it never starts or controls the referenced run.

## Configuration

Optional `~/.pi/agent/continuous-tasks.json` (or `$PI_CODING_AGENT_DIR/continuous-tasks.json`). This legacy filename is intentionally unchanged; no new config path or migration is introduced:

```json
{
  "maxStagnantSettles": 5,
  "requireCompletionEvidence": true
}
```

Missing/invalid settings use safe defaults. `countdownMs` remains parse-compatible but is deprecated and ignored: native continuation has no countdown. Supervisor host-evidence requirements cannot be waived by `requireCompletionEvidence: false`. `phaseCompletionPromptTemplate` may include `{phase}`.

## Local development

```bash
npm ci --ignore-scripts
npm run check
```

`check` runs type checking, lint, format checks, coverage (unchanged 90% branch gate), and isolated real-Pi **faux-provider** smokes: board-only, supervised, automatic compaction, paused in-flight review plus compaction, and native boundary abort/recovery. Smokes use temporary agent directories, no builtin executor tools or live inference, and verify real settings remain unchanged.

Compatibility evidence and limitations: [`CANARY.md`](./CANARY.md). Original workspace design: [`../docs/continuous-tasks-extension-design.md`](../docs/continuous-tasks-extension-design.md) (outside this standalone repository; not included in a Git checkout or package).
