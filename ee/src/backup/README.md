# ee backups (plan/phase-backups.md, milestone K1)

Nightly, client-side encrypted snapshots of a company to any S3-compatible
bucket, taken by ee itself (D16: a systemd timer fires `ee backup --scheduled`,
which asks the running ee daemon to do the work — no extra service).

## What a snapshot holds

| object | what | how it is taken |
|---|---|---|
| `snapshots/<id>/db.dump` | the company Postgres database (`os`) | `pg_dump --format=custom` as `postgres` |
| `snapshots/<id>/ee-state.tar.gz` | `/var/lib/ee/company` (desired state repo), `/var/lib/ee/secrets.enc` (sealed secret store: workload secrets, DB passwords, deploy keys, the backup config), `/etc/ee/master.key` (unseals it) | `tar -czf` |
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

## The backup key and the recovery code

The 32-byte backup key is generated when the owner first saves the bucket in
Settings → Backups. It is sealed in ee's secret store (scope `_backup`) so
nightly runs need no human, and shown to the owner **once** as a recovery code:
Crockford base32 of the key (52 chars) + 2 checksum chars, in 9 groups of 6
(`ABCDEF-…`). Case, dashes, spaces and O/0, I/L/1 look-alikes are forgiven when
typed back. Without the code, a lost server's backups cannot be read — by
anyone.

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
