## Review

- **Correct — remaining P1 #3 CLOSED.** `src/idle-human.ts:38,412–417` imports the original `selectedAcceptanceContract()` and passes the actual `currentWorkOwner(sessionId)`, not nullable `source.owner`. The original selector preserves owner matching and effective scope-commit filtering (`src/acceptance-journal.ts:1733–1748`). The retained R2 source confirms replacement of `contracts.at(-1)` at this seam.

- **Correct — regression targets the original failure.** `src/__tests__/idle-human.test.ts:849–869` retains a real historical Goal contract, disables that Goal, creates/compiles/pauses an independent task-only board, verifies changed ownership and retained history, then inspects actual component-rendered recovery material. It requires explicit `"currentContract":"未提供/未知"` and excludes the old entry ID/digest. `/tmp/task-supervisor-b-r3-red.log` records failure at that exact assertion on old code. The existing precise scope-adoption regression remains at lines 815–847.

- **Evidence.** `/tmp/task-supervisor-human-interaction-b-r3-check-final.log:31–40` records **147 files / 3493 tests passing**, with original coverage gates met. The R3 manifest identifies production fingerprint `e1f5aa17616519df04654e9b956089bfa13e4e84cdd6401e46b62a31c377d852` and eleven current native reports. Inspected R3 scope material retains the current-owner contract and exact committed revision.

- **Findings:** No issues found. No material defect identified in this narrow change; R2’s CLOSED owner-binding and recovery-safety findings remain closed.
- **Fixed:** None by reviewer; read-only review.
- **Compatibility / limits:** A/H0 remain accepted dependencies, without requalification. R3 old-1.1 evidence preserves A-only behavior. Deployment/global upgrade is not a local implementation gate. No edits, tests, builds, audit execution, or original business-session access performed; fingerprints were not independently recomputed. Synthetic CLI evidence is not business approval. Whole-goal acceptance remains Main’s responsibility.
- **Merge verdict: OK** for this local R3 candidate.

**B R3 local candidate implementation verdict: OK**