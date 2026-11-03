# Local deployment — 2026-11-03

The user explicitly requested push and local installation after the candidate was accepted. Both are complete. Existing Pi/business sessions were not reloaded, and no business approval/Start/recovery was performed.

## Pushed candidate

- Repository: `git@github.com:YungeG/pi-task-supervisor.git`, `main`.
- Code commit: `8d388977354f9b592dd83ebe187f46b4e0c69a20`.
- Supervisor production fingerprint: `e1f5aa17616519df04654e9b956089bfa13e4e84cdd6401e46b62a31c377d852` (87 files).
- The exact accepted H0 source patch, base and per-file hashes are also pushed under [host-patches](host-patches/README.md). Nothing was pushed to the official Pi repository. No npm release/tag was published.
- Unrelated `.pi/` preferences and `docs/supervisor-journal-growth-and-restore-repair-plan.md` remain untracked and untouched; they were not included in the package.

## Installed components

1. Node Pi **1.4.0 + accepted H0 R2**, installed from the already built local tarball using npm with lifecycle scripts disabled. Its version string remains `1.4.0`; H0 is the local patch, not a new upstream release.
2. Immutable Supervisor package at:
   `~/.pi/agent/local-packages/pi-task-supervisor/candidate-e1f5aa17616519df04654e9b956089bfa13e4e84cdd6401e46b62a31c377d852`.

Only the old Supervisor package source was replaced in personal settings. Every other settings value is unchanged; a normal fresh startup registers `/task-supervisor` exactly once from this installed package. The repository's test dependency remains Pi 1.1.0.

Tarball SHA-256:
- H0 host: `eb3c3a47dabd04433e19668fb0c8af8db27f1a4c606b74188a1c7588d53b871c`.
- Supervisor: `44f26a6bcd899105b2b2f01756c4fde5c859ec091f579fe0aea71e3a011d387e`.

## Installation validation

- Exact H0 patch replay against upstream base: PASS, all 13 resulting file hashes match acceptance.
- Package dry run and isolated npm global-prefix install, with scripts disabled: PASS.
- Packaged Node bundle + Supervisor native first workflow in that isolated prefix: PASS.
- Actual global installed host: **1283 packaged files** verified against the smoked H0 tarball.
- Actual installed Supervisor: **87 production files** match acceptance, read-only permissions.
- Real installed global bundle and actual installed source (not another copy): native permissions/separate Start, preparation/definition/recover and scope/board-only/recover flows all PASS. Models/keys were synthetic offline fixtures, not business acceptance.
- Fresh normal global-configuration startup: one Supervisor command, zero messages/no model prompt, clean exit. This RPC check proves registration only; RPC was not certified as an approval frontend.

Evidence and private rollback artifacts are under:
`~/.local/state/pi-task-supervisor/deployments/20261103T012046Z/`.

`verified.json` records installed hashes and the three actual native reports; `global-startup-verified.json` records normal configuration loading. Backup settings/tarballs are private, not committed. The original 3493-test/full native acceptance remains in [B validation](supervisor-human-interaction-b-validation.md).

## Use and rollback

Start a **new Pi process** to use the installed host and Supervisor. No existing session was automatically reloaded. Reloading extensions alone does not replace host code already loaded in memory.

The stock host, previous immutable Supervisor and prior settings are retained. An operator can inspect the rollback plan without changes:

```sh
python ~/.local/state/pi-task-supervisor/deployments/20261103T012046Z/rollback.py
```

Add `--apply` only to deliberately restore the stock host and the previous Supervisor source. The helper preserves other settings and does not reload existing sessions.

An ordinary later `pi update`/npm upgrade can overwrite the local H0 host patch. Recheck H0 capability before expecting B controls afterward; unsupported hosts fail closed to A-only.
