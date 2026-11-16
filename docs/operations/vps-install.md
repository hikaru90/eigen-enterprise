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

The installer verifies the release signature and every download's checksum (see [Signed releases](#signed-releases)), then prints a private **claim link** — open it to become the company's owner. Lost it? `ee claim-link`.

## After the install

The whole setup fits in one sitting:

1. **Rent a server** that meets the [requirements](#requirements) and open the ports.
2. **Run the installer** as root (above). It finishes with "Your company is running" and the claim link.
3. **Open the claim link.** It makes you the owner. It works once, for seven days; `ee claim-link` prints a new one.
4. **Tell the assistant about your company.** Connect your AI provider, then answer the assistant's questions about what you do and who for. It sets up the rest from your answers.
5. **Invite your team.** Send invite links. Each person adds their name, a photo and a passkey, and lands in Messages.

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

## Signed releases

Every release carries `SHA256SUMS` (the sha256 of each asset) and `SHA256SUMS.sig`, an Ed25519 signature by the project's release key. The public key is built into `install.sh` and `ee`; the private key never leaves the owner's machine and the release workflow's `EE_RELEASE_SIGNING_KEY` secret.

- `install.sh` checks the signature with OpenSSL (Debian 13 / Ubuntu 24.04 ship OpenSSL 3) and then every file it uses against `SHA256SUMS` — before installing anything, for `--from <url>` and `--from <dir>` alike. A missing or wrong signature, or one changed file, stops it.
- `ee upgrade` checks the signature and the downloaded `install.sh` before running it as root; otherwise it refuses and changes nothing.
- There is no way to skip the check. A build made before the key existed says "this build has no release signing key".

The key is made once with `scripts/release-key.sh` (it prints the `gh secret set` command). Copying a release to the server by hand (`--from <dir>`) needs `SHA256SUMS` and `SHA256SUMS.sig` next to the other files.

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
