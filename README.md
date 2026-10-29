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
/task-supervisor tasks-only               # task board only; no automatic Supervisor
/task-supervisor disable                  # safe release after actual quiescence
/task-supervisor supervise <goal>          # read-only planning, not immediate execution
/task-supervisor supervise --replan [goal] # same unstarted target only; no inherited old-attempt grant
/task-supervisor supervise -- <goal>       # literal goal text that starts with --
/task-supervisor approve [planId [all|none|IDs]]
/task-supervisor start [planId]
/task-supervisor revoke <planId>
/task-supervisor status
/task-supervisor tasks
/task-supervisor history [goalKey|page:offset]  # read-only archived goals
/task-supervisor pause [reason]
/task-supervisor resume
/task-supervisor decide
/task-supervisor repair-decision          # confirmed board cache only
/task-supervisor repair-preflight         # confirmed preflight cache only
/task-supervisor recover
/task-supervisor review-contract <proposalId> # native definition review before compilation
/task-supervisor verify-check <checkId>    # current manual artifact condition, not business approval
/task-supervisor review-scope <proposalId> # exact same-Goal amendment; remains held
/task-supervisor repair-scope <proposalId> # original witnessed metadata only
/task-supervisor revoke-scope <revisionId> # revocation never falls back to older execution rights
/task-supervisor retry-review [attemptId]  # completed work: review/qualified validation only
/task-supervisor repair-completion <intentId> # candidate: confirmed missing metadata only, never replay
/task-supervisor stop
```

Only `/task-supervisor` is registered. The old `preflight`, `enable`, `supervise-legacy`, `resolve` subcommands and `/continuous-tasks` prefix are removed, not forwarded. Repeated `tasks-only` is idempotent; using it while supervised is an explicit mode change, not a read-only view. Existing `continuous-tasks:*` journal entries, messages, and renderers retain their identifiers. Historical records remain readable, but untyped legacy decisions require a complete replacement proposal and a new native response; unknown or inconsistent authorization history is held, not silently migrated.

- `tasks-only` selects **tasks** mode: task tools without a Supervisor/Advisor. After detaching a Goal, it creates an independent empty board rather than reviving old grants, evidence or supervision; an existing bare task board can remain explicit tracking history/work.
- `supervise` consistently enters **supervised read-only planning**, including a fresh session. Native permissions and separate first-start remain required. With stopped/completed history it uses native archive-and-plan for an independent GoalRun in the **same Session**. Archive is not business approval or Start. There is no direct compatibility-start command. Real pending decisions, faults and unknown external execution still block; old done tasks are never new proof.
- `pause` cancels an advisor immediately and pauses managed Main/the board. `stop` and `disable` cancel local automation first, then confirm actual Main/queue, writer, host-capture and native-control quiescence before publishing **off**. No executor is killed, task forced done or reference discarded. Unknown outcomes remain `stopping-with-attention`; repair only exact existing metadata/original native questions, then repeat `disable`. Known settled business failure or a confirmed native rejection may remain history. Neither `recover` nor a model flag forces release.
- `resume` jointly resumes a confirmed ordinary human pause of the board and supervisor without resetting counters, usage, epoch, or evidence. Legacy/unknown pauses and stronger holds resume only the board and explicitly require inspection plus `recover`; no automatic Main turn is started. Decisions, pending host work, wrong sessions, and inconsistent state do not gain joint recovery. `decide` collects a native response for the exact current decision; command answer text is not authorization. `recover` clears an applicable hold after inspection but preserves spent review/continuation budgets, usage and Goal identity. It never grants other approvals or restarts external writers. Generic recovery still cannot reopen faulted completed boards. The candidate's `retry-review` path below retries only review or registers a constrained final validation; it does not redo completed tasks.
- `status` is read-only even while disabled or journal-faulted. It reports the goal, host activity, claimed batch, soft check point, all available gate information, advisor-only usage/limits, unknown external run status, and the next valid human action.
- `/task-supervisor tasks` opens a full readonly TUI board with fixed 总览 / 确认与回应 / 最终验收 entries, even with zero tasks. Filter tasks by status/phase and inspect complete details and retained evidence; Esc returns from a detail/filter to the list, then to the editor. It works while disabled or journal-faulted and never activates supervision or schedules work. RPC/print retain their existing text/select fallback.

The local candidate has one host-selected **off / tasks / supervised** mode and **unmanaged / board / Goal** work context; `enabled` is only its compatibility projection. Fresh sessions are off. With no mode record, retained legacy management is restored compatibly/held, not silently turned off. Confirmed mode/owner records are Session/branch-bound, take precedence over old activation=true, and cannot lend authority to a fork or another Session. Legacy pure board/activation inheritance is not a Goal grant. Unfinished supervision restored after restart/tree navigation remains interrupted/held rather than automatically running. Fileless/setup-only management is explicitly volatile, not a recoverable approval or durable off proof; later materialization never erases a stop intent.

In off mode, ordinary host-authorized work is unmanaged: it neither borrows old permissions nor enters the old Goal ledger. Old callbacks cannot become a new owner's evidence; late Advisor usage still belongs to its original call/owner. Recorded acceptance is immutable history, separate from current applicability (`needs_verification`/`stale`). `status` and the read-only overview show mode, work context, retained Goal/acceptance and attention. Loaded code revision is **unknown** unless actually established; on-disk edits or Git HEAD alone are not proof of the running revision.

## Same-Goal scope amendments

For an already started, compiled and held Goal, Main submits complete `propose_scope_revision` metadata. Native `review-scope` shows the original Goal/permission/Start sources, old and proposed constraints and check definitions. Only the complete witnessed commit makes the candidate contract current. The original Goal, task IDs, first Start, permissions and accounting stay intact; reviewing or repairing does not resume work. Resume a separate board gate if needed, then explicitly `recover` to adopt the committed scope. Current-source, capability, budget and fresh-evidence gates still apply.

Version1 keeps the existing workspace, permission/capability objects, scope/input/output/environment objects and requirement/check identities; it amends precise conditions, not guessed “latest values”. Native material is bounded without omissions. `repair-scope` completes only the original witnessed metadata; changed material needs a new exact review. `revoke-scope` also blocks dependent successors and never falls back to older execution rights. Old success/receipts remain history, not new-scope validation. These agreements are not a hostile-code sandbox.

Default models-enabled codemode cannot certify tools-only evidence. Capability checks before Start/recover select an actual supported direct check path or report unsupported. Direct SDK root seals say **observed**, not container-qualified. Spent/unknown review and continuation budgets cannot be replenished by recover or a scope amendment.

## Sequential goals in one Session (local source candidate)

A Session retains the conversation; one GoalRun is current and earlier goals are read-only archives. After explicitly ending a goal, use `supervise <new goal>` and the native archive-and-plan choice. Do **not** clear historical tasks or open another Session merely to free a goal slot. Archive keeps unfinished task statuses, usage, evidence, permissions and holds unchanged; it does not complete, abandon, revoke, reset or terminate old work.

The new GoalRun has its own empty board, planning attempt, permission/start requests, ledger and accounting. No old receipt, task ID, digest, grant, external reference or quota usage is inherited. Reusing the same goal text or task IDs does not reuse identity. A separate native permission response and first-start are still required before business execution.

Before Supervisor exists, `supervise --replan [same goal]` explicitly replans the same target using a fresh attempt/preflight ID; repeated `supervise` only reports status. `stop` can end a positively never-started goal without inventing a Supervisor or revoking closed grants. Real unanswered permission/start work and unknown business execution stay with their original owners. Lost pure-planning output can be closed only after actual host/queue quiescence and lease cancellation. Reopening/repair never redispatches planning or execution.

`history` lists at most ten archived summaries per page; `history page:10` requests the next text page, and `history <goalKey>` opens one archived board. The current board also has a history entry. Viewing it never swaps the current runtime, executes work or grants authority; raw receipt bodies are not copied into the history DTO. Stopped-unstarted goals leave no resident work badge, while independent problems remain visible.

Lifecycle checkpoints use strict wire5, scoped owner snapshots use carrier3, and archive readback uses goal frame2; receipt-ledger format remains3. Legacy formats1/2/3 retain their identity rules; unintegrated recovery wire4 is held, not guessed. Older readers must refuse the new fence. Full cold/native/compatibility validation and independent implementation acceptance are still required for this candidate; nothing here installs or reloads it.

## Native human responses (local source candidate)

The UI readability candidate keeps planning, awaiting authorization and approved-but-not-started visible even before tasks exist. Native prompts group the complete selected/unselected permissions, limits, risks, prohibitions and reconfirmation conditions instead of duplicating the full scope as JSON. Chinese display choices map to unchanged internal outcomes; arbitrary business-choice values remain verbatim. Required-only selection and a separate first-start confirmation are unchanged.

Human notifications and interactive tool results link to `/task-supervisor tasks → 确认与回应`; non-TUI command text and machine-facing content/details remain unchanged. Expanded preflight results retain the complete original request, explicitly marked as not being a current grant. The readonly history separates the current request, latest saved branch response and preflight material: missing/unconfirmed history is shown as absent/unknown, not replaced by an older answer. Viewing history grants no authority.

Before the native final select/input, a readonly paginated scope review renders all material with visible significant whitespace/control escapes. Review alone is not an answer; the final short title identifies the purpose/request. Users can review again. Invalid information is explicitly unsaved and offers an explicit retry or defer; rejected input is not echoed. Required-only permissions, indexed business choices mapped to exact original values, and the separate first-start confirmation remain unchanged. UI checks are local SDK-boundary simulations, not new native product acceptance. Full/coverage/native validation is still pending for this integrated revision; SDK1.2 is MISSING this round. No installation, merge or business use is claimed.

New approvals support the trusted local Node Pi CLI/TUI with real stdin/stdout TTYs and a recoverable session JSONL file. The first structured request opens the complete readonly scope review, then Pi's native select/input; no decision ID or second resolve command is needed. Bare chat, RPC/print, ordinary SDK custom UI, model flags and copied result objects do not submit new approval. This is a trusted-host boundary, not authentication against malicious same-process/OS programs.

`workflow_gate` proposals declare `decision.spec.version: 1` and one kind: `authorization` with exact `scope`/`prohibitions`; `choice` with exact options; or `information` with `text`/`integer`/`date` format. Only authorization approval grants that displayed scope. Choice/information resolve their information gate without new business rights. Main supplies a complete same-task `supersedes` replacement for legacy/rejected gates; this changes metadata only, never task execution/evidence.

Approve resolves only that gate. Reject retains waiting and does not nag; defer/cancel saves no final response. Independent preflight permissions, Supervisor faults, budgets, execution references and final evidence stay in force. An existing confirmed response is never obtained again just because a derived cache failed.

Saved results require actual file readback of the owner control and its derived witness, not an in-memory leaf. `repair-decision`/`repair-preflight` recheck original proof and repair only a missing derived cache: no new approval, witness, startup, scope enable, budget reset or Main dispatch. Broken physical ancestry, conflicting history and an unconfirmed start stay visibly held; do not retry uncertain external execution. In-memory/setup-only sessions cannot save recoverable approvals.

## Opt-in authorization preflight (local source candidate)

These native-interaction commands are a **local source candidate**. This integration has not been committed or installed; earlier delivery authority for another revision does not authorize this feature. Verify the selected package revision before using it.

- For a fresh legacy goal, `preflight <goal>` requires an idle host, no pending work, an empty board and no unstopped supervisor. Terminal history uses the sequential-goal lifecycle above instead. It records planning and sends a hidden **read-only planning instruction**, without starting supervision or creating tasks.
- `submit_preflight` is the model's proposal-only tool. It inventories required/optional permissions, limits, risks, alternatives, prohibitions and reconfirmation conditions. It cannot approve or start work. Complete proposals have a 16,000-byte UTF-8 limit and exact session/goal/revision/digest identity.
- Human `approve` opens the same native confirmation and **replaces** the selected permission IDs. With no arguments it selects only declared required IDs, never optional rights. Compatible explicit `all`/`none`/exact subsets still require the final native response. Missing required IDs prevent startup; complete approval is **approved, not started**, and never dispatches Main.
- Human `start` needs no plan ID: it separately presents native first-start confirmation, rechecks the current-branch approval and all existing gates, then binds the same approved plan and dispatches Main once. An explicit plan ID is only a stale-ID check. With no preflight record, only explicitly selected `supervise-legacy` retains immediate compatibility behavior; ordinary `supervise` still plans first, and neither path bypasses a selected preflight for the corresponding goal.
- `revoke` cancels this plugin's review, requests Main abort when needed, waits for actual idle and records revocation, without requiring a native UI response first. It preserves the board/evidence and stronger holds; it cannot stop or roll back external processes. Reapproving an unchanged started plan does not resume it: existing `resume`/`recover` gates still apply. `stop` does not detach a retained started board from its authorization; a revoked grant still blocks board-only resume and task mutation.
- Permission withdrawal is **not a final answer to an unresolved question**. An unanswered or historically ambiguous request still holds stop/archive after revoke. Use `approve` to respond through the original owner's native UI; select **Reject / 不允许** to keep permission absent, then explicitly `revoke <planId>` again before archive if needed. For a current stopped/completed GoalRun with an unresolved question this entry is **denial-only**: Allow and Later publish no permission control, grant or Start, and do not revive the goal. An already-finalized closed owner cannot create a new question through this entry. Faults and other independent holds still apply; no archived runtime is installed.

Task mutation is blocked during planning/approval and when a bound grant is missing or revoked. Restarts and tree navigation validate the current session/branch closure without replay; forks do not inherit the grant. Complete preflight material is protected inside the unchanged 64,000-byte advisor packet cap. This is an execution agreement, **not an OS sandbox or general tool-permission engine**: other tools keep existing host controls, and Main must check natural-language limits and reconfirmation conditions before acting.

## Visible task board

In the interactive terminal, a persistent board appears above the editor. It uses the existing session snapshot, not a separate task store:

```text
┌ 任务监督 · 需检查 ───────────────────────────────────────────────────┐
│ 已完成 2/6 · 未结束 3 · 放弃 1  ████░░░░░░░░                         │
│ 阻塞：旧版执行记录需显式恢复／迁移                                   │
│ 待办：处理指引尚未一致，请查看完整状态                               │
├ 当前任务记录 ────────────────────────────────────────────────────────┤
│ 阶段：Implement                                                      │
│ 实施记录 · t-2.1 Login endpoint                                      │
└ /task-supervisor tasks · 验收未记录 ─────────────────────────────────┘
```

The resident card uses the active native theme, at most eight lines and at most 96 terminal columns; below 32 columns it falls back to clipped plain text. It separates done/unfinished/abandoned counts and recorded work from execution liveness. Known internal receipt-hold and conflicting-next-step messages have display-only Chinese aliases, never new recovery instructions or permissions. Unknown owner text remains unchanged. The original error, next-step value, complete goal and acceptance-task metadata remain in the full readonly routes. With no tasks, the goal and captured permission state stay visible; no approval is inferred. Task completion and even a completed acceptance task do not by themselves claim goal acceptance.

While tasks exist, the compact card prioritizes blocker/next guidance, current phase and task record; full goal text and other notices move to the full board instead of competing for resident width. Full IDs, prompts, dependencies, evidence, risks and original values remain available. Navigation consumes one frozen capture, so reopen to see newer facts. Fresh empty sessions have no resident widget, but the three fixed board entries remain reachable.

After an explicit `stop`, quiet retained history no longer keeps the TUI card or status line resident; `tasks`, `status` and the readonly board still retain that history. Independent planning, decisions, repairs, integrity/receipt issues, uncertain execution and identity mismatches remain visible. An idle host alone never means the goal has stopped. Explicit board-only resume makes the active board visible again without restarting supervision. RPC text behavior is unchanged.

The structured readonly board keeps captured state and the original next-step guidance before secondary progress. A thin separator divides that summary from the fixed 总览 / 确认与回应 / 最终验收 routes and a phase/task tree. The captured active phase starts expanded; Enter on a phase only expands/collapses local navigation. Status and phase filters remain independent, including empty/no-match states.

At 100 columns or wider, native TUI layout puts a readonly preview beside the tree; narrower terminals remain single-column. Previews show meaningful task/state/record summaries, not capture JSON. Enter on a task or fixed route still opens the complete original material with all IDs, whitespace, evidence, risks and capture identity; Esc returns to the same filter/cursor, then to the editor. A preview is neither full-material review nor an answer. The progress bar counts only done tasks, not abandoned tasks or goal acceptance. No recovery/approval/start callback is added to this view.

This compact-card revision is an isolated presentation candidate. It does not change the installed package or reload any current/business session. Its current source and terminal-component validation are recorded separately; earlier native product pilots must not be relabeled as acceptance of this new layout.

Use ↑↓ to scroll full details in both terminal modes. Pi fullscreen reserves PgUp/PgDn for its host viewport; those keys are not promised for embedded detail scrolling. Component page bindings remain available when the host forwards them; this extension does not intercept host keys or use an overlay as an ownership workaround.

The status bar is text-only through the existing Pi status API; this extension does not replace the footer. Opening its own board or native question suppresses only its own resident widget. A native question preempts and actually joins its own reader; the final valid release resnapshots through the original publisher. Session/tree/shutdown cleanup invalidates stale displays. This coordinates only this extension's A/C views, not arbitrary third-party chrome or a cross-extension atomic lease. RPC/print have no custom widget and keep the original text/select behavior.

Supervisor footer entries are synchronized on every UI refresh, including RPC/print clients. A missing or foreign-session owner, or a stopped owner with no pending operation, clears the old Supervisor entry without deleting history or changing task/goal state. Current active/reviewing/held/completed owners and real journal, projection, receipt-identity or GoalRun attention remain visible. This is deterministic display cleanup, not stop/recover, inherited authorization, or goal acceptance. A completed task board alone does not stop a current valid Supervisor.

## Human decision materials

The built-in board, preflight and archive-and-plan questions now open **A: a formatted decision card with real native draft controls**. The question, Markdown context, owner-derived scope/risk summary and native `SelectList` or `Input` remain on the same screen. Long summaries are visibly marked as incomplete. This replaces the earlier candidate that merely renamed the raw pager as A; materialless legacy callers retain their existing transport.

`F4` opens **B: read-only Markdown material**; Esc or the configured confirm key returns to the same draft. `m` is an additional shortcut only outside information fields and when it does not conflict with a native binding. Information fields keep literal typing, cursor/IME focus and their draft across browsing. Rejected input is discarded together with native undo/kill-ring state, without echoing it into errors or final dialogs.

`F2`, or submitting an unreviewed draft, opens the complete exact-source scope. Every original page must still render; review completion only returns to the card and never submits the draft. At 100 columns or wider, `F3` enables **C: actual draft controls beside the original scope**; Tab moves focus between answer and source. A native action bound to those keys always wins. Resize resets canonical coverage while preserving the draft; narrow terminals return to A. No global input listener, overlay or new framework is added.

An explicitly submitted, fully reviewed draft is privately branded for that captured question instance. A forged custom result or completion DTO cannot become a native answer. A separate **native final selector** confirms only that draft, with bounded request identity, question context and a safe draft excerpt; business values retain their original ordinal and bytes. Information is entered once in the card and confirmed without retyping. Returning to modify retains only a valid draft; explicit source review requires a new complete check. Approval and first-start remain separate. The original answer registry, session/branch/currentness checks and physical control/witness publication remain in force.

Offline actual-CLI/PTY checks: `python3 test/goal-native-smoke.py permissions --decision-layouts` covers archive, permission and separate startup; `python3 test/goal-native-smoke.py information` types a value, browses material, reviews in C and checks its exact saved answer. These use owned synthetic sessions and keys, not live business work or human identity proof.

All material is captured before asynchronous interaction. Deferred layout uses captured materials and prepared native syntax output, with the supplied native theme for text styling; it does not read owner state, journals, history, files, network or wall clock. The resident card, board navigation, machine content, canonical values, permission/readback/receipt/recovery/budget checks and original native answer registry are not replaced. This candidate is not automatically merged, installed or reloaded; runtime, browser and human acceptance limits are recorded with its validation artifacts.

## Closed loop and evidence

1. Main prepares a phased board, claims one ready batch, implements work, and enters review. After verified completion it reports results and yields to the native supervisor checkpoint; this remains guidance, not a host-enforced phase gate. Completing a batch does not pause the goal.
2. Actual host `tool_result` events create bounded evidence receipts (`tool:<call-id>`).
3. When Main stops, Pi's actionable `agent_before_settle` boundary runs after automatic compaction, retries, and queued work drain. The read-only advisor examines the durable goal, board, host receipts, and recent transcript.
4. Structured advisor actions distinguish `guide` (current-batch work or planning/validation repair), `next_batch` (claim another ready batch), `hold` (pause the whole goal), and `accept` (final goal acceptance). The host checks these against the board: `next_batch` requires no claimed tasks or unresolved execution references and nonempty ready task IDs. An ambiguous legacy `guide` at a ready-batch checkpoint faults immediately, without repeated wakeups. For `next_batch`, the host supplies the claim instruction and typed continuation action; advisor prose is not forwarded as an execution instruction or notice. A batch checkpoint alone never asks for renewed confirmation of already-approved scope. Guidance is **not user approval**. `agent_settled` is notification-only and reconciles native aborts; it never schedules work.
5. Acceptance requires every task to be done, no unresolved execution receipts, final dependency closure covering the whole board, unchanged host-bound task evidence, and fresh final validation. There is no percentage-completion rule.

Under supervision, each review-to-done transition requires a passing **command** reference to a successful host receipt captured during that exact task review, at the current mutation epoch, with observed structured `exit_code: 0`. Main-supplied status/exit codes alone are not proof. Acceptance advice must cite successful receipts bound to completed tasks. Unknown tools (including `bash`) conservatively advance the mutation epoch unless explicitly annotated read-only. Later potentially mutating tools revoke acceptance visibly.

A host tool without structured exit status cannot prove command success; use a host validation tool that exposes it. These receipts establish host observation, not the truth or quality of arbitrary external tool output. The advisor judges goal coverage; the task/evidence gates are deterministic.

The batch-control repair is a separate source candidate from journal-growth/recovery work; it changes no persisted receipt format, approval, pause/stop, budget or recovery semantics and is not automatically installed or reloaded. It does not parse arbitrary chat into control commands or claim live-model/business acceptance.

## Receipt storage and recovery

There is **no cumulative 500-receipt stop**. Each proof is appended once to Pi's branch-local receipt ledger; Supervisor checkpoints contain metadata and exact bindings rather than repeating all historical receipt bodies. An instance-local cache defaults to 128 entries / 1 MiB of serialized UTF-8 data. Reaching the cache budget evicts cache copies, not audit history or proof validity. Evicted bound and current-review evidence is resolved from its original branch. Compact receipt locators still grow linearly with history; this does not make the entire Pi session constant-memory or impose a new unlimited execution permission.

Potentially mutating tools first record an intent. A lost result stays unknown, late/unmatched results invalidate earlier freshness, and recovery never replays the tool automatically. Validation overlapping unfinished modifications, or started before its task review, cannot prove completion. Failed capture reports the actual evidence error while preserving the original tool result/structured status; it does not repeatedly resend an older acceptance warning.

V1 inline journals and the configured v2 batch format remain readable. V2 uses a bounded read-only archive view: its hash chain, cursor, session/goal scope and complete checkpoint must validate, and necessary pause/fault/stop metadata stays v2 without adding new v2 bodies. An unfinished v1/v2 goal migrates only through explicit `recover` after the existing board/authorization gates, preserving bindings, usage and exact old records while requiring fresh validation. Recovery confirms its checkpoint before publishing active state.

A v1 snapshot at the old 500 limit may have missed later modifications: loading it records one freshness barrier, clears its old acceptance and keeps explicit pauses, budgets and the completed task board. A valid completed v1 goal below saturation and a stopped goal are not indiscriminately reopened or migrated. Format recovery establishes its own subsequent freshness boundary. New goals and recovered work write v3. Old extensions refuse v3 (and older v3-only candidates do not understand its v2 legacy base), so rolling back the package does **not** make every v3 session writable by the old version.

Supervision remains session/explicit-goal scoped, not an inferred working-directory sandbox: changing Git worktrees is not itself a new Supervisor goal. Stop an old goal explicitly before unrelated work; preserve its history and use the native same-Session archive-and-plan transition for an independent new GoalRun. Post-acceptance potential mutation still revokes acceptance.

## Existing async execution

When all claimed tasks have exact `workflow_gate` execution references, the native boundary checks the installed execution owner's versioned `pi-subagents` RPC `ping/status` contract. A complete, current-session snapshot reporting queued/running work establishes a finite wait instead of another advisor call or stagnant continuation. A completed workflow parent with active children still waits.

The first wait has a fixed 30-minute deadline, not renewed by status checks. There is one expiry timer, no executor/model polling. Missing, truncated, foreign, unknown, failed or stopped status fails closed and retains run references. `status` shows the **last owner report**, not independent proof that an OS process is alive.

The executor still owns result delivery, deduplication and waking Main; Supervisor does not duplicate completion handlers or schedule another turn. Successful terminal status with unresolved references remains `results_pending` within the original deadline. Main must inspect results, clear exact references, and collect fresh host validation before completing tasks. Notifications cannot accept a task or clear pause/stop, decisions, faults or exhausted budgets. Restart/tree navigation and compaction during a wait require inspection and explicit recovery. Dispatch, concurrency, write permissions and worktrees remain with Main/the existing executor.

## Local candidate: host progress and batch handoff

Verified, deduplicated host progress can keep an implementing task moving without treating output timestamps, polling, repeated results or version cycles as progress. Later batches can hand off mechanically under the latest unchanged reviewed plan/authority, without another Advisor call; a legal wrong batch action gets at most one charged correction. Holds, unknown execution/persistence, identity and original budgets still win. See [progress and handoff scope/limits](docs/progress-handoff.md). Owned SDK samples: `node test/progress-sdk-smoke.mjs` and `node test/progress-sdk-smoke.mjs --correction`; neither is business acceptance.

## Local candidate: Code Mode deferred completion

Actual SDK parent/kernel-end observations can qualify a nested original check without rewriting its receipt. A nested done request returns an explicit deferred intent; only a quiet, qualified native boundary may commit it once. The tested tool-only SDK factory excludes models/store/image/spill and unknown effects from qualification, rather than making every container readonly. Existing controls, versions, writer settlement and budgets still win. See [qualification, recovery and resource limits](docs/codemode-completion.md). Default models-enabled and task-only nested check completion remain unqualified/unavailable on the tested surface; no real session settings are changed.

## Local candidate: source-bound acceptance contracts

`propose_contract` records untrusted Session/source-bound metadata; native `review-contract <proposalId>` can bind the complete reviewed conditions/checks before first compilation, independently of permissions/first-start. `run_check({checkId})` executes only the frozen registered finite Node definition; native `verify-check <checkId>` creates a version-bound manual response through the private native-answer/physical-witness path. Missing requirements, substituted/no-op invocations, zero/failed/skipped/stale checks and copied SDK replies cannot be masked by all-done tasks. Legacy/host/contract/model-review history and actual human/product acceptance stay distinct. See [construction, supported capability and limits](docs/acceptance-contract.md). These remain local candidate mechanisms, not a release or real human/product acceptance.

## Local candidate: bounded final review

Task completion is separate from goal acceptance. New physical-session reviews record the actual Goal owner, board/binding digests, current artifact version, validation source and bounded attempt outcome. `/task-supervisor retry-review [attemptId]` requires idle Main, unchanged authority/first-start and no decision, unknown execution or host capture. It never invokes generic recovery, queues business, changes modes, grants permission or replenishes budget. A confirmed accepted fact with a missing derived publication is repaired without another provider call.

Each attempt shares **30 seconds and at most four provider calls**: at most one structured transient transport retry, one action correction and two retained-detail rounds, simultaneously limited by the original shared 40-call/review and 20-continuation budgets. English error text containing “503” is not structured retry evidence. `request_evidence` accepts only registered detail/receipt IDs, never arbitrary paths or commands. Required metadata stays present; task/body/output excerpts and unavailable original capture are explicitly marked. The same pure 64,000-UTF-8-byte constructor checks projected task completion and actual review, without rewriting receipts, bindings or their hashes.

The minimal current artifact policy captures bounded Git-visible workspace inputs plus selected Node/SDK identity, not arbitrary ignored files, external effects or an OS-atomic snapshot. Missing/changed/unknown applicability cannot be treated as same. Existing completed work lacking a version needs a new actual check, never an invented past snapshot. Native retry may register a **unique fully retained, unredacted prior bound final Bash check** with exact arguments and native Session cwd; nothing is executed or queued. Only that invocation is admitted under unchanged authority. A new successful stable-input, non-overlapping current-epoch receipt can supplement final validation without changing completed tasks or old bindings. Missing/ambiguous input remains blocked. Registration does not prove the check's semantic quality or authorize business replay; the separate source-bound contract layer also checks trusted definitions and requirement coverage; the retained Bash path is not a generic registered-check replay API.

Running/retryable final review does not reopen ordinary writes or task claiming. A user pause of completed review remains authoritative even over a prior fault; native `resume` lifts only that review pause back to held review/validation, never active business or Main dispatch. Stop, revoke, source/owner changes and unknown outcomes still win. Cold restore projects held metadata without network or replay. Status distinguishes task-complete work from recorded review state; current artifact applicability is checked at control/adoption, not by the pure UI. These are local candidate capabilities, not an installation, production acceptance or untested version-matrix claim.

## Safety and limits

- Task tools are removed/blocked until a human command activates the session. Supervisor state is isolated per extension instance.
- Supervisor holds/faults, board pauses, and real decision gates block task mutation. Completed supervised tasks are frozen; required tasks cannot be discarded or abandoned.
- The advisor uses the pinned **session runtime** model with no executor tools or separate credential discovery. Common credential patterns are redacted in captured receipt text and advisor packets; this is not a general secret scanner. Do not put credentials in goals, tasks, or tool labels.
- Reviews have a 30-second bound, a 64KB packet cap, and a 2048-token output cap. Limits: 40 reviews, 20 resumes, three non-progress continuations, and at most 100 supervised tasks/bindings. Receipt caches have bounded count/bytes, not a cumulative goal receipt limit. Oversized plans are rejected on start, write, and recovery. Explicit same-Goal recovery preserves review/resume counters, approvals and recorded usage; it clears the local stagnation hold, not the spent budget. An exhausted budget is not renewed by recovery.
- Packet size is measured in UTF-8 bytes. The complete recorded goal and required task/state/result/reference/digest metadata are never dropped. Optional task text, labels, transcript and receipt bodies (including bound bodies when necessary) may be explicitly excerpted; retained capture may already be incomplete. Hashes never reconstruct missing text or prove it was read. Oversized required metadata fails closed; the original durable evidence remains unchanged.
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

Task tools: `write_tasks`, `edit_tasks`, `compile_tasks`, `clear_tasks`, `get_ready_tasks`, `advance_tasks`, `workflow_gate`. Planning also uses `submit_preflight`; additive contract tools are `propose_contract` and `run_check` (the process runner is not metadata-only).

`compile_tasks` requires a final acceptance task in the last phase whose dependency closure covers every earlier task. `workflow_gate` creates user-owned decisions and binds/clears exact opaque execution receipts; it never starts or controls the referenced run.

## Configuration

Optional `~/.pi/agent/continuous-tasks.json` (or `$PI_CODING_AGENT_DIR/continuous-tasks.json`). This legacy filename is intentionally unchanged; no new config path or migration is introduced:

```json
{
  "maxStagnantSettles": 5,
  "requireCompletionEvidence": true,
  "receiptCache": {
    "maxEntries": 128,
    "maxBytes": 1048576
  }
}
```

`receiptCache.maxEntries` accepts 1–4096; `maxBytes` accepts 16 KiB–64 MiB. These only size the raw cache, not the advisor packet, cumulative receipt count or execution authority. A single oversized cache item remains in the ledger and is read without caching. Status shows cumulative count, cache budget, pending captures and ledger health without writing state or querying an executor.

Missing/invalid settings use safe defaults. `countdownMs` remains parse-compatible but is deprecated and ignored: native continuation has no countdown. Supervisor host-evidence requirements cannot be waived by `requireCompletionEvidence: false`. `phaseCompletionPromptTemplate` may include `{phase}`.

## Local development

```bash
npm ci --ignore-scripts
npm run check
```

`check` runs type checking, lint, format checks, coverage (all four unchanged 90% gates), and thirteen isolated real-Pi **faux-provider** smokes. Native-session test-file WIP is bounded to four workers without extending test timeouts or dropping scenarios. An additional candidate qualification uses `node test/real-pi-smoke.mjs --fresh-supervise` to verify fresh planning, native approval and separate first-start through the same SDK harness. The original eight cover board-only, supervised, automatic compaction, paused in-flight review plus compaction, native boundary abort/recovery, ordinary pause/single-command resume with retained counters, owner-confirmed async waiting followed by executor-owned result delivery and fresh Main acceptance, and opt-in preflight with a required/optional inventory, source-boundary simulated native approval and separate start. Four additional modes cover 1000 reads with an evicted validation proof, 500-receipt v1 gap/migration through a real recovery command, interrupted intent recovery without replay, and cross-batch v2 migration preserving its original records. The intent fixture first uses actual explicit recovery to enter an eligible state; a labeled conservative pending-context simulation suppresses its arming dispatch, without claiming a real queue, then the SDK admission/crash/reopen path preserves the missing result and original epoch/budget assertions. A thirteenth mode verifies first-batch completion followed by automatic next-batch execution and final acceptance, with contradictory advisor stop prose excluded from Main, zero user messages and no stagnant continuations. The preflight SDK arm explicitly mocks argv/TTY/UI to test owner plumbing, not ordinary-SDK approval support or human identity. Its fixed host-recognized contract adds an actual registered Node check while retaining both original host checks; it reports recognized-host, never native contract-review or product acceptance. This integration requires separate offline real CLI/PTY product-entry and real double-TTY ordinary-SDK rejection checks; older candidate results do not stand in for these. SDK hosts must bind real command-context actions, including `waitForIdle`; a still-busy host after that callback is rejected rather than treated as settled. Smokes use temporary agent directories, no builtin executor tools or live inference, and verify real settings remain unchanged.

Compatibility evidence and limitations: [`CANARY.md`](./CANARY.md). Original workspace design: [`../docs/continuous-tasks-extension-design.md`](../docs/continuous-tasks-extension-design.md) (outside this standalone repository; not included in a Git checkout or package).

## Flow optimization proposal

[Supervisor flow optimization](./docs/supervisor-flow-optimization.md) records Stage 1 and the narrowed Stage 2 async integration. The [Stage 1 contract](./docs/supervisor-flow-implementation-packet.md) and [async integration contract](./docs/supervisor-async-integration-packet.md) freeze authority, recovery semantics, persistence failure handling, and validation scope. Publication and installation require explicit authorization and a pinned revision; the earlier document review is not an implementation review.

## Authorization preflight design

The same-Session lifecycle has separate offline entry checks: `python3 test/goal-native-smoke.py sequential`, `permissions`, or `sdk-denial` (use `--cli` with a matching peer CLI when needed). Positive cases use the actual CLI/PTY and physical A/B/C plus permission/start records; the ordinary SDK case has two real TTYs but must save no new authority. All sessions are owned synthetic data, the model is a local faux provider, and scripted keys do not establish human identity or business acceptance. `node test/goal-cold.mjs --session <owned-fixture.jsonl>` checks current cold restore without replay; `--reader <frozen-older-source> --expect-refusal` checks actual old-reader denial, including `--a-only`. These do not install, reload or operate a business session.

[Pre-execution authorization preflight](./docs/supervisor-permission-preflight-design.md) describes read-only planning, explicit scoped user approval, and supervised execution without repeated requests inside the approved scope. It distinguishes user authorization from host tool permissions and defines when renewed confirmation is required. The locally authorized [implementation contract](./docs/supervisor-permission-preflight-implementation-packet.md) freezes opt-in commands, exact plan/approval identity, recovery and acceptance requirements. The local source candidate now implements this opt-in path. The authorized independent read-only implementation review has completed; Main reproduced and fixed its two concrete findings with targeted regressions. Final task-board acceptance uses its own fresh host proof. Subsequent authorized installation is a separate operation and must select this source revision rather than the old recovery-hotfix snapshot. Neither document grants host-policy changes, publication or installation.
