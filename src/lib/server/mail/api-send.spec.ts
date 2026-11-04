import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryRateLimiter,
  handleMailSend,
  TemplateInvalid,
  TemplateNotFound,
  type MailSendAudit,
  type MailSendDeps,
  type MailSendStore,
} from './api-send'
import { MailNotConfiguredError, MailSetupError } from './company-mail'

const KEY = { id: 'k1', name: 'agent-bot' }
const BODY = { to: 'ada@example.com', subject: 'Hi', text: 'Hello Ada' }
const SECRET_TEXT = 'TOP-SECRET-BODY-TEXT'

function memoryStore(
  scopes: Record<string, boolean>,
): MailSendStore & { rows: Map<string, unknown> } {
  type Row = {
    id: string
    bodyHash: string
    status: 'pending' | 'sent'
    logId: string | null
    sendStatus: string | null
    createdAt: number
  }
  const rows = new Map<string, Row>()
  let n = 0
  return {
    rows,
    async canSendMail(keyId) {
      return scopes[keyId] === true
    },
    async claim({ keyId, idempotencyKey, bodyHash }) {
      const k = `${keyId}:${idempotencyKey}`
      const existing = rows.get(k)
      if (existing) return { kind: 'existing', ...existing }
      const id = `row-${++n}`
      rows.set(k, { id, bodyHash, status: 'pending', logId: null, sendStatus: null, createdAt: Date.now() })
      return { kind: 'claimed', id }
    },
    async markSent(id, result) {
      for (const r of rows.values())
        if (r.id === id) Object.assign(r, { status: 'sent', logId: result.logId, sendStatus: result.sendStatus })
    },
    async release(id) {
      for (const [k, r] of rows) if (r.id === id) rows.delete(k)
    },
  }
}

let send: ReturnType<typeof vi.fn>
let isConfigured: ReturnType<typeof vi.fn>
let audits: MailSendAudit[]
let deps: MailSendDeps
let logSpy: ReturnType<typeof vi.spyOn>[]

beforeEach(() => {
  let logs = 0
  send = vi.fn(async () => ({ id: `log-${++logs}`, status: 'sent', messageId: 'ses-1' }))
  isConfigured = vi.fn(async () => true)
  audits = []
  deps = {
    mail: { isConfigured, send },
    renderTemplate: async (id, vars) => {
      if (id === '00000000-0000-4000-8000-00000000dead') throw new TemplateNotFound()
      if (!vars.name) throw new TemplateInvalid('Missing variables: name.', ['name'])
      return { subject: `Hi ${vars.name}`, html: `<p>Hi ${vars.name}</p>`, text: `Hi ${vars.name}` }
    },
    store: memoryStore({ k1: true, k2: false }),
    limiter: createMemoryRateLimiter({ limit: 60, windowMs: 60_000, now: () => 0 }),
    audit: async (a) => {
      audits.push(a)
    },
  }
  logSpy = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
})

describe('auth', () => {
  it('no key (or a cookie session, which never sets apiKeyAuth) is 401', async () => {
    const res = await handleMailSend(deps, { apiKey: null, body: BODY })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
    expect(send).not.toHaveBeenCalled()
  })

  it('a key without the mail scope is 403 and audited', async () => {
    const res = await handleMailSend(deps, { apiKey: { id: 'k2', name: 'reader' }, body: BODY })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden', message: 'this key may not send mail' })
    expect(send).not.toHaveBeenCalled()
    expect(audits[0]).toMatchObject({ keyName: 'reader', outcome: 'forbidden', ok: false })
  })
})

describe('validation', () => {
  it.each([
    [{ ...BODY, to: 'nope' }, 'to'],
    [{ ...BODY, subject: '' }, 'subject'],
    [{ ...BODY, subject: 'x'.repeat(999) }, 'subject'],
    [{ ...BODY, text: '' }, 'text'],
    [{ ...BODY, replyTo: 'bad' }, 'replyTo'],
    [{ ...BODY, idempotencyKey: 'x'.repeat(129) }, 'idempotencyKey'],
    [{ ...BODY, to: ['a@example.com', 'b@example.com'] }, 'to'],
  ])('rejects %j on %s', async (body, field) => {
    const res = await handleMailSend(deps, { apiKey: KEY, body })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid_request' })
    expect(Object.keys((res.body as { fields: object }).fields)).toContain(field)
    expect(send).not.toHaveBeenCalled()
  })

  it('a body is either subject + text or a templateId (+ variables)', async () => {
    const tpl = '00000000-0000-4000-8000-000000000001'
    for (const [body, field] of [
      [{ to: 'a@example.com' }, 'subject'],
      [{ to: 'a@example.com', templateId: tpl, subject: 'x' }, 'subject'],
      [{ ...BODY, variables: { a: 'b' } }, 'variables'],
      [{ to: 'a@example.com', templateId: 'not-a-uuid' }, 'templateId'],
    ] as const) {
      const res = await handleMailSend(deps, { apiKey: KEY, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(Object.keys((res.body as { fields: object }).fields)).toContain(field)
    }
  })

  it('rejects unknown fields', async () => {
    const res = await handleMailSend(deps, { apiKey: KEY, body: { ...BODY, cc: 'x@example.com' } })
    expect(res.status).toBe(400)
    expect((res.body as { fields: object }).fields).toHaveProperty('cc')
  })

  it('rejects a non-object body', async () => {
    const res = await handleMailSend(deps, { apiKey: KEY, body: null })
    expect(res.status).toBe(400)
  })
})

describe('sending', () => {
  it('sends through companyMail and returns 200 {id, status, to}', async () => {
    const res = await handleMailSend(deps, {
      apiKey: KEY,
      body: { ...BODY, html: '<p>Hi</p>', replyTo: 'me@example.com' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'log-1', status: 'sent', to: 'ada@example.com' })
    expect(send).toHaveBeenCalledWith({
      to: 'ada@example.com',
      subject: 'Hi',
      text: 'Hello Ada',
      html: '<p>Hi</p>',
      replyTo: 'me@example.com',
      source: 'api',
      apiKey: KEY,
    })
    expect(audits).toEqual([
      expect.objectContaining({
        ok: true,
        outcome: 'sent',
        id: 'log-1',
        to: 'ada@example.com',
        keyName: 'agent-bot',
        activity: 'Sent an email to ada@example.com (via key agent-bot)',
      }),
    ])
  })

  it('passes a sender and a send time; a scheduled send says so', async () => {
    send.mockResolvedValueOnce({ id: 'log-9', status: 'scheduled', messageId: null })
    const at = new Date(Date.now() + 3_600_000).toISOString()
    const res = await handleMailSend(deps, { apiKey: KEY, body: { ...BODY, from: 'news@kindred.test', scheduledAt: at } })
    expect(res.body).toEqual({ id: 'log-9', status: 'scheduled', to: 'ada@example.com' })
    expect(send.mock.calls[0][0]).toMatchObject({ from: 'news@kindred.test', scheduledAt: new Date(at) })
    expect(audits[0]).toMatchObject({ ok: true, outcome: 'scheduled', activity: 'Scheduled an email to ada@example.com (via key agent-bot)' })
  })

  it('rejects a send time more than 30 days ahead', async () => {
    const at = new Date(Date.now() + 31 * 86_400_000).toISOString()
    const res = await handleMailSend(deps, { apiKey: KEY, body: { ...BODY, scheduledAt: at } })
    expect(res.status).toBe(400)
    expect((res.body as { fields: object }).fields).toHaveProperty('scheduledAt')
  })

  it('a suppressed recipient is 200 with status suppressed and the reason', async () => {
    send.mockResolvedValueOnce({ id: 'log-7', status: 'suppressed', messageId: null })
    const res = await handleMailSend(deps, { apiKey: KEY, body: BODY })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'log-7', status: 'suppressed', message: expect.stringMatching(/suppression list/) })
    expect(audits[0]).toMatchObject({ ok: false, outcome: 'suppressed' })
  })

  it('text-only mail gets an html part escaped from the text', async () => {
    await handleMailSend(deps, { apiKey: KEY, body: { ...BODY, text: 'a < b\nc' } })
    expect(send.mock.calls[0][0].html).toBe('<p>a &lt; b<br>c</p>')
  })

  it('503 when Email is not set up', async () => {
    isConfigured.mockResolvedValue(false)
    const res = await handleMailSend(deps, { apiKey: KEY, body: BODY })
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ error: 'mail_not_configured' })
    expect(typeof (res.body as { message: string }).message).toBe('string')
    expect(send).not.toHaveBeenCalled()
  })

  it('503 when the send itself says not configured', async () => {
    send.mockRejectedValue(new MailNotConfiguredError())
    const res = await handleMailSend(deps, { apiKey: KEY, body: BODY })
    expect(res.status).toBe(503)
  })

  it('maps an SES error to 502 with the plain-words message, no stack', async () => {
    const plain = 'Amazon refused the email: Email address is not verified.'
    send.mockRejectedValue(new MailSetupError(plain, { cause: new Error('raw aws') }))
    const res = await handleMailSend(deps, { apiKey: KEY, body: BODY })
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'delivery_failed', message: plain })
    expect(audits[0]).toMatchObject({ ok: false, outcome: 'delivery_failed' })
  })

  it('an unexpected error is 502 with a generic message (never the raw error)', async () => {
    send.mockRejectedValue(new Error('at Object.<anonymous> (/srv/x.js:1:1)'))
    const res = await handleMailSend(deps, { apiKey: KEY, body: BODY })
    expect(res.status).toBe(502)
    expect(JSON.stringify(res.body)).not.toContain('/srv/x.js')
  })
})

describe('templates', () => {
  const tpl = '00000000-0000-4000-8000-000000000001'

  it('renders the template and sends its subject/html/text, tagged with the template id', async () => {
    const res = await handleMailSend(deps, { apiKey: KEY, body: { to: 'ada@example.com', templateId: tpl, variables: { name: 'Ada' } } })
    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Hi Ada', html: '<p>Hi Ada</p>', text: 'Hi Ada', templateId: tpl, source: 'api' }),
    )
  })

  it('404 for an unknown template, 422 listing missing variables; nothing sent', async () => {
    const gone = await handleMailSend(deps, { apiKey: KEY, body: { to: 'a@example.com', templateId: '00000000-0000-4000-8000-00000000dead' } })
    expect(gone).toMatchObject({ status: 404, body: { error: 'template_not_found' } })
    const missing = await handleMailSend(deps, { apiKey: KEY, body: { to: 'a@example.com', templateId: tpl } })
    expect(missing).toMatchObject({ status: 422, body: { error: 'template_invalid', missing: ['name'] } })
    expect(send).not.toHaveBeenCalled()
    expect(audits.map((a) => a.outcome)).toEqual(['template_not_found', 'template_invalid'])
  })
})

describe('idempotency', () => {
  const body = { ...BODY, idempotencyKey: 'order-42' }

  it('a repeat returns the first id and sends once', async () => {
    const a = await handleMailSend(deps, { apiKey: KEY, body })
    const b = await handleMailSend(deps, { apiKey: KEY, body })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.body).toEqual(a.body)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the same idempotencyKey with a different body is 409', async () => {
    await handleMailSend(deps, { apiKey: KEY, body })
    const res = await handleMailSend(deps, { apiKey: KEY, body: { ...body, text: 'changed' } })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'idempotency_conflict' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a failed send releases the key so a retry can send', async () => {
    send.mockRejectedValueOnce(new MailSetupError('Amazon is limiting how fast'))
    expect((await handleMailSend(deps, { apiKey: KEY, body })).status).toBe(502)
    expect((await handleMailSend(deps, { apiKey: KEY, body })).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('rate limit', () => {
  it('429 with Retry-After after the per-key limit', async () => {
    let t = 0
    deps.limiter = createMemoryRateLimiter({ limit: 2, windowMs: 60_000, now: () => t })
    await handleMailSend(deps, { apiKey: KEY, body: BODY })
    await handleMailSend(deps, { apiKey: KEY, body: BODY })
    t = 15_000
    const res = await handleMailSend(deps, { apiKey: KEY, body: BODY })
    expect(res.status).toBe(429)
    expect(res.body).toMatchObject({ error: 'rate_limited' })
    expect(res.headers?.['Retry-After']).toBe('45')
    expect(send).toHaveBeenCalledTimes(2)
    t = 60_001
    expect((await handleMailSend(deps, { apiKey: KEY, body: BODY })).status).toBe(200)
  })
})

describe('no secrets in logs or audit', () => {
  it('audit and console never hold the body or the key', async () => {
    const body = { ...BODY, subject: 'S-' + SECRET_TEXT, text: SECRET_TEXT, html: SECRET_TEXT }
    await handleMailSend(deps, { apiKey: KEY, body })
    send.mockRejectedValue(new MailSetupError('nope'))
    await handleMailSend(deps, { apiKey: KEY, body })
    await handleMailSend(deps, { apiKey: { id: 'k2', name: 'reader' }, body })
    const dump = JSON.stringify(audits) + JSON.stringify(logSpy.map((s) => s.mock.calls))
    expect(dump).not.toContain(SECRET_TEXT)
    expect(dump).not.toContain('eigen_')
    expect(dump).not.toContain('"k1"')
  })
})
