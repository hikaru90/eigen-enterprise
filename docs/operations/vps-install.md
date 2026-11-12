# VPS install and upgrade

eigenEnterprise runs on a bare Linux server under **ee**, the company's init: one binary under systemd that installs Postgres (with pgvector, Apache AGE, pg_cron, pg_net) and Caddy, and runs eigenEnterprise and your apps. No Docker on the server. Design: [`plan/phase-substrate.md`](../../plan/phase-substrate.md).

Releases are published on GitHub for **x64 (amd64)** and **arm64**: <https://github.com/hikaru90/eigen-enterprise/releases>.

## Requirements

| | |
| --- | --- |
| OS | Ubuntu 24.04 LTS or Debian 13, fresh |
| CPU | x64 or arm64 (the installer picks the right build) |
| RAM / disk | ≥ 4 GB / ≥ 20 GB |
| Ports | 80/tcp and 443/tcp (Caddy gets certificates from Let's Encrypt); 7881/tcp and 7882/udp (call media) |
| DNS | your console host and `rtc.<console host>` (calls) point at the server — only with `--console-host` |

## Install

As root on the server:

```sh
curl -fsSL https://github.com/hikaru90/eigen-enterprise/releases/latest/download/install.sh \
  | sh -s -- --from https://github.com/hikaru90/eigen-enterprise/releases/latest/download --node-ip <public IP>
```

`--node-ip` is required: the public IP browsers send call (video and audio) media to. The installer never guesses it. On a VPS it is the address on the main interface (`ip -4 -brief addr show scope global`). If that shows only a private address (10.x, 172.16–31.x, 192.168.x), the server is behind NAT: use the public IP and forward 7881/tcp and 7882/udp to the server.

Optional: `--console-host os.example.com` (otherwise `<ip>.sslip.io`) and `--acme-email you@example.com`. With your own console host, also create a DNS record for `rtc.os.example.com` (calls) pointing at the server.

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

**First upgrade to a release with calls (v0.5.3 or later):** it stops once, before changing anything, and asks for the node IP. Open 7881/tcp and 7882/udp (host firewall and the provider's firewall, if either is on), then run `ee upgrade --node-ip <public IP>`. The IP is saved; later upgrades don't ask again. This first upgrade also redeploys every workload once (the console and apps switch without downtime).

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
