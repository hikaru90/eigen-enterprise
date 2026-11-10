# VPS install and upgrade

eigenEnterprise runs on a bare Linux server under **ee**, the company's init: one binary under systemd that installs Postgres (with pgvector, Apache AGE, pg_cron, pg_net) and Caddy, and runs eigenEnterprise and your apps. No Docker on the server. Design: [`plan/phase-substrate.md`](../../plan/phase-substrate.md).

Releases are published on GitHub for **x64 (amd64)** and **arm64**: <https://github.com/hikaru90/eigen-enterprise/releases>.

## Requirements

| | |
| --- | --- |
| OS | Ubuntu 24.04 LTS or Debian 13, fresh |
| CPU | x64 or arm64 (the installer picks the right build) |
| RAM / disk | ≥ 4 GB / ≥ 20 GB |
| Ports | 80 and 443 open (Caddy gets certificates from Let's Encrypt) |

## Install

As root on the server:

```sh
curl -fsSL https://github.com/hikaru90/eigen-enterprise/releases/latest/download/install.sh \
  | sh -s -- --from https://github.com/hikaru90/eigen-enterprise/releases/latest/download
```

Optional: `--console-host os.example.com` (otherwise `<ip>.sslip.io`) and `--acme-email you@example.com`.

The installer verifies every download by checksum, then prints a private **claim link** — open it to become the company's owner. Lost it? `ee claim-link`.

## Upgrade (over the air)

```sh
ee upgrade --check   # what would be installed
ee upgrade           # install the newest release
```

An upgrade keeps everything — people, messages, Drive files, websites and apps, connected repos and deploy keys, domains and certificates, secrets, the backup schedule:

1. **Safety copy first** — a database dump and ee's state (company repo, sealed secrets, master key) in `/var/lib/ee/upgrades/<time>/`, with the exact rollback steps in `ROLLBACK.txt` (the three newest copies are kept). If the copy fails, nothing is changed.
2. **The release installer** runs again: it installs what is missing and never upgrades installed packages, and Caddy keeps serving (it is restarted only if its unit changed).
3. **Health-gated deploy**: the new version starts next to the running one, migrations run, and traffic switches only when it is healthy. If it never becomes healthy, the old version stays live.

Servers installed before `ee upgrade` existed (no `ee upgrade` command yet): run the install line above once — it upgrades in place the same way and brings `ee upgrade` with it.

## Roll back

`cat /var/lib/ee/upgrades/<time>/ROLLBACK.txt` and run the steps: they stop ee and the apps, restore ee's state and the database (including the Apache AGE graph-id repair a restore needs), and start ee, which redeploys the release that ran before.

## Backups

Off-box, encrypted, nightly: Settings → Backups (S3-compatible bucket). `ee backup` takes one now, `ee backup status` lists them, `ee restore` restores (see `ee` for the flags).

## Useful commands

```sh
ee status          # desired vs applied state, apps, routes
ee logs os         # eigenEnterprise's logs
ee domain add <host> --workload <app>
```
