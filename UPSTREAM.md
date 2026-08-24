# Upstream provenance

- Repository: <https://github.com/harms-haus/pi-tasks>
- Package: `@harms-haus/pi-tasks@0.1.0`
- Pinned commit: `25c41f27072123e13ac64bb389a0c49f2f3d5d7a`
- License: MIT; preserved in `LICENSE` and `LICENSE.upstream`
- Local branch: `local/continuous-tasks`

## Baseline verification

Run on 2026-08-23 before local changes:

```text
npm ci --ignore-scripts                         PASS
npm test -- --reporter=dot                     PASS (415 tests, 14 files)
npm run typecheck                              PASS
npm run lint                                   PASS
npm run format:check                           PASS
```

`npm ci` reported eight high-severity audit findings in the upstream development dependency tree. This is recorded as baseline rather than silently fixed during vendoring; runtime packaging and the final fan-in audit must classify whether any production dependency is affected.

## Local fork scope

The local fork may change only the lifecycle, snapshot contract, quality evidence, decision/run receipt controls, session scoping, tests, and package metadata defined in `../docs/continuous-tasks-extension-design.md`.

Do not load this local fork together with the upstream npm extension: both register overlapping task tools.

## Local compatibility baseline

The local fork pins its development and peer surface to Pi `0.84.2` and `typebox@1.3.7`.

Implemented commits:

```text
67e6e23 feat: add versioned task board contract
f2a6da9 feat: continue only after agent settles
33087da feat: require evidence for task completion
21f2cfc feat: add decision and execution receipt gates
28d9e2e feat: enable continuous tasks per session
```

Current fan-in expectations:

```text
npm test                                      PASS (450 tests, 21 files)
npm run test:coverage                         PASS (90.19% branches)
npm run typecheck                             PASS
npm run lint                                  PASS
npm run format:check                          PASS
node test/real-pi-smoke.mjs                   PASS (Node 24.14.1 and 25.9.0)
npm audit --omit=dev --audit-level=high       PASS (0 runtime vulnerabilities)
gitleaks on source/test/docs/manifests        PASS
packed extension load                         PASS
```

Development-only audit findings remain baseline until dependency upgrades can be proven compatible; they are not silently rewritten during the feature fork.

Independent review found one blocker: generation regressed or failed to advance on claim, clear, and reconstruction paths. The fix increments claim/clear generations, rejects persisted generation zero, and fails closed on regressing snapshot history. A fresh fallback re-review returned `PASS` after `npm run check` and the real Pi smoke passed.

Session authorization now uses a typed `continuous-tasks:activation` entry written only by the user command `/continuous-tasks enable`. The real Pi smoke invokes that command through Pi's command runner, persists exactly one activation entry, resumes the saved session, and confirms the task tools are restored. Global configuration no longer stores session IDs.
