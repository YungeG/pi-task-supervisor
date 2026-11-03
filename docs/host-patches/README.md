# Qualified local Pi H0 patch

`pi-1.4.0-h0-r2.patch` preserves the exact accepted 13-file H0 candidate against upstream Pi v1.4.0 (`4a080252f06caf63a525d7873c5d94d3c23887e0`). The adjacent JSON records the patch hash and each resulting file hash. Patch replay against the original base was checked before commit.

This is a source patch, not an npm release or a push to the official Pi repository. It adds public H0 v1 for Supervisor B. Qualification is for the Node local TUI; RPC/Bun are not newly trusted approval frontends.

Reproduce source in a separate checkout at the exact base:

```sh
git apply --check /path/to/pi-1.4.0-h0-r2.patch
git apply /path/to/pi-1.4.0-h0-r2.patch
```

Follow the checkout's dependency/security/build rules and the [host validation record](../supervisor-human-interaction-h0-validation.md). Do not regenerate model catalogs or substitute a different base. Supervisor B must resolve to the same qualified host installation that actually runs the CLI; merely selecting another CLI path is insufficient.

Local installation uses an already verified built tarball with lifecycle scripts disabled, after an isolated install/startup/native-flow smoke test. Keep the stock host and settings backup. A later ordinary `pi update`/npm upgrade can overwrite this local H0 patch; recheck H0 capability before expecting B controls. Existing sessions are not reloaded by installing the candidate. Business approval/Start/recovery remain separate actions.
