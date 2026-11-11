# Video calls — the Calls module on LiveKit (draft, awaiting owner decisions)

Source: Contribute board item: "Chats are nice, but I want a video call function, both for
direct messages and for group calls." Status: **plan only, no code.**

**Owner decisions (2026-11-11):** video calls are their **own module** (`modules/calls`), not a
part of Messages, and the media server is **LiveKit**. This replaces the earlier draft
(`5afae92`: P2P WebRTC + coturn inside Messages, LiveKit later for groups).

## Where we start

- Modules live in `modules/<id>/` (manifest, service, store/db-store, tools, http) and are wired
  in `modules/index.ts`. System modules like `drive` self-seed active. Cross-module use goes
  through ports (`modules/messages/access-port.ts`); `modules/boundaries.spec.ts` enforces it.
- Messages realtime is server → client SSE (`GET /api/messages/stream`, Postgres LISTEN/NOTIFY via
  `MessagesHub`); client → server is `fetch` POST. No WebSocket in the console.
- ee (`ee/src/spec.ts`): a workload's source is a `release` tarball or a `git` mirror; the only
  runtimes are `node` and `static` (`appContractSchema`, `CATALOG`), units are node-only
  (`ee/src/units.ts`, DynamicUser, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`). There is
  **no host-port field**: every workload is reached only through Caddy (`ee/src/caddy.ts`,
  per-host `reverse_proxy` or `file_server`). System workloads get only console/public hosts
  (`ee/src/domains.ts`). Running LiveKit is therefore an eigen change (D16).

## Shape

One media path for every call: **all calls, 1:1 and group, go through LiveKit** (an SFU).
No P2P path, no separate coturn — LiveKit's embedded TURN covers restrictive networks.

```
browser ──https──▶ Caddy ──▶ console (os)      /calls, /api/calls/** (tokens, state, webhook)
browser ──wss────▶ Caddy ──▶ livekit-server    rtc.<console host>  (signalling, :7880 local)
browser ──udp/tcp──────────▶ livekit-server    7882/udp (media mux), 7881/tcp (ICE/TCP fallback)
livekit-server ──https webhook──▶ console      /api/calls/livekit (signed, participant joined/left)
```

### 1. `modules/calls` (the module)
- `manifest.ts` — `CALLS_MODULE_ID = 'calls'`, name **Calls**, system module (self-seeded
  active like Drive), tools listed below, `permissions: { roles: ['admin', 'agent'] }`.
- `store.ts` / `db-store.ts` / `memory-store.ts` — tables via `drizzle/NNNN_calls.sql` + journal
  entry + schema in `src/lib/server/db/`:
  - `call` (id, room name, `context_kind` `dm|channel|meeting`, `context_id` nullable, title,
    started_by, state `ringing|active|ended|missed|declined`, started_at, ended_at)
  - `call_participant` (call_id, user_id, invited_at, joined_at, left_at, response
    `accepted|declined|none`)
- `service.ts` — start a call for a context (who may join is decided by the context's owner
  module through a port: Messages answers "who are the members of this DM/channel"; a
  `meeting` has an explicit invite list), accept/decline/hang up, end when the last person
  leaves, ringing timeout → missed. Membership is checked on every action (fail closed).
- `livekit.ts` — mints room tokens with `livekit-server-sdk` (Apache-2.0): identity = user id,
  name = display name, grant = `roomJoin` for that one room, TTL ~10 min. Key + secret come from
  env set by ee from its secret store (`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`);
  any missing → explicit error, the Calls UI says "Calls are not set up on this server".
  Never logged (`*secret` redaction).
- `webhook.ts` — `WebhookReceiver` verifies LiveKit's signed webhook; `participant_joined`,
  `participant_left`, `room_finished` update `call_participant` / `call`. The webhook is the
  source of truth for "who was really in the call"; client calls only express intent.
- `hub.ts` — call frames (`call.ringing`, `call.state`) to the people involved. Reuses the
  console's SSE pattern (`src/lib/messages/resumable-stream.ts`); own stream
  `GET /api/calls/stream` so it rings on any nucleus page without depending on Messages.
- `tools.ts` — `calls.list` (read), `calls.start` (rings people → approval-gated),
  `calls.end`. Agents and the `ee` CLI see the same actions; **agents never join media**.
- `http.ts` + `src/routes/api/calls/**` — `POST /api/calls` (start), `/[id]/{accept,decline,
  hangup}`, `GET /[id]/token`, `GET /stream`, `POST /livekit` (webhook; CSRF-exempt in
  `src/lib/server/csrf.ts` like the SNS callback, signature-checked instead).

### 2. Messages integration (through a port, Messages stays call-agnostic)
- Messages exposes `memberAccess(conversationId)` to Calls via an access port.
- Calls exposes `CallsPort.start(context)` + a small `<CallButton>` component; Messages puts it in
  DM and channel headers of `src/routes/(nucleus)/messages/+page.svelte`.
- When a call ends, Calls posts a system message into the DM/channel through Messages' port
  ("Call, 4 min" / "Missed call") so history stays in the log.

### 3. UI
- `src/routes/(nucleus)/calls/+page.svelte` — recent calls, "New meeting" (pick people → link).
- `src/routes/(nucleus)/calls/[id]/+page.svelte` — the call: `livekit-client` (Apache-2.0)
  grid, mute, camera off, screen share, hang up; leaving the page leaves the call.
- `src/lib/calls/incoming-call-toast.svelte` — mounted in `src/routes/(nucleus)/+layout.svelte`,
  accept/decline + ringtone. `src/lib/calls/call-state.ts` — pure state machine (testable).
- Nav entry **Calls** (announce: new nav item). PWA push for a ringing call when the tab is
  closed is a later slice (`src/lib/pwa/sw-core.ts`).

### 4. ee: livekit-server as a system workload
- **Binary runtime:** the contract gains `runtime: 'binary'` (start argv relative to the
  release, no build steps) and `units.ts` writes its unit with the same hardening.
  livekit-server is a single static Go binary; `scripts/release.sh` fetches the pinned version
  per arch, checks its sha256, packs it as a release tarball.
- **Host ports:** `workloadSchema` gains `ports: [{ port, proto: 'udp'|'tcp' }]`, allowed for
  `tier: 'system'` only and only from an allow-list (7881/tcp, 7882/udp, TURN ports if chosen);
  collisions rejected. Validation + generated unit output are unit-tested.
- **Signalling host:** a new route role "calls host" (`rtc.<console host>`) → the livekit
  workload's local port 7880. Caddy's `reverse_proxy` already passes WebSocket upgrades, so this
  is a new route, not a new handler. `domains.ts` learns the role.
- **Config:** ee renders `livekit.yaml` (rtc.tcp_port 7881, rtc.udp_port 7882, `use_external_ip`
  or explicit `node_ip`, webhook URL = the console host's `/api/calls/livekit`, keys from the
  secret store). ee generates the API key/secret once on install and gives the `os` workload the
  same values as secrets.
- **Box:** `ee/e2e/box.sh` + `ee/e2e/Dockerfile.box` publish 7881/tcp and 7882/udp; README note
  for the operator's firewall.

## Slices (each its own worktree; S1 and S2 touch disjoint files and can run in parallel)

| Slice | Files | Done when |
|---|---|---|
| **S1 ee** | `ee/src/{spec,units,caddy,domains,reconcile,bootstrap}.ts`, `scripts/release.sh`, `ee/e2e/{box.sh,Dockerfile.box}` | box runs livekit-server healthy, `rtc.os.ee.localhost` answers, ports open |
| **S2 module core** | `modules/calls/**`, `modules/index.ts`, `drizzle/**`, `src/lib/server/db/`, `src/routes/api/calls/**`, `src/lib/server/csrf.ts` | unit tests green; token + webhook proven against `livekit-server --dev` |
| **S3 UI + Messages** | `src/routes/(nucleus)/calls/**`, `src/lib/calls/**`, `(nucleus)/+layout.svelte`, Messages header + port | component tests green |
| **S4 proof** | `e2e/calls.e2e.ts`, `ee/e2e/box-journey.mjs` | two-browser e2e passes; box journey with relay-only ICE passes |

## Test strategy (TDD, tests first)
- **Unit (vitest):** call state machine (ringing → active → ended, both start at once, timeout →
  missed); membership: a non-member gets no token and no frames; token grant is one room, short
  TTL, identity = user; webhook with a bad signature is rejected and changes nothing; webhook
  events drive participant rows; ee `ports` validation (system only, allow-list, collisions),
  `binary` unit output, calls-host Caddy route; migration journal check.
- **Component (real browser):** call button in DM and channel headers; toast accept/decline emits
  the right calls; call page controls with a fake `MediaStream`.
- **E2E (Playwright, throwaway harness):** the harness additionally starts `livekit-server --dev`
  (new local test dependency; missing binary → the run fails loud, no skip). Two contexts signed in
  as two people, Chromium `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`:
  A calls B in a DM → B's toast → accept → both see a remote `<video>` with `videoWidth > 0` →
  hang up → "Call, n min" in both DMs. Plus decline, missed, and a three-person channel call.
- **Box:** `ee/e2e/box-journey.mjs` with `iceTransportPolicy: 'relay'` proves the embedded TURN.

## Open decisions for the owner
1. **1:1 calls also on LiveKit** (this plan) — one media path, no P2P code. Veto → P2P + coturn for 1:1.
2. **ee opens host ports** for system workloads only, from an allow-list (7881/tcp, 7882/udp).
3. **TURN on 443/TLS** for locked-down corporate networks (needs a second IP or an SNI split in
   front of Caddy) — needed for customer zero, or later?
4. **Recording / transcripts** (LLM summary into Memory) — later phase with consent UX (recommended), or now?
5. **Ring everywhere** (any nucleus page; push when closed later) — recommended — or only on /calls and Messages?
6. **Who can start a meeting** outside a DM/channel: every member (recommended) or admins only?
