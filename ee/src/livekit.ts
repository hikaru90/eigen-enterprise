import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { Settings } from './company-repo.ts'
import { generateSecret, type SecretMap } from './secrets.ts'
import { HOST_PORT_ALLOWLIST, OS_INTERNAL_PORT, type HostPort, type Workload, type WorkloadInput } from './spec.ts'

/**
 * livekit-server as a system workload (plan/video-calls.md §4).
 *
 * - Signalling (HTTP + WebSocket) listens on loopback at the slot port ee gives
 *   every workload; Caddy routes the calls host (rtc.<console host>) to it.
 * - Media is on two fixed host ports: 7881/tcp (ICE over TCP) and 7882/udp (UDP mux).
 * - The node IP it advertises is explicit (settings.rtcNodeIp); missing = an error.
 * - Its API key/secret live once in the secret store (scope "livekit"); os gets
 *   the same values plus LIVEKIT_URL — the env contract with the Calls module.
 *
 * Slots: LiveKit holds rooms in memory and the media ports are exclusive, so a
 * new release cannot start next to the old one. reconcile.ts stops the live slot
 * first, then starts the candidate (a deploy drops calls in progress; an
 * unchanged pass restarts nothing). See `hasHostPorts` in reconcile.ts.
 */

export const LIVEKIT_WORKLOAD = 'livekit'

export const LIVEKIT_TCP_PORT = 7881
export const LIVEKIT_UDP_PORT = 7882
export const LIVEKIT_HOST_PORTS: HostPort[] = [
  { port: LIVEKIT_TCP_PORT, proto: 'tcp' },
  { port: LIVEKIT_UDP_PORT, proto: 'udp' },
]
// The allow-list is exactly LiveKit's ports; keep them from drifting apart.
for (const p of LIVEKIT_HOST_PORTS) {
  if (!HOST_PORT_ALLOWLIST.some((a) => a.port === p.port && a.proto === p.proto)) {
    throw new Error(`livekit host port ${p.proto}/${p.port} is not on HOST_PORT_ALLOWLIST`)
  }
}

/** The console's stable loopback listener (Caddy's internal server for os), so a webhook never misses a slot swap. */
export const LIVEKIT_WEBHOOK_URL = `http://127.0.0.1:${OS_INTERNAL_PORT}/api/calls/livekit`

/**
 * LiveKit's server API for os (close a room): a stable loopback listener in Caddy,
 * like OS_INTERNAL_PORT for os, so os never loops out through the public calls host
 * (hairpin NAT, the local CA on test boxes) and never misses a slot swap.
 */
export const LIVEKIT_INTERNAL_PORT = 4001
export const LIVEKIT_API_URL = `http://127.0.0.1:${LIVEKIT_INTERNAL_PORT}`

/** Names in the secret store (scope LIVEKIT_WORKLOAD), and the env names os receives. */
export const LIVEKIT_SECRETS = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const

/** LiveKit refuses (logs an error for) secrets shorter than this. */
const MIN_SECRET_LENGTH = 32

export function generateLivekitKeys(): Record<(typeof LIVEKIT_SECRETS)[number], string> {
  return { LIVEKIT_API_KEY: `API${randomBytes(6).toString('hex')}`, LIVEKIT_API_SECRET: generateSecret(32) }
}

/** The livekit workload as the company repo holds it. */
export function livekitWorkload(tarball: string, sha256: string): WorkloadInput {
  return {
    name: LIVEKIT_WORKLOAD,
    tier: 'system',
    source: { kind: 'release', tarball, sha256 },
    ports: LIVEKIT_HOST_PORTS,
    resources: { memoryMb: 1024, cpuPercent: 200 },
  }
}

export type LivekitConfigInput = { port: number; nodeIp: string; apiKey: string; apiSecret: string }

/** livekit.yaml, as an object (rendered as JSON, which is YAML). */
export function livekitConfig(i: LivekitConfigInput): Record<string, unknown> {
  if (isIP(i.nodeIp) === 0) throw new Error(`livekit: node IP "${i.nodeIp}" is not an IP address`)
  if (i.apiSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`livekit: LIVEKIT_API_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  }
  return {
    port: i.port,
    // Signalling only on loopback: browsers reach it through Caddy (TLS) on the calls host.
    bind_addresses: ['127.0.0.1'],
    rtc: { tcp_port: LIVEKIT_TCP_PORT, udp_port: LIVEKIT_UDP_PORT, use_external_ip: false, node_ip: i.nodeIp },
    keys: { [i.apiKey]: i.apiSecret },
    webhook: { api_key: i.apiKey, urls: [LIVEKIT_WEBHOOK_URL] },
  }
}

function livekitKeys(secrets: SecretMap, who: string): { apiKey: string; apiSecret: string } {
  const stored = secrets[LIVEKIT_WORKLOAD] ?? {}
  const [keyName, secretName] = LIVEKIT_SECRETS
  for (const name of LIVEKIT_SECRETS) {
    if (!stored[name]) {
      throw new Error(`${who}: ${name} is not in the secret store (scope ${LIVEKIT_WORKLOAD}) — re-run \`ee bootstrap\` to generate it`)
    }
  }
  return { apiKey: stored[keyName]!, apiSecret: stored[secretName]! }
}

export type LinkState = { workloads: Workload[]; settings: Settings }

/**
 * Env that ee wires between workloads (pure; reconcile and the boot-time
 * render-env both use it). Rendered only into root-only env files.
 * `port` is the slot port the workload runs on.
 */
export function linkedEnv(state: LinkState, w: Workload, secrets: SecretMap, port: number): Record<string, string> {
  const calls = state.workloads.some((x) => x.name === LIVEKIT_WORKLOAD)
  if (w.name === LIVEKIT_WORKLOAD) {
    const nodeIp = state.settings.rtcNodeIp
    if (!nodeIp) {
      throw new Error(
        `${LIVEKIT_WORKLOAD}: no node IP set — calls need the public IP media reaches this server on: ` +
          're-run the installer with `--node-ip <public IP of this server>`',
      )
    }
    const config = livekitConfig({ port, nodeIp, ...livekitKeys(secrets, LIVEKIT_WORKLOAD) })
    return { LIVEKIT_CONFIG: JSON.stringify(config) }
  }
  if (w.name === 'os' && calls) {
    const host = state.settings.callsHost
    if (!host) throw new Error('os: a livekit workload is desired but there is no calls host (settings.callsHost)')
    const { apiKey, apiSecret } = livekitKeys(secrets, 'os')
    return { LIVEKIT_API_KEY: apiKey, LIVEKIT_API_SECRET: apiSecret, LIVEKIT_URL: `wss://${host}`, LIVEKIT_API_URL }
  }
  return {}
}
