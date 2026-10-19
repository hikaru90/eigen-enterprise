import { describe, expect, it } from 'vitest'
import { MailNotConfiguredError, MailSetupError, SenderNotVerifiedError } from '$lib/server/mail/company-mail'
import { awsError, FakeSes } from './fake-ses'
import { OwleryService } from './service'
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

function setup() {
  const ses = new FakeSes()
  const store = new InMemoryOwleryStore()
  const service = new OwleryService({ store, key: () => key, ses: ses.factory })
  return { ses, store, service }
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

  it('sends from the saved sender with the unsealed credentials', async () => {
    const { ses, service } = await configured()
    const out = await service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't', replyTo: 'r@b.co' })
    expect(out.messageId).toBe('msg-1')
    expect(ses.sent[0]).toEqual({ from: 'hello@kindred.test', to: 'a@b.co', subject: 's', html: 'h', text: 't', replyTo: 'r@b.co' })
    expect(ses.credentials[0]).toEqual({ region: 'eu-central-1', accessKeyId: 'AKIATEST', secretAccessKey: 'super-secret-value' })
  })

  it('send failures surface in plain language', async () => {
    const { ses, service } = await configured()
    ses.failSend = awsError('SendingPausedException')
    await expect(service.send({ to: 'a@b.co', subject: 's', html: 'h', text: 't' })).rejects.toThrow(/paused/)
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
