# Handoff: office files in the Drive (PDF, Word, PowerPoint)

**For:** the next orchestrator agent picking up `plan/phase-office-files.md`.
**State as of:** 2026-11-20, ~14:30.
**Read first:** `AGENTS.md`, then `plan/phase-office-files.md` (the approved plan: clean-room rules §1, stack §2, foundation §3, milestones §4), then the office entries in `plan/progress.md` (2026-11-20).

## 1. Where things stand

| Piece | State | Commits |
|---|---|---|
| Foundation F | on `main`, pushed, on the box | `c3b46ebc`, `c880c4c5` |
| P1 PDF viewer + text for agents | on `main`, pushed, on the box | `1bbd3676`, `7b3b63cb` |
| D1 Word view + text for agents | on `main`, pushed, on the box | `0e3d61e7` |
| S1 PowerPoint view + text for agents | on `main`, pushed, on the box | `d6e37cae` |
| Drive list name-column fix, e2e hydration waits | on `main`, pushed, on the box | `00ad3192` |
| Office revision history (download any version, restore) | on `main`, **not pushed** | `09d8693f` |
| **P2** PDF organise + agent tools | **in progress**, worktree branch | `worktree-agent-aeba4868780601270` (first commit `42e774e7`) |
| **D2** Word editing (ProseMirror) | **in progress**, worktree branch | `worktree-agent-aca1cf1e9b242ae5b` (no commits yet) |
| **S2** PowerPoint editing | **in progress**, worktree branch | `worktree-agent-ae542c139edcfa4b3` (no commits yet) |

- **The box** (https://os.ee.localhost) runs release `0.5.29-282565d8`: viewers only, no editing, no revision panel.
- **The three M2 branches** were started by the previous orchestrator's subagents. Their worktrees are under `.claude/worktrees/agent-<id>`.
  - If those agents are gone, nobody will finish them automatically. Check each branch, `git log main..<branch>`, and the uncommitted changes in its worktree (`git -C .claude/worktrees/agent-<id> status`).
  - Then either finish the work yourself, or start a fresh subagent in that worktree with the brief in §4.
- **Another session works on `main` at the same time** (company brain, Drive app previews). Never commit its uncommitted files. Stage only your own paths.

## 2. Your job, in order

1. **Collect the three M2 streams.** For each branch:
   - Review it: clean room (§3 below), scope (only its own files), no `$effect` control flow, no silent fallbacks.
   - Merge it into `main` with `--no-ff`. Resolve the expected conflicts:
     - `src/lib/office/viewers.ts`: keep every format's line.
     - `package.json` / `package-lock.json`: keep both sides, then run `npm install` in the main checkout.
   - Apply the orchestrator changes it asks for. Typical requests:
     - new `OfficeViewerProps` fields (e.g. a folder id for "extract to a new file")
     - `optimizeDeps.include` entries in `vitest.browser.config.ts` (ProseMirror may need them)
     - new Drive endpoints
     - UI-parity map entries
   - Remove the worktree after merging: delete its `node_modules`/`.env` symlinks first with `rm`, then `git worktree remove -f -f`, then `git branch -d`.
2. **Gate on `main`:** `npm run ci:local` must be green. Run it in the background; it takes about 3 minutes.
3. **e2e in isolation.** Never run e2e in the main checkout while another session is committing; see §5. Run:
   - `src/routes/e2e/drive.e2e.ts`
   - `src/routes/e2e/drive-office.e2e.ts`
   - Extend `drive-office.e2e.ts` with one editing step per format: organise a PDF page, edit a Word paragraph, edit a slide title. Each must save, reopen showing the change, and add a revision.
4. **Log** the merge in `plan/progress.md`: what shipped, commits, what broke, decisions, next.
   - Announce in it that office files are now editable.
   - Announce that the Word editor uses a flowing "Edit" layout, with pages only in view mode. This was a decision taken, not a silent choice.
5. **Ask the owner** before pushing and releasing. Release command: `scripts/release.sh arm64 && ee/e2e/box.sh install os.ee.localhost`.
6. **Milestone 3+** (annotations and forms, redaction/OCR/signatures, Word comments and tracked changes, PowerPoint comments, PDF export, co-editing) needs the owner's go-ahead first. Don't start it.

## 3. Rules that bind every agent on this work

- **Clean room:**
  - Never open, fetch, clone or search the source, tests or fixtures of `storytold/pdfcraft`, `eigenpal/docx-editor` or `eigenpal/pptx-editor`.
  - Never install `@eigenpal/*`, `@docx-editor.dev/*` or `pdfcraft*`.
  - Work only from the plan, ISO 32000-2, ECMA-376 and the docs of permissive libraries.
  - The Eigenpal editors keep tracked changes, comments, collaboration and PDF export under an evaluation-only licence. Our versions of those must be written strictly clean-room.
- **Dependencies:** MIT, BSD, Apache, ISC, or OFL for fonts. No GPL/AGPL (so no MuPDF or Ghostscript).
- **Stack (owner decision):** TypeScript everywhere; Svelte 5; DOM/SVG/Canvas 2D. No WebGL, and no Rust/WASM unless profiling proves a bottleneck.
- **Lossless saves:** parts nobody touched are written back byte for byte (`src/lib/office/ooxml/package.ts`). Edited XML keeps every attribute and child it doesn't change.
- **Saving:**
  - Every save goes through `createOfficeEditSession` (`src/lib/office/edit-session.ts`): the W-6 lock, one revision per editing session, takeover handling.
  - Agent tools go through the Drive service (`writeBytes`, `upload`), never the database directly.
  - Every UI mutation needs a registry tool (the CB4 parity gate, `src/lib/kernel/parity.spec.ts`).
- **Guardrails (AGENTS.md):**
  - TDD, and never weaken assertions.
  - No `$effect` for control flow.
  - No silent fallbacks: anything not drawn or not editable shows a visible note.
  - No name/regex heuristics for meaning:
    - Word headings come from `w:outlineLvl`.
    - PowerPoint placeholders are matched by type/idx.
  - Inline English strings, matching the Drive.

## 4. Brief for restarting a stream, if its agent is gone

Give the subagent the full milestone text from `plan/phase-office-files.md` §4 (P2, D2 or S2) plus everything below:

- **Setup:**
  - `git merge --ff-only main`
  - symlink `/Users/alexanderbuckner/+Code/eigenEnterprise/node_modules` and `.env` into the worktree
  - `npx svelte-kit sync`
- **Scope:** edit only `src/lib/office/<kind>/**` and `package.json`/lockfile.
  - P2 may also edit `modules/drive/pdf-tools*.ts`, the registration lines in `modules/drive/tools.ts` + `manifest.ts`, and the UI-parity map.
  - Anything else: stop and report the exact change needed.
- **Gate in the worktree:**
  - `npm run lint`
  - `npx svelte-check --tsconfig ./tsconfig.json` (**not** `--incremental`, which skips every path under `.claude/` and gives false errors)
  - `npm run test:unit`
  - `npm run test:components`
- **Never** run a dev server or Playwright. Playwright finds no tests under `.claude/`.
- **Decisions already taken:**
  - **D2:** edit in a flowing page-width ProseMirror surface styled from the document; keep pagination for view mode; no live pagination.
  - **P2:** organise mode stages changes with undo, and Save writes one revision.
  - **S2:** edits are serializable ops with inverses; untouched slides stay byte-identical.

## 5. Traps already found (don't rediscover them)

- **e2e in the main checkout is unreliable while another session commits.** Vite reloads mid-test: detached elements and repeated navigations. To get a reliable run:
  - `git worktree add --detach <scratchpad>/e2e-iso <commit>`, outside `.claude/`
  - symlink `node_modules` and `.env`
  - `npx svelte-kit sync`, so `$lib` resolves
  - `npm run db:migrate`, because the test DB falls behind new migrations
  - `npx playwright test -g "<test title>"`; file-path filters didn't match there
  - Clean up afterwards: `rm` the symlinks, then `git worktree remove --force`.
- **Hydration:** after a full page load, a click lands before hydration and does nothing. Use `gotoHydrated(page, url)` from `src/routes/e2e/test-helpers.ts`.
- **Component tests run without Tailwind** (by design, `vitest.browser.config.ts`). Layout and CSS can only be verified in e2e.
- **CommonJS packages in browser tests:**
  - They need `optimizeDeps.include` in `vitest.browser.config.ts` (xmldom is already listed).
  - Components that import the CSV editor pull in papaparse; mock `./csv-editor.svelte` in specs.
- **`src/lib/office/**/*.svelte.spec.ts`** is already enrolled in the browser gate.
- **xmldom** throws on fatal XML errors. The OPC layer turns them into `OpcError` (`c880c4c5`).

## 6. Known gaps after M1 (for the M2/M3 conversations)

- **PDF:** links inside pages aren't clickable; reading order ignores tagged-PDF structure; ICC colour management is off.
- **Word:**
  - Floating objects are placed in line.
  - Charts, equations and EMF/WMF are placeholders.
  - Multi-column sections render as one column.
  - Comments aren't shown; tracked changes are shown as markup.
  - Table rows taller than a page are clipped.
- **PowerPoint:**
  - Charts, SmartArt, effects, video and the `cloud` preset are placeholders.
  - Rect and shape path gradients are drawn radial.
  - Non-Latin numbering falls back to Arabic digits.
- **Infra:** `npm run check` (`--incremental`) fails inside `.claude/worktrees/`. This is worth a small fix in `package.json`'s `ci:local`, or a documented non-incremental variant for worktrees. It is cross-cutting, so raise it with the owner.
