# Human question display correction — 2026-11-03

## Defect and scope

The custom question reader and decision card previously replaced the editor without an enclosing panel. The approval document used an overlay but had no enclosing border/background of its own. Process/journal inspection alone could not establish visual readability; the earlier response asking the user for a screenshot instead of reproducing the owned UI was insufficient.

This correction changes presentation only:

- All custom human question surfaces use one centered overlay with a complete `borderAccent` frame and `userMessageBg` fill, rather than inheriting the editor/footer background.
- Foreground/background resets in child content restore the panel defaults. Text and border stay separate in both stock themes: border contrast **4.10:1 dark / 3.14:1 light**, text contrast **8.88:1 / 8.50:1**.
- The frame reserves two rows/four columns inside the host's 95%-width/90%-height overlay budget. It delegates input, focus, invalidation, disposal and original completion unchanged. Tiny viewports remain cancel-only; resize still invalidates reading coverage.
- Original Enter/full-reading gates, separate final native selector, NativeAnswer/physical witnesses, H0 and recovery/permission semantics are unchanged. No input was sent to the user's business panes.

## Verification

- RED: actual `reviewScope()` factory rendered `只读核对（非作答）` without a frame where the test required a visibly bounded panel.
- 13 new display tests: real dark/light theme contrast, actual public custom factory, overlay/geometry, zero confirmation on render, Enter/input/cursor focus forwarding, Esc, tiny/invalid width, nested SGR resets and idempotent cleanup.
- Full `npm run check` PASS: **148 files / 3506 tests**; original 90% gates retained (93.38% statements / 90.05% branches / 97.92% functions / 95.50% lines), original smoke chain PASS. Log: `/tmp/task-supervisor-ui-frame-check-accepted-20261103.log`.
- Four actual CLI/TTY synthetic native workflows PASS: permission/separate Start, information input/full-text return, preparation/definition/recovery, scope metadata/board-only recovery/adoption. Final pair `/tmp/task-supervisor-ui-frame-pair-final-20261103`; reports under `/tmp/task-supervisor-ui-frame-accepted-*-20261103/owned-*/verified.json`.
- Actual component ANSI output for dark/light is saved in `/tmp/task-supervisor-ui-panel-final-20261103/question-*.json`. The derived `preview.png` was visually inspected: full frame, separate fill, readable body and action hints. It is a faithful rendering of component ANSI output, **not a screenshot of the user's terminal**. Browser capture was unavailable because the installed browser integration rejected its old agent-browser version; no browser upgrade was made.
- Initial full run timed out because two old test drivers identified pages at an unframed header position; they were updated to strip only the presentation frame before exercising the same real components. Reading material/selection assertions remain. A native test initially paired the installed CLI with a different module root and correctly failed its pairing assertion; rerunning the matched pair passed. Neither failure was counted as PASS.

The existing user popup's original Enter report was not reproduced in the business session; one observed pane had already saved Start. This correction does not claim a specific root cause for that past keypress. It fixes the directly reproduced owned rendering defect and verifies input propagation without weakening approval gates.

Installation follows the previously authorized immutable local-package mechanism, preserves a settings/source rollback record, and does not reload active sessions. Existing processes must explicitly reload extensions or start fresh to show the correction; never send Enter or reload a business session on the user's behalf.
