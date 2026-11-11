# Video calls in Messages — plan (draft, awaiting owner decisions)

Source: Contribute board item: "Chats are nice, but I want a video call function, both for
direct messages and for group calls." Status: **plan only, no code.**

## Where we start

- Messages is the `modules/messages` module (service, db-store, `hub.ts` + `live.ts`) behind
  `src/routes/api/messages/**`; the UI is `src/routes/(nucleus)/messages/+page.svelte` with
  helpers in `src/lib/messages/**`.
- Realtime is **server → client SSE only**: `GET /api/messages/stream` (`messagesStreamResponse`),
  fed by Postgres LISTEN/NOTIFY through `MessagesHub`, resumable by event id
  (`src/lib/messages/resumable-stream.ts`). Client → server is plain `fetch` POST. No WebSocket.
- The box: `ee` runs workloads as hardened systemd units (`ee/src/units.ts`: DynamicUser,
  `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`) behind Caddy (`ee/src/caddy.ts`, HTTP
  `reverse_proxy` only). The workload spec (`ee/src/spec.ts`) has **no ports** and the
  `CATALOG` has no media capability. Any UDP media port is new ee surface (D16: an eigen change).

## Options

| Option | 1:1 | Group | Box surface | Licence |
|---|---|---|---|---|
| A. P2P WebRTC, our signalling over SSE + POST | yes | mesh, ≤3–4 people | none for media; TURN needed in practice | browser APIs; our code Apache-2.0 |
| B. SFU as ee-managed workload (LiveKit) | yes | yes, 50+ | 1 TCP (signal, via Caddy) + UDP range or single UDP mux port; embedded TURN | LiveKit server + JS SDK: Apache-2.0 |
| B'. SFU mediasoup (in our Node process / worker) | yes | yes | UDP port range; we write rooms/signalling ourselves | ISC (compatible) |
| C. TURN (coturn) — complement to A, not an alternative | relay | relay | 3478 udp/tcp, 5349 tls, relay range e.g. 49160–49200/udp | BSD-3 (compatible) |
| D. Embed external (Jitsi Meet self-host, or hosted Jitsi/Whereby/Daily) | yes | yes | Jitsi self-host = several Java/Prosody services; hosted = none | Jitsi Apache-2.0; hosted = proprietary ToS |

Trade-offs:
- **A** is smallest and keeps data on the box, but fails behind symmetric NAT/corporate
  firewalls without TURN, and mesh upload cost grows n-1 per person, so it does not scale to groups.
  SSE adds ~one POST round trip per ICE batch; acceptable for signalling.
- **B (LiveKit)** solves groups, simulcast, screen share, and ships its own TURN (TLS/443 and UDP),
  so no separate coturn. Cost: a Go binary ee must install, a release source (not node/static —
  a catalog gap), new port/UDP spec fields, JWT room tokens minted by eigenEnterprise.
- **B' mediasoup** keeps everything in-repo but we own the room logic and native build per arch
  (`scripts/release.sh arm64`); more code than LiveKit for the same outcome.
- **C** is required for A to be reliable; one small workload, but credentials must be
  short-lived (TURN REST shared secret in ee's secret store, never logged).
- **D hosted** sends company media to a third party — conflicts with single-tenant self-hosting.
  **D self-host Jitsi** is heavy (4 services) and a separate identity/UI; poor fit for "the website is the company".

## Recommendation

Build signalling once in `modules/messages` (call state + offer/answer/ICE over the existing
SSE hub and POST), transport-agnostic. **Phase 1: P2P 1:1 in DMs + coturn workload.**
**Phase 2: groups via LiveKit as an ee-managed system workload**, reusing the same call model
and UI; P2P stays the 1:1 path (or 1:1 also moves to LiveKit if one media path is simpler to own —
owner decision). No hosted service.

### Phase 1 — 1:1 calls inside a DM thread
1. Call model: `message_calls` table (id, conversation_id, started_by, state
   `ringing|active|ended|missed|declined`, started_at, ended_at) — `drizzle/NNNN_message_calls.sql`
   + journal entry + schema in `src/lib/server/db/`. A call ends as a system message in the DM
   ("Call, 4 min" / "Missed call") so history stays in the log.
2. Signalling: `POST /api/messages/calls` (start), `/calls/[id]/{accept,decline,hangup,signal}`;
   `signal` relays SDP/ICE to the other member only (membership checked in `service.ts`, same
   rule as messages). Hub gains `call` and `call-signal` frames; signal frames are ephemeral
   (NOTIFY payload, not persisted, not in catch-up), call-state frames are persisted.
3. TURN credentials: `GET /api/messages/calls/[id]/ice` returns STUN/TURN URLs + HMAC credentials
   (TTL ~10 min) from the coturn shared secret in ee's secret store. Missing secret = explicit error, no STUN-only fallback.
4. Kernel actions/tools registered in `modules/messages/tools.ts` + `manifest.ts` (start/hang up),
   so agents and the `ee` CLI see the same actions; agents never join media.
5. UI: call button (camera icon) in the DM conversation header of `+page.svelte`; new
   `src/lib/messages/call-panel.svelte` (local/remote video, mute, camera off, hang up) overlaying
   the conversation; `src/lib/messages/incoming-call-toast.svelte` (accept/decline, ringtone) shown
   from the nucleus layout so it rings on any page; `src/lib/messages/call.ts` = pure state machine +
   `RTCPeerConnection` wrapper with injected factory (testable). PWA: service worker push for a call
   when the tab is closed is a later slice (`src/lib/pwa/sw-core.ts`).
6. ee: new `coturn` system workload. Needs (a) a `release` source for a non-node binary,
   (b) spec fields for host ports, e.g. `ports: [{ port, proto: 'udp'|'tcp' }]` validated against an
   allow-list, (c) `units.ts` unit without DynamicUser port restrictions beyond binding those ports,
   (d) firewall/README note for the operator. Ports: 3478/udp+tcp, 5349/tcp (TLS, cert from Caddy's
   store or own), relay 49160–49200/udp. `ee/e2e/box.sh` box gets the same ports.

### Phase 2 — group calls (channels and multi-person DMs)
LiveKit `livekit-server` as an ee system workload: signal over Caddy at `/rtc` (WebSocket upgrade —
a new Caddy route shape), media on 7881/tcp + one UDP mux port (7882/udp) or a range; embedded TURN
replaces coturn if the owner wants one fewer workload. eigenEnterprise mints room JWTs per member
(`livekit-server-sdk`, Apache-2.0). Call button appears in channel headers; same toast/panel.

## Files that change (phase 1)
- `modules/messages/{service,store,db-store,memory-store,hub,http,tools,manifest}.ts` (+ specs)
- `src/routes/api/messages/calls/**` (new), `src/routes/api/messages/stream/+server.ts` (new frame types)
- `src/routes/(nucleus)/messages/+page.svelte` (header button, panel, `events` list),
  `src/routes/(nucleus)/+layout.svelte` (toast), `src/lib/messages/{call.ts,call-panel.svelte,incoming-call-toast.svelte,view.ts}`
- `drizzle/NNNN_message_calls.sql`, `drizzle/meta/_journal.json`, `src/lib/server/db/` schema
- `ee/src/{spec,units,caddy,reconcile}.ts`, `ee/e2e/box.sh`, `ee/e2e/Dockerfile.box`

## Test strategy (TDD, tests first)
- **Unit (vitest):** call state machine (ringing→active→ended, glare when both start, timeout →
  missed); service membership checks (a non-member cannot signal); hub routes `call-signal` only to
  the peer and excludes it from catch-up; TURN credential HMAC + expiry; ee spec validation of ports
  (allow-list, no collisions) and generated unit/Caddy output; migration journal check.
- **Component (real browser):** header button visible only in DMs; toast accept/decline emits the
  right calls; call panel controls with fake `MediaStream`.
- **E2E (Playwright, throwaway harness):** two browser contexts signed in as two people, Chromium
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, permissions granted; A calls
  B in a DM → B sees toast → accept → both see a remote `<video>` with `videoWidth > 0` and
  `RTCPeerConnection.connectionState === 'connected'` → hang up → "Call, n min" in both logs. Plus
  decline and missed paths. Host-candidate only in the harness (same machine); TURN covered on the box
  via `ee/e2e/box-journey.mjs` with `iceTransportPolicy: 'relay'` to prove the relay works.

## Open decisions for the owner
1. Phase-1 transport: P2P + coturn (recommended) or go straight to LiveKit for 1:1 too (one media path, bigger first step)?
2. Groups: LiveKit (recommended) vs mediasoup in-process vs not now.
3. ee opening host UDP ports: accept a `ports` field for system workloads only (recommended), and the relay range size.
4. TURN on 443/TLS for locked-down networks (needs SNI split in Caddy layer4 or a second IP) — needed for customer zero?
5. Recording/transcripts of calls (LLM summaries into memory) — out of scope, or a later phase with consent UX?
6. Ring everywhere (any nucleus page + push notifications) in phase 1, or only while Messages is open?
