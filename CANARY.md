# Isolated canary report

- Date: 2026-08-23
- Baseline candidate: `2b2fb3567abd8ce569e10d4aa966e9d8c7b943a5`
- Session activation candidate: `28d9e2eb188d324c3c87750349b66858fc47f65e`
- Pi: `0.84.2`
- Node: `24.14.1`, `25.9.0`
- Real user settings/session modified: no

## Scenarios

| Scenario                                                                | Evidence                                         | Result |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ------ |
| `agent_end` does not continue; `agent_settled` does                     | `settled-continuation.test.ts`, `events.test.ts` | PASS   |
| Hidden custom continuation, no forged user message                      | real Pi faux-provider smoke                      | PASS   |
| Progress/status input cancels one countdown and workflow remains active | `settled-continuation.test.ts`, `events.test.ts` | PASS   |
| User abort and exhausted error pause                                    | `events.test.ts`                                 | PASS   |
| Stagnation circuit breaker pauses                                       | `events.test.ts`                                 | PASS   |
| Generation changes invalidate stale countdown                           | `events.test.ts`, `generation.test.ts`           | PASS   |
| Snapshot reload/reconstruction and legacy migration                     | `state.test.ts`, `snapshot-v2.test.ts`           | PASS   |
| Regressing snapshot generation fails closed                             | `generation.test.ts`                             | PASS   |
| Sessions without activation remove/block task tools                     | `events.test.ts`, `commands.test.ts`             | PASS   |
| User `enable` writes one typed activation entry                         | commands test and real Pi smoke                  | PASS   |
| Saved-session resume restores activated tools                           | real Pi persistent-session smoke                 | PASS   |
| Decision pause/resolve                                                  | `workflow-gates.test.ts`, `commands.test.ts`     | PASS   |
| Existing external run receipt prevents duplicate writer guidance        | `workflow-gates.test.ts`                         | PASS   |
| Review/validation evidence required for completion                      | `quality-transitions.test.ts`                    | PASS   |
| Packed extension loads through Pi resource loader                       | isolated packed install/load                     | PASS   |
| Removing the extension/config leaves real settings untouched            | packed/smoke sandbox cleanup and digest check    | PASS   |

## Commands

```text
npm run check                                             PASS
npm audit --omit=dev --audit-level=high                  PASS
npm run check under Node 24.14.1                         PASS
gitleaks source/test/docs/manifests                      PASS
packed extension install/load                            PASS
focused activation canary: 59 tests                      PASS
fresh independent review                                 PASS
```

## Residual boundary

The activation canary uses an isolated Pi agent directory and session file. It does not enable a real session or change real settings. Independent sessions remain disabled until their user invokes `/continuous-tasks enable`; ending a session requires no cleanup.
