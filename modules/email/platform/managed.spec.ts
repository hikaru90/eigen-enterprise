import { describe, expect, it } from 'vitest'
import { InMemoryMailLog } from './memory-log'
import { FakeSes, FakeSns } from '../owlery/fake-ses'
import { MANAGED } from '../owlery/managed-fixtures'
import { OwleryService } from '../owlery/service'
import { InMemoryOwleryStore, owlerySealKey } from '../owlery/store'
import { EmailPlatform, EmailPlatformError, MANAGED_DOMAIN_PENDING_MESSAGE } from './service'
import type { DomainRow, EmailStore } from './store'

/** Just the domain/sender/suppression slice of EmailStore the managed paths touch. */
function memoryStore() {
  const domains = new Map<string, DomainRow>()
  const senders: { address: string; domainId: string | null }[] = []
  const removed: string[] = []
  let seq = 0
  const store = {
    listDomains: async () => [...domains.values()],
    getDomain: async (id: string) => domains.get(id) ?? null,
    getDomainByName: async (name: string) => [...domains.values()].find((d) => d.name === name) ?? null,
    insertDomain: async (v: Partial<DomainRow>) => {
      const row = {
        id: `d-${++seq}`, status: 'NOT_STARTED', publicKey: null, dkimTokens: null, mailFromDomain: null, adopted: false,
        dkimStatus: 'NOT_STARTED', mailFromStatus: 'NOT_STARTED', dmarcAdded: false, tracking: false, receiving: false,
        errorMessage: null, isVerifying: true, lastCheckedAt: null, createdAt: new Date(), updatedAt: new Date(), ...v,
      } as DomainRow
      domains.set(row.id, row)
      return row
    },
    updateDomain: async (id: string, patch: Partial<DomainRow>) => {
      const row = { ...domains.get(id)!, ...patch }
      domains.set(id, row)
      return row
    },
    deleteDomain: async (id: string) => void domains.delete(id),
    mailboxesOnDomain: async () => 0,
    upsertSender: async (v: { address: string; domainId: string | null }) => (senders.push(v), v),
    removeSuppression: async (e: string) => (removed.push(e), true),
  }
  return { store: store as unknown as EmailStore, domains, senders, removed }
}

function setup() {
  const ses = new FakeSes()
  const owlery = new OwleryService({
    store: new InMemoryOwleryStore(),
    key: () => owlerySealKey('k'),
    ses: ses.factory,
    sns: new FakeSns().factory,
    log: new InMemoryMailLog(),
    managed: () => MANAGED,
  })
  const m = memoryStore()
  const fetched: string[] = []
  const platform = new EmailPlatform({
    owlery,
    store: m.store,
    resolveTxt: async () => [],
    resolveMx: async () => [],
    receiving: { state: async () => { throw new Error('managed mode never reads receiving state') } } as never,
    receivingRecipients: async () => [],
    fetch: (async (url: string) => (fetched.push(url), new Response('ok'))) as never,
    brand: async () => ({}) as never,
    db: async () => ({}) as never,
    origin: () => 'https://os.example',
  })
  return { ses, owlery, platform, fetched, ...m }
}

const PROVISIONING = ['createIdentity', 'createDomainIdentity', 'deleteIdentity', 'ensureEventDestination', 'isSandbox']

describe('EmailPlatform domains in managed mode', () => {
  it('adds the row without key or SES call; pending until SES knows it; then Easy DKIM CNAMEs', async () => {
    const { platform, ses } = setup()
    const d = await platform.addDomain('kindred.test', 'u1')
    expect(d).toMatchObject({ publicKey: null, errorMessage: MANAGED_DOMAIN_PENDING_MESSAGE, sendable: false })
    expect(ses.calls).toEqual([])
    expect((await platform.refreshDomain(d.id)).errorMessage).toBe(MANAGED_DOMAIN_PENDING_MESSAGE)
    ses.existingDomain('kindred.test', { dkimTokens: ['a1', 'b2', 'c3'] })
    const ready = await platform.refreshDomain(d.id)
    expect(ready.status).toBe('SUCCESS')
    expect(ready.records.filter((r) => r.purpose === 'dkim').map((r) => r.value)).toEqual([
      'a1.dkim.amazonses.com', 'b2.dkim.amazonses.com', 'c3.dkim.amazonses.com',
    ])
    expect(ses.calls.filter((c) => PROVISIONING.includes(c))).toEqual([])
  })

  it('receiving only sets the flag (MX shows); delete only removes the row', async () => {
    const { platform, ses, domains } = setup()
    ses.existingDomain('kindred.test')
    const d = await platform.addDomain('kindred.test', 'u1')
    await platform.refreshDomain(d.id)
    const out = await platform.setDomainReceiving(d.id, true, 'https://os.example')
    expect(out.receivingError).toBeNull()
    expect(out.domain.records.some((r) => r.purpose === 'inbound_mx')).toBe(true)
    expect(await platform.syncReceiving()).toBeNull()
    await platform.deleteDomain(d.id)
    expect(domains.size).toBe(0)
    expect(ses.calls.filter((c) => PROVISIONING.includes(c))).toEqual([])
  })

  it('senders: the first on a company domain becomes the default; another domain is refused (D8)', async () => {
    const { platform, owlery, ses } = setup()
    ses.existingDomain('kindred.test')
    const d = await platform.addDomain('kindred.test', 'u1')
    await platform.refreshDomain(d.id)
    await platform.addSender({ address: 'hello@kindred.test', displayName: null }, 'u1')
    expect((await owlery.settings())!.emailFrom).toBe('hello@kindred.test')
    await expect(platform.addSender({ address: 'me@gmail.test', displayName: null }, 'u1')).rejects.toThrow(EmailPlatformError)
    await expect(platform.addSender({ address: 'me@gmail.test', displayName: null }, 'u1')).rejects.toThrow(/company’s own domains/)
  })

  it('a bought domain (managed-domains DM5) is added with receiving on, once', async () => {
    const { platform, ses, domains } = setup()
    const first = await platform.addBoughtDomain('acme.eu')
    expect(first).toMatchObject({ added: true })
    expect([...domains.values()]).toEqual([
      expect.objectContaining({ name: 'acme.eu', receiving: true, createdBy: 'domains', errorMessage: MANAGED_DOMAIN_PENDING_MESSAGE }),
    ])
    expect(await platform.addBoughtDomain('ACME.eu')).toMatchObject({ added: false })
    expect(domains.size).toBe(1)
    expect(ses.calls.filter((c) => PROVISIONING.includes(c))).toEqual([])
  })

  it('outside managed mode a bought domain is refused in plain words (its records live in our zone)', async () => {
    const owlery = new OwleryService({
      store: new InMemoryOwleryStore(),
      key: () => owlerySealKey('k'),
      ses: new FakeSes().factory,
      sns: new FakeSns().factory,
      log: new InMemoryMailLog(),
      managed: () => null,
    })
    const platform = new EmailPlatform({ ...(setup().platform as unknown as { deps: object }).deps, owlery } as never)
    await expect(platform.addBoughtDomain('acme.eu')).rejects.toThrow(/eigenEnterprise Mail/)
  })

  it('suppression removal names the tenant', async () => {
    const { platform, ses, removed } = setup()
    await platform.unsuppress('x@y.test')
    expect(ses.unsuppressedTenants).toEqual(['ee-box1'])
    expect(removed).toEqual(['x@y.test'])
  })

  it('events webhook: only the env topic; its confirmation works without stored settings', async () => {
    const { platform, fetched } = setup()
    const confirm = { Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription', Message: '' }
    expect((await platform.handleSnsMessage({ ...confirm, TopicArn: 'arn:aws:sns:eu-central-1:1:other' } as never)).status).toBe(403)
    const ok = await platform.handleSnsMessage({ ...confirm, TopicArn: MANAGED.eventsTopicArn } as never)
    expect(ok).toEqual({ status: 200, body: { ok: true, confirmed: true } })
    expect(fetched).toHaveLength(1)
  })
})
