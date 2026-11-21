# GitHub repos in Drive: the full repo, not only the docs (proposed 2026-11-20)

Owner, 2026-11-20: "why does my connected github repo in eigen enterprise only show docs? it
should show all folders and all code in the repo" → "Plan full mirror".

**Status (2026-11-21): M0–M4 built and merged on main; not pushed, not on the box.** It builds on `plan/github-drive.md`
(approved 2026-11-12, S0–S4 shipped) and changes one owner decision there:
"README and the Markdown docs … No code files" becomes **every file of the default branch**.

Read first: `AGENTS.md` (guardrails: TDD, migrations + journal, no fallbacks, no silent removals,
no UI-only actions), `plan/github-drive.md` (the whole design this extends).

## 1. What the owner sees when it's done

```
Drive: GitHub / <owner> / <repo> /
  Overview.md · Branches.md · Pull requests.md · Activity.md     (generated, unchanged)
  <default branch>/                                              (NEW: the whole tree, e.g. "main/")
     src/… modules/… package.json … README.md …                  every folder and file, at its repo path
```

- Every file of the default branch, read-only (the existing source-item rule), code included.
- Code and other text files open in the Drive viewer as text. Images, PDFs, office files and HTML
  use the previews Drive already has. Anything else can be downloaded.
- The agent can read any text file through `drive.read` (it already reads `text/*`).
- Overview.md says what was copied: "N files, X MB from `main` @ `abc1234`", and lists anything
  not copied with the reason (see §4).
- **Per-repo choice "Copy: all files / docs only"** on the repos settings page. Default for new
  and existing repos: **all files**. "Docs only" keeps today's behaviour, for huge monorepos.

**Visible change, to announce (no silent removals):** the `Docs/` folder goes away. Its files now
live at their real paths under `<default branch>/`. With "docs only", the Markdown files sit under
`<default branch>/` too, at the same paths, so both modes have one layout. Put this line in the
session summary and in `plan/progress.md`.

## 2. Decisions taken (owner may veto, log them in progress.md)

1. **The folder is named after the default branch** (`main/`). Its key stays stable
   (`repo:<id>/tree`), so a renamed default branch only renames the folder. This leaves room for
   more branches later.
2. **Visibility unchanged:** the whole company can view, and admins narrow it with Drive sharing.
   That was the owner's 2026-11-12 decision. Code is more sensitive than docs, so the summary
   to the owner says so once.
3. **Fetching: tarball for big changes, single blobs for small ones** (§3). One tarball request
   costs 1 of the 5,000 requests/h, where per-blob reads of a 5,000-file repo would use up the
   whole budget.
4. **Limits** (constants in `modules/repos/snapshot.ts`, replacing `DOC_LIMITS`):
   - 50,000 files per repo
   - 20 MB per file
   - 2 GB per repo
   - Shallow paths win, as today, so the root files always make it.
5. **Not followed in v1, listed in Overview instead:**
   - submodules (tree entries of type `commit`, shown as `path → <sha>`)
   - symlinks (mode `120000`)
   - Git LFS pointer files: detected by the LFS pointer format's fixed first line
     `version https://git-lfs.github.com/spec/v1`. That is format parsing, not meaning.
6. **Integrity:** every file taken from a tarball is checked against the tree's git blob sha
   (`sha1("blob " + size + "\0" + bytes)`). A mismatch fails the sync loudly. Never write a file
   that doesn't match.
7. **Storage:** Drive's content-addressed blob store (`modules/drive/storage.ts`). Source items
   are already excluded from backups and the git-native data repo: they are derived, and GitHub
   holds the history. There are no Drive revisions for source files (unchanged).
8. **MIME type** by extension, using Drive's existing table (`modules/drive/preview.ts`
   `MIME_BY_EXT`). With no entry: `text/plain; charset=utf-8` when the bytes decode as strict
   UTF-8, else `application/octet-stream`. That is a byte-format check, not a semantic one.

## 3. Sync changes (`modules/repos/`)

Today (`snapshot.ts` `takeSnapshot`): when the default head moved, it reads the tree
(`client.tree`), keeps `.md/.mdx` (`pickDocs`), and fetches each changed blob with
`client.blobText`, which is UTF-8 only.

New flow when the default head moved (everything else in the run stays as it is):

1. `GET git/trees/<head>?recursive=1` (exists). Pick files by mode, using
   `pickFiles(entries, mode: 'all' | 'docs')`, which applies the limits of §2.4.
2. Compare each picked entry's sha with the stored sha for that path.
   - **≤ 50 changed blobs**, and the tree is not truncated: fetch each one with
     `client.blobBytes(fullName, sha)`. This is new and returns a `Uint8Array`; `blobText` stays
     for nothing else and can be removed if unused.
   - **More than 50, the first sync, or a truncated tree:** `client.tarball(fullName, head)`, which
     is `GET /repos/{o}/{r}/tarball/{sha}`, a 302 to codeload. Stream it to a temp file under the
     Drive storage dir. Then read it with a new streaming ustar/pax **reader**: gunzip with
     `fflate`, already a dependency. `modules/drive/tar.ts` is a writer only; add the reader next
     to it or in `src/lib/server/github/`.
     - Strip the tarball's top folder `<owner>-<repo>-<sha>/`.
     - Keep only the picked paths and check each sha (§2.6).
     - With a truncated tree, the tarball's own listing is the file list: compute the blob shas
       from the bytes.
3. Write changed files through the new port call (§5), and remove paths that are gone.
4. **Don't touch the tree when the head didn't move.** Today `writeRepo` upserts every rendered
   item on every sync. At tens of thousands of files that is a query storm every 15 minutes.
   - Split it: generated pages are written every sync, and the tree only when
     `snapshot.tree.commitSha` changed, or Drive is missing items (reconcile per repo prefix).
   - Writes go in batches (see §5 `upsertMany`).
5. Memory: never hold the whole repo in memory. Stream file by file; the tarball is on disk.

**Stored state:**
- **Migration `0161_repo_files`** (+ journal entry + `src/lib/server/db/repos.schema.ts`):
  - new table `repo_source_files(source_id, path, sha, size, primary key (source_id, path))`
    replaces the `doc_shas` jsonb. 50k paths don't belong in one jsonb row.
  - `repo_sources.copy_mode text not null default 'all' check (copy_mode in ('all','docs'))`
  - keep `doc_shas` in 0161 (expand/contract, `plan/phase-substrate.md` D15): defaulted and
    unused by the new code, so the old blue-green slot keeps working. **The drop ships one
    release later**, in its own migration.
- `RepoSnapshot.docs` becomes `RepoSnapshot.tree`, with the same shape plus `bytes` and
  `skipped` (submodule/symlink/lfs). Only counts and the not-copied list are stored in the
  snapshot, never the file list (that's in the table).
- **Upgrade path:** existing sources have `doc_shas` but no rows in the new table, so their next
  sync is a "first sync" (tarball). The old `Docs/` items are removed by the normal reconcile,
  because they're no longer rendered.

**Rate budget:** keep the `guard()` / `RatePause` checks before every request, the tarball
included.

## 4. Overview.md (`modules/repos/render.ts`)

- Replace the "## Docs" section with "## Files":
  - `N files, X MB from \`main\` @ \`abc1234\`, in the main folder.` (docs mode says "Markdown files")
  - "Not copied": path, size and reason. Reasons: `file_size`, `file_count`, `total_size`, `name`
    (a path segment Drive can't hold: contains `\`, longer than 255, `.`/`..`), `submodule`,
    `symlink`, `lfs`. Show at most 200 lines, then "and N more".
- Keep the "GitHub cut the file list short" note only when the tarball fallback also failed.
  It shouldn't happen; if it does, it's an error, not a note.
- Update the summary input (`summary.ts`) if it reads `docs`: it must not send file contents to
  the model, only counts. Check this.

## 5. Drive changes (`modules/drive/`, `modules/repos/drive-port.ts`, `modules/index.ts`)

- **Port + writer:** add
  `upsertBytes(source, key, parentKey, name, bytes: Uint8Array, mime: string)`, which writes a
  blob only when the sha256 differs, like `upsertText`.
- **Batching:** add `upsertMany(source, items[])` so a sync writes in transactions of ~500 items,
  instead of one `getSourceItem` + insert per file.
- **Listing:** add `list(source, keyPrefix?)` scoped to one repo, plus a store index on
  `(source, external_key text_pattern_ops)` if needed.
- **`remove`:** batch-delete as well, and release unreferenced blobs. Check how Drive
  garbage-collects blobs today before adding anything.
- **Preview** (`preview.ts`): `previewKind` already returns `text` for `text/*`, so code files
  with the `text/plain` MIME type preview as text.
  - Add a size cap for the text preview: over 2 MB, show "too large to preview, download".
  - Line numbers in the text viewer if cheap. Syntax highlighting is not in this plan.
- **Drive rail / folder list performance:** open a folder with 2,000 files in the component tests
  and the e2e, and make sure the list stays usable (paging or virtualised rows if it doesn't).
- **HTML files** from a repo already open in the sandboxed frame (scripts, no same origin). That
  needs no change; add a test that a source HTML file gets the same sandbox.

## 6. The setting (registry first, then UI)

- Kernel tool `repos.set_copy_mode { repoId, mode: 'all' | 'docs' }` (owner/admin). It makes the
  repo due now. MCP and the CLI get it through the registry, because there are no UI-only actions.
- Repos settings page: a two-option control per ticked repo, which calls the tool. Switching to
  "docs only" removes the non-doc files on the next sync. The confirm says so.

## 7. Workstreams (disjoint files, one worktree each, under `.claude/worktrees/`)

| Stream | Scope | Files | Order |
|---|---|---|---|
| **M0 contract** | port types (`upsertBytes`, `upsertMany`, `list(prefix)`), `GitHubTokenClient.tarball` + `blobBytes` signatures, migration number 0161 reserved | `modules/repos/drive-port.ts`, `src/lib/server/github/token-client.ts` | first, on main |
| **M1 GitHub client** | `tarball` (follow 302, stream to file), `blobBytes`, tar reader with pax long paths, git blob sha check; fake in `modules/repos/testing.ts` | `src/lib/server/github/**`, tar reader file | ∥ |
| **M2 Drive writer** | `upsertBytes`, `upsertMany`, scoped `list`, batched `remove`, preview size cap, big-folder list check | `modules/drive/**`, `src/lib/components/drive/**` | ∥ |
| **M3 repos sync** | migration 0161, `pickFiles`, new snapshot flow, `writeRepo` split, render "Files", `repos.set_copy_mode` | `modules/repos/**`, `drizzle/0161*`, journal, `src/lib/server/db/repos.schema.ts` | after M0, against fakes; merge after M1+M2 |
| **M4 UI + e2e** | copy-mode control, e2e journey | repos settings route + component, `e2e/` | after M3 |

## 8. Tests first (TDD)

- **M1:**
  - tar reader: ustar, pax long path, a file over 8 GiB is rejected, a truncated archive fails loud
  - blob sha check, matching and mismatching
  - `tarball` follows a 302 and counts against the budget once
- **M2:**
  - `upsertBytes` writes the blob once per content
  - `upsertMany` is atomic per batch
  - `list(prefix)` returns only that repo
  - a source item stays read-only for a person and for the agent (existing rule, new call)
  - a binary file can be downloaded with the right MIME type
- **M3** (fake GitHub in `testing.ts`, extend its fixture with code files, a PNG, a submodule, a
  symlink, an LFS pointer and a path with `\`):
  - First sync: the tarball path. Every file lands at its path under `main/`; Overview lists the
    skipped files with reasons.
  - One file changed: a single blob fetch, no tarball, only that file rewritten.
  - 60 files changed: the tarball.
  - A head that didn't move: zero tree writes (assert on the fake port's call log).
  - A deleted file is removed. A renamed default branch renames the folder; the keys stay.
  - "docs only" gives today's file set at the new paths. Switching modes adds or removes files.
  - Limits: count, file size and total, shallow first.
  - Rate pause mid-tarball: nothing half-written. Either the sync writes nothing new, or the
    stored shas match what's in Drive.
  - Upgrade: a source with `doc_shas` and a `Docs/` folder ends with no `Docs/` and the full
    tree under `main/`.
  - The summary input carries no file contents.
- **M4 e2e:** connect a fake repo, see `main/src/index.ts` open as text, a PNG as an image,
  Overview's file count; switch to docs only and see the code go.

## 9. Done when

- On the box, a connected repo shows every folder and file of its default branch under
  `GitHub/<owner>/<repo>/<branch>/`. Code opens as text, and the agent can `drive.read` it.
- A sync where nothing moved makes no tree writes. A sync with a small change fetches only the
  changed blobs.
- `npm run check`, `npm run lint`, unit, components and e2e are green.
- `plan/progress.md` has the entry with the decisions of §2 and the `Docs/` → `<branch>/` change.
- Released with `scripts/release.sh arm64 && ee/e2e/box.sh install os.ee.localhost` and checked
  there. os.cerberusblue.com only on the owner's go-ahead.

## Not in this plan

- Branches other than the default one (the folder naming leaves room).
- Following submodules, LFS objects, symlink targets.
- Syntax highlighting, code search (`repos.search_code`), indexing code into the company brain
  (that's CB8's question for all of Drive).
- Running a repo as a Drive web app (`drive.app_run`). Source folders are read-only, and app run
  is a separate decision.
- Writing anything to GitHub (the token stays read-only).
