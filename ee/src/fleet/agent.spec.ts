import { describe, expect, it, vi } from 'vitest'
import type { BackupConfig, BackupRun, Health } from '../backup/service.ts'
import { settingsSchema, type DesiredState } from '../company-repo.ts'
import { addDomain, OS_HOME_PATH, OS_PUBLIC_SURFACE } from '../domains.ts'
import { EE_VERSION } from '../version.ts'
import { BOX_KEY, FLEET_BACKUP_MARK, FLEET_SCOPE, FleetAgent, FleetError, IMPLEMENTED_FEATURES, LEGACY_PLATFORM_AI_SECRETS, LOCAL_TOKEN, UPGRADE_UNIT, type FleetHost } from './agent.ts'
import type { HostedAddressRecord } from './hosted-address.ts'
import { escrowRequestV1, FLEET_FEATURES, FLEET_PATHS, newBoxKey, reportV1, verifyFleetRequest, type DomainClaimV1 } from './protocol.ts'

const BOX = '0b9a7c3e-1f2d-4c5b-8a6e-9d8c7b6a5f4e'
const CP = 'https://hosting.example.com'
const TOKEN = 't'.repeat(40)
const SEALED = 'S'.repeat(43) + '='

type Call = { url: string; init: RequestInit }

function fakeHost(opts: { managed?: boolean } = {}) {
  const box = newBoxKey()
  const secrets: Record<string, Record<string, string>> = { os: { BETTER_AUTH_SECRET: 'x' } }
  let state: Omit<DesiredState, 'rev'> = {
    workloads: [{ name: 'os', tier: 'system', source: { kind: 'release', tarball: '/var/lib/ee/releases/eigenenterprise-0.5.12-aaaaaaaaaaaa-linux-x64.tar.gz', sha256: 'a'.repeat(64) }, env: {}, secrets: ['BETTER_AUTH_SECRET'], deploy: {} } as never],
    routes: [{ host: 'os.acme.example.com', workload: 'os' } as never, { host: 'rtc.os.acme.example.com', workload: 'livekit' } as never],
    settings: settingsSchema.parse({ consoleHost: 'os.acme.example.com', callsHost: 'rtc.os.acme.example.com' }),
  }
  if (opts.managed) {
    state.settings.managed = { controlPlane: CP, boxId: BOX, pollSeconds: 60 }
    secrets[FLEET_SCOPE] = { [BOX_KEY]: box.privateKey }
    secrets['os']![LOCAL_TOKEN] = 'local-token'
    ;(state.workloads[0] as { secrets: string[] }).secrets.push(LOCAL_TOKEN)
  }
  let backupCfg: BackupConfig | null = null
  let runs: BackupRun[] = []
  let health: Health = { state: 'unconfigured' }
  const calls: Call[] = []
  const commits: string[] = []
  const logs: Array<{ type: string; message: string }> = []
  let answer: (url: string) => Response = () => Response.json({ protocol: 1, pollSeconds: 60 })
  let claims: DomainClaimV1[] | null = null
  let hosted: HostedAddressRecord = { hostedAddress: null, fleetSiteHost: null }
  const host = {
    read: async () => structuredClone(state),
    change: vi.fn(async (message: string, mutate: (s: typeof state) => typeof state) => {
      state = mutate(structuredClone(state))
      commits.push(message)
      return { reconcileError: null as string | null }
    }),
    reconcile: vi.fn(async () => {}),
    secrets: {
      all: () => secrets,
      set: async (scope: string, name: string, value: string) => {
        secrets[scope] = { ...(secrets[scope] ?? {}), [name]: value }
      },
      delete: async (scope: string, name: string) => {
        if (!secrets[scope]?.[name]) return false
        delete secrets[scope]![name]
        return true
      },
    },
    osRelease: async () => 'eigenenterprise-0.5.12-aaaaaaaaaaaa-linux-x64.tar.gz',
    osHealth: async () => 'healthy' as const,
    reconcileError: () => 'reconcile finished with errors:\n- route x: y has nothing live',
    disk: async () => ({ usedGb: 12.5, totalGb: 80 }),
    seats: vi.fn(async () => 4),
    mailDomains: vi.fn(async (_token: string): Promise<Array<{ name: string; receive: boolean }> | null> => [{ name: 'acme.example.com', receive: true }]),
    backupKey: vi.fn(async (_token: string): Promise<string> => 'K'.repeat(43) + '='),
    backups: {
      hasKey: vi.fn(() => true),
      key: vi.fn((): string | null => SEALED),
      config: () => backupCfg,
      configure: vi.fn(async (input: { target: BackupConfig['target']; schedule: { hour: number }; retentionDays: number; author: string }) => {
        backupCfg = { target: input.target, schedule: { hour: input.schedule.hour, minute: 7 }, retentionDays: input.retentionDays, configuredAt: 'now', configuredBy: input.author, keyCreatedAt: 'now' }
        health = { state: 'ok', lastSuccessAt: 'now' }
        return {}
      }),
      unconfigure: vi.fn(async () => {
        backupCfg = null
        health = { state: 'unconfigured' }
      }),
      status: async () => ({ health, runs }),
      start: vi.fn(async () => ({})),
      isRunning: () => false,
    },
    upgradeActive: vi.fn(async () => false),
    startUpgrade: vi.fn(async () => {}),
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return answer(String(url))
    }),
    now: () => new Date('2026-11-16T12:00:00Z'),
    log: async (type: string, message: string) => void logs.push({ type, message }),
    saveClaims: vi.fn(async (c: DomainClaimV1[] | null) => {
      claims = c === null ? null : structuredClone(c)
    }),
    readHostedAddress: vi.fn(async () => structuredClone(hosted)),
    saveHostedAddress: vi.fn(async (r: HostedAddressRecord) => {
      hosted = structuredClone(r)
    }),
  }
  return {
    host: host as unknown as FleetHost & typeof host,
    box,
    secrets,
    calls,
    commits,
    logs,
    state: () => state,
    claims: () => claims,
    hosted: () => hosted,
    setState: (mutate: (s: Omit<DesiredState, 'rev'>) => Omit<DesiredState, 'rev'>) => (state = mutate(structuredClone(state))),
    setAnswer: (a: (url: string) => Response) => (answer = a),
    setBackup: (c: BackupConfig | null, r: BackupRun[] = [], h?: Health) => {
      backupCfg = c
      runs = r
      health = h ?? (c ? { state: 'ok', lastSuccessAt: 'x' } : { state: 'unconfigured' })
    },
  }
}

const desired = (extra: Record<string, unknown> = {}) => () => Response.json({ protocol: 1, pollSeconds: 60, ...extra })
const target = { endpoint: 'https://s3.example.com', region: 'eu-central-1', bucket: 'acme-backups', prefix: 'box', accessKeyId: 'AKIA', secretAccessKey: 'SECRET-S3' }

describe('fleet: enroll', () => {
  it('seals a new box key, POSTs the enroll request, saves managed + declares the loopback token on os', async () => {
    const f = fakeHost()
    f.setAnswer(() => Response.json({ boxId: BOX, pollSeconds: 30 }))
    const agent = new FleetAgent(f.host)
    vi.spyOn(agent, 'start').mockImplementation(() => {})
    const managed = await agent.enroll({ controlPlane: CP, token: TOKEN })
    expect(managed).toEqual({ controlPlane: CP, boxId: BOX, pollSeconds: 30 })
    expect(f.calls[0]!.url).toBe(`${CP}${FLEET_PATHS.enroll}`)
    const sent = JSON.parse(String(f.calls[0]!.init.body))
    expect(sent).toMatchObject({ protocol: 1, enrollToken: TOKEN, eeVersion: EE_VERSION, features: IMPLEMENTED_FEATURES })
    expect(f.secrets[FLEET_SCOPE]![BOX_KEY]).toBeTruthy()
    expect(sent.publicKey).not.toBe(f.secrets[FLEET_SCOPE]![BOX_KEY])
    expect(f.secrets['os']![LOCAL_TOKEN]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(f.state().settings.managed).toEqual(managed)
    expect(f.state().workloads[0]!.secrets).toContain(LOCAL_TOKEN)
    expect(agent.start).toHaveBeenCalled()
    // Nothing secret reaches the journal.
    for (const l of f.logs) expect(l.message).not.toContain(TOKEN)
  })

  it('refuses when already enrolled, a non-https origin, and a failed control plane answer', async () => {
    await expect(new FleetAgent(fakeHost({ managed: true }).host).enroll({ controlPlane: CP, token: TOKEN })).rejects.toThrow(/already enrolled/)
    await expect(new FleetAgent(fakeHost().host).enroll({ controlPlane: 'http://hosting.example.com', token: TOKEN })).rejects.toThrow(FleetError)
    await expect(new FleetAgent(fakeHost().host).enroll({ controlPlane: `${CP}/path`, token: TOKEN })).rejects.toThrow(/origin/)
    const f = fakeHost()
    f.setAnswer(() => new Response('bad token', { status: 403 }))
    await expect(new FleetAgent(f.host).enroll({ controlPlane: CP, token: TOKEN })).rejects.toThrow(/403/)
    expect(f.state().settings.managed).toBeNull()
  })
})

describe('fleet: poll', () => {
  it('sends a signed, valid report and keeps unknown desired fields for the next one', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(desired({ futureThing: 1 }))
    const agent = new FleetAgent(f.host)
    const r = await agent.poll()
    expect(r).toMatchObject({ ok: true, ignoredFields: ['futureThing'] })
    const call = f.calls[0]!
    expect(call.url).toBe(`${CP}${FLEET_PATHS.poll}`)
    const headers = call.init.headers as Record<string, string>
    const v = verifyFleetRequest({ publicKey: f.box.publicKey, method: 'POST', path: FLEET_PATHS.poll, body: String(call.init.body), headers, now: f.host.now().getTime() })
    expect(v).toEqual({ ok: true, boxId: BOX })
    const report = reportV1.parse(JSON.parse(String(call.init.body)))
    expect(report).toMatchObject({
      eeVersion: EE_VERSION,
      release: 'eigenenterprise-0.5.12-aaaaaaaaaaaa-linux-x64.tar.gz',
      health: { os: 'healthy', reconcileError: 'reconcile finished with errors: - route x: y has nothing live' },
      seats: 4,
      hosts: ['os.acme.example.com', 'rtc.os.acme.example.com'],
      disk: { usedGb: 12.5, totalGb: 80 },
      backup: null,
      ignoredFields: [],
    })
    expect(f.host.seats).toHaveBeenCalledWith('local-token')
    expect(report.features).toContain('mail')
    expect(report.features).toContain('domains')
    expect(report.mail).toEqual({ domains: [{ name: 'acme.example.com', receive: true }] })
    expect(f.host.mailDomains).toHaveBeenCalledWith('local-token')
    await agent.poll()
    expect(JSON.parse(String(f.calls[1]!.init.body)).ignoredFields).toEqual(['futureThing'])
  })

  it('a failed poll is a result, journaled once per distinct error, never a throw', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(() => new Response('down', { status: 502 }))
    const agent = new FleetAgent(f.host)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await agent.poll()).toMatchObject({ ok: false, error: expect.stringContaining('502') })
    await agent.poll()
    expect(f.logs.filter((l) => l.type === 'fleet.poll_failed')).toHaveLength(1)
    expect(err).toHaveBeenCalledTimes(2)
    f.setAnswer(() => Response.json({ protocol: 1 }))
    expect((await agent.poll()).ok).toBe(false)
    expect(agent.lastPoll?.error).toMatch(/pollSeconds/)
    err.mockRestore()
  })

  it('runs one poll at a time', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(desired())
    const agent = new FleetAgent(f.host)
    const [a, b] = [agent.poll(), agent.poll()]
    expect(a).toBe(b)
    await a
    expect(f.calls).toHaveLength(1)
  })
})

describe('fleet: desired state (level-triggered)', () => {
  it('pollSeconds and suspended are committed only on change', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(desired({ pollSeconds: 120, suspended: true }))
    const agent = new FleetAgent(f.host)
    await agent.poll()
    expect(f.state().settings.managed?.pollSeconds).toBe(120)
    expect(f.state().settings.suspended).toBe(true)
    const n = f.commits.length
    await agent.poll()
    expect(f.commits).toHaveLength(n)
    f.setAnswer(desired({ pollSeconds: 120, suspended: false }))
    await agent.poll()
    expect(f.state().settings.suspended).toBe(false)
  })

  it('release: starts the detached upgrade only when the running release differs and no upgrade runs', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    f.setAnswer(desired({ release: { name: 'eigenenterprise-0.5.12-aaaaaaaaaaaa-linux-x64.tar.gz', from: 'https://r.example.com/v1' } }))
    await agent.poll()
    expect(f.host.startUpgrade).not.toHaveBeenCalled()
    f.setAnswer(desired({ release: { name: 'eigenenterprise-0.6.0-bbbbbbbbbbbb-linux-x64.tar.gz', from: 'https://r.example.com/v2' } }))
    await agent.poll()
    expect(f.host.startUpgrade).toHaveBeenCalledWith('https://r.example.com/v2', 'eigenenterprise-0.6.0-bbbbbbbbbbbb')
    f.host.upgradeActive.mockResolvedValue(true)
    await agent.poll()
    expect(f.host.startUpgrade).toHaveBeenCalledTimes(1)
    expect(f.logs.some((l) => l.message.includes(UPGRADE_UNIT))).toBe(true)
  })

  it('release: the target names a release, not a CPU — an arm64 target on an x64 box running it starts nothing', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(desired({ release: { name: 'eigenenterprise-0.5.12-aaaaaaaaaaaa-linux-arm64.tar.gz', from: 'https://r.example.com/v1' } }))
    await new FleetAgent(f.host).poll()
    f.setAnswer(desired({ release: { name: 'eigenenterprise-0.5.12-aaaaaaaaaaaa', from: 'https://r.example.com/v1' } }))
    await new FleetAgent(f.host).poll()
    expect(f.host.startUpgrade).not.toHaveBeenCalled()
  })

  it('release: the upgrade may install only the target (never whatever is newest at from)', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(desired({ release: { name: 'eigenenterprise-0.6.0-bbbbbbbbbbbb-linux-arm64.tar.gz', from: 'https://r.example.com/v2' } }))
    await new FleetAgent(f.host).poll()
    expect(f.host.startUpgrade).toHaveBeenCalledWith('https://r.example.com/v2', 'eigenenterprise-0.6.0-bbbbbbbbbbbb')
  })

  it('release: an older target is installed too (a downgrade from the release\'s own folder)', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(desired({ release: { name: 'eigenenterprise-0.5.10-cccccccccccc', from: 'https://github.com/o/r/releases/download/v0.5.10' } }))
    await new FleetAgent(f.host).poll()
    expect(f.host.startUpgrade).toHaveBeenCalledWith('https://github.com/o/r/releases/download/v0.5.10', 'eigenenterprise-0.5.10-cccccccccccc')
  })

  it('release: a target that did not take is started again after 15 minutes, not every poll', async () => {
    const f = fakeHost({ managed: true })
    let now = new Date('2026-11-16T12:00:00Z').getTime()
    f.host.now = () => new Date(now)
    const agent = new FleetAgent(f.host)
    f.setAnswer(desired({ release: { name: 'eigenenterprise-0.6.0-bbbbbbbbbbbb', from: 'https://r.example.com/v2' } }))
    await agent.poll()
    now += 60_000
    await agent.poll()
    expect(f.host.startUpgrade).toHaveBeenCalledTimes(1)
    now += 15 * 60_000
    await agent.poll()
    expect(f.host.startUpgrade).toHaveBeenCalledTimes(2)
  })

  it('release: a target that is not a release name is a poll error, nothing started', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(desired({ release: { name: 'latest', from: 'https://r.example.com/v2' } }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await new FleetAgent(f.host).poll()).toMatchObject({ ok: false, error: expect.stringContaining('not a release name') })
    expect(f.host.startUpgrade).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('platformAi: sets + declares the four PLATFORM_LLM_* secrets on os, redeploys only on change, null removes them', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    const ai = { llmBaseUrl: 'https://llm.example.com', llmApiKey: 'sk-PLATFORM', llmModelChat: 'chat-1', llmModelEmbedding: 'embed-1' }
    const names = ['PLATFORM_LLM_BASE_URL', 'PLATFORM_LLM_API_KEY', 'PLATFORM_LLM_MODEL_CHAT', 'PLATFORM_LLM_MODEL_EMBEDDING']
    f.setAnswer(desired({ platformAi: ai }))
    expect((await agent.poll()).ok).toBe(true)
    expect(f.secrets['os']).toMatchObject({ PLATFORM_LLM_BASE_URL: ai.llmBaseUrl, PLATFORM_LLM_API_KEY: 'sk-PLATFORM', PLATFORM_LLM_MODEL_CHAT: 'chat-1', PLATFORM_LLM_MODEL_EMBEDDING: 'embed-1' })
    expect(f.state().workloads[0]!.secrets).toEqual(expect.arrayContaining(names))
    // Never under the self-hosted BYOK names: os must not read the platform AI as the owner's own key.
    for (const legacy of LEGACY_PLATFORM_AI_SECRETS) {
      expect(f.secrets['os']![legacy]).toBeUndefined()
      expect(f.state().workloads[0]!.secrets).not.toContain(legacy)
    }
    const n = f.commits.length
    await agent.poll()
    expect(f.commits).toHaveLength(n)
    expect(f.host.reconcile).not.toHaveBeenCalled()
    f.setAnswer(desired({ platformAi: { ...ai, llmModelChat: 'chat-2' } }))
    await agent.poll()
    expect(f.host.reconcile).toHaveBeenCalledTimes(1)
    expect(f.secrets['os']!['PLATFORM_LLM_MODEL_CHAT']).toBe('chat-2')
    f.setAnswer(desired({ platformAi: null }))
    await agent.poll()
    for (const name of names) {
      expect(f.secrets['os']![name]).toBeUndefined()
      expect(f.state().workloads[0]!.secrets).not.toContain(name)
    }
    for (const l of f.logs) expect(l.message).not.toContain('sk-PLATFORM')
  })

  it('platformAi: a box an older ee configured has its fleet-set LLM_* retired in the same step (one commit), then stays still', async () => {
    const f = fakeHost({ managed: true })
    // What the older ee left on os: the platform AI under the self-hosted BYOK names, declared.
    Object.assign(f.secrets['os']!, { LLM_BASE_URL: 'https://llm.example.com', LLM_API_KEY: 'sk-OLD', LLM_MODEL_CHAT: 'chat-1', LLM_MODEL_EMBEDDING: 'embed-1' })
    f.state().workloads[0]!.secrets.push(...LEGACY_PLATFORM_AI_SECRETS)
    const agent = new FleetAgent(f.host)
    const ai = { llmBaseUrl: 'https://llm.example.com', llmApiKey: 'sk-PLATFORM', llmModelChat: 'chat-1', llmModelEmbedding: 'embed-1' }
    f.setAnswer(desired({ platformAi: ai }))
    const n = f.commits.length
    expect((await agent.poll()).ok).toBe(true)
    expect(f.commits).toHaveLength(n + 1)
    expect(f.secrets['os']).toMatchObject({ PLATFORM_LLM_BASE_URL: ai.llmBaseUrl, PLATFORM_LLM_API_KEY: 'sk-PLATFORM' })
    for (const legacy of LEGACY_PLATFORM_AI_SECRETS) {
      expect(f.secrets['os']![legacy]).toBeUndefined()
      expect(f.state().workloads[0]!.secrets).not.toContain(legacy)
    }
    expect(f.state().workloads[0]!.secrets).toContain('BETTER_AUTH_SECRET')
    await agent.poll()
    expect(f.commits).toHaveLength(n + 1)
    expect(f.host.reconcile).not.toHaveBeenCalled()
    for (const l of f.logs) expect(l.message).not.toMatch(/sk-PLATFORM|sk-OLD/)
  })

  it('platformAi null on a box an older ee configured: the fleet-set LLM_* go too', async () => {
    const f = fakeHost({ managed: true })
    Object.assign(f.secrets['os']!, { LLM_BASE_URL: 'https://llm.example.com', LLM_API_KEY: 'sk-OLD', LLM_MODEL_CHAT: 'chat-1', LLM_MODEL_EMBEDDING: 'embed-1' })
    f.state().workloads[0]!.secrets.push(...LEGACY_PLATFORM_AI_SECRETS)
    f.setAnswer(desired({ platformAi: null }))
    expect((await new FleetAgent(f.host).poll()).ok).toBe(true)
    for (const legacy of LEGACY_PLATFORM_AI_SECRETS) {
      expect(f.secrets['os']![legacy]).toBeUndefined()
      expect(f.state().workloads[0]!.secrets).not.toContain(legacy)
    }
  })

  it('local token: re-declared on os when a bootstrap re-run (upgrade) dropped it, value kept', async () => {
    const f = fakeHost({ managed: true })
    f.state().workloads[0]!.secrets = f.state().workloads[0]!.secrets.filter((n) => n !== LOCAL_TOKEN)
    f.setAnswer(desired())
    expect((await new FleetAgent(f.host).poll()).ok).toBe(true)
    expect(f.state().workloads[0]!.secrets).toContain(LOCAL_TOKEN)
    expect(f.secrets['os']![LOCAL_TOKEN]).toBe('local-token')
    expect(f.logs.map((l) => l.type)).toContain('fleet.local_token')
  })

  it('local token: made again when the secret store lost it', async () => {
    const f = fakeHost({ managed: true })
    delete f.secrets['os']![LOCAL_TOKEN]
    f.setAnswer(desired())
    expect((await new FleetAgent(f.host).poll()).ok).toBe(true)
    expect(f.secrets['os']![LOCAL_TOKEN]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(f.state().workloads[0]!.secrets).toContain(LOCAL_TOKEN)
  })

  it('local token: nothing committed or redeployed while it is in place', async () => {
    const f = fakeHost({ managed: true })
    f.setAnswer(desired())
    await new FleetAgent(f.host).poll()
    expect(f.commits).toEqual([])
    expect(f.host.reconcile).not.toHaveBeenCalled()
  })

  it('os refusing a loopback question is journaled once per distinct error; the report goes out without it', async () => {
    const f = fakeHost({ managed: true })
    f.host.mailDomains.mockRejectedValue(new Error('os answered 404 on /api/fleet/mail-domains'))
    f.setAnswer(desired())
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const agent = new FleetAgent(f.host)
    expect((await agent.poll()).ok).toBe(true)
    await agent.poll()
    expect(JSON.parse(String(f.calls[0]!.init.body))).not.toHaveProperty('mail')
    expect(f.logs.filter((l) => l.type === 'fleet.os_unanswered')).toEqual([
      { type: 'fleet.os_unanswered', message: expect.stringContaining('404 on /api/fleet/mail-domains') },
    ])
    expect(err).toHaveBeenCalledWith(expect.stringContaining('404 on /api/fleet/mail-domains'))
    err.mockRestore()
  })

  it('report omits mail when os cannot say (older os)', async () => {
    const f = fakeHost({ managed: true })
    f.host.mailDomains.mockResolvedValue(null)
    await new FleetAgent(f.host).poll()
    expect(JSON.parse(String(f.calls[0]!.init.body))).not.toHaveProperty('mail')
  })

  it('mail: sets + declares the EE_MAIL_* secrets on os, redeploys only on change, null removes them', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    const mail = {
      region: 'eu-central-1', accessKeyId: 'AKIAMAIL', secretAccessKey: 'SECRET-MAIL', tenant: `ee-${BOX}`,
      configurationSet: 'ee-cs', trackingConfigurationSet: 'ee-cs-tracking',
      eventsTopicArn: 'arn:aws:sns:eu-central-1:1:events', inboundTopicArn: 'arn:aws:sns:eu-central-1:1:inbound',
      inboundBucket: 'ee-inbound', inboundPrefix: `${BOX}/`,
    }
    const names = ['EE_MAIL_REGION', 'EE_MAIL_ACCESS_KEY_ID', 'EE_MAIL_SECRET_ACCESS_KEY', 'EE_MAIL_TENANT', 'EE_MAIL_CONFIG_SET', 'EE_MAIL_TRACKING_CONFIG_SET', 'EE_MAIL_EVENTS_TOPIC_ARN', 'EE_MAIL_INBOUND_TOPIC_ARN', 'EE_MAIL_INBOUND_BUCKET', 'EE_MAIL_INBOUND_PREFIX']
    f.setAnswer(desired({ mail }))
    expect((await agent.poll()).ok).toBe(true)
    expect(f.secrets['os']).toMatchObject({
      EE_MAIL_REGION: 'eu-central-1', EE_MAIL_ACCESS_KEY_ID: 'AKIAMAIL', EE_MAIL_SECRET_ACCESS_KEY: 'SECRET-MAIL', EE_MAIL_TENANT: `ee-${BOX}`,
      EE_MAIL_CONFIG_SET: 'ee-cs', EE_MAIL_TRACKING_CONFIG_SET: 'ee-cs-tracking', EE_MAIL_EVENTS_TOPIC_ARN: mail.eventsTopicArn,
      EE_MAIL_INBOUND_TOPIC_ARN: mail.inboundTopicArn, EE_MAIL_INBOUND_BUCKET: 'ee-inbound', EE_MAIL_INBOUND_PREFIX: `${BOX}/`,
    })
    expect(f.state().workloads[0]!.secrets).toEqual(expect.arrayContaining(names))
    const n = f.commits.length
    await agent.poll()
    expect(f.commits).toHaveLength(n)
    expect(f.host.reconcile).not.toHaveBeenCalled()
    f.setAnswer(desired({ mail: { ...mail, secretAccessKey: 'SECRET-MAIL-2' } }))
    await agent.poll()
    expect(f.host.reconcile).toHaveBeenCalledTimes(1)
    expect(f.secrets['os']!['EE_MAIL_SECRET_ACCESS_KEY']).toBe('SECRET-MAIL-2')
    f.setAnswer(desired({ mail: null }))
    await agent.poll()
    for (const name of names) {
      expect(f.secrets['os']![name]).toBeUndefined()
      expect(f.state().workloads[0]!.secrets).not.toContain(name)
    }
    for (const l of f.logs) expect(l.message).not.toMatch(/SECRET-MAIL|AKIAMAIL/)
  })

  it('domains: sets + declares EE_DOMAINS_API_BASE + EE_DOMAINS_TOKEN on os, redeploys only on change, null removes them', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    const domains = { apiBase: 'https://hosting.example.com', token: 'D'.repeat(48) }
    const names = ['EE_DOMAINS_API_BASE', 'EE_DOMAINS_TOKEN']
    f.setAnswer(desired({ domains }))
    expect((await agent.poll()).ok).toBe(true)
    expect(f.secrets['os']).toMatchObject({ EE_DOMAINS_API_BASE: 'https://hosting.example.com', EE_DOMAINS_TOKEN: domains.token })
    expect(f.state().workloads[0]!.secrets).toEqual(expect.arrayContaining(names))
    const n = f.commits.length
    await agent.poll()
    expect(f.commits).toHaveLength(n)
    expect(f.host.reconcile).not.toHaveBeenCalled()
    const rotated = 'E'.repeat(48)
    f.setAnswer(desired({ domains: { ...domains, token: rotated } }))
    expect((await agent.poll()).ok).toBe(true)
    expect(f.host.reconcile).toHaveBeenCalledTimes(1)
    expect(f.commits).toHaveLength(n)
    expect(f.secrets['os']!['EE_DOMAINS_TOKEN']).toBe(rotated)
    f.setAnswer(desired({ domains: null }))
    expect((await agent.poll()).ok).toBe(true)
    for (const name of names) {
      expect(f.secrets['os']![name]).toBeUndefined()
      expect(f.state().workloads[0]!.secrets).not.toContain(name)
    }
    // The token is a secret: never in the journal or a commit message.
    for (const l of f.logs) expect(l.message).not.toMatch(/DDDD|EEEE/)
    for (const c of f.commits) expect(c).not.toMatch(/DDDD|EEEE/)
  })

  it('domains: a desired state without domains leaves the EE_DOMAINS_* secrets alone', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    const domains = { apiBase: 'https://hosting.example.com', token: 'D'.repeat(48) }
    f.setAnswer(desired({ domains }))
    await agent.poll()
    const n = f.commits.length
    f.setAnswer(desired())
    expect((await agent.poll()).ok).toBe(true)
    expect(f.secrets['os']).toMatchObject({ EE_DOMAINS_API_BASE: domains.apiBase, EE_DOMAINS_TOKEN: domains.token })
    expect(f.state().workloads[0]!.secrets).toEqual(expect.arrayContaining(['EE_DOMAINS_API_BASE', 'EE_DOMAINS_TOKEN']))
    expect(f.commits).toHaveLength(n)
    expect(f.host.reconcile).not.toHaveBeenCalled()
  })

  it('claims: announced; each poll stores the latest desired.claims; null or absent clears them', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    const claims = [
      { host: 'www.acme.com', verified: false, txtName: '_ee-verify.www.acme.com', txtValue: 'company-token' },
      { host: 'acme.com', verified: true, txtName: '_ee-verify.acme.com', txtValue: 'company-token' },
    ]
    f.setAnswer(desired({ claims }))
    expect((await agent.poll()).ok).toBe(true)
    expect(JSON.parse(String(f.calls[0]!.init.body)).features).toContain('claims')
    expect(f.claims()).toEqual(claims)
    const verified = claims.map((c) => ({ ...c, verified: true }))
    f.setAnswer(desired({ claims: verified }))
    await agent.poll()
    expect(f.claims()).toEqual(verified)
    f.setAnswer(desired({ claims: [] }))
    await agent.poll()
    expect(f.claims()).toEqual([])
    f.setAnswer(desired({ claims: null }))
    await agent.poll()
    expect(f.claims()).toBeNull()
    f.setAnswer(desired({ claims }))
    await agent.poll()
    f.setAnswer(desired())
    expect((await agent.poll()).ok).toBe(true)
    expect(f.claims()).toBeNull()
    // Storing claims is no change to the company repo.
    expect(f.commits).toEqual([])
  })

  it('claims: a failed store is a poll error, and the other fields still apply', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.host.saveClaims.mockRejectedValueOnce(new Error('disk full'))
    f.setAnswer(desired({ suspended: true, claims: [] }))
    const r = await agent.poll()
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('claims: disk full') })
    expect(f.state().settings.suspended).toBe(true)
  })

  describe('hostedAddress (plan/hosted-address.md H5)', () => {
    const hostedAddress = { mailDomain: 'acme.eigenenterprise.app', siteHost: 'www.acme.eigenenterprise.app' }
    const siteRoute = { host: hostedAddress.siteHost, workload: 'os', allowPaths: OS_PUBLIC_SURFACE, rootRewrite: OS_HOME_PATH }

    it('is announced: every enroll and report lists every feature', async () => {
      expect(IMPLEMENTED_FEATURES).toEqual([...FLEET_FEATURES])
      const f = fakeHost({ managed: true })
      f.setAnswer(desired())
      await new FleetAgent(f.host).poll()
      expect(JSON.parse(String(f.calls[0]!.init.body)).features).toContain('hostedAddress')
    })

    it('no public host yet: siteHost becomes the public host (website surface only), stored with its provenance; idempotent across polls', async () => {
      const f = fakeHost({ managed: true })
      const agent = new FleetAgent(f.host)
      f.setAnswer(desired({ hostedAddress }))
      expect((await agent.poll()).ok).toBe(true)
      expect(f.state().settings.publicHost).toBe(hostedAddress.siteHost)
      expect(f.state().routes).toContainEqual(siteRoute)
      expect(f.hosted()).toEqual({ hostedAddress, fleetSiteHost: hostedAddress.siteHost })
      expect(f.logs.map((l) => l.type)).toContain('fleet.hosted_site_added')
      const commits = f.commits.length
      expect(commits).toBe(1)
      for (let i = 0; i < 3; i++) expect((await agent.poll()).ok).toBe(true)
      expect(f.commits).toHaveLength(commits)
      expect(f.state().routes.filter((r) => r.host === hostedAddress.siteHost)).toHaveLength(1)
      expect(f.host.saveHostedAddress).toHaveBeenCalledTimes(1)
    })

    it('an own public host the owner set is never replaced; the address is still stored for os', async () => {
      const f = fakeHost({ managed: true })
      f.setState((s) => addDomain(s, { host: 'www.acme.com', workload: 'os', role: 'public' }))
      const agent = new FleetAgent(f.host)
      f.setAnswer(desired({ hostedAddress }))
      expect((await agent.poll()).ok).toBe(true)
      expect(f.state().settings.publicHost).toBe('www.acme.com')
      expect(f.state().routes.some((r) => r.host === hostedAddress.siteHost)).toBe(false)
      expect(f.hosted()).toEqual({ hostedAddress, fleetSiteHost: null })
      expect(f.commits).toEqual([])
    })

    it("the owner's own domain wins: connecting it displaces the fleet's siteHost, which is dropped and never comes back while the owner's host stays", async () => {
      const f = fakeHost({ managed: true })
      const agent = new FleetAgent(f.host)
      f.setAnswer(desired({ hostedAddress }))
      await agent.poll()
      // The owner connects their domain as the website (POST /v1/domains → setDomain → addDomain).
      f.setState((s) => addDomain(s, { host: 'www.acme.com', workload: 'os', role: 'public' }))
      expect(f.state().routes.some((r) => r.host === hostedAddress.siteHost)).toBe(false)
      const commits = f.commits.length
      expect((await agent.poll()).ok).toBe(true)
      expect(f.state().settings.publicHost).toBe('www.acme.com')
      expect(f.hosted()).toEqual({ hostedAddress, fleetSiteHost: null })
      expect(f.logs.find((l) => l.type === 'fleet.hosted_site_displaced')?.message).toContain('www.acme.com')
      await agent.poll()
      expect(f.commits).toHaveLength(commits)
      // hostedAddress null later: the owner's host is never removed.
      f.setAnswer(desired({ hostedAddress: null }))
      expect((await agent.poll()).ok).toBe(true)
      expect(f.state().settings.publicHost).toBe('www.acme.com')
      expect(f.commits).toHaveLength(commits)
    })

    it('null removes siteHost when the fleet added it and it is still the public host', async () => {
      const f = fakeHost({ managed: true })
      const agent = new FleetAgent(f.host)
      f.setAnswer(desired({ hostedAddress }))
      await agent.poll()
      f.setAnswer(desired({ hostedAddress: null }))
      expect((await agent.poll()).ok).toBe(true)
      expect(f.state().settings.publicHost).toBeNull()
      expect(f.state().routes.some((r) => r.host === hostedAddress.siteHost)).toBe(false)
      expect(f.hosted()).toEqual({ hostedAddress: null, fleetSiteHost: null })
      expect(f.logs.map((l) => l.type)).toContain('fleet.hosted_site_removed')
      const commits = f.commits.length
      await agent.poll()
      expect(f.commits).toHaveLength(commits)
    })

    it('null never removes the same host when the owner added it (no fleet provenance)', async () => {
      const f = fakeHost({ managed: true })
      f.setState((s) => addDomain(s, { host: hostedAddress.siteHost, workload: 'os', role: 'public' }))
      const agent = new FleetAgent(f.host)
      f.setAnswer(desired({ hostedAddress }))
      await agent.poll()
      expect(f.hosted().fleetSiteHost).toBeNull()
      f.setAnswer(desired({ hostedAddress: null }))
      await agent.poll()
      expect(f.state().settings.publicHost).toBe(hostedAddress.siteHost)
      expect(f.commits).toEqual([])
    })

    it('absent leaves everything as is (a control plane that does not send it)', async () => {
      const f = fakeHost({ managed: true })
      const agent = new FleetAgent(f.host)
      f.setAnswer(desired({ hostedAddress }))
      await agent.poll()
      f.setAnswer(desired())
      expect((await agent.poll()).ok).toBe(true)
      expect(f.state().settings.publicHost).toBe(hostedAddress.siteHost)
      expect(f.hosted()).toEqual({ hostedAddress, fleetSiteHost: hostedAddress.siteHost })
    })

    it('a new siteHost (slug renamed) replaces the fleet one it added', async () => {
      const f = fakeHost({ managed: true })
      const agent = new FleetAgent(f.host)
      f.setAnswer(desired({ hostedAddress }))
      await agent.poll()
      const next = { mailDomain: 'acme2.eigenenterprise.app', siteHost: 'www.acme2.eigenenterprise.app' }
      f.setAnswer(desired({ hostedAddress: next }))
      expect((await agent.poll()).ok).toBe(true)
      expect(f.state().settings.publicHost).toBe(next.siteHost)
      expect(f.state().routes.some((r) => r.host === hostedAddress.siteHost)).toBe(false)
      expect(f.hosted()).toEqual({ hostedAddress: next, fleetSiteHost: next.siteHost })
    })

    it('the provenance is stored before the commit: a failed commit is a poll error and the next poll completes it', async () => {
      const f = fakeHost({ managed: true })
      const agent = new FleetAgent(f.host)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      f.host.change.mockRejectedValueOnce(new Error('repo locked'))
      f.setAnswer(desired({ hostedAddress }))
      const r = await agent.poll()
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('hostedAddress: repo locked') })
      expect(f.hosted().fleetSiteHost).toBe(hostedAddress.siteHost)
      expect(f.state().settings.publicHost).toBeNull()
      expect((await agent.poll()).ok).toBe(true)
      expect(f.state().settings.publicHost).toBe(hostedAddress.siteHost)
      expect(f.logs.map((l) => l.type)).not.toContain('fleet.hosted_site_displaced')
    })

    it('fails loud when siteHost is already routed to another workload (never re-routed silently)', async () => {
      const f = fakeHost({ managed: true })
      f.setState((s) => ({ ...s, routes: [...s.routes, { host: hostedAddress.siteHost, workload: 'livekit' } as never] }))
      const agent = new FleetAgent(f.host)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      f.setAnswer(desired({ hostedAddress }))
      const r = await agent.poll()
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining(`hostedAddress: ${hostedAddress.siteHost} is already routed to livekit`) })
      expect(f.state().settings.publicHost).toBeNull()
    })

    it('a reconcile error after adding it is a poll error', async () => {
      const f = fakeHost({ managed: true })
      const agent = new FleetAgent(f.host)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      f.host.change.mockImplementationOnce(async (_m: string, mutate: (s: Omit<DesiredState, 'rev'>) => Omit<DesiredState, 'rev'>) => {
        f.setState(mutate)
        return { reconcileError: 'caddy refused' }
      })
      f.setAnswer(desired({ hostedAddress }))
      expect(await agent.poll()).toMatchObject({ ok: false, error: expect.stringContaining('hostedAddress: caddy refused') })
    })
  })

  it('backup: configures the fleet target, reconfigures only on change, null removes only its own', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    f.setAnswer(desired({ backup: target }))
    await agent.poll()
    expect(f.host.backups.configure).toHaveBeenCalledWith({ target: { ...target, addressing: 'path' }, schedule: { hour: 3 }, retentionDays: 30, author: 'fleet' })
    expect(f.secrets[FLEET_SCOPE]![FLEET_BACKUP_MARK]).toBe('1')
    await agent.poll()
    expect(f.host.backups.configure).toHaveBeenCalledTimes(1)
    f.setAnswer(desired({ backup: { ...target, bucket: 'acme-backups-2' } }))
    await agent.poll()
    expect(f.host.backups.configure).toHaveBeenCalledTimes(2)
    f.setAnswer(desired({ backup: null }))
    await agent.poll()
    expect(f.host.backups.unconfigure).toHaveBeenCalledTimes(1)
    expect(f.secrets[FLEET_SCOPE]![FLEET_BACKUP_MARK]).toBeUndefined()
  })

  it('backup: no key sealed yet → asks os for it over loopback and configures with it', async () => {
    const f = fakeHost({ managed: true })
    f.host.backups.hasKey.mockReturnValue(false)
    const agent = new FleetAgent(f.host)
    f.setAnswer(desired({ backup: target }))
    const r = await agent.poll()
    expect(r.ok).toBe(true)
    expect(f.host.backupKey).toHaveBeenCalledWith('local-token')
    expect(f.host.backups.configure).toHaveBeenCalledWith({ target: { ...target, addressing: 'path' }, schedule: { hour: 3 }, retentionDays: 30, author: 'fleet', backupKey: 'K'.repeat(43) + '=' })
  })

  it('backup: os cannot give the key → error in the poll, nothing configured, retried next tick', async () => {
    const f = fakeHost({ managed: true })
    f.host.backups.hasKey.mockReturnValue(false)
    f.host.backupKey.mockRejectedValueOnce(new Error('os could not give the backup key: HTTP 503'))
    const agent = new FleetAgent(f.host)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.setAnswer(desired({ backup: target }))
    const r = await agent.poll()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/backup: os could not give the backup key/)
    expect(f.host.backups.configure).not.toHaveBeenCalled()
    expect(f.secrets[FLEET_SCOPE]![FLEET_BACKUP_MARK]).toBeUndefined()
    expect((await agent.poll()).ok).toBe(true)
    expect(f.host.backups.configure).toHaveBeenCalledTimes(1)
  })

  it('backup: a sealed key is never fetched again', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    f.setAnswer(desired({ backup: target }))
    await agent.poll()
    expect(f.host.backupKey).not.toHaveBeenCalled()
  })

  it('escrowBackupKey: sends a signed escrow request with the sealed key after the backup step', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    f.setAnswer((url) => (url.endsWith(FLEET_PATHS.escrow) ? new Response(null, { status: 204 }) : desired({ escrowBackupKey: true })()))
    const r = await agent.poll()
    expect(r).toMatchObject({ ok: true, error: null })
    const call = f.calls.find((c) => c.url === `${CP}${FLEET_PATHS.escrow}`)!
    expect(call.init.method).toBe('POST')
    const headers = Object.fromEntries(Object.entries(call.init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const v = verifyFleetRequest({ publicKey: f.box.publicKey, method: 'POST', path: FLEET_PATHS.escrow, body: String(call.init.body), headers, now: f.host.now().getTime() })
    expect(v.ok).toBe(true)
    expect(escrowRequestV1.parse(JSON.parse(String(call.init.body)))).toEqual({ protocol: 1, backupKey: SEALED })
    expect(f.logs.some((l) => l.type === 'fleet.backup_key_escrowed')).toBe(true)
    for (const l of f.logs) expect(l.message).not.toContain(SEALED)
  })

  it('escrowBackupKey: no request without a sealed key, or when the field is absent or false', async () => {
    for (const extra of [{ escrowBackupKey: true }, {}, { escrowBackupKey: false }]) {
      const f = fakeHost({ managed: true })
      if ('escrowBackupKey' in extra && extra.escrowBackupKey) f.host.backups.key.mockReturnValue(null)
      const agent = new FleetAgent(f.host)
      f.setAnswer(desired(extra))
      expect((await agent.poll()).ok).toBe(true)
      expect(f.calls.filter((c) => c.url.endsWith(FLEET_PATHS.escrow))).toHaveLength(0)
    }
  })

  it('escrowBackupKey: a 409 shows in the poll error and the key appears nowhere', async () => {
    const f = fakeHost({ managed: true })
    const agent = new FleetAgent(f.host)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.setAnswer((url) => (url.endsWith(FLEET_PATHS.escrow) ? new Response('already holds a different key', { status: 409 }) : desired({ escrowBackupKey: true })()))
    const r = await agent.poll()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/escrowBackupKey: .*answered 409: already holds a different key/)
    expect(r.error).not.toContain(SEALED)
    for (const l of f.logs) expect(l.message).not.toContain(SEALED)
    for (const c of err.mock.calls) expect(String(c)).not.toContain(SEALED)
  })

  it('backup: never touches a target the owner set by hand', async () => {
    const f = fakeHost({ managed: true })
    f.setBackup({ target: { ...target, bucket: 'owners-own', addressing: 'virtual' }, schedule: { hour: 1, minute: 2 }, retentionDays: 9, configuredAt: 'x', configuredBy: 'owner:al', keyCreatedAt: 'x' })
    const agent = new FleetAgent(f.host)
    f.setAnswer(desired({ backup: target }))
    await agent.poll()
    f.setAnswer(desired({ backup: null }))
    await agent.poll()
    expect(f.host.backups.configure).not.toHaveBeenCalled()
    expect(f.host.backups.unconfigure).not.toHaveBeenCalled()
  })

  it('backup: a failed configure is reported and leaves no fleet mark', async () => {
    const f = fakeHost({ managed: true })
    f.host.backups.configure.mockRejectedValueOnce(new Error('the backup key (derived from the company recovery code) is required the first time'))
    const agent = new FleetAgent(f.host)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.setAnswer(desired({ backup: target, suspended: true }))
    const r = await agent.poll()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/backup: the backup key/)
    expect(f.secrets[FLEET_SCOPE]![FLEET_BACKUP_MARK]).toBeUndefined()
    // The other fields still applied.
    expect(f.state().settings.suspended).toBe(true)
  })

  it('backupRequestedAt: runs a backup when no run started since the request', async () => {
    const f = fakeHost({ managed: true })
    const cfg = { target: { ...target, addressing: 'path' as const }, schedule: { hour: 3, minute: 1 }, retentionDays: 30, configuredAt: 'x', configuredBy: 'fleet', keyCreatedAt: 'x' }
    const run = (startedAt: string, status: BackupRun['status']) => ({ startedAt, status, endedAt: startedAt }) as BackupRun
    f.setBackup(cfg, [run('2026-11-15T03:00:00Z', 'succeeded')])
    const agent = new FleetAgent(f.host)
    f.setAnswer(desired({ backupRequestedAt: '2026-11-16T11:00:00Z' }))
    await agent.poll()
    expect(f.host.backups.start).toHaveBeenCalledWith('manual', 'fleet')
    f.setBackup(cfg, [run('2026-11-16T11:30:00Z', 'failed'), run('2026-11-15T03:00:00Z', 'succeeded')], { state: 'failed', at: 'x', error: 'bucket gone' })
    await agent.poll()
    expect(f.host.backups.start).toHaveBeenCalledTimes(1)
    const report = JSON.parse(String(f.calls.at(-1)!.init.body))
    expect(report.backup).toEqual({ lastOkAt: '2026-11-15T03:00:00Z', lastError: 'bucket gone' })
  })
})
