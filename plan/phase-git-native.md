# Phase: Git-native — the company lives in git

**Status:** APPROVED direction (owner, 2026-11-03). G0 (the foundation) starts first; every later milestone moves one surface.
**Owner direction (2026-11-03):** "Every editable and user-interactable surface is a file that can be committed and pushed to git … files are the source of truth … everything, and the secrets also … everything gated for a certain user role should be encrypted … if I start fresh, everything should be rebuildable from what is committed to git, including the encrypted files." Remote: **a private GitHub repo**.
**Supersedes:** Postgres as the system of record for company data. Postgres stays, as a **rebuildable index** (queries, search, permissions lookups, realtime fan-out, sessions).

## 1. Principles (binding)

1. **The repo is the company.** Every durable piece of company state is a file in the company data repo. Fresh server + `git clone` + the company key = the same company, with nothing else needed.
2. **Postgres is derived.** Every table that holds company data can be dropped and rebuilt from the repo (`ee rebuild-index`). Writes go file-first (write file → commit → update index in the same operation); a crash between steps is repaired by reconciling index ← repo at boot.
3. **Encrypted where gated.** Anything not visible to everyone in the company is encrypted in the repo: private channels, DMs, restricted Drive folders/files, member-only data, and **all secrets** (API keys, provider credentials, SES keys, deploy keys, the tenant master key, passkey public keys, backup config). Company-wide content is plain text (readable diffs).
4. **Ephemeral stays out.** Sessions, rate-limit counters, caches, presence, push subscriptions' transient state, unread cursors (derivable) — not in git. After a rebuild people sign in again with their passkeys.
5. **Edits from git flow in.** A push to the GitHub repo (or a commit on the server) is pulled and re-indexed; the app shows the change. Conflicts fail loud (never silent overwrite).
6. **Deterministic files.** Canonical formats (sorted keys, stable ordering, one record per line where appendable) so diffs are small and merges are sane — same rule as eigen-design's `.eigen.json`.

## 2. Repo layout (v1, refined in G0)

```
company-data/
  company.md                      # name, founding answers (plain)
  settings/*.yaml                 # non-secret company + module settings
  members/<user-id>.md            # profile, role (plain); passkeys → secrets/
  groups/<slug>.yaml              # name, members (plain)
  access/<resource-type>/<id>.yaml# grants for that resource (plain metadata; content may be encrypted)
  drive/<path…>/<name>.md|.csv|…  # company-wide files plain; restricted ones as <name>.age
  drive/.meta/<file-id>.yaml      # ids, owners, created/updated, LFS pointers for binaries
  messages/<channel-slug>/<yyyy-mm-dd>.jsonl     # public channels, append-only
  messages/<channel-slug>/<yyyy-mm-dd>.jsonl.age # private channels / DMs, encrypted
  memory/{notes,projects,tasks}/<id>.md          # frontmatter + Markdown
  roadmap/<id>.md
  brand/active.json, brand/sets/<id>.json
  website/apps/<name>.yaml, website/routes.yaml
  agent/…                         # agent conversations (encrypted per owner), roadmap links
  secrets/<scope>/<name>.age      # every secret, encrypted
  .keys/recipients.yaml           # public recipients per scope (no private keys)
```
Binary Drive files (images, PDFs, uploads) via **Git LFS** (GitHub LFS storage), restricted ones encrypted before LFS.

## 3. Encryption

- **Format:** age (X25519), via a pinned library; every encrypted file is a standard `.age` file (decryptable with the `age` CLI given the key — no lock-in).
- **Keys:** a **company root key** generated at setup; the owner gets it **once** as a recovery code (same UX as the backup recovery code — the two become one). Per-scope data keys (one per private channel, DM, restricted folder, secret scope) are wrapped to the root key and stored in the repo; the server holds the root key sealed (ee secret store) to serve the app.
- **Access stays enforced by the app:** the server decrypts on behalf of a user only if the access contract allows it. Git readers without the root key see only company-wide plain content.
- **Rotation:** rotating a scope key re-encrypts that scope; removing a member from a private scope rotates its key (future content), documented limits for past history.

## 4. Git engine

- One writer: the os workload owns the working copy (`${EE_STATE_DIR}/company-data`), commits with the acting member as author (agent → its principal), batches high-frequency writes (messages: commit every few seconds per channel-day file; others: per save).
- Push: debounced to the private GitHub repo with a write-scoped credential for that one repo (GitHub App installation token with `contents: write`, minted per push — also resolves factory S4's open question).
- Pull: GitHub webhook (push event) → fetch → fast-forward → re-index the diff; non-fast-forward → loud error on Overview "Needs you", nothing overwritten.
- Index rebuild: `ee rebuild-index` (all) and incremental by diff; a boot-time reconcile (repo HEAD vs index watermark).

## 5. Milestones

Each: tests first, gates green, a **rebuild-from-scratch test** for the surface (wipe its tables → rebuild from repo → identical behaviour), a progress entry.

- **G0 — Foundation:** repo layout contract + canonical formats, encryption (age, root/scope keys, recovery code), git engine (commit batching, author mapping, push/pull, conflict → loud), index framework (per-surface `toFiles`/`fromFiles` + watermark + rebuild + boot reconcile), `ee rebuild-index`, one-time **export** of the current DB into a repo (migration path for existing installs).
- **G1 — Team:** settings, members (profile/role), groups, access grants, passkey public keys + secrets (encrypted).
- **G2 — Drive:** files + meta + revisions = git history (the own `drive_revision` table becomes an index of commits), LFS for binaries, restricted items encrypted.
- **G3 — Memory, Roadmap, Brand, Website config.**
- **G4 — Messages:** append-only day files, batching, private/DM encrypted; realtime stays in Postgres/NOTIFY (derived).
- **G5 — Agent state:** durable conversations (pi-durable SQLite is runtime state; settled conversations exported to the repo encrypted per owner), the agent's roadmap/factory links.
- **G6 — GitHub:** the private repo setup in Settings (connect via the GitHub App, create or pick the repo), push/pull + webhook, status on Overview.
- **Proof:** on the test server: a company with members, groups, messages (public + private + DM), Drive (plain + restricted + binary), memory, brand → push to a GitHub repo → **destroy the server** → fresh install → connect the repo + enter the recovery code → everything is back and the same people sign in with their passkeys. Plus: edit a Markdown file on GitHub → the app shows it.

## 6. Relation to other phases

- **Backups (`phase-backups.md`):** the GitHub repo (+ LFS) becomes the primary copy. The S3 backup in progress becomes the **second, independent copy** (encrypted repo bundle + LFS objects + nothing else needed); its database dump becomes unnecessary once G1–G5 are done. Kept, scoped down after G5.
- **Factory (`phase-software-factory.md`) S4:** the GitHub write credential mechanism from G6 is reused.
- **Workspace (`phase-workspace.md`):** Drive revisions and message storage move onto G2/G4; UI unchanged.

## 7. Risks

- **Volume:** a busy company produces many commits (messages). Batching + day files keep it bounded; GitHub repo size limits (soft 1–5 GB) and LFS quota must be watched — shown on Overview.
- **Key loss = data loss** for encrypted content. The recovery code UX must make this unmistakable; optional second holder (an admin) can be added later.
- **Two writers** (app + people pushing from git): conflicts fail loud; no auto-merge of encrypted files.
- **Rebuild time** grows with history; incremental reconcile by diff, full rebuild only on a fresh server.

## 8. Code, versions and restore (owner, 2026-11-03)

- **`system.yaml`** (data repo root) pins what runs: core release + commit, each extension with version + commit (`plan/phase-extensions.md`), installed apps with their source commits. Every change to it is a commit authored by the person who clicked deploy/update.
- **Restore** = fresh server → ee clones the data repo → reads `system.yaml` → installs exactly that core and those extensions → the core rebuilds the index from the files. Checking out an older data commit and restoring installs the matching older code.
- **Format versions:** every file family carries `format` + `version` (like eigen-design's `eigen-doc` v1). A core release that changes a format ships a migration; the migration's file changes are committed in the same step that bumps `system.yaml`, so data commit X always matches code commit Y. Migrations are expand/contract (D15) so updates stay reversible.
- **The core is never forked per company** (extensions plan): company code lives in the extensions repo, never in a company copy of the core.
