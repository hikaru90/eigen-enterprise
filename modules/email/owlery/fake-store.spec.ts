import { describe, expect, it } from 'vitest'
import { SenderNotVerifiedError } from '$lib/server/mail/company-mail'
import { fakeStoreSes, InMemoryFakeMailStore } from './fake-store'
import { OwleryService } from './service'
import { InMemoryOwleryStore, owlerySealKey } from './store'

const key = owlerySealKey('master-key-for-tests')
const input = {
  region: 'eu-central-1',
  accessKeyId: 'AKIAFAKE',
  secretAccessKey: 'fake-secret',
  emailFrom: 'hello@kindred.test',
  testRecipient: 'Owner@Kindred.test',
  updatedBy: 'u1',
}

function setup() {
  const fake = new InMemoryFakeMailStore()
  const service = new OwleryService({ store: new InMemoryOwleryStore(), key: () => key, ses: fakeStoreSes(fake) })
  return { fake, service }
}

describe('InMemoryFakeMailStore', () => {
  it('creates identities pending, verifies them, never downgrades a verified one', async () => {
    const s = new InMemoryFakeMailStore()
    expect(await s.getIdentity('a@b.co')).toEqual({ exists: false, verified: false })
    await s.createIdentity('A@b.co')
    expect(await s.getIdentity('a@b.co')).toEqual({ exists: true, verified: false })
    await s.verifyIdentity('a@b.co')
    await s.createIdentity('a@b.co')
    expect(await s.getIdentity('a@b.co')).toEqual({ exists: true, verified: true })
  })

  it('captures mails, filters by recipient case-insensitively, clears everything', async () => {
    const s = new InMemoryFakeMailStore()
    await s.capture({ from: 'f@x.co', to: 'One@x.co', subject: 's1', html: '<p>1</p>', text: '1' })
    await s.capture({ from: 'f@x.co', to: 'two@x.co', subject: 's2', html: '<p>2</p>', text: '2', replyTo: 'r@x.co' })
    expect((await s.list()).map((m) => m.subject)).toEqual(['s1', 's2'])
    expect((await s.list({ to: 'ONE@x.co' })).map((m) => m.subject)).toEqual(['s1'])
    await s.verifyIdentity('f@x.co')
    await s.clear()
    expect(await s.list()).toEqual([])
    expect(await s.getIdentity('f@x.co')).toEqual({ exists: false, verified: false })
  })
})

describe('OwleryService on the fake transport', () => {
  it('first setup: sender unknown → created pending → SenderNotVerifiedError, nothing captured', async () => {
    const { fake, service } = setup()
    await expect(service.saveVerified(input)).rejects.toBeInstanceOf(SenderNotVerifiedError)
    expect(await fake.getIdentity('hello@kindred.test')).toEqual({ exists: true, verified: false })
    expect(await fake.list()).toEqual([])
    expect(await service.isConfigured()).toBe(false)
  })

  it('after verification: the test mail is captured and settings are saved; later sends are captured too', async () => {
    const { fake, service } = setup()
    await fake.verifyIdentity('hello@kindred.test')
    await service.saveVerified(input)
    const [testMail] = await fake.list({ to: 'owner@kindred.test' })
    expect(testMail).toMatchObject({ from: 'hello@kindred.test', subject: 'Email works — Eigen Enterprise' })
    expect(await service.isConfigured()).toBe(true)

    const sent = await service.send({ to: 'a@b.co', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' })
    const [captured] = await fake.list({ to: 'a@b.co' })
    expect(captured).toMatchObject({ from: 'hello@kindred.test', subject: 'Hi', messageId: sent.messageId })
  })

  it('reports status from the fake (verified sender, never sandbox)', async () => {
    const { fake, service } = setup()
    await fake.verifyIdentity('kindred.test')
    await service.saveVerified(input)
    expect(await service.status()).toEqual({
      configured: true,
      region: 'eu-central-1',
      sender: 'hello@kindred.test',
      senderVerified: true,
      sandbox: false,
    })
  })
})
