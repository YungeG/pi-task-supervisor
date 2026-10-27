# Local candidate: host progress and batch handoff

Progress affects stagnation only. It grants no permission, task completion, evidence eligibility, renewed budget or goal acceptance.

## Recorded progress

`progress-facts-v1` uses the existing strict control fence and confirmed native journal. A trusted host can register a bounded definition with `registerProgressMilestone()`; no agent tool accepts arbitrary milestone declarations. Supported observations are:

- Actual formation of a registered artifact (simple root-relative filename; parent traversal/symlinks or unknown scope do not qualify).
- An exact registered tool/input check changing from observed failure to success, with a durable supervised host receipt. SDK 1.1.0's task-only native result does not retain structured exit codes; task-only check registration returns unavailable rather than manufacturing a passing check.
- A new verified version of registered managed inputs.

For one unambiguous implementing task, admitted non-readonly work gets a minimal default Git-visible workspace definition. The existing bounded workspace capture excludes the session journal and ignored files. Missing Git/scope provenance, inventory drift, ambiguous tasks, overlap, failed/unknown results, late input changes and owner/control changes do not earn credit. New files that change the registered inventory require an explicit suitable scope rather than silently widening the definition. Fileless work has no durable progress proof.

The key includes a versioned prefix, owner, task, definition, normalized outcome and artifact version—not stdout, timestamps, receipt IDs or call counts. Identical results and previously seen versions, including the baseline and A→B→A cycles, do not earn repeated credit. This proves an observed byte-level input difference, not its business usefulness; requirement/check semantics remain a separate acceptance contract.

Per owner limits are 100 definitions, 256 observations, 128 credited keys and 80 retained batch-advice observations. Runtime captures/staged observations share a 128-frame limit. At a progress limit, confirmed history is not evicted or reset; new optional credit stops. Existing review/continuation/stagnation budgets remain authoritative. Unknown persistence closes the journal gate; there is no tool replay.

The review packet includes a bounded recent projection and source/digest/version references. Status/UI reads cached facts only. Cold restoration folds actual causal references; it does not repeat tools, provider calls or progress observations.

## Mechanical handoff

A later batch may use host-generated `next_batch` only with the latest still-applicable semantic plan/authority observation, no claimed task, ready work, unchanged owner/context and no control, pending host operation, execution uncertainty or spent budget. A later hold/mismatch or changed plan invalidates reuse; an older positive observation is not selected around it. Fileless reuse is runtime-only, never a durable grant. Final acceptance and semantic uncertainty still require review.

The host records a bounded facts digest in its continuation reason and rechecks facts after publication before dispatch. Generation churn and status questions remain non-progress; repeated empty handoffs still reach the original three-continuation stagnation hold. The original continuation budget is charged even when no extra Advisor call is needed. Partial claimed batches retain the existing safe Main/unbound-work policy; this does not turn an active writer into a completed batch.

A format-legal `guide`/`next_batch` mismatch can receive one correction under the same owner, attempt, facts and lease. Other invalid advice does not get this exception. The original advice and every provider call/usage remain recorded; another mismatch blocks. Pause/stop/revoke, journal uncertainty and exhausted budgets win before another attempt.

## Bounded registration resource probe

`P8_REGISTRATION_COUNT=1|10|100 node test/progress-registration-smoke.mjs` uses the actual owned SDK claim/kernel-end context and real public trusted registrations, not raw wire rows. Run1 before10 before100. A100-definition arm must still reject101 without eviction, keep zero progress credit and leave the task implementing under an actual Advisor hold. The original100-call10-second sentinel is not widened; output includes timing, journal bytes, bounded cache metrics and process RSS. These bounded samples do not prove generic linear latency or a heap/RSS bound. The matching original component configuration is exercised by `P8_COMPONENT_REGISTRATION_COUNT=1|10|100 npm test -- src/__tests__/progress-registration-resource.test.ts` (default1 in the ordinary suite).

## Qualification boundary

Owned real SDK/faux-provider samples cover four finite file edits with the same task still implementing, durable progress and no-replay cold restore, one charged action correction, task-only native-result input differences, and mechanical handoff across normal and automatic-compaction flows. A checked-in immutable 66 KB owned task-only SDK fixture also exercises the native metadata decoder; it contains no real user session. Structured task-only check exits remain unqualified on SDK 1.1.0. Existing thirteen SDK scenarios and four 90% coverage gates remain required. These are not real CLI/PTY, real-user approval, external executor-version, Code Mode effect-tree or business acceptance qualification.
