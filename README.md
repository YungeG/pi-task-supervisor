# Pi Task Supervisor

Package and local directory: `pi-task-supervisor`. Primary human command: `/task-supervisor`.

Local Pi `1.1.0` extension for session-scoped phased work and evidence-driven supervision. It reuses one task board, preserves human approval gates, and continues authorized unfinished work without repeated `continue` prompts.

This is a maintained fork of [`@harms-haus/pi-tasks`](https://github.com/harms-haus/pi-tasks). See [`UPSTREAM.md`](./UPSTREAM.md) for provenance. Install an explicit npm version or Git revision; isolated SDK/faux-provider validation is not certification of every live-model or business workflow.

## Installation

The npm beta target is `0.1.0-beta.1`, using the `beta` tag rather than `latest`. Verify registry availability before using the command below or replacing an installed Git pin. Requires Pi 1.1.0 and Node.js 22 or newer; host peer ranges describe Pi-supplied modules, not a promise that older Pi releases support the native supervision lifecycle.

```bash
pi install npm:pi-task-supervisor@0.1.0-beta.1
```

Do not leave the existing Git source enabled alongside the npm source: they have different package-manager identities and can register the same task tools twice. Keep the working Git pin until the npm release and source replacement are verified. Reload only in an idle session, or open a new Pi process.

## Human commands

```text
/task-supervisor enable
/task-supervisor supervise <goal>
/task-supervisor preflight <goal>
/task-supervisor approve <planId> <all|none|IDs>
/task-supervisor start <planId>
/task-supervisor revoke <planId>
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
- `resume` jointly resumes a confirmed ordinary human pause of the board and supervisor without resetting counters, usage, epoch, or evidence. Legacy/unknown pauses and stronger holds resume only the board and explicitly require inspection plus `recover`; no automatic Main turn is started. Decisions, pending host work, wrong sessions, and inconsistent state do not gain joint recovery. `resolve` changes only the exact decision gate. `recover` retains its explicit counter-reset semantics and never grants other approvals or restarts external writers. Faulted completed boards require stopping and re-planning.
- `status` is read-only even while disabled or journal-faulted. It reports the goal, host activity, claimed batch, soft check point, all available gate information, advisor-only usage/limits, unknown external run status, and the next valid human action.
- `tasks` opens a scrollable full list, including completed/abandoned tasks; select a task to inspect its details and retained evidence. This read-only view works even when task tools are disabled or the supervisor journal is faulted, and never activates supervision or schedules work.

Activation is a durable session entry. Resuming restores it; independent sessions remain disabled. Forks inherit the board/activation but **not the source session's supervisor**. Any unfinished supervisor restored after restart/tree navigation becomes an interrupted fault requiring inspection and explicit recovery, never an active-but-idle badge.

## Opt-in authorization preflight (local source candidate)

The four preflight commands above exist in this source revision; recovery-hotfix snapshot `273cc79` does not include them. Implementation and isolated validation are separate from delivery authorization. A later explicit user instruction authorized commit, push and exact-revision installation; npm publication and business deployment remain outside that instruction. Verify the selected package revision before using the new commands.

- `preflight <goal>` requires an idle host, no pending work, an empty board and no unstopped supervisor. It records planning and sends a hidden **read-only planning instruction**, without starting supervision or creating tasks.
- `submit_preflight` is the model's proposal-only tool. It inventories required/optional permissions, limits, risks, alternatives, prohibitions and reconfirmation conditions. It cannot approve or start work. Complete proposals have a 16,000-byte UTF-8 limit and exact session/goal/revision/digest identity.
- Human `approve` confirms the exact proposal and **replaces** the selected permission IDs. `all` selects all listed IDs; `none` selects no extra permissions. Missing required IDs prevent startup. Approval never dispatches Main.
- Human `start` separately rechecks the current-branch control receipt and all existing gates, then binds the approved plan and dispatches Main once. With no preflight record, legacy `supervise` remains immediate; it cannot bypass a selected preflight for the corresponding goal.
- `revoke` cancels this plugin's review, requests Main abort when needed, waits for actual idle and records revocation. It preserves the board/evidence and stronger holds; it cannot stop or roll back external processes. Reapproving an unchanged started plan does not resume it: existing `resume`/`recover` gates still apply. `stop` does not detach a retained started board from its authorization; a revoked grant still blocks board-only resume and task mutation.

Task mutation is blocked during planning/approval and when a bound grant is missing or revoked. Restarts and tree navigation validate the current session/branch closure without replay; forks do not inherit the grant. Complete preflight material is protected inside the unchanged 64,000-byte advisor packet cap. This is an execution agreement, **not an OS sandbox or general tool-permission engine**: other tools keep existing host controls, and Main must check natural-language limits and reconfirmation conditions before acting.

## Visible task board

In the interactive terminal, a persistent board appears above the editor. It uses the existing session snapshot, not a separate task store:

```text
╭─ Tasks  2/6 done · 4 unfinished
│  Workflow: active · Phase 2: Implement
│  ▶ doing  t-2.1  Login endpoint
│  ◇ review t-2.2  Error handling
│  ○ queued t-3.1  Documentation · waiting for t-2.1; waiting for phase 3
│  ○ queued t-3.2  Final acceptance · waiting for t-2.2, t-3.1; waiting for phase 3
╰─ /task-supervisor tasks · 2 folded
```

The widget uses Pi's active theme, a subtle left rail, aligned status/ID columns, and bold titles for implementing/reviewing tasks. Monochrome glyphs and labels keep status readable without color: `▶ doing` (implementing), `◇ review` (reviewing), `● ready`, `○ queued` (configured), and `· draft`. IDs are capped at 14 display columns; full IDs remain in the read-only list. Zero overflow/fold counts are omitted from the footer; overflow appears as `+N more`.

The widget is capped at eight single terminal lines and prioritizes implementing/reviewing tasks, then ready and planned tasks. It shows unmet dependencies, later-phase gates, execution references (status unknown), pending decisions, pause reasons, supervisor holds/faults, and a compact next-action line. Long lines are truncated to terminal width; the full list/details remain available through `/task-supervisor tasks` (also `/continuous-tasks tasks`). Completed and abandoned tasks are folded, never auto-deleted; abandoned tasks are counted separately from verified completion. Empty fresh sessions have no widget. RPC/print modes have no custom widget; RPC can use the native list command.

## Closed loop and evidence

1. Main prepares a phased board, claims one ready batch, implements work, and enters review. The execution guidance asks it to finish the run normally after verifying that batch, before claiming another; this is not a host-enforced phase gate.
2. Actual host `tool_result` events create bounded evidence receipts (`tool:<call-id>`).
3. When Main stops, Pi's actionable `agent_before_settle` boundary runs after automatic compaction, retries, and queued work drain. The read-only advisor examines the durable goal, board, host receipts, and recent transcript.
4. Valid guidance is returned as a hidden typed boundary entry, and Pi resumes Main automatically. Guidance is **not user approval**. `agent_settled` is notification-only and reconciles native aborts; it never schedules work.
5. Acceptance requires every task to be done, no unresolved execution receipts, final dependency closure covering the whole board, unchanged host-bound task evidence, and fresh final validation. There is no percentage-completion rule.

Under supervision, each review-to-done transition requires a passing **command** reference to a successful host receipt captured during that exact task review, at the current mutation epoch, with observed structured `exit_code: 0`. Main-supplied status/exit codes alone are not proof. Acceptance advice must cite successful receipts bound to completed tasks. Unknown tools (including `bash`) conservatively advance the mutation epoch unless explicitly annotated read-only. Later potentially mutating tools revoke acceptance visibly.

A host tool without structured exit status cannot prove command success; use a host validation tool that exposes it. These receipts establish host observation, not the truth or quality of arbitrary external tool output. The advisor judges goal coverage; the task/evidence gates are deterministic.

## Existing async execution

When all claimed tasks have exact `workflow_gate` execution references, the native boundary checks the installed execution owner's versioned `pi-subagents` RPC `ping/status` contract. A complete, current-session snapshot reporting queued/running work establishes a finite wait instead of another advisor call or stagnant continuation. A completed workflow parent with active children still waits.

The first wait has a fixed 30-minute deadline, not renewed by status checks. There is one expiry timer, no executor/model polling. Missing, truncated, foreign, unknown, failed or stopped status fails closed and retains run references. `status` shows the **last owner report**, not independent proof that an OS process is alive.

The executor still owns result delivery, deduplication and waking Main; Supervisor does not duplicate completion handlers or schedule another turn. Successful terminal status with unresolved references remains `results_pending` within the original deadline. Main must inspect results, clear exact references, and collect fresh host validation before completing tasks. Notifications cannot accept a task or clear pause/stop, decisions, faults or exhausted budgets. Restart/tree navigation and compaction during a wait require inspection and explicit recovery. Dispatch, concurrency, write permissions and worktrees remain with Main/the existing executor.

## Safety and limits

- Task tools are removed/blocked until a human command activates the session. Supervisor state is isolated per extension instance.
- Supervisor holds/faults, board pauses, and real decision gates block task mutation. Completed supervised tasks are frozen; required tasks cannot be discarded or abandoned.
- The advisor uses the pinned **session runtime** model with no executor tools or separate credential discovery. Common credential patterns are redacted in captured receipt text and advisor packets; this is not a general secret scanner. Do not put credentials in goals, tasks, or tool labels.
- Reviews have a 30-second bound, a 64KB packet cap, and a 2048-token output cap. Limits: 40 reviews, 20 resumes, three non-progress continuations, 500 receipts, and at most 100 supervised tasks/bindings. Oversized plans are rejected on start, write, and recovery. Explicit recovery resets review/resume/stagnation counters, not approvals or recorded usage.
- Packet size is measured in UTF-8 bytes. The complete goal, task board, selected receipt identities/digests, and bound validation receipts are never shortened. When space is tight, only unbound receipt and recent-transcript excerpts are shortened and explicitly marked; durable history is unchanged. Oversized protected material still fails closed before any advisor call.
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

`check` runs type checking, lint, format checks, coverage (unchanged 90% branch gate), and eight isolated real-Pi **faux-provider** smokes: board-only, supervised, automatic compaction, paused in-flight review plus compaction, native boundary abort/recovery, ordinary pause/single-command resume with retained counters, owner-confirmed async waiting followed by executor-owned result delivery and fresh Main acceptance, and opt-in preflight with a required/optional inventory, explicit human-command approval and separate start. SDK hosts must bind real command-context actions, including `waitForIdle`; a still-busy host after that callback is rejected rather than treated as settled. Smokes use temporary agent directories, no builtin executor tools or live inference, and verify real settings remain unchanged.

Compatibility evidence and limitations: [`CANARY.md`](./CANARY.md). Original workspace design: [`../docs/continuous-tasks-extension-design.md`](../docs/continuous-tasks-extension-design.md) (outside this standalone repository; not included in a Git checkout or package).

## Flow optimization proposal

[Supervisor flow optimization](./docs/supervisor-flow-optimization.md) records Stage 1 and the narrowed Stage 2 async integration. The [Stage 1 contract](./docs/supervisor-flow-implementation-packet.md) and [async integration contract](./docs/supervisor-async-integration-packet.md) freeze authority, recovery semantics, persistence failure handling, and validation scope. Publication and installation require explicit authorization and a pinned revision; the earlier document review is not an implementation review.

## Authorization preflight design

[Pre-execution authorization preflight](./docs/supervisor-permission-preflight-design.md) describes read-only planning, explicit scoped user approval, and supervised execution without repeated requests inside the approved scope. It distinguishes user authorization from host tool permissions and defines when renewed confirmation is required. The locally authorized [implementation contract](./docs/supervisor-permission-preflight-implementation-packet.md) freezes opt-in commands, exact plan/approval identity, recovery and acceptance requirements. The local source candidate now implements this opt-in path. The authorized independent read-only implementation review has completed; Main reproduced and fixed its two concrete findings with targeted regressions. Final task-board acceptance uses its own fresh host proof. Subsequent authorized installation is a separate operation and must select this source revision rather than the old recovery-hotfix snapshot. Neither document grants host-policy changes, publication or installation.
