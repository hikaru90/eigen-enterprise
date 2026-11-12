import { describe, expect, it } from 'vitest'
import { pluginGate, type GateRequest, type PluginGateDeps } from './gate'

/**
 * The plugin gate (owner, 2026-11-12): a switched-off plugin's pages show one
 * clear page, its APIs answer 409 plugin_inactive, its provider webhooks get
 * their decided policy; the core and switched-on plugins pass untouched.
 */

const NAMES: Record<string, string> = { drive: 'Drive', calls: 'Calls', email: 'Email', website: 'Website', memory: 'Memory', messages: 'Messages' }

function deps(active: Record<string, boolean>, roles: { admins?: string[] } = {}) {
  const logs: string[] = []
  const counts = { activations: 0, canManage: 0 }
  const d: PluginGateDeps = {
    activations: async () => {
      counts.activations += 1
      return new Map(Object.entries(active))
    },
    pluginName: async (id) => NAMES[id],
    canManage: async (userId) => {
      counts.canManage += 1
      return (roles.admins ?? []).includes(userId)
    },
    log: (line) => logs.push(line),
  }
  return { d, logs, counts }
}

function req(pathname: string, over: Partial<Omit<GateRequest, 'headers'>> & { headers?: Record<string, string> } = {}): GateRequest {
  return {
    pathname,
    method: over.method ?? 'GET',
    isDataRequest: over.isDataRequest ?? false,
    headers: new Headers(over.headers ?? { accept: 'text/html,application/xhtml+xml' }),
    userId: over.userId === undefined ? 'member-1' : over.userId,
  }
}

async function body(res: Response) {
  return { status: res.status, json: await res.json() }
}

describe('pluginGate — on/off per prefix', () => {
  it.each(['/drive', '/drive/file/abc', '/api/drive/upload'])('%s passes while Drive is on', async (path) => {
    expect(await pluginGate(req(path), deps({ drive: true }).d)).toEqual({ kind: 'pass' })
  })

  it('core routes pass without reading the activation set (Settings → Plugins stays reachable)', async () => {
    const { d, counts } = deps({})
    for (const path of ['/', '/settings/modules', '/assistant', '/api/chat', '/api/capture/transcribe', '/login']) {
      expect(await pluginGate(req(path), d)).toEqual({ kind: 'pass' })
    }
    expect(counts.activations).toBe(0)
  })

  it('a plugin the kernel has not registered passes (its routes answer as they do)', async () => {
    expect(await pluginGate(req('/m/recap'), deps({}).d)).toEqual({ kind: 'pass' })
  })

  it('no activation record counts as off (fail closed, like the kernel)', async () => {
    expect(await pluginGate(req('/drive'), deps({}).d)).toMatchObject({ kind: 'page' })
  })
})

describe('pluginGate — pages of a switched-off plugin', () => {
  it('a member gets the switched-off page without the way to switch it (ask an admin)', async () => {
    expect(await pluginGate(req('/drive/shared'), deps({ drive: false }).d)).toEqual({
      kind: 'page',
      off: { id: 'drive', name: 'Drive', canManage: false },
    })
  })

  it('an owner/admin gets the switched-off page with the way to Settings → Plugins', async () => {
    expect(await pluginGate(req('/drive', { userId: 'admin-1' }), deps({ drive: false }, { admins: ['admin-1'] }).d)).toEqual({
      kind: 'page',
      off: { id: 'drive', name: 'Drive', canManage: true },
    })
  })

  it('a client-side navigation (__data.json) gets the same page', async () => {
    expect(await pluginGate(req('/messages', { isDataRequest: true, headers: { accept: '*/*' } }), deps({ messages: false }).d)).toMatchObject({
      kind: 'page',
      off: { id: 'messages' },
    })
  })

  it('signed out: passes (the page sends them to sign-in; nothing about plugins is said)', async () => {
    expect(await pluginGate(req('/drive', { userId: null }), deps({ drive: false }).d)).toEqual({ kind: 'pass' })
  })

  it('an enhanced form action never runs: the client gets an error result for the switched-off page', async () => {
    const decision = await pluginGate(
      req('/m/email/domains', { method: 'POST', headers: { accept: 'application/json', 'x-sveltekit-action': 'true' } }),
      deps({ email: false }).d,
    )
    if (decision.kind !== 'respond') throw new Error(`expected a response, got ${decision.kind}`)
    expect(await body(decision.response)).toEqual({
      status: 404,
      json: { type: 'error', status: 404, error: { message: 'Email is switched off', pluginOff: { id: 'email', name: 'Email', canManage: false } } },
    })
  })

  it('a plain form post is sent back to the page (a GET: no redirect loop, the page shows it is off)', async () => {
    const decision = await pluginGate(req('/m/email/domains', { method: 'POST' }), deps({ email: false }).d)
    if (decision.kind !== 'respond') throw new Error('expected a response')
    expect(decision.response.status).toBe(303)
    expect(decision.response.headers.get('location')).toBe('/m/email/domains')
  })

  it('an endpoint under a page prefix (no HTML wanted) answers the API error', async () => {
    const decision = await pluginGate(
      req('/m/website/apps/site/deploy-progress', { headers: { accept: 'text/event-stream' }, userId: 'admin-1' }),
      deps({ website: false }).d,
    )
    if (decision.kind !== 'respond') throw new Error('expected a response')
    expect((await body(decision.response)).json).toMatchObject({ code: 'plugin_inactive', plugin: 'website' })
  })
})

describe('pluginGate — APIs of a switched-off plugin', () => {
  it.each([
    ['/api/drive/upload', 'POST', 'drive', 'Drive'],
    ['/api/messages/stream', 'GET', 'messages', 'Messages'],
    ['/api/calls/stream', 'GET', 'calls', 'Calls'],
    ['/api/timeline/projects', 'GET', 'memory', 'Memory'],
  ])('%s (%s) answers 409 plugin_inactive, never a 500', async (path, method, plugin, name) => {
    const decision = await pluginGate(req(path, { method, headers: { accept: 'application/json' } }), deps({ [plugin]: false }).d)
    if (decision.kind !== 'respond') throw new Error('expected a response')
    expect(await body(decision.response)).toEqual({
      status: 409,
      json: {
        error: `${name} is switched off. The owner or an admin can switch it on in Settings → Plugins.`,
        code: 'plugin_inactive',
        plugin,
      },
    })
  })

  it('signed out: passes (the route answers 401 itself)', async () => {
    expect(await pluginGate(req('/api/drive/upload', { method: 'POST', userId: null }), deps({ drive: false }).d)).toEqual({ kind: 'pass' })
  })
})

describe('pluginGate — provider webhooks', () => {
  it('drop: SES inbound mail is accepted (200, so SNS does not retry) and dropped with one log line', async () => {
    const { d, logs } = deps({ email: false })
    const decision = await pluginGate(req('/api/mail/ses-inbound', { method: 'POST', userId: null, headers: { accept: '*/*' } }), d)
    if (decision.kind !== 'respond') throw new Error('expected a response')
    expect(await body(decision.response)).toEqual({ status: 200, json: { ok: true, dropped: 'plugin_inactive' } })
    expect(logs).toEqual(['[plugins] Email is switched off: dropped POST /api/mail/ses-inbound (Amazon SNS (SES receipt notifications))'])
  })

  it('refuse: a GitHub push answers 409 plugin_inactive (GitHub keeps it to redeliver), logged once', async () => {
    const { d, logs } = deps({ website: false })
    const decision = await pluginGate(req('/api/github/webhook', { method: 'POST', userId: null, headers: { accept: '*/*' } }), d)
    if (decision.kind !== 'respond') throw new Error('expected a response')
    expect(await body(decision.response)).toMatchObject({ status: 409, json: { code: 'plugin_inactive', plugin: 'website' } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('refused POST /api/github/webhook')
  })

  it.each(['/api/calls/livekit', '/api/mail/ses-events', '/api/mail/unsubscribe/tok-1'])(
    'open: %s keeps working while switched off (its own signature check runs as always)',
    async (path) => {
      const { d, counts } = deps({ calls: false, email: false })
      expect(await pluginGate(req(path, { method: 'POST', userId: null }), d)).toEqual({ kind: 'pass' })
      expect(counts.activations).toBe(0)
    },
  )

  it('a webhook of a switched-on plugin passes to its route (signature checks untouched)', async () => {
    expect(await pluginGate(req('/api/github/webhook', { method: 'POST', userId: null }), deps({ website: true }).d)).toEqual({ kind: 'pass' })
  })
})
