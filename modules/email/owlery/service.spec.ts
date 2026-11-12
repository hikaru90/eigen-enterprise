import { describe, expect, it } from 'vitest'
import { MailNotConfiguredError, MailSetupError, SenderNotVerifiedError } from '$lib/server/mail/company-mail'
import { InMemoryMailLog } from '../platform/memory-log'
import { awsError, FakeSes, FakeSns } from './fake-ses'
import { eventResourceNames, formatFrom, OwleryService, SEND_SCHEDULED_JOB, WEBMAIL_SANDBOX_MESSAGE } from './service'
import { describeSesError } from './ses'
import { InMemoryOwleryStore, owlerySealKey, sealSecret, unsealSecret } from './store'

const key = owlerySealKey('master-key-for-tests')
const input = {
  region: 'eu-central-1',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'super-secret-value',
  emailFrom: 'hello@kindred.test',
  testRecipient: 'owner@kindred.test',
  updatedBy: 'u1',
}

function setup(now = () => 1_000_000) {
  const ses = new FakeSes()
  const sns = new FakeSns()
  const store = new InMemoryOwleryStore()
  const log = new InMemoryMailLog()
  const service = new OwleryService({ store, key: () => key, ses: ses.factory, sns: sns.factory, log, now })
  return { ses, sns, store, log, service }
}

describe('sealing', () => {
  it('round-trips the secret and never stores it in plain text', () => {
    const sealed = sealSecret('super-secret-value', key)
    expect(sealed).not.toContain('super-secret-value')
    expect(unsealSecret(sealed, key)).toBe('super-secret-value')
  })

  it('cannot be unsealed with a key from another master key', () => {
    const sealed = sealSecret('s', key)
    expect(() => unsealSecret(sealed, owlerySealKey('other'))).toThrow()
  })

  it('refuses an empty master key', () => {
    expect(() => owlerySealKey('  ')).toThrow(/TENANT_MASTER_KEY/)
  })
})

describe('OwleryService.saveVerified', () => {
  it('creates a missing sender identity and asks the owner to verify it (saves nothing)', async () => {
    const { ses, store, service } = setup()
    const err = await service.saveVerified(input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SenderNotVerifiedError)
    expect((err as SenderNotVerifiedError).emailFrom).toBe('hello@kindred.test')
    expect((err as Error).message).toMatch(/hello@kindred\.test/)
    expect(ses.created).toEqual(['hello@kindred.test'])
    expect(ses.sent).toEqual([])
    expect(store.writes).toBe(0)
  })

  it('does not re-create a pending sender identity, still asks to verify', async () => {
    const { ses, store, service } = setup()
    ses.identities.set('hello@kindred.test', { exists: true, verified: false })
    await expect(service.saveVerified(input)).rejects.toBeInstanceOf(SenderNotVerifiedError)
    expect(ses.created).toEqual([])
    expect(store.writes).toBe(0)
  })

  it('accepts a sender whose whole domain is verified', async () => {
    const { ses, store, service } = setup()
    ses.verify('kindred.test')
    await service.saveVerified(input)
    expect(store.writes).toBe(1)
  })

  it('in the sandbox, an unverified test recipient gets a plain sandbox message (saves nothing)', async () => {
    const { ses, store, service } = setup()
    ses.verify('hello@kindred.test')
    ses.sandbox = true
    const err = await service.saveVerified(input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailSetupError)
    expect((err as Error).message).toMatch(/sandbox/)
    expect((err as Error).message).toMatch(/owner@kindred\.test/)
    expect(ses.created).toEqual(['owner@kindred.test'])
    expect(ses.sent).toEqual([])
    expect(store.writes).toBe(0)
  })

  it('in the sandbox, a MessageRejected on send is explained as the sandbox', async () => {
    const { ses, store, service } = setup()
    ses.verify('hello@kindred.test').verify('owner@kindred.test')
    ses.sandbox = true
    ses.failSend = awsError('MessageRejected', 'Email address is not verified.')
    await expect(service.saveVerified(input)).rejects.toThrow(/sandbox/)
    expect(store.writes).toBe(0)
  })

  it('bad keys fail with plain language and save nothing', async () => {
    const { ses, store, service } = setup()
    ses.failAccount = awsError('UnrecognizedClientException', 'The security token included in the request is invalid.')
    await expect(service.saveVerified(input)).rejects.toThrow(/access key ID/)
    expect(store.writes).toBe(0)
  })

  it('validates input before talking to Amazon', async () => {
    const { ses, service } = setup()
    await expect(service.saveVerified({ ...input, region: 'Frankfurt' })).rejects.toThrow(/eu-central-1/)
    await expect(service.saveVerified({ ...input, emailFrom: 'nope' })).rejects.toThrow(/sender/)
    await expect(service.saveVerified({ ...input, secretAccessKey: ' ' })).rejects.toThrow(/secret access key/)
    expect(ses.credentials).toEqual([])
  })

  it('sends a real test email, then saves with the secret sealed', async () => {
    const { ses, store, service } = setup()
    ses.verify('hello@kindred.test')
    expect(await service.isConfigured()).toBe(false)
    await service.saveVerified({ ...input, accessKeyId: ' AKIATEST ' })
    expect(ses.sent).toHaveLength(1)
    expect(ses.sent[0]).toMatchObject({ from: 'hello@kindred.test', to: 'owner@kindred.test' })
    expect(store.row).toMatchObject({ region: 'eu-central-1', accessKeyId: 'AKIATEST', emailFrom: 'hello@kindred.test', updatedBy: 'u1' })
    expect(store.row!.sealedSecretAccessKey).not.toContain('super-secret-value')
    expect(unsealSecret(store.row!.sealedSecretAccessKey, key)).toBe('super-secret-value')
    expect(await service.isConfigured()).toBe(true)
  })

  it('a failed test email saves nothing', async () => {
    const { ses, store, service } = setup()
    ses.verify('hello@kindred.test')
    ses.failSend = awsError('AccessDeniedException')
    await expect(service.saveVerified(input)).rejects.toThrow(/not allowed to use Amazon SES/)
    expect(store.writes).toBe(0)
  })
})

describe('OwleryService.send / status', () => {
  async function configured() {
    const s = setup()
    s.ses.verify('hello@kindred.test')
    await s.service.saveVerified(input)
    s.ses.sent.length = 0
    s.ses.credentials.length = 0
    return s
  }

  it('fails loud when email is not set up', async () => {
    const { service } = setup()
    await expect(service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't' })).rejects.toBeInstanceOf(
      MailNotConfiguredError,
    )
    expect(await service.status()).toEqual({ configured: false })
  })

  it('sends from the saved sender with the unsealed credentials, tagged with its log id', async () => {
    const { ses, log, service } = await configured()
    const out = await service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't', replyTo: 'r@b.co' })
    expect(out).toEqual({ id: 'log-1', status: 'sent', messageId: 'msg-1' })
    expect(ses.sent[0]).toEqual({
      from: 'hello@kindred.test',
      to: 'a@b.co',
      subject: 's',
      html: 'h',
      text: 't',
      replyTo: 'r@b.co',
      tags: { ee_message: 'log-1' },
    })
    expect(ses.credentials[0]).toEqual({ region: 'eu-central-1', accessKeyId: 'AKIATEST', secretAccessKey: 'super-secret-value' })
    expect(log.messages[0]).toMatchObject({ status: 'sent', sesMessageId: 'msg-1', source: 'system', toAddress: 'a@b.co' })
    expect(log.events.map((e) => e.status)).toEqual(['queued', 'sent'])
  })

  it('system mail never keeps its body in the log; other sources do', async () => {
    const { log, service } = await configured()
    await service.send({ to: 'a@b.co', subject: 'Your code: 123456', html: '<p>123456</p>', text: '123456' })
    await service.send({ to: 'a@b.co', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', source: 'agent' })
    expect(log.messages[0]).toMatchObject({ contentStored: false, html: null, text: null })
    expect(log.messages[1]).toMatchObject({ contentStored: true, html: '<p>Hi</p>', text: 'Hi', source: 'agent' })
  })

  it('send failures surface in plain language and are logged as failed', async () => {
    const { ses, log, service } = await configured()
    ses.failSend = awsError('SendingPausedException')
    await expect(service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't' })).rejects.toThrow(/paused/)
    expect(log.messages[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/paused/) })
    expect(log.events.map((e) => e.status)).toEqual(['queued', 'failed'])
  })

  it('a suppressed recipient is logged as suppressed and never reaches Amazon', async () => {
    const { ses, log, service } = await configured()
    log.suppressed.add('gone@b.co')
    const out = await service.send({ to: 'Gone@B.co', subject: 's', html: 'h', text: 't', source: 'api' })
    expect(out).toEqual({ id: 'log-1', status: 'suppressed', messageId: null })
    expect(ses.sent).toEqual([])
    expect(log.events.map((e) => e.status)).toEqual(['suppressed'])
  })

  it('refuses a From that is not a verified sender; uses the display name of one that is', async () => {
    const { ses, log, service } = await configured()
    await expect(service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't', from: 'x@other.test' })).rejects.toThrow(
      /not one of your senders/,
    )
    expect(log.messages).toEqual([])
    log.senders.set('news@kindred.test', { ok: true, displayName: 'Kindred "News"', tracking: true })
    await service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't', from: 'News@Kindred.test' })
    expect(ses.sent[0]!.from).toBe('"Kindred \\"News\\"" <news@kindred.test>')
    expect(log.messages[0]!.fromAddress).toBe('news@kindred.test')
  })

  it('uses the tracking configuration set for a tracking domain once events are wired', async () => {
    const { ses, log, service } = await configured()
    await service.setupEvents('https://os.kindred.test')
    log.senders.set('news@kindred.test', { ok: true, displayName: null, tracking: true })
    await service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't', from: 'news@kindred.test' })
    await service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't' })
    expect(ses.sent[0]!.configurationSet).toBe('ee-os-kindred-test-tracking')
    expect(ses.sent[1]!.configurationSet).toBe('ee-os-kindred-test')
  })

  it('a future scheduledAt holds the mail as scheduled with a job; sendScheduled sends it later', async () => {
    let now = 1_000_000
    const s = setup(() => now)
    s.ses.verify('hello@kindred.test')
    await s.service.saveVerified(input)
    s.ses.sent.length = 0
    const at = new Date(now + 3_600_000)
    const out = await s.service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't', scheduledAt: at })
    expect(out.status).toBe('scheduled')
    expect(s.ses.sent).toEqual([])
    expect(s.log.jobs).toEqual([{ kind: SEND_SCHEDULED_JOB, payload: { messageId: out.id }, runAt: at, dedupeKey: `send:${out.id}` }])
    expect(s.log.messages[0]).toMatchObject({ status: 'scheduled', html: 'h', contentStored: true })
    now += 3_600_000
    await s.service.sendScheduled(out.id)
    expect(s.ses.sent).toHaveLength(1)
    expect(s.log.messages[0]).toMatchObject({ status: 'sent' })
    // A second run (job retried) does not send twice.
    await s.service.sendScheduled(out.id)
    expect(s.ses.sent).toHaveLength(1)
  })
})

describe('OwleryService.sendMailboxMail (webmail, S5)', () => {
  async function configured() {
    const s = setup()
    s.ses.verify('hello@kindred.test')
    await s.service.saveVerified(input)
    s.ses.sent.length = 0
    s.log.senders.set('ana.lind@kindred.test', { ok: true, displayName: null, tracking: true })
    return s
  }
  const raw = new TextEncoder().encode('From: ana.lind@kindred.test\r\nSubject: Hi\r\n\r\nHello\r\n')
  const recipients = { to: ['a@b.co'], cc: ['c@b.co'], bcc: ['secret@b.co'] }

  it('sends the raw mail with the whole envelope, tagged as webmail — and writes nothing to the sent-mail log', async () => {
    const { ses, log, service } = await configured()
    await service.setupEvents('https://os.kindred.test')
    const out = await service.sendMailboxMail({ fromAddress: 'Ana.Lind@kindred.test', recipients, raw })
    expect(out).toEqual({ sesMessageId: 'raw-1' })
    expect(ses.rawSent).toEqual([
      { from: 'ana.lind@kindred.test', recipients, raw, configurationSet: 'ee-os-kindred-test', tags: { ee_webmail: '1' } },
    ])
    expect(ses.sent).toEqual([])
    expect(log.messages).toEqual([])
    expect(log.events).toEqual([])
  })

  it('never uses the tracking configuration set (no opens or clicks on personal mail)', async () => {
    const { ses, service } = await configured()
    await service.setupEvents('https://os.kindred.test')
    await service.sendMailboxMail({ fromAddress: 'ana.lind@kindred.test', recipients, raw })
    expect(ses.rawSent[0]!.configurationSet).toBe('ee-os-kindred-test')
  })

  it('refuses the whole mail when any recipient is suppressed, naming it, and sends nothing', async () => {
    const { ses, log, service } = await configured()
    log.suppressed.add('secret@b.co')
    await expect(service.sendMailboxMail({ fromAddress: 'ana.lind@kindred.test', recipients, raw })).rejects.toThrow(
      /secret@b\.co is on the company’s suppression list/,
    )
    expect(ses.rawSent).toEqual([])
    expect(log.messages).toEqual([])
  })

  it('refuses a mailbox whose domain is not verified, in plain words', async () => {
    const { ses, service } = await configured()
    await expect(service.sendMailboxMail({ fromAddress: 'x@pending.test', recipients, raw })).rejects.toThrow(
      'Mail can’t go out from x@pending.test yet: its domain pending.test isn’t verified at Amazon SES. The owner or an admin finishes its DNS records under Email › Domains.',
    )
    expect(ses.rawSent).toEqual([])
  })

  it('explains a rejection in the sandbox as the sandbox; other rejections in Amazon’s words', async () => {
    const { ses, service } = await configured()
    ses.failSend = awsError('MessageRejected', 'Email address is not verified.')
    ses.sandbox = true
    await expect(service.sendMailboxMail({ fromAddress: 'ana.lind@kindred.test', recipients, raw })).rejects.toThrow(WEBMAIL_SANDBOX_MESSAGE)
    ses.sandbox = false
    await expect(service.sendMailboxMail({ fromAddress: 'ana.lind@kindred.test', recipients, raw })).rejects.toThrow(
      'Amazon refused the email: Email address is not verified.',
    )
  })

  it('fails loud before setup', async () => {
    const { service } = setup()
    await expect(service.sendMailboxMail({ fromAddress: 'ana.lind@kindred.test', recipients, raw })).rejects.toBeInstanceOf(MailNotConfiguredError)
  })
})

describe('OwleryService.setupEvents', () => {
  async function configured() {
    const s = setup()
    s.ses.verify('hello@kindred.test')
    await s.service.saveVerified(input)
    return s
  }

  it('creates the topic, both configuration sets and the https subscription; waits for SNS to confirm', async () => {
    const { ses, sns, store, service } = await configured()
    const out = await service.setupEvents('https://os.kindred.test/')
    expect(out).toMatchObject({ eventsStatus: 'waiting', eventsError: null, configSet: 'ee-os-kindred-test' })
    expect(sns.topics).toEqual(['arn:aws:sns:eu-central-1:000000000000:ee-os-kindred-test-mail-events'])
    expect(sns.subscriptions).toEqual([
      { topicArn: sns.topics[0], endpoint: 'https://os.kindred.test/api/mail/ses-events' },
    ])
    expect(ses.eventDestinations.map((d) => [d.configurationSet, d.events.includes('OPEN')])).toEqual([
      ['ee-os-kindred-test', false],
      ['ee-os-kindred-test-tracking', true],
    ])
    expect(store.row).toMatchObject({ eventsStatus: 'waiting', eventsTopicArn: sns.topics[0] })
  })

  it('an already confirmed subscription is ready at once', async () => {
    const { sns, service } = await configured()
    sns.confirmImmediately = true
    expect((await service.setupEvents('https://os.kindred.test')).eventsStatus).toBe('ready')
  })

  it('stores a plain failure instead of throwing', async () => {
    const { sns, store, service } = await configured()
    sns.failSubscribe = awsError('AuthorizationErrorException')
    const out = await service.setupEvents('https://os.kindred.test')
    expect(out).toMatchObject({ eventsStatus: 'failed', configSet: null, eventsError: expect.stringMatching(/AmazonSNSFullAccess/) })
    expect(store.row).toMatchObject({ eventsStatus: 'failed' })
  })

  it('names resources after the host', () => {
    expect(eventResourceNames('https://os.kindred.co.uk:8443')).toEqual({
      topic: 'ee-os-kindred-co-uk-mail-events',
      configSet: 'ee-os-kindred-co-uk',
      trackingConfigSet: 'ee-os-kindred-co-uk-tracking',
    })
    expect(formatFrom('a@b.co', '  ')).toBe('a@b.co')
  })

  it('status reports region, sender, verification and sandbox', async () => {
    const { ses, service } = await configured()
    ses.sandbox = true
    expect(await service.status()).toEqual({
      configured: true,
      region: 'eu-central-1',
      sender: 'hello@kindred.test',
      senderVerified: true,
      sandbox: true,
    })
  })
})

describe('describeSesError', () => {
  it('never mentions env vars and explains unknown errors', () => {
    expect(describeSesError(awsError('SignatureDoesNotMatch'))).toMatch(/secret access key/)
    expect(describeSesError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toMatch(/region/)
    expect(describeSesError(new Error('boom'))).toMatch(/boom/)
  })
})
