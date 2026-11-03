## Review

### What changed
R2 binds task-only interactions to the actual WorkOwner, adds direct recovery-safety checks, and presents paginated recovery material before a separate leased confirmation. The original readonly helpers are exported without changing their command-policy behavior.

### Original P1 status

- **P1 #1 — CLOSED.** `src/idle-human.ts:116–157` now includes `currentWorkOwner()` only for tasks mode. Retention still checks that captured identity (`src/session-controls.ts:234–250`). The three replacement-owner regressions actually replace **and compile** the new board before returning cancelled/rejected/unknown, then assert zero later writes (`src/__tests__/idle-human.test.ts:629–677`).

- **P1 #2 — CLOSED.** `src/idle-human.ts:176–196` checks active/non-null management ownership, identity/invocation integrity, original `writerAttention()`, execution acceptance and flow faults, failing closed on exceptions. It runs during derivation and before/after confirmation. Tests cover unsafe task-only sources before requesting UI and injection during final selection (`src/__tests__/idle-human.test.ts:716–748`). These checks prevent reaching recover’s unknown-close/migration path with the examined unsafe states.

- **P1 #3 — OPEN, narrowly: the newly displayed “current contract” is not owner-selected.**

### Finding

**P1 — Recovery material can identify a historical Goal contract as the current task-board contract.**

**Location:** `src/idle-human.ts:412–416`.

`recoveryScope()` uses:

`currentContract: source.view?.contracts.at(-1)`

That view contains historical contracts, not just the current owner’s contract (`src/acceptance-journal.ts:1677–1718`). The original selector explicitly filters by owner and effective scope commit (`src/acceptance-journal.ts:1733–1747`).

A supported same-session transition releases a Goal and creates an independent task-only owner while retaining old history (`src/management-policy.ts:683–725,898–914`; existing transition test: `src/__tests__/management-mode.test.ts:61–115`). After compiling and pausing that new board, its recovery material can therefore label the old Goal’s contract as `currentContract`, rather than showing the current board’s contract or explicit absence. The new snapshot equality check consistently binds this **incorrect selection**; it does not correct it.

**Minimum correction:** Select the effective contract with the actual current WorkOwner using `selectedAcceptanceContract()`. Add a regression retaining a previous Goal contract before task-only recovery; require the unrelated contract to be absent and missing current material explicitly unknown.

The remaining presentation repair is correct: original readonly pagination, separate leased select, complete-material/domain rechecks, non-truncating redaction, distinct recovery effects and Esc-without-mutation (`src/idle-human.ts:443–529`; tests: `src/__tests__/idle-human.test.ts:749–848`).

### Evidence and limits
Reviewed the R2 manifest, RED log, check log, eleven native reports and four terminal-material artifacts. The check log records **147 files / 3492 tests passing** with original coverage gates. Existing recovery-material tests use single-owner histories and do not cover the finding above.

No edits, tests, builds or business-session access performed; fingerprints were not independently recomputed. A/H0 remain frozen. Synthetic native evidence is not business approval, and deployment/global upgrade is not a blocker.

**Fixed:** None; read-only review.  
**Merge verdict: BLOCK.**

**B R2 local candidate implementation verdict: BLOCK**