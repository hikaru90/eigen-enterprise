# ee backups (plan/phase-backups.md, milestone K1)

Nightly, client-side encrypted snapshots of a company to any S3-compatible
bucket, taken by ee itself (D16: a systemd timer fires `ee backup --scheduled`,
which asks the running ee daemon to do the work — no extra service).

## What a snapshot holds

| object | what | how it is taken |
|---|---|---|
| `snapshots/<id>/db.dump` | the company Postgres database (`os`) | `pg_dump --format=custom` as `postgres` |
| `snapshots/<id>/ee-state.tar.gz` | `/var/lib/ee/company` (desired state repo), `/var/lib/ee/secrets.enc` (sealed secret store: workload secrets, DB passwords, deploy keys, the backup config), `/etc/ee/master.key` (unseals it), the os workload's `company-data` git repo and `company-keys` (sealed company root key) | `tar -czf` |
| `snapshots/<id>/agent.sqlite` | the agent's durable state (`/var/lib/ee-state/os/agent/agent.sqlite`) | SQLite **online backup API** (`node:sqlite` `backup()`), never a raw copy |
| `blobs/<sha256>` | Drive blobs (`/var/lib/ee-state/os/drive/blobs/aa/bb/<sha256>`) | content-addressed: uploaded once, skipped when already in the bucket |
| `snapshots/<id>/manifest.json` | list of the files (size, sha256 of the plaintext) and of every blob the snapshot references | written **last** |

`<id>` is the UTC start time, `20261103T031700Z`. A snapshot without a manifest
is incomplete: it is never restored from and is pruned after a day.

Every object — the manifest included — is encrypted (format below), so the
bucket provider sees object sizes and the sha256 *names* of Drive blobs, nothing
else.

## Encryption format "EEBK v1"

```
header (41 bytes)
  0  4  magic "EEBK"
  4  1  version = 0x01
  5  4  chunk size C, uint32 big-endian (default 1 MiB)
  9 32  salt (random per object)
chunks
  AES-256-GCM(ciphertext ‖ 16-byte tag) of each C bytes of plaintext;
  the last chunk holds 0..C bytes (an empty object is one empty final chunk)
```

- Per-object key: `HKDF-SHA256(ikm = backup key, salt, info = "ee-backup/v1/object-key")`, 32 bytes.
- Nonce for chunk *i* (12 bytes): 7 zero bytes ‖ `i` as uint32 BE ‖ final flag (`0x01` on the last chunk, else `0x00`).
- AAD of every chunk: the 41-byte header.

So a flipped bit fails its chunk's tag; reordered or dropped chunks fail (the
counter is in the nonce); truncation at a chunk boundary fails (the new last
chunk was sealed as non-final); a swapped header fails (it is the AAD). On top,
restore checks every file's and blob's plaintext sha256 against the manifest.

## The backup key and the ONE company recovery code

There is one recovery code per company (plan/phase-git-native.md §3): the
company root key, an age X25519 identity minted by the app
(`src/lib/server/gitstore/keys.ts`), written `EE1-XXXXX-…` (Crockford base32 of
the 32 key bytes + a 2-byte checksum `sha256("EE1" ‖ bytes)[0..2]`, groups of 5).

The backup key is **derived** from it:
`HKDF-SHA256(ikm = root key bytes, salt = empty, info = "eigenEnterprise backup key v1", 32)`
(`deriveBackupKey` in the app and in `crypto.ts` here — a shared test vector
pins them together). When the owner first saves Settings → Backups, the app
loads (or creates) the root key, derives the backup key and sends it once in
`POST /v1/backups/config { backupKey }`; ee seals it in its secret store (scope
`_backup`, name `KEY`) so nightly runs need no human. ee never receives the root
key or the code; a later config with a different key is refused (it would
orphan every snapshot). The page shows the same `EE1-…` code to confirm it is
stored. `ee restore` asks for that code and derives the backup key from it.

## S3 client: own implementation (`s3.ts`)

ee ships as one bundled `ee.mjs` with zod as its only dependency. The AWS SDK v3
S3 client bundles to several MB with dozens of transitive packages; the small
community clients (e.g. aws4fetch, minio-js) either lack multipart or pull in
their own trees. ee needs five verbs — PUT, multipart (initiate/part/complete/
abort), GET, ListObjectsV2, DELETE — plus SigV4, which is ~150 lines tested
against the AWS documented signature example, an in-process fake that verifies
every signature, and a real MinIO. Path-style and virtual-host addressing.

## Retention

After each successful run: complete snapshots older than `retentionDays` are
deleted (manifest first, so a half-deleted one reads as incomplete) — the
newest complete snapshot always stays; incomplete snapshots older than a day
are deleted; then every `blobs/<sha>` no remaining manifest lists is deleted.
If any remaining manifest cannot be read, the blob sweep stops: ee never
deletes a blob it cannot prove unreferenced.

## Restore

```
# on a fresh server: install first, then restore over it
ee bootstrap --release <tarball> …
ee restore --snapshot latest --endpoint https://… --region … --bucket … \
  [--prefix …] [--addressing path|virtual] --access-key-id …
  # stdin: the S3 secret key, then the recovery code
ee restore --verify [--snapshot <id>]   # download + decrypt + check hashes; writes nothing
```

Restore downloads and verifies everything before it touches the box, then:
stops ee, the backup timer and every workload unit; replaces the company repo,
the sealed secret store and the host key; drops and `pg_restore --create`s the
`os` database; copies Drive blobs and `agent.sqlite` into the os state dir
(owned by the workload's user); starts ee, whose reconcile re-renders env
files, re-keys the database role with the restored password and redeploys.
The drill is `ee/e2e/restore-drill.sh`.

## Check and restore from Settings → Backups (`restore.ts`)

The owner can check or restore any complete snapshot from the console; ee does
the work, the console only asks (control API, owner-only page, D11):

```
GET  /v1/backups/snapshots   complete snapshots in the bucket, newest first
GET  /v1/backups/restore     the last check/restore job (polled by the page)
POST /v1/backups/check       { snapshotId, author }             → 202 { job }
POST /v1/backups/restore     { snapshotId, backupKey, author }  → 202 { job }
```

- **Check** = `ee restore --verify` in the daemon: download, decrypt and hash
  every file and blob of that snapshot with the sealed key. Writes nothing.
- **Restore** asks for the company recovery code like the CLI does. The app
  turns it into the backup key and sends only that (ee never sees a code); ee
  refuses a key that is not the sealed one (422), holds it in memory for the
  verify and never writes it. The daemon downloads + verifies the whole
  snapshot into `/var/lib/ee/backup-tmp/restore-<id>` (nothing on the box is
  touched if any check fails), then starts the transient
  `ee-restore.service` (`systemd-run … ee restore-apply --snapshot <id>`),
  because the apply stops ee.service itself. The unit needs no key: it runs
  the same steps as the CLI restore (stop ee and the workloads, ee state,
  database, Drive + agent, start ee) on the already-verified files.
- One job at a time: a backup, a check or a restore; the others get 409.
- Progress (`step`: verifying → handover → stopping → restoring-state →
  restoring-database → restoring-files → starting → done) lives in
  `/var/lib/ee/restore.json`, written by the daemon up to the hand-over and by
  the unit after it, so the page can poll it again once ee and os are back.
  A job cut off by a restart reads as failed (`verifying`/`handover`: nothing
  changed; later: possibly partly restored). If the unit fails it records the
  error and starts ee again so the page can show it. The terminal event is
  journaled (`restore.succeeded` / `restore.failed`) when the daemon next reads
  the job.
- Whole box only: there is no partial restore.
