## Review

### What B changes

B adds the qualified H0 adapter, shared original session-control cores, and a runtime-bound native interaction controller. It connects independent Start, definition/scope reviews, board responses and explicit recovery without approval-command execution. Legacy hosts retain A-only behavior.

### Must-fix findings

1. **P1 — Stable identity omits the task-board WorkOwnerKey.**  
   **Location:** `src/idle-human.ts:114–151,614–637`.  
   `identity()` includes Session, goal epoch/IDs, mode and preflight ID, but not the actual task-board owner. A task-only board replacement changes that owner (`src/management-policy.ts:737–757`) without changing these identity inputs. Consequently, an old saved-control result can still pass `owner.current()` and call `retainHumanDelivery()`, which pauses the replacement board (`src/session-controls.ts:234–250`). The stricter candidate stamp prevents stale dispatch, but does not protect this retention write. This contradicts packet §2.3’s explicit task-board owner binding.  
   **Smallest correction:** Include the actual board WorkOwnerKey in task-only stable identity, preserving the permitted preflight-to-Start ownership transition.  
   **Missing validation:** Replace the board owner before an old cancelled/rejected/unknown result arrives; verify zero writes to the replacement owner.

2. **P1 — New recovery does not fully reject unknown owner/activity/capture sources.**  
   **Location:** `src/idle-human.ts:171–179,286–319,347–373,398–418`.  
   `recoveryBlocked()` relies on `flowFacts()`, but that presentation projection deliberately omits activity/receipt issues outside managed Goal context (`src/flow.ts:163,177–188`). B also ignores the management snapshot’s identity/invocation issues and unresolved/null owner. A concrete retained state is supplied by `holdInvalidatedTaskOwner()`: task mode, `stopping-with-attention`, null owner, and no new journal fault (`src/management-policy.ts:307–328`). With a paused board, B can nevertheless offer and apply `resumeBoardControl()`; its structural checks do not reject that owner state. Later dispatch denial does not undo the recovery write. Packet §4 requires diagnosis only for unknown sources.  
   **Smallest correction:** Gate B recovery directly on actual current owner/management integrity and execution/capture safety, both before presentation and after confirmation. Preserve legacy command behavior.  
   **Missing validation:** Negative recovery cases for null/invalidated owner, task-only unresolved activity and unknown capture.

3. **P1 — Recovery confirmation does not display its bound material.**  
   **Location:** `src/idle-human.ts:398–418`.  
   The confirmation shows only a generic operation label and disclaimer. It does not show board generation/digest, Supervisor status/hold cause/reason, owner, scope references, spent usage or settlement facts required by packet §4 (`docs/supervisor-human-interaction-b-implementation-packet.md:116`). These facts are hashed internally, not presented. The shared lock also suppresses the task widget (`src/human-ui.ts:207–231`; `src/board-ui.ts:75–90`), so it cannot substitute for that material. In particular, recover may subsequently adopt a scope revision (`src/supervisor.ts:880–885`) without identifying it in this confirmation.  
   **Smallest correction:** Present the original recovery snapshot and exact prospective effect, then retain the existing post-answer equality checks.  
   **Missing validation:** Assert displayed recovery material and independently distinguish board-only, joint user-pause resume and recover/adoption.

### Correct / compatibility checks

- Display adaptation is narrowly restricted; blocking methods remain leased, context descriptors are preserved, and other sends throw: `src/host-idle.ts:105–168`.
- Original NativeAnswer registration remains separate from the shared UI lock: `src/human-ui.ts:203–231,1024`.
- Both documented RED fixes are correctly wired: direct original definition review and partial-grant selection excluding missing optional permissions (`src/idle-human.ts:181–196,436–449`; tests at `src/__tests__/idle-human.test.ts:467,700`).
- Final dispatch rechecks owner, post-control state, candidate, evidence capability and first-Start material: `src/idle-human.ts:488–533`.
- Deferred projection failure calls `ctx.abort()`; technical-failure settlement precedes the existing scope early return: `src/idle-human.ts:729–784`; `src/events.ts:977–984`.
- Parent muting is bounded without eviction; cold restoration seeds existing pending controls, including preparation: `src/idle-human.ts:155–157,376–389`.

### Evidence and remaining gaps

Reviewed the supplied manifest, complete check log, ten native reports and relevant harness assertions. The log records **147 files / 3476 tests passing**, original coverage gates and full smoke chain. Native reports establish actual CLI/module pairing and distinguish logical ACK, kernel start and provider work.

I did not rerun tests or independently recompute fingerprints. Existing passing evidence does not cover the findings above. Synthetic models/keystrokes are not business approval proof. A/H0 acceptance remains unchanged; deployment or global upgrade is not an implementation gate.

**Fixed:** None; read-only review.  
**Should-fix/P2:** No additional findings.  
**Merge verdict: BLOCK.**

**B local candidate implementation verdict: BLOCK**