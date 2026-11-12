import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbInboxStore } from '../inbox/db-store'
import { receivingRecipients } from '../inbox/receiving-addresses'
import { INBOUND_RULE_SET } from '../inbox/receiving-contract'
import { FakeInboundBucket, FakeSesReceiving } from '../owlery/fake-receiving'
import { awsError, FakeSes, FakeSns } from '../owlery/fake-ses'
import { ReceivingService } from '../owlery/receiving'
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
  let mx: Record<string, Array<{ exchange: string; priority: number }>> = {}
  let rules: FakeSesReceiving
  let fetched: string[] = []

  beforeAll(async () => {
    const { createScopedDrizzle, appSql } = await import('$lib/server/db')
    db = createScopedDrizzle(appSql)
  })

  async function wipe() {
    await db.execute('DELETE FROM mail_flow_log' as never)
    await db.execute('DELETE FROM mail_flow_enrollments' as never)
    await db.execute('DELETE FROM mail_flows' as never)
    await db.execute('DELETE FROM mail_contacts' as never)
    await db.execute('DELETE FROM mail_contact_lists' as never)
    await new EmailStore(db).clearAll()
  }

  beforeEach(async () => {
    await wipe()
    now = new Date('2026-11-04T12:00:00Z')
    ses = new FakeSes()
    ses.verify('hello@kindred.test')
    const sns = new FakeSns()
    store = new EmailStore(db)
    const owlerySettingsStore = new InMemoryOwleryStore()
    const owlery = new OwleryService({
      store: owlerySettingsStore,
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
    mx = {}
    fetched = []
    rules = new FakeSesReceiving()
    platform = new EmailPlatform({
      owlery,
      store,
      resolveMx: async (name) => {
        const found = mx[name]
        if (!found) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
        return found
      },
      receiving: new ReceivingService({
        store: owlerySettingsStore,
        credentials: () => owlery.settings(),
        ses: rules.factory,
        bucket: new FakeInboundBucket().factory,
        sns: sns.factory,
      }),
      receivingRecipients: (domainIds) => receivingRecipients(dbInboxStore(db), domainIds),
      resolveTxt: async (name) => {
        if (name !== '_dmarc.kindred.com' || dmarc.length === 0) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
        return dmarc
      },
      fetch: (async (url: string) => {
        fetched.push(url)
        return new Response('ok')
      }) as unknown as typeof fetch,
      brand: async () => emailBrandFromCssVars(null, 'Kindred'),
      db,
      origin: () => 'https://os.kindred.test',
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

  it('receiving: warns with the current MX, provisions on the first domain, follows mailboxes, and switches off', async () => {
    const d = await platform.addDomain('kindred.com', 'u1')
    await expect(platform.setDomainReceiving(d.id, true, 'https://os.kindred.test')).rejects.toThrow(/not verified yet/)
    ses.verify('kindred.com')
    await platform.refreshDomain(d.id)

    mx['kindred.com'] = [
      { exchange: 'alt1.aspmx.l.google.com', priority: 5 },
      { exchange: 'aspmx.l.google.com', priority: 1 },
    ]
    expect((await platform.currentMx(d.id)).map((r) => r.exchange)).toEqual(['aspmx.l.google.com', 'alt1.aspmx.l.google.com'])
    expect((await platform.getDomain(d.id))!.records.some((r) => r.purpose === 'inbound_mx')).toBe(false)

    const inbox = dbInboxStore(db)
    const mailboxId = randomUUID()
    const at = new Date()
    await inbox.insertMailbox(
      { id: mailboxId, kind: 'shared', ownerUserId: null, groupId: 'g-1', displayName: null, disabledAt: null, createdBy: 'u1', createdAt: at, updatedAt: at },
      { address: 'info@kindred.com', mailboxId, domainId: d.id, primary: true, createdBy: 'u1', createdAt: at },
    )
    try {
      const on = await platform.setDomainReceiving(d.id, true, 'https://os.kindred.test')
      expect(on.receivingError).toBeNull()
      expect(on.domain.receiving).toBe(true)
      expect(on.domain.records.find((r) => r.purpose === 'inbound_mx')).toMatchObject({
        value: 'inbound-smtp.eu-central-1.amazonaws.com',
        status: 'PENDING',
      })
      expect(await platform.receivingState()).toMatchObject({ receivingStatus: 'waiting', receivingRuleSet: INBOUND_RULE_SET })
      expect(rules.ruleSets.get(INBOUND_RULE_SET)!.map((r) => r.recipients)).toEqual([['info@kindred.com']])

      // The owner switched MX: the record is seen.
      mx['kindred.com'] = [{ exchange: 'inbound-smtp.eu-central-1.amazonaws.com', priority: 10 }]
      expect((await platform.getDomain(d.id))!.records.find((r) => r.purpose === 'inbound_mx')!.status).toBe('SUCCESS')

      // A new alias joins the rules on the next sync.
      await inbox.insertAddress({ address: 'hello@kindred.com', mailboxId, domainId: d.id, primary: false, createdBy: 'u1', createdAt: at })
      expect(await platform.syncReceiving()).toBeNull()
      expect(rules.ruleSets.get(INBOUND_RULE_SET)!.map((r) => r.recipients)).toEqual([['hello@kindred.com', 'info@kindred.com']])

      // A domain with mailboxes cannot be removed (and Amazon is not touched).
      await expect(platform.deleteDomain(d.id)).rejects.toThrow('1 mailbox still uses kindred.com — remove or move it first')
      expect(ses.deleted).toEqual([])

      const off = await platform.setDomainReceiving(d.id, false, 'https://os.kindred.test')
      expect(off.receivingError).toBeNull()
      expect(off.domain.records.some((r) => r.purpose === 'inbound_mx')).toBe(false)
      expect(rules.ruleSets.get(INBOUND_RULE_SET)).toEqual([])
    } finally {
      await db.execute(`DELETE FROM mailboxes WHERE id = '${mailboxId}'` as never)
    }
  })

  it('receiving: a sync failure is returned in plain words and kept on the receiving state', async () => {
    const d = await platform.addDomain('kindred.com', 'u1')
    ses.verify('kindred.com')
    await platform.refreshDomain(d.id)
    rules.failures.set('activeRuleSet', awsError('AccessDenied'))
    const out = await platform.setDomainReceiving(d.id, true, 'https://os.kindred.test')
    expect(out.domain.receiving).toBe(true)
    expect(out.receivingError).toMatch(/receipt rules/)
    expect(await platform.receivingState()).toMatchObject({ receivingStatus: 'failed', receivingError: out.receivingError })
  })

  it('lists messages in, or outside, a set of statuses (the Mail view: pending apart from sent)', async () => {
    const base = { source: 'api' as const, fromAddress: 'hello@kindred.test', subject: 's', html: null, text: 'x', contentStored: true }
    for (const status of ['scheduled', 'queued', 'delivered', 'bounced'] as const) {
      await store.insertMessage({ ...base, status, toAddress: `${status}@x.co` })
    }
    const pending = await store.listMessages({ statuses: ['scheduled', 'queued'], limit: 10 })
    expect(pending.map((m) => m.status).sort()).toEqual(['queued', 'scheduled'])
    const sent = await store.listMessages({ excludeStatuses: ['scheduled', 'queued'], limit: 10 })
    expect(sent.map((m) => m.status).sort()).toEqual(['bounced', 'delivered'])
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

  it('webmail (S5): sends without a log row; its bounces and complaints still suppress, its other events change nothing', async () => {
    const d = await platform.addDomain('kindred.com', 'u1')
    ses.verify('kindred.com')
    await platform.refreshDomain(d.id)
    const raw = new TextEncoder().encode('From: ana@kindred.com\r\nSubject: Private\r\n\r\nBody\r\n')
    const { sesMessageId } = await platform.owlery.sendMailboxMail({
      fromAddress: 'ana@kindred.com',
      recipients: { to: ['friend@x.co'], cc: [], bcc: ['other@x.co'] },
      raw,
    })
    expect(ses.rawSent).toHaveLength(1)
    expect(await store.listMessages({ limit: 50 })).toHaveLength(0)

    const mail = { messageId: sesMessageId, tags: { ee_webmail: ['1'] } }
    expect(await platform.applySesEvent({ eventType: 'Delivery', mail })).toEqual({ applied: true })
    await platform.applySesEvent({ eventType: 'Bounce', mail, bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'friend@x.co' }] } })
    await platform.applySesEvent({ eventType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: 'other@x.co' }] } })
    expect((await store.listSuppressions()).map((s) => [s.email, s.reason, s.source]).sort()).toEqual([
      ['friend@x.co', 'HARD_BOUNCE', 'webmail'],
      ['other@x.co', 'COMPLAINT', 'webmail'],
    ])
    expect(await store.listMessages({ limit: 50 })).toHaveLength(0)
    // The next webmail send to a suppressed address is refused whole.
    await expect(
      platform.owlery.sendMailboxMail({ fromAddress: 'ana@kindred.com', recipients: { to: ['friend@x.co'], cc: [], bcc: [] }, raw }),
    ).rejects.toThrow(/friend@x\.co is on the company’s suppression list/)
    expect(ses.rawSent).toHaveLength(1)
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

  it('contacts + flows: double opt-in, enrollment, send with one-click unsubscribe, wait, bounce unsubscribes', async () => {
    const a = platform.audience
    const t = platform.templates
    const tpl = await t.createTemplate({ name: 'Hello', layoutId: null }, 'u1')
    await t.updateTemplate(tpl.id, {
      name: 'Hello',
      subject: 'Hi {{ firstName | "there" }}',
      format: 'html',
      body: '<p>Hi {{ firstName | "there" }}</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
      textBody: null,
      layoutId: null,
      sampleVariables: {},
    })
    const list = await a.createList({ name: 'Newsletter', doubleOptIn: true }, 'u1')
    const flow = await a.createFlow({ name: 'Welcome', triggerListId: list.id }, 'u1')
    await expect(a.setFlowStatus(flow.id, 'active')).rejects.toThrow(/at least one step/)
    await a.updateFlow(flow.id, {
      name: 'Welcome',
      triggerListId: list.id,
      steps: [
        { id: 's1', type: 'send', templateId: tpl.id },
        { id: 'w1', type: 'wait', amount: 1, unit: 'days' },
        { id: 's2', type: 'send', templateId: tpl.id },
      ],
    })
    await a.setFlowStatus(flow.id, 'active')

    // Double opt-in: pending + confirmation mail; no flow yet.
    const { contact } = await a.addContact(list.id, { email: 'Reader@X.co', firstName: 'Ada' })
    expect(contact).toMatchObject({ email: 'reader@x.co', status: 'pending' })
    expect(ses.sent.at(-1)!.text).toContain(`https://os.kindred.test/mail/confirm/${contact.token}`)
    expect(await a.enrollments(flow.id)).toEqual([])

    // Confirm → subscribed → enrolled; the job sends step 1 and starts the wait.
    expect((await a.confirm(contact.token))!.status).toBe('subscribed')
    expect(await platform.runJobs()).toEqual({ done: 1, failed: 0 })
    const welcome = ses.sent.at(-1)!
    expect(welcome).toMatchObject({ to: 'reader@x.co', subject: 'Hi Ada' })
    expect(welcome.html).toContain(`https://os.kindred.test/mail/unsubscribe/${contact.token}`)
    expect(welcome.headers).toEqual([
      { name: 'List-Unsubscribe', value: `<https://os.kindred.test/api/mail/unsubscribe/${contact.token}>` },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ])
    let [e] = await a.enrollments(flow.id)
    expect(e).toMatchObject({ status: 'active', stepIndex: 1 })
    expect(e!.waitUntil).not.toBeNull()

    // A day later the wait is over: step 2 is sent and the run completes.
    now = new Date(now.getTime() + 86_400_000 + 1000)
    expect(await platform.runJobs()).toEqual({ done: 1, failed: 0 })
    ;[e] = await a.enrollments(flow.id)
    expect(e).toMatchObject({ status: 'completed', stepIndex: 3 })
    expect((await a.flowLog(flow.id)).map((l) => l.event).reverse()).toEqual(['entered', 'email_sent', 'waiting', 'email_sent', 'completed'])

    // Re-adding the address neither duplicates nor re-enrolls.
    expect((await a.addContact(list.id, { email: 'reader@x.co' })).created).toBe(false)

    // A hard bounce unsubscribes the address everywhere; unsubscribe is idempotent.
    const other = await a.createList({ name: 'Customers', doubleOptIn: false }, 'u1')
    const { contact: c2 } = await a.addContact(other.id, { email: 'reader@x.co' })
    expect(c2.status).toBe('subscribed')
    await platform.applySesEvent({
      eventType: 'Bounce',
      mail: { messageId: 'ses-bounced', tags: { ee_message: [(await store.listMessages({ limit: 1 }))[0]!.id] } },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'reader@x.co' }] },
    })
    expect((await a.getContact(c2.id))!).toMatchObject({ status: 'unsubscribed', unsubscribeReason: 'BOUNCED' })
    expect((await a.unsubscribe(contact.token))!.status).toBe('unsubscribed')
    expect(await a.unsubscribe('nope')).toBeNull()

    const imported = await a.importContacts(other.id, 'email,first\nnew@x.co,Grace\nbroken\n')
    expect(imported).toEqual({ added: 1, updated: 0, invalid: ['broken'] })
  })
})
