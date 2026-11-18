import { describe, expect, it } from 'vitest'
import { MailSetupError } from '$lib/server/mail/company-mail'
import type { ManagedMailConfig } from '$lib/server/mail/managed-config'
import { InMemoryMailLog } from '../platform/memory-log'
import { awsError, FakeSes, FakeSns } from './fake-ses'
import { MANAGED } from './managed-fixtures'
import { MANAGED_NO_SENDER_MESSAGE, MANAGED_PAUSED_MESSAGE, OwleryService } from './service'
import { InMemoryOwleryStore, owlerySealKey } from './store'

const key = owlerySealKey('master-key-for-tests')


/** Calls that provision or read the account: never made in managed mode (D3, D4, D8). */
const PROVISIONING = ['createIdentity', 'createDomainIdentity', 'deleteIdentity', 'ensureEventDestination', 'isSandbox']

function setup(managed: ManagedMailConfig | null = MANAGED) {
  const ses = new FakeSes()
  const sns = new FakeSns()
  const store = new InMemoryOwleryStore()
  const log = new InMemoryMailLog()
  const service = new OwleryService({ store, key: () => key, ses: ses.factory, sns: sns.factory, log, managed: () => managed })
  return { ses, sns, store, log, service }
}

describe('OwleryService in managed mode (eigenEnterprise Mail)', () => {
  it('without managed config and own keys: not configured, no mode', async () => {
    const { service } = setup(null)
    expect(await service.settings()).toBeNull()
    expect(await service.mode()).toBeNull()
  })

  it('synthesizes settings from the env config: region, key, config sets, topic, events ready, tenant', async () => {
    const { service } = setup()
    const s = (await service.settings())!
    expect(s).toMatchObject({
      mode: 'managed',
      tenant: 'ee-box1',
      region: 'eu-central-1',
      accessKeyId: 'AKIAMANAGED',
      secretAccessKey: 'managed-secret',
      configSet: 'ee-box1',
      trackingConfigSet: 'ee-box1-tracking',
      eventsTopicArn: MANAGED.eventsTopicArn,
      eventsStatus: 'ready',
      emailFrom: '',
    })
    expect(await service.managedConfig()).toEqual(MANAGED)
  })

  it('is not configured for sending until a default sender exists (sign-in codes need one)', async () => {
    const { service, log } = setup()
    expect(await service.isConfigured()).toBe(false)
    await expect(service.send({ to: 'x@y.test', subject: 's', html: 'h', text: 't' })).rejects.toThrow(MANAGED_NO_SENDER_MESSAGE)
    expect(log.messages).toEqual([])
    await service.setDefaultSender('Hello@Kindred.test', 'u1')
    expect(await service.isConfigured()).toBe(true)
    expect((await service.settings())!.emailFrom).toBe('hello@kindred.test')
  })

  it('own SES keys saved take precedence (D1)', async () => {
    const { service, ses } = setup()
    ses.verify('own@kindred.test')
    await service.saveVerified({
      region: 'us-east-1',
      accessKeyId: 'AKIAOWN',
      secretAccessKey: 'own',
      emailFrom: 'own@kindred.test',
      testRecipient: 'o@kindred.test',
      updatedBy: 'u1',
    })
    const s = (await service.settings())!
    expect(s).toMatchObject({ mode: 'own', tenant: null, region: 'us-east-1', accessKeyId: 'AKIAOWN' })
    expect(await service.managedConfig()).toBeNull()
  })

  it('every send carries the tenant and the config set; nothing is provisioned', async () => {
    const { service, ses, log } = setup()
    await service.setDefaultSender('hello@kindred.test', 'u1')
    log.senders.set('hello@kindred.test', { ok: true, displayName: null, tracking: false })
    await service.send({ to: 'x@y.test', subject: 's', html: 'h', text: 't' })
    expect(ses.sent[0]).toMatchObject({ tenantName: 'ee-box1', configurationSet: 'ee-box1', from: 'hello@kindred.test' })
    await service.sendMailboxMail({
      fromAddress: 'hello@kindred.test',
      recipients: { to: ['x@y.test'], cc: [], bcc: [] },
      raw: new Uint8Array([1]),
    })
    expect(ses.rawSent[0]).toMatchObject({ tenantName: 'ee-box1', configurationSet: 'ee-box1' })
    expect(ses.credentials.every((c) => c.accessKeyId === 'AKIAMANAGED')).toBe(true)
    expect(ses.calls.filter((c) => PROVISIONING.includes(c))).toEqual([])
  })

  it('refuses the default-sender shortcut: a managed sender must pass the sender check', async () => {
    const { service, ses } = setup()
    await service.setDefaultSender('hello@kindred.test', 'u1')
    await expect(service.send({ to: 'x@y.test', subject: 's', html: 'h', text: 't' })).rejects.toThrow(/not one of your senders/)
    expect(ses.sent).toEqual([])
  })

  it('a paused tenant gives the D8 message as the send error (no sandbox lookup)', async () => {
    const { service, ses, log } = setup()
    await service.setDefaultSender('hello@kindred.test', 'u1')
    log.senders.set('hello@kindred.test', { ok: true, displayName: null, tracking: false })
    ses.tenantStatus.set('ee-box1', 'DISABLED')
    ses.failSend = awsError('SendingPausedException')
    await expect(service.send({ to: 'x@y.test', subject: 's', html: 'h', text: 't' })).rejects.toThrow(MANAGED_PAUSED_MESSAGE)
    expect(log.messages[0]).toMatchObject({ status: 'failed', error: MANAGED_PAUSED_MESSAGE })
    ses.failSend = awsError('MessageRejected', 'nope')
    const err = await service
      .sendMailboxMail({ fromAddress: 'hello@kindred.test', recipients: { to: ['x@y.test'], cc: [], bcc: [] }, raw: new Uint8Array([1]) })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailSetupError)
    expect((err as Error).message).toBe(MANAGED_PAUSED_MESSAGE)
    expect(ses.calls).not.toContain('isSandbox')
  })

  it('status: managed, no sandbox, the pause from GetTenant, the sender checked by its domain only', async () => {
    const { service, ses } = setup()
    await service.setDefaultSender('hello@kindred.test', 'u1')
    ses.verify('kindred.test')
    expect(await service.status()).toEqual({
      configured: true,
      region: 'eu-central-1',
      sender: 'hello@kindred.test',
      senderVerified: true,
      sandbox: false,
      managed: true,
      paused: false,
    })
    ses.tenantStatus.set('ee-box1', 'DISABLED')
    expect(await service.tenantPaused()).toBe(true)
    expect(ses.calls).not.toContain('isSandbox')
  })

  it('does not set up events and stores nothing on an SNS confirmation', async () => {
    const { service, store } = setup()
    await expect(service.setupEvents('https://os.example')).rejects.toThrow(/eigenEnterprise Mail/)
    await service.markEvents({ eventsStatus: 'failed' })
    expect(store.row).toBeNull()
    expect((await service.settings())!.eventsStatus).toBe('ready')
  })
})
