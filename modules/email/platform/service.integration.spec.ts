import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { awsError, FakeSes, FakeSns } from '../owlery/fake-ses'
import { OwleryService } from '../owlery/service'
import { InMemoryOwleryStore, owlerySealKey } from '../owlery/store'
import { EmailPlatform, EmailPlatformError } from './service'
import { EmailStore } from './store'
import { emailBrandFromCssVars } from './templates/brand'

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * The email platform end to end on the test database (domains → DNS → verify →
 * senders → the one send path → SES events → suppression → jobs), with SES and
 * SNS faked. Runs when DATABASE_URL is set.
 */
describe.skipIf(!hasDb)('EmailPlatform (test database)', () => {
  let db: AppDatabase
  let now = new Date('2026-11-04T12:00:00Z')
  const key = owlerySealKey('integration')
  let ses: FakeSes
  let platform: EmailPlatform
  let store: EmailStore
  let dmarc: string[][] = []
  let fetched: string[] = []

  beforeAll(async () => {
    const { createScopedDrizzle, appSql } = await import('$lib/server/db')
    db = createScopedDrizzle(appSql)
  })

  async function wipe() {
    await new EmailStore(db).clearAll()
  }

  beforeEach(async () => {
    await wipe()
    now = new Date('2026-11-04T12:00:00Z')
    ses = new FakeSes()
    ses.verify('hello@kindred.test')
    const sns = new FakeSns()
    store = new EmailStore(db)
    const owlery = new OwleryService({
      store: new InMemoryOwleryStore(),
      key: () => key,
      ses: ses.factory,
      sns: sns.factory,
      log: store,
      now: () => now.getTime(),
    })
    await owlery.saveVerified({
      region: 'eu-central-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 's',
      emailFrom: 'hello@kindred.test',
      testRecipient: 'owner@kindred.test',
      updatedBy: 'u1',
    })
    ses.sent.length = 0
    dmarc = []
    fetched = []
    platform = new EmailPlatform({
      owlery,
      store,
      resolveTxt: async (name) => {
        if (name !== '_dmarc.kindred.com' || dmarc.length === 0) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
        return dmarc
      },
      fetch: (async (url: string) => {
        fetched.push(url)
        return new Response('ok')
      }) as unknown as typeof fetch,
      brand: async () => emailBrandFromCssVars(null, 'Kindred'),
      now: () => now,
    })
  })

  afterAll(async () => {
    await wipe()
  })

  it('adds a domain with our DKIM key, shows its records and verifies it through the state machine', async () => {
    const d = await platform.addDomain('Kindred.com', 'u1')
    expect(d).toMatchObject({ name: 'kindred.com', status: 'PENDING', region: 'eu-central-1', sendable: false })
    expect(ses.domains.get('kindred.com')).toMatchObject({ dkimSelector: 'ee', mailFromDomain: 'mail.kindred.com' })
    expect(d.records.find((r) => r.purpose === 'dkim')!.value).toBe(`p=${d.publicKey}`)
    await expect(platform.addDomain('kindred.com', 'u1')).rejects.toThrow(/already added/)

    // Pending: the background check finds nothing yet.
    expect((await platform.refreshDomain(d.id)).status).toBe('PENDING')
    // DNS published + DMARC added.
    ses.verify('kindred.com')
    dmarc = [['v=DMARC1; p=none;']]
    const verified = await platform.refreshDomain(d.id)
    expect(verified).toMatchObject({ status: 'SUCCESS', isVerifying: false, dmarcAdded: true, sendable: true })
    expect(verified.records.every((r) => r.status === 'SUCCESS')).toBe(true)
  })

  it('the background pass re-checks only domains that are due', async () => {
    const d = await platform.addDomain('kindred.com', 'u1')
    expect(await platform.refreshDueDomains()).toBe(1)
    now = new Date(now.getTime() + 30_000)
    expect(await platform.refreshDueDomains()).toBe(0)
    now = new Date(now.getTime() + 60_000)
    ses.verify('kindred.com')
    expect(await platform.refreshDueDomains()).toBe(1)
    expect((await platform.getDomain(d.id))!.status).toBe('SUCCESS')
    expect(await platform.refreshDueDomains()).toBe(0)
  })

  it('a sender needs a verified domain; the default sender cannot be removed', async () => {
    const d = await platform.addDomain('kindred.com', 'u1')
    await expect(platform.addSender({ address: 'news@kindred.com', displayName: 'Kindred News' }, 'u1')).rejects.toThrow(/not verified yet/)
    await expect(platform.addSender({ address: 'x@elsewhere.test', displayName: null }, 'u1')).rejects.toThrow(/under Domains/)
    ses.verify('kindred.com')
    await platform.refreshDomain(d.id)
    const sender = await platform.addSender({ address: 'News@Kindred.com', displayName: 'Kindred News' }, 'u1')
    expect(sender).toMatchObject({ address: 'news@kindred.com', domainId: d.id })

    const listed = await platform.listSenders()
    expect(listed.map((s) => [s.address, s.isDefault])).toEqual([
      ['hello@kindred.test', true],
      ['news@kindred.com', false],
    ])

    await platform.setDefaultSender(sender.id, 'u1')
    await expect(platform.deleteSender(sender.id)).rejects.toThrow(/default sender/)
    await expect(platform.deleteDomain(d.id)).rejects.toThrow(/default sender/)
  })

  it('sends through the one path, logs it, follows SES events and suppresses a hard bounce', async () => {
    const d = await platform.addDomain('kindred.com', 'u1')
    ses.verify('kindred.com')
    await platform.refreshDomain(d.id)
    await platform.addSender({ address: 'news@kindred.com', displayName: 'Kindred' }, 'u1')

    const sent = await platform.owlery.send({ to: 'Reader@x.co', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi', from: 'news@kindred.com', source: 'api' })
    expect(sent.status).toBe('sent')
    expect(ses.sent[0]).toMatchObject({ from: '"Kindred" <news@kindred.com>', to: 'reader@x.co', tags: { ee_message: sent.id } })

    const mail = { messageId: sent.messageId!, tags: { ee_message: [sent.id] } }
    // Event times are Amazon's; the queued/sent rows carry the database clock.
    const later = (sec: number) => new Date(Date.now() + sec * 1000).toISOString()
    await platform.applySesEvent({ eventType: 'Delivery', mail, delivery: { timestamp: later(5) } })
    await platform.applySesEvent({ eventType: 'Open', mail, open: { timestamp: later(600) } })
    await platform.applySesEvent({ eventType: 'Open', mail, open: { timestamp: later(660) } })
    // A late Delivery never downgrades.
    await platform.applySesEvent({ eventType: 'Delivery', mail })
    let row = await store.getMessage(sent.id)
    expect(row!.status).toBe('opened')
    const timeline = (await store.events(sent.id)).map((e) => e.status)
    expect(timeline.filter((s) => s === 'opened')).toHaveLength(1)
    expect(timeline.slice(0, 3)).toEqual(['queued', 'sent', 'delivered'])

    await platform.applySesEvent({
      eventType: 'Bounce',
      mail,
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'reader@x.co' }] },
    })
    expect(await store.isSuppressed('READER@x.co')).toBe(true)
    const again = await platform.owlery.send({ to: 'reader@x.co', subject: 'Again', html: 'h', text: 't', source: 'api' })
    expect(again.status).toBe('suppressed')
    expect(ses.sent).toHaveLength(1)

    // Unknown messages (another install on the same topic) are ignored.
    expect(await platform.applySesEvent({ eventType: 'Delivery', mail: { messageId: 'other' } })).toEqual({ applied: false })
    row = await store.getMessage(again.id)
    expect(row!.status).toBe('suppressed')
  })

  it('manual suppression: add and remove (also from Amazon’s list)', async () => {
    await platform.suppress(' Someone@X.co ', 'u1')
    expect((await store.listSuppressions()).map((s) => [s.email, s.reason, s.source])).toEqual([['someone@x.co', 'MANUAL', 'human:u1']])
    await platform.unsuppress('someone@x.co')
    expect(ses.unsuppressed).toEqual(['someone@x.co'])
    expect(await store.listSuppressions()).toEqual([])
    await expect(platform.suppress('nope', 'u1')).rejects.toBeInstanceOf(EmailPlatformError)
  })

  it('scheduled sends run from the job table once due, with retries', async () => {
    const at = new Date(now.getTime() + 3_600_000)
    const out = await platform.owlery.send({ to: 'later@x.co', subject: 'Later', html: 'h', text: 't', source: 'api', scheduledAt: at })
    expect(out.status).toBe('scheduled')
    expect(await platform.runJobs()).toEqual({ done: 0, failed: 0 })
    now = new Date(at.getTime() + 1000)
    ses.failSend = awsError('TooManyRequestsException')
    expect(await platform.runJobs()).toEqual({ done: 0, failed: 1 })
    ses.failSend = null
    now = new Date(now.getTime() + 61_000)
    expect(await platform.runJobs()).toEqual({ done: 1, failed: 0 })
    expect((await store.getMessage(out.id))!.status).toBe('sent')
  })

  it('SNS: only our topic; a confirmation is fetched from SNS and marks events ready', async () => {
    await platform.owlery.setupEvents('https://os.kindred.test')
    const topic = (await platform.owlery.settings())!.eventsTopicArn!
    const base = { MessageId: 'm', Message: 'x', Timestamp: 't', SignatureVersion: '2' as const, Signature: 's', SigningCertURL: 'u' }
    expect((await platform.handleSnsMessage({ ...base, Type: 'Notification', TopicArn: 'arn:other' })).status).toBe(403)
    const ok = await platform.handleSnsMessage({
      ...base,
      Type: 'SubscriptionConfirmation',
      TopicArn: topic,
      SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 't',
    })
    expect(ok).toEqual({ status: 200, body: { ok: true, confirmed: true } })
    expect(fetched).toEqual(['https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription'])
    expect((await platform.owlery.settings())!.eventsStatus).toBe('ready')
    expect((await platform.handleSnsMessage({ ...base, Type: 'Notification', TopicArn: topic, Message: 'not json' })).status).toBe(400)
  })

  it('templates: layout + template render with the brand, send by id through the one path, strict variables', async () => {
    const t = platform.templates
    const layout = await t.createLayout('Brand', 'u1')
    expect(layout.body).toContain('{{ content }}')
    const tpl = await t.createTemplate({ name: 'Welcome', layoutId: layout.id }, 'u1')
    expect(await t.variablesOf(tpl)).toEqual([
      { name: 'firstName', required: false },
      { name: 'link', required: true },
    ])

    const sent = await t.send({ templateId: tpl.id, to: 'new@x.co', variables: { firstName: 'Ada', link: 'https://k.test' }, source: 'api' })
    expect(sent.status).toBe('sent')
    expect(ses.sent[0]).toMatchObject({ subject: 'Welcome, Ada!', to: 'new@x.co' })
    expect(ses.sent[0]!.html).toContain('Kindred')
    const row = await store.getMessage(sent.id)
    expect(row).toMatchObject({ templateId: tpl.id, source: 'api', contentStored: true })

    await expect(t.send({ templateId: tpl.id, to: 'new@x.co', variables: {} })).rejects.toMatchObject({ missing: ['link'] })
    expect(ses.sent).toHaveLength(1)

    // Edits are validated: a layout keeps its slot, a template its layout's format.
    await expect(t.updateLayout(layout.id, { name: 'Brand', format: 'mjml', body: '<mjml></mjml>' })).rejects.toThrow(/content/)
    await expect(
      t.updateTemplate(tpl.id, { name: 'W', subject: 's', format: 'html', body: '<p>x</p>', textBody: null, layoutId: layout.id, sampleVariables: {} }),
    ).rejects.toThrow(/MJML/)
    await expect(t.deleteLayout(layout.id)).rejects.toThrow(/Still used by Welcome/)

    const test = await t.sendTest(tpl.id, 'owner@kindred.test')
    expect(test.status).toBe('sent')
    expect((await store.getMessage(test.id))!.source).toBe('test')
  })
})
