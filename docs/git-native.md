# Git-native company data (G0 foundation)

Plan: `plan/phase-git-native.md`. Code: `src/lib/server/gitstore/`. This page is
for the agents moving surfaces in G1–G5.

## The rule

Files in the **company data repo** are the truth; Postgres tables are an
**index** rebuilt from them. Every write is file-first: write the file → update
the index → commit (batched). A crash anywhere in between is repaired at boot by
`reconcile({ recover: true })`.

## Where the repo lives

`COMPANY_DATA_DIR`, else `$EE_STATE_DIR/company-data` (the os workload's state
dir), else the server refuses to start the surface. The os workload is the
**one writer**: this is a separate repo from ee's desired-state repo
(`ee/src/company-repo.ts`, written only by ee, holds workloads/routes) and from
the kernel's per-tool code autocommit (`src/lib/kernel/vcs.ts`,
`EE_VCS_AUTOCOMMIT`, commits the *code* checkout). Three repos, three writers,
no sharing of a working tree.

## Layout (v1) — `src/lib/server/gitstore/layout.ts`

```
system.yaml                 pins core / extensions / apps (system.ts)
company.md   settings/   members/   groups/   access/   drive/   messages/
memory/   roadmap/   brand/   website/   agent/
secrets/<scope>/<name>.age  every secret, encrypted
.keys/recipients.yaml       root + per-scope public recipients
.keys/scopes/<scope>/<generation>.age   scope private keys, wrapped to the root
extensions/<id>/…           reserved: each extension's own data folder
```

A surface owns its prefix(es); the framework refuses writes outside them and
overlapping registrations. `assertRepoPath` refuses `..`, absolute paths, `.git`.

## Formats — `canonical.ts`

- `canonicalYaml` / `canonicalJson`: keys sorted recursively, arrays keep order
  (sort a set yourself before writing), Dates → ISO UTC, trailing `\n`,
  YAML 1.2 core schema both ways (ISO strings stay strings), no folding.
- `canonicalMarkdown` / `parseMarkdown`: `---` frontmatter (canonical YAML) + body.
- `jsonlLine` / `appendJsonl` / `parseJsonl`: one compact sorted record per
  line; append never rewrites existing bytes (messages day files, G4).
- **Every file family carries `format` + `version`** (e.g. `format:
  eigen.group`, `version: 1`). The framework refuses unknown formats and
  newer versions loudly (`FormatVersionError`, names the fix: install the core
  pinned in `system.yaml`) and runs registered migrations (v → v+1) as ONE
  server-authored commit before indexing.

## Adopting the framework (one adapter per surface) — `framework.ts`

```ts
interface SurfaceAdapter<Entity, Row = Entity> {
  surface: string                 // "groups": watermark + batching key
  paths: readonly string[]        // ["groups/"]
  format: string                  // "eigen.group"
  version: number                 // what this code writes/reads
  formatOf(path, text): { format; version }
  migrations: readonly { from: number; migrate(path, text): FileChange[] }[]
  toFiles(entity): { path; content }[]
  fromFiles(files: Map<path, text>): { rows; problems }   // bad files → problems, skipped
  replaceIndex(rows): Promise<{ problems }>                // idempotent: index == rows
}
```

1. Write the adapter + an index (`GroupIndex`-like: all/get/upsert/remove/replaceAll).
2. Wrap the surface's existing store so its reads stay on Postgres and its
   writes call `framework.writeThrough({ surface, changes, author, message, index })`.
   Pass the acting member id down so the commit author is right.
3. Register it in `live.ts` (`buildFramework`) and add a `loadAll` source to
   `exportLiveDb` (existing installs are exported once at boot, never wiped).
4. Tests: byte-determinism of the file, rebuild-from-scratch (wipe tables →
   `rebuildIndex` → identical reads), external edit → `reconcile` → index
   reflects it, a migration test. `surfaces/groups.spec.ts` +
   `db.integration.spec.ts` are the templates.

Watermarks (`gitstore_watermark`, migration 0113): the commit each surface's
index was built from. Our own commits advance it; `reconcile` rebuilds any
surface whose paths changed since (or whose watermark is missing / not in
history — e.g. after a force-push).

## Git engine — `engine.ts`

- git CLI via `spawn` (on every box; LFS needed in G2; same as ee's repo).
  All operations serialized through one queue.
- **Author** = the acting member (`liveAuthor`: user name + email; an agent
  principal → `agent <id> <id@agents.eigen.local>` — the kernel's ToolContext
  does not yet carry the human principal behind an agent; map it there when it
  does). **Committer** = `eigenEnterprise <os@eigen.local>`.
- **Batching**: per-surface debounce (`debounceMs: { messages: 3000 }`; default
  0 = commit at once). Writes inside the window share one commit; a different
  author closes the batch. `flush()` forces.
- **Remote**: `push/pull({ url, credentials? })`. Credentials go in through
  `GIT_CONFIG_*` env (`http.extraHeader`), never argv, never stored. Pull =
  fetch → fast-forward only → returns changed paths (call `reconcile()`
  after). Diverged history (pull or a rejected push) → `GitConflictError`, the
  state is persisted in `.git/eigen-conflict.json`, push/pull refuse until a
  person merges and `clearConflict()` (which checks HEAD contains the remote
  commit). Nothing is overwritten; no auto-merge. G6 wires GitHub + webhook +
  the Overview "Needs you" item.

## Keys and recovery — `keys.ts`

- age X25519 via `age-encryption` 0.3.1 (Filippo Valsorda's TypeScript
  implementation, the reference library; standard `.age` output — proven by a
  test against the Go `age` CLI v1.2.1 when `AGE_CLI`/`age` is available).
- **Company root key**: one X25519 identity generated at setup
  (`generateRootKey`). The owner sees it once as the **recovery code**
  `EE1-XXXXX-…` (32 key bytes + 2-byte checksum, Crockford base32; tolerant of
  case, spaces, O/0, I/L/1; typos caught). It is the **one** company recovery
  code: the backup key of `plan/phase-backups.md` is `deriveBackupKey(root)`
  (HKDF-SHA256, info `eigenEnterprise backup key v1`), so K2's "show the
  recovery code once" must show THIS code, not mint a second one.
- **On the server**: `SealedRootKeyStore` at `COMPANY_KEYS_DIR` or
  `$EE_STATE_DIR/company-keys/root.sealed` (0600), AES-256-GCM under
  TENANT_MASTER_KEY — which ee keeps in its sealed secret store and injects.
  So the chain is rooted in ee's store while the os workload (the one writer)
  can create the key at setup and read it at boot without a control-API
  round-trip. Never replaced by a different key.
- **Scopes**: `KeyRing.ensureScope('secrets/test')` mints a scope key, wraps it
  to the root recipient (`.keys/scopes/<scope>/1.age`) and lists its public
  recipient in `.keys/recipients.yaml`. `encrypt(scope, …)` needs only public
  data; `decrypt` needs the root key. `rotateScope` mints generation n+1 and
  re-encrypts the scope's current files; older generations stay wrapped so
  history remains readable (removing a member protects future content only).
  The KeyRing returns `FileChange[]`; commit them through the engine.
- **Restore**: fresh server → clone → `rootKeyFromRecoveryCode(code)` →
  `SealedRootKeyStore.save` → `rebuildIndex('all')`. `system.yaml`
  (`readSystemPin`) says which core/extensions to install first.

## Operator commands

`npm run company-data -- rebuild-index [surface|all] | reconcile | export | status`
(`scripts/company-data.ts`, runs with the os workload's env). ee's
`ee rebuild-index` verb is to call this entry point (not wired in G0).

## G0 status

Groups are file-first (`groups/<slug>.yaml`, `format: eigen.group` v1). Not yet
wired: the root-key setup UI / recovery-code screen, secrets on KeyRing,
GitHub remote + webhook (G6), `ee rebuild-index` in the ee binary.
