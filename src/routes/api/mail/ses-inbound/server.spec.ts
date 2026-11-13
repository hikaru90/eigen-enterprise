import type { InboundDeps } from '../../../../../modules/email/inbox/inbound'
import type { SnsMessage } from '../../../../../modules/email/platform/sns-signature'
import { beforeEach, describe, expect, it } from 'vitest'
import { CSRF_EXEMPT_PATHS } from '$lib/server/csrf'
import { PLAIN } from '../../../../../modules/email/inbox/mime-fixtures'
import { fakeRawMailSource } from '../../../../../modules/email/inbox/raw-source'
import { BUCKET, received, signed, SIGNING_PEM, TOPIC } from '../../../../../modules/email/inbox/receipt-fixtures'
import { INBOUND_CALLBACK_PATH } from '../../../../../modules/email/inbox/receiving-contract'
import { assignPersonalMailbox } from '../../../../../modules/email/inbox/service'
import { fixture } from '../../../../../modules/email/inbox/test-fixtures'
import { InMemoryOwleryStore, NO_EVENTS, NO_RECEIVING } from '../../../../../modules/email/owlery/store'

const { POST, _deps } = await import('./+server')

const SUBSCRIBE_URL = 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t'

let f: ReturnType<typeof fixture>
let owlery: InMemoryOwleryStore
let raw: ReturnType<typeof fakeRawMailSource>
let fetched: string[]
let fetchStatus: number
let anaBox: string

beforeEach(async () => {
  f = fixture()
  anaBox = (await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })).id
  owlery = new InMemoryOwleryStore()
  owlery.row = {
    region: 'eu-central-1',
    accessKeyId: 'AKIA',
    sealedSecretAccessKey: 'sealed',
    emailFrom: 'hello@example.com',
    updatedBy: 'olga',
    ...NO_EVENTS,
    ...NO_RECEIVING,
    receivingStatus: 'waiting',
    receivingTopicArn: TOPIC,
    receivingBucket: BUCKET,
  }
  raw = fakeRawMailSource()
  raw.objects.set(`${BUCKET}/ses-msg-1`, Buffer.from(PLAIN))
  fetched = []
  fetchStatus = 200
  const deps: InboundDeps = {
    owlery,
    fetch: (async (url: string) => {
      fetched.push(url)
      return new Response('<ConfirmSubscriptionResponse/>', { status: fetchStatus })
    }) as typeof fetch,
    ingest: { store: f.store, raw, log: () => {}, received: async () => {} },
  }
  _deps.inbound = async () => deps
  _deps.fetchCert = async () => SIGNING_PEM
})

const post = (body: string) =>
  POST({
    request: new Request(`https://x.test${INBOUND_CALLBACK_PATH}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    }),
  } as never)

const send = (m: Partial<SnsMessage>) => post(JSON.stringify(signed(m)))
const notify = (n: unknown = received()) => send({ Message: JSON.stringify(n) })
const confirmation = (over: Partial<SnsMessage> = {}) =>
  send({ Type: 'SubscriptionConfirmation', Message: 'You have chosen to subscribe…', SubscribeURL: SUBSCRIBE_URL, Token: 't', ...over })

describe(`POST ${INBOUND_CALLBACK_PATH}`, () => {
  it('is exempt from the cross-site form check (SNS posts text/plain without an Origin)', () => {
    expect(CSRF_EXEMPT_PATHS).toContain(INBOUND_CALLBACK_PATH)
  })

  it('stores a signed receipt notification in the recipient’s mailbox', async () => {
    const res = await notify()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored: 1, duplicates: 0, skipped: 0 })
    expect([...f.store.messages.values()].map((m) => [m.mailboxId, m.folder, m.subject])).toEqual([[anaBox, 'inbox', 'Quarterly numbers']])
  })

  it('does not duplicate a retried notification', async () => {
    await notify()
    const again = await notify()
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ stored: 0, duplicates: 1 })
    expect(f.store.messages.size).toBe(1)
  })

  it('refuses unsigned or forged messages before reading them', async () => {
    const forged = { ...signed({ Message: JSON.stringify(received()) }), Message: JSON.stringify(received({ recipients: ['x@example.com'] })) }
    expect((await post(JSON.stringify(forged))).status).toBe(401)
    expect((await post(JSON.stringify(received()))).status).toBe(401)
    expect((await post('not json')).status).toBe(400)
    expect(raw.reads).toEqual([])
  })

  it('refuses a topic other than the stored receiving topic (403), also before setup', async () => {
    expect((await send({ TopicArn: 'arn:aws:sns:eu-central-1:999:other', Message: JSON.stringify(received()) })).status).toBe(403)
    expect((await confirmation({ TopicArn: 'arn:aws:sns:eu-central-1:999:other' })).status).toBe(403)
    owlery.row = { ...owlery.row!, receivingTopicArn: null }
    expect((await notify()).status).toBe(403)
    expect(fetched).toEqual([])
    expect(f.store.messages.size).toBe(0)
    expect(owlery.row.receivingStatus).toBe('waiting')
  })

  it('rejects a notification naming another bucket (400, nothing read)', async () => {
    const res = await notify(received({ bucket: 'someone-elses' }))
    expect(res.status).toBe(400)
    expect(raw.reads).toEqual([])
  })

  it('answers malformed notifications with 400', async () => {
    expect((await send({ Message: 'not json' })).status).toBe(400)
    expect((await notify({ notificationType: 'Received', mail: {} })).status).toBe(400)
  })

  it('acknowledges a notification that carries no mail (SES setup test)', async () => {
    const res = await notify({ notificationType: 'AMAZON_SES_SETUP_NOTIFICATION' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ignored: 'AMAZON_SES_SETUP_NOTIFICATION' })
  })

  it('fails with 5xx when the raw mail cannot be read, so SNS retries', async () => {
    raw.objects.clear()
    await expect(notify()).rejects.toThrow()
    expect(f.store.messages.size).toBe(0)
  })

  it('asks SNS to retry (503) when no inbound bucket is stored yet', async () => {
    owlery.row = { ...owlery.row!, receivingBucket: null }
    expect((await notify()).status).toBe(503)
    expect(raw.reads).toEqual([])
  })

  it('confirms the subscription for our topic and marks receiving ready', async () => {
    owlery.row = { ...owlery.row!, receivingError: 'old' }
    const res = await confirmation()
    expect(res.status).toBe(200)
    expect(fetched).toEqual([SUBSCRIBE_URL])
    expect(owlery.row).toMatchObject({ receivingStatus: 'ready', receivingError: null })
  })

  it('refuses a SubscribeURL off SNS and records a refused confirmation', async () => {
    expect((await confirmation({ SubscribeURL: 'https://evil.example/confirm' })).status).toBe(400)
    expect(fetched).toEqual([])
    fetchStatus = 403
    expect((await confirmation()).status).toBe(502)
    expect(owlery.row).toMatchObject({ receivingStatus: 'failed', receivingError: 'Amazon SNS refused the confirmation (HTTP 403).' })
  })

  it('marks receiving failed when the subscription is removed at Amazon', async () => {
    owlery.row = { ...owlery.row!, receivingStatus: 'ready' }
    expect((await send({ Type: 'UnsubscribeConfirmation', Message: 'unsubscribed', SubscribeURL: SUBSCRIBE_URL, Token: 't' })).status).toBe(200)
    expect(owlery.row.receivingStatus).toBe('failed')
  })
})
