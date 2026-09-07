---
name: dev-agent-protocol
description: How to dispatch code tasks to the dev-agent module (headless pi in a worktree sandbox) and what the prompt contract is. Use when you want code changes implemented by the self-improvement agent.
---

# Dev-Agent Protocol

The `dev-agent` module is the recursive-improvement building block: it runs the
**pi coding agent headlessly** inside a dedicated **git worktree sandbox**,
verifies the result, and lands it via an owner-approved merge. One run at a
time.

## Dispatching a task

All interaction goes through kernel tools (`ee` CLI / MCP surface):

| Tool | Who | What |
|---|---|---|
| `dev-agent.dispatch` | owner, agent | Start a run: `{ "task": "<code task>" }`. Returns `{ runId }`. Fails with `run_in_progress` while another run is active. |
| `dev-agent.status` | admin, agent | One run by optional `runId`, or all runs. |
| `dev-agent.logs` | admin, agent | Full log of one run incl. stored (truncated) pi output. |
| `dev-agent.merge` | **owner only** | Land a **green** run: merge into main, remove worktree + branch. Git failures are loud and leave the run green (retryable). |
| `dev-agent.abort` | owner, admin | Kill a running run or clean up a finished one. Not for dispatched/merged/aborted runs. |

## Run lifecycle

```
dispatched -> running -> green -> merged (via dev-agent.merge, owner)
                     \-> red     -> aborted (cleanup, branch -D)
                      \-> failed -> aborted
```

- `green` = in the worktree, `npx vitest run src/cli src/lib/kernel src/lib/server/mcp modules`
  and `npm run check` both exited 0.
- `red` = pi finished but verification failed (read `dev-agent.logs`).
- `failed` = pi itself died, or sandbox setup broke.
- Never merge a red/failed run. Fix or abort.

## The prompt contract

`dispatch` sends `pi -p --mode json "<task>"` where the prompt is the task text
plus a **mandatory suffix** (modules/dev-agent/prompt.ts). The suffix binds the
pi run to the repo engineering rules; it is not negotiable:

- tests must pass (`npx vitest run` for touched scopes)
- `npm run check` must not add errors beyond the 5 baseline (push/vapid, posthog)
- single commit, imperative message
- no secrets, no weakening tests, no fallbacks — AGENTS.md is law

So: write the `task` as a complete, self-contained engineering brief. The agent
has no conversation with you — the task text is the whole instruction.

## Sandboxing

Each run gets `../ee-da-<runId>` worktree on branch `wt/da/<runId>`, created in
the MAIN repo. pi works only inside that worktree; main is touched only by
`dev-agent.merge`.
