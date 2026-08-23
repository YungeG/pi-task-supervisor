# Continuous Tasks

Local Pi `0.84.2` extension for session-scoped, phased implementation plans that must continue through review and validation without asking the user to type `continue` after every milestone.

This is a pinned local fork of [`@harms-haus/pi-tasks`](https://github.com/harms-haus/pi-tasks). See [`UPSTREAM.md`](./UPSTREAM.md) for provenance and local differences.

## Safety model

- Default deny: the extension activates only for exact session IDs listed in `~/.pi/agent/continuous-tasks.json`.
- Non-allowlisted sessions have the task tools removed and blocked.
- Continuation is scheduled only from Pi's `agent_settled` event, after retry, compaction retry, and queued follow-ups finish.
- Continuations are hidden typed custom messages, not fake user messages.
- Review completion requires bounded evidence with at least one passing reference.
- User abort, exhausted model errors, real decisions, deadlock, and stagnation pause the workflow.
- The extension does not merge, push, release, deploy, manage credentials, or run subagents itself.

## Configuration

Create `~/.pi/agent/continuous-tasks.json`:

```json
{
  "enabledSessionIds": ["01a0228b-ccbb-7fdf-b504-9f815411e609"],
  "countdownMs": 3000,
  "maxStagnantSettles": 5,
  "requireCompletionEvidence": true
}
```

Do not create this file until the target board has been reviewed. Missing or invalid configuration disables the extension.

## Task lifecycle

```text
draft → configured → ready → implementing → reviewing → done
```

Workflow:

```text
write_tasks
→ edit_tasks
→ compile_tasks(finalAcceptanceTaskId)
→ get_ready_tasks
→ implementation
→ advance_tasks(implementing → reviewing)
→ fresh review and validation
→ advance_tasks(reviewing → done, evidence)
```

`compile_tasks` requires a final acceptance task in the final phase whose dependency closure covers every earlier task.

## Agent tools

- `write_tasks`
- `edit_tasks`
- `compile_tasks`
- `clear_tasks`
- `get_ready_tasks`
- `advance_tasks`
- `workflow_gate`

`workflow_gate` can:

- create a structured user-owned decision gate;
- bind an opaque `pi-subagents` or workflow run ID to an implementing task;
- clear the exact matching execution receipt.

It does not start, stop, resume, or inspect the external run itself.

## Human command

```text
/continuous-tasks status
/continuous-tasks pause [reason]
/continuous-tasks resume
/continuous-tasks resolve <decision-id> <answer>
```

## Development

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm run lint
npm run format:check
npm audit --omit=dev --audit-level=high
```

The design and implementation-readiness packet are in [`../docs/continuous-tasks-extension-design.md`](../docs/continuous-tasks-extension-design.md).
