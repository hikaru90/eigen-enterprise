# Phase Managed Box — what a hosted company's box needs

**Status:** Approved by the owner 2026-11-16 ("just build it"). Box side is open source here; the control plane that runs the hosted offer is a separate, private repo (`eigenEnterprise-cloud`).
**Source:** Owner conversation, 2026-11-16: the product splits into open-source self-host and hosted. Hosted companies each get their own VM, on bare-metal servers we rent (Hetzner or Netcup dedicated), not a VPS each. A card is required at signup. The system must stay modularly extensible.
**Must stay congruent with:** `phase-substrate.md` (ee is init; no Docker; typed verbs, no "run this"), `phase-backups.md`, `video-calls.md`, `contribute-phone-home.md` (the signing pattern).

## 0. Shape

```
internet ─► bare-metal host, one public IPv4
  :443  HAProxy, SNI passthrough + PROXY v2 ─► the VM's own Caddy (its TLS, its certs)
  :80   HAProxy by Host + PROXY v2           ─► the VM's Caddy (ACME HTTP-01, redirects)
  rtc   one tcp/udp port pair per VM         ─► nftables DNAT to that VM's LiveKit
VM (Incus/KVM, one per company) ─► NAT ─► internet
VM's ee ── HTTPS pull, Ed25519-signed ──► control plane (fleet protocol)
```

**The box stays the self-host box.** Everything below is off unless the install passes the flag; a self-hosted install behaves exactly as today.

## 1. Box changes

| # | Change | Why |
|---|---|---|
| M1 | `--rtc-ports <tcp>,<udp>` at bootstrap (kept on re-runs; default 7881,7882). The host-port allow-list becomes "the company's configured LiveKit ports", limited to the defaults or 20000–29999. LiveKit's `rtc.tcp_port`/`rtc.udp_port` follow. | Behind one shared IP each VM needs its own media ports, and LiveKit must listen on the port browsers are given (ICE candidates carry it), so the router can't remap. |
| M2 | `--trusted-proxy <cidr>` at bootstrap (kept; default none). Caddy's public servers get the `proxy_protocol` listener wrapper allowing only that CIDR. | Without it every box sees the host router as the client (login audit, rate limits). |
| M3 | `--claim-hash <sha256 hex>` at bootstrap (first install only). ee stores the given hash instead of minting a token, and prints no link. | The control plane mints the claim token and redirects the person who signed up. Nobody reads a cloud VM's console. |
| M4 | Managed mode: `ee managed enroll --control-plane <https origin> --token <t>`, then the daemon polls `ee/src/fleet/protocol.ts`. Desired state: release, suspended, backup target, platform AI, backup now. Report: versions, health, seats, hosts, disk, backup. os exposes seats to ee on loopback with a per-box bearer token. | We manage the fleet without SSH or an inbound port; level-triggered and typed like the rest of ee. |
| M5 | Signed releases: CI signs `SHA256SUMS` with an Ed25519 key held only in GitHub secrets; `install.sh` and `ee upgrade` verify the signature before running anything (public key embedded). | With a fleet, choosing a version on the control plane must not equal root on every box. Self-hosters get it too. |

## 2. Decisions of record

- **D1** Pull only. The control plane never connects to a box.
- **D2** Desired state, not commands. One-off actions are timestamps (`backupRequestedAt`), so a repeated poll is harmless.
- **D3** Extensible by feature list: the box announces `features`; unknown desired fields are ignored and reported back (`ignoredFields`), never fatal. New features append to `FLEET_FEATURES`.
- **D4** The control plane vendors `ee/src/fleet/protocol.ts` verbatim.
- **D5** Suspended = every host answers 503 with a short "paused" page; os, data and backups keep running (reversible at once).
- **D6** Seats = active human members (no agents, no service principals), counted by os.

## 3. Owner steps (not code)

Bare-metal server with `/dev/kvm`; the hosted domain + one wildcard DNS record; Stripe account; S3 bucket for backups; the platform AI provider key; a Let's Encrypt rate-limit override for the hosted domain; the release signing key in GitHub secrets. Tracked in `plan/progress.md`.
