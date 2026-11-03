# Phase: Backups — the company's data leaves the server every night

**Status:** APPROVED (owner, 2026-11-03: "S3 backups"). Blocks real company use of the workspace (`plan/phase-workspace.md` §5).
**Must follow:** D11 (only humans change the server — the owner configures backups; the agent may read status), D16 (no new services: ee does it natively, no extra daemon), AGENTS.md (fail loud, secrets never logged).

## 1. What is backed up

Everything needed to bring the company back on a fresh server:
- the company Postgres database (`pg_dump` custom format — includes every app's schema per D-2 of module readiness),
- Drive blobs (`${EE_STATE_DIR}/drive` of the os workload — content-addressed, so incremental by hash),
- ee's own state: the company repo (desired state), the sealed secret store, deploy keys, and the agent's durable state (`agent.sqlite`, copied with SQLite's backup API, not a raw file copy).

## 2. Design

- **Owner (ee, root, system tier).** A `ee backup` verb + a systemd timer (nightly, randomized minute) + `ee backup now`. ee holds the S3 credentials in its sealed secret store.
- **Target:** any S3-compatible bucket (AWS S3, Hetzner Object Storage, Backblaze B2, MinIO): endpoint, region, bucket, prefix, access key, secret key. Path-style and virtual-host addressing.
- **Encryption before upload:** every object is encrypted client-side with a backup key generated at setup (AES-256-GCM in authenticated chunks, a documented format). The owner gets the key **once** as a recovery code to store safely; without it the backups are unreadable — said plainly in the UI. The key is also kept sealed on the server so nightly runs need no human.
- **Layout:** `<prefix>/snapshots/<timestamp>/manifest.json` (+ db dump, ee state, agent state) and `<prefix>/blobs/<sha256>` (Drive blobs, uploaded once). A snapshot is complete only when its manifest is written last.
- **Retention:** daily snapshots for 30 days (owner-configurable); ee prunes old snapshots and blobs no remaining snapshot references.
- **Health:** each run records start/end/size/result as a kernel event and in ee status; a failed or missing nightly run shows on Overview and Settings → Backups and notifies the owner (push).
- **Restore:** `ee restore --snapshot <id|latest>` on a fresh install (asks for the recovery code), restores DB, Drive, ee state and agent state, then reconciles. A dry-run `ee restore --verify` checks a snapshot is complete and decryptable without touching anything.
- **UI:** Settings → **Backups** (company-wide, rule 3 of phase-cohesion): set up the bucket (test connection before saving), show the recovery code once, schedule + retention, "Back up now", the last runs, and "How to restore" in plain words.

## 3. Milestones

- **K1 — ee backup engine:** S3 client (SigV4, multipart for large objects; a small pinned dependency or own implementation — justify), encryption format, snapshot + blobs + manifest, retention, `ee backup`/`backup now`/timer, `ee restore` + `--verify`. Tests against an in-process fake S3 and against MinIO.
- **K2 — Settings → Backups:** setup (connection test), recovery code once, schedule/retention, run now, history, failure notices; control-API endpoints in ee for status and configuration (owner only, D11).
- **Proof:** on the test server with a MinIO bucket: back up a company with Messages + Drive data → destroy the box → fresh install → `ee restore` with the recovery code → the messages, files and revisions are back.

## 4. Open (owner)

The real bucket (provider + credentials) — the owner enters them in Settings → Backups; nothing is needed from the owner to build and prove this with MinIO.
