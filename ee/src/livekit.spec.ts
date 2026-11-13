import { describe, expect, it } from 'vitest'
import {
  LIVEKIT_HOST_PORTS,
  LIVEKIT_WEBHOOK_URL,
  LIVEKIT_WORKLOAD,
  generateLivekitKeys,
  linkedEnv,
  livekitConfig,
  livekitWorkload,
} from './livekit.ts'
import type { Settings } from './company-repo.ts'
import type { SecretMap } from './secrets.ts'
import { workloadSchema, type Workload } from './spec.ts'

const KEY = 'APIabcdef012345'
const SECRET = 's'.repeat(43)
const secrets: SecretMap = { livekit: { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET } }

const lk = workloadSchema.parse(livekitWorkload('/var/lib/ee/releases/livekit-server-1.13.11-linux-arm64.tar.gz', 'c'.repeat(64)))
const os = workloadSchema.parse({
  name: 'os',
  tier: 'system',
  source: { kind: 'release', tarball: '/var/lib/ee/releases/os.tar.gz', sha256: 'a'.repeat(64) },
})
const settings: Settings = { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null, callsHost: 'rtc.os.example.com', rtcNodeIp: '203.0.113.7', contributeHub: 'off' }
const state = (workloads: Workload[], s: Partial<Settings> = {}) => ({ workloads, settings: { ...settings, ...s } })

describe('the livekit workload ee seeds', () => {
  it('is a system workload from a release tarball that opens exactly the media ports', () => {
    expect(lk).toMatchObject({
      name: LIVEKIT_WORKLOAD,
      tier: 'system',
      source: { kind: 'release', sha256: 'c'.repeat(64) },
      ports: [
        { port: 7881, proto: 'tcp' },
        { port: 7882, proto: 'udp' },
      ],
      secrets: [],
    })
    expect(LIVEKIT_HOST_PORTS).toEqual(lk.ports)
  })

  it('the webhook goes to the console on its stable loopback listener (whichever os slot is live)', () => {
    expect(LIVEKIT_WEBHOOK_URL).toBe('http://127.0.0.1:4000/api/calls/livekit')
  })
})

describe('livekitConfig (livekit.yaml)', () => {
  it('signalling on loopback at the slot port, media on the fixed host ports, explicit node IP, keys and signed webhook', () => {
    expect(livekitConfig({ port: 4102, nodeIp: '203.0.113.7', apiKey: KEY, apiSecret: SECRET })).toEqual({
      port: 4102,
      bind_addresses: ['127.0.0.1'],
      rtc: { tcp_port: 7881, udp_port: 7882, use_external_ip: false, node_ip: '203.0.113.7' },
      keys: { [KEY]: SECRET },
      webhook: { api_key: KEY, urls: ['http://127.0.0.1:4000/api/calls/livekit'] },
    })
  })

  it('refuses a secret LiveKit would call too short (under 32 characters)', () => {
    expect(() => livekitConfig({ port: 4102, nodeIp: '203.0.113.7', apiKey: KEY, apiSecret: 'short' })).toThrow(/32/)
  })

  it('refuses a node IP that is not an IP address', () => {
    expect(() => livekitConfig({ port: 4102, nodeIp: 'auto', apiKey: KEY, apiSecret: SECRET })).toThrow(/IP/)
  })
})

describe('linkedEnv: what ee wires between livekit and os', () => {
  it('livekit gets its whole config as LIVEKIT_CONFIG (YAML; JSON is YAML), on one line for its env file', () => {
    const env = linkedEnv(state([lk, os]), lk, secrets, 4102)
    expect(Object.keys(env)).toEqual(['LIVEKIT_CONFIG'])
    expect(env.LIVEKIT_CONFIG).not.toContain('\n')
    expect(JSON.parse(env.LIVEKIT_CONFIG!)).toEqual(livekitConfig({ port: 4102, nodeIp: '203.0.113.7', apiKey: KEY, apiSecret: SECRET }))
  })

  it('os gets the key, the secret and the calls URL (the contract with the Calls module)', () => {
    expect(linkedEnv(state([lk, os]), os, secrets, 4100)).toEqual({
      LIVEKIT_API_KEY: KEY,
      LIVEKIT_API_SECRET: SECRET,
      LIVEKIT_URL: 'wss://rtc.os.example.com',
      LIVEKIT_API_URL: 'http://127.0.0.1:4001',
    })
  })

  it('os gets nothing call-related when no livekit workload is desired', () => {
    expect(linkedEnv(state([os], { callsHost: null }), os, {}, 4100)).toEqual({})
  })

  it('other workloads get nothing', () => {
    const app = workloadSchema.parse({ name: 'site', tier: 'app', source: os.source })
    expect(linkedEnv(state([lk, os, app]), app, secrets, 4104)).toEqual({})
  })

  it('fails loudly when the node IP was never set — no guessing, no STUN', () => {
    expect(() => linkedEnv(state([lk, os], { rtcNodeIp: null, contributeHub: 'off' }), lk, secrets, 4102)).toThrow(/--node-ip/)
  })

  it('fails loudly when the keys are missing (for livekit and for os)', () => {
    expect(() => linkedEnv(state([lk, os]), lk, {}, 4102)).toThrow(/LIVEKIT_API_KEY/)
    expect(() => linkedEnv(state([lk, os]), os, { livekit: { LIVEKIT_API_KEY: KEY } }, 4100)).toThrow(/LIVEKIT_API_SECRET/)
  })

  it('fails loudly when livekit is desired but there is no calls host', () => {
    expect(() => linkedEnv(state([lk, os], { callsHost: null }), os, secrets, 4100)).toThrow(/calls host/)
  })
})

describe('generateLivekitKeys', () => {
  it('a fresh key + a secret long enough for LiveKit, different every time', () => {
    const a = generateLivekitKeys()
    const b = generateLivekitKeys()
    expect(a.LIVEKIT_API_KEY).toMatch(/^API[0-9a-f]{12}$/)
    expect(a.LIVEKIT_API_SECRET.length).toBeGreaterThanOrEqual(32)
    expect(a.LIVEKIT_API_SECRET).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toEqual(b)
  })
})
