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
