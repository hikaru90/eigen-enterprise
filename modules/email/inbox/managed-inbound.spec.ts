import { describe, expect, it } from 'vitest'
import { MANAGED } from '../owlery/managed-fixtures'
import { InMemoryOwleryStore } from '../owlery/store'
import { handleInboundSns } from './inbound'
import { PLAIN } from './mime-fixtures'
import { fakeRawMailSource } from './raw-source'
import { received } from './receipt-fixtures'
import { assignPersonalMailbox } from './service'
import { fixture } from './test-fixtures'

async function setup() {
  const f = fixture()
  await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })
  const raw = fakeRawMailSource()
  const owlery = new InMemoryOwleryStore()
  const fetched: string[] = []
  const logs: { event: string; fields: Record<string, unknown> }[] = []
  const deps = {
    owlery,
    fetch: (async (u: string) => (fetched.push(u), new Response('ok'))) as never,
    managed: async () => MANAGED,
    ingest: {
      store: f.store,
      raw,
      discard: (b: string, k: string) => raw.deleteRaw(b, k),
      received: async () => {},
      log: (event: string, fields: Record<string, unknown>) => logs.push({ event, fields }),
    },
  }
  const notify = (o: { key: string; recipients?: string[]; bucket?: string }) => {
    const n = received({ recipients: o.recipients ?? ['ana.lind@example.com'], bucket: o.bucket ?? MANAGED.inboundBucket })
    n.receipt.action.objectKey = o.key
    return handleInboundSns(deps, { Type: 'Notification', TopicArn: MANAGED.inboundTopicArn, Message: JSON.stringify(n) } as never)
  }
  return { f, raw, owlery, fetched, logs, deps, notify }
}

describe('inbound mail in managed mode (pinned topic, bucket, prefix)', () => {
  it('refuses another topic; confirms the env topic without writing owlery_settings', async () => {
    const s = await setup()
    const confirm = { Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription', Message: '' }
    expect((await handleInboundSns(s.deps, { ...confirm, TopicArn: 'arn:aws:sns:eu-central-1:1:x' } as never)).status).toBe(403)
    expect((await handleInboundSns(s.deps, { ...confirm, TopicArn: MANAGED.inboundTopicArn } as never)).status).toBe(200)
    expect(s.fetched).toHaveLength(1)
    expect(s.owlery.row).toBeNull()
  })

  it('stores mail under `${prefix}/`, refuses another box’s key, a lookalike prefix, or another bucket', async () => {
    const s = await setup()
    s.raw.objects.set(`${MANAGED.inboundBucket}/box1/m1`, Buffer.from(PLAIN))
    expect((await s.notify({ key: 'box1/m1' })).body).toMatchObject({ stored: 1 })
    expect((await s.notify({ key: 'box2/m1' })).status).toBe(400)
    expect((await s.notify({ key: 'box1x/m1' })).status).toBe(400)
    expect((await s.notify({ key: 'box1' })).status).toBe(400)
    expect((await s.notify({ key: 'box1/m1', bucket: 'other' })).status).toBe(400)
  })

  it('mail to an address nobody holds is deleted from S3, ids only in the log', async () => {
    const s = await setup()
    s.raw.objects.set(`${MANAGED.inboundBucket}/box1/m2`, Buffer.from(PLAIN))
    const out = await s.notify({ key: 'box1/m2', recipients: ['nobody@example.com'] })
    expect(out.body).toMatchObject({ stored: 0, skipped: 1 })
    expect(s.raw.deleted).toEqual([`${MANAGED.inboundBucket}/box1/m2`])
    expect(s.raw.reads).toEqual([])
    expect(s.logs).toEqual([{ event: 'discarded', fields: { sesMessageId: 'ses-msg-1', skipped: 1 } }])
  })
})
