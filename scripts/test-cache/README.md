# Test cache: only what a change can affect

Owner, 2026-11-26: "only things that are changed get retested… we need a cache."

The push and release gates no longer run every test every time. Each suite remembers the
commit it last passed on (a clean tree, nothing uncommitted) and runs only the tests that
the changes since then can reach. The record lives beside the gate stamps, in
`<git common dir>/ee-gate/test-cache/`, shared by every worktree.

| Suite | Runs | How it knows what a test depends on |
|---|---|---|
| unit (`ci › test:unit`) | `vitest.mjs unit` | Vitest's import graph (`vitest list --changed <base>`), plus the files each spec **reads, lists or runs** (recorded by `vitest-record.ts` on every gate run: `fs` reads, directory listings, `child_process` calls) |
| components (`ci › test:components`) | `vitest.mjs components` | Vitest's import graph |
| browser e2e (release gate) | `e2e.mjs` | Recorded per e2e file on every gate run: the server code that **executed** (V8 coverage of the dev server, `vite-e2e-deps.mjs`) and the modules the browser **requested**, plus the dev server's import graph |

## When everything runs anyway

- `EE_GATE_FULL=1 npm run push -- …` (or no record yet, or the recorded commit is gone).
- Toolchain and shared inputs change: `package.json`, the lockfile, `vite`/`vitest`/`playwright`/`svelte`/`tsconfig` configs, `drizzle/`, `messages/` (Paraglide compiles all messages into one module every page loads), `vendor/`, this folder.
- e2e only: the harness (`src/routes/e2e/` files other than `*.e2e.ts`, `scripts/mock-*`, `e2e.sh`, the migrate/ensure scripts), `static/`, `src/app.html`, and any file whose code ran while the dev server started (a change there can break every test).

## How the e2e record decides

A changed file `F` re-runs an e2e file when that file's recorded run executed `F`, or
executed a file that imports `F` (a changed constant is read there; re-export barrels and
constant-only modules are followed through to whoever runs code). An e2e file with no
record (new, or not importing `test` from `./e2e-test`) always runs. A changed e2e file
runs itself.

Limits, by design of the approach: code that runs only on a timer (the once-a-minute email
tick) is attributed to whichever test was running then; a test that depends on something
no code path reaches (a file the server sends as is) is covered by the global triggers
above, not by the record.

## Reading it

`npm run gate:times` shows, under the step timings, what each suite ran and why
("12 of 1270 file(s) — 3 changed file(s) since abc"). The e2e gate also prints each
selected file with the reason ("it ran modules/email/inbox/service.ts").
