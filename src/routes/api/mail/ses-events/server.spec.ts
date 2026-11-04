import { createSign, generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stringToSign, type SnsMessage } from '../../../../../modules/email/platform/sns-signature'

const handled: SnsMessage[] = []
vi.mock('../../../../../modules/email/platform/service', () => ({
  emailPlatform: () => ({
    handleSnsMessage: async (m: SnsMessage) => {
      handled.push(m)
      return { status: 200, body: { ok: true } }
    },
  }),
}))

const { POST, _deps } = await import('./+server')

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function snsBody(over: Partial<SnsMessage> = {}): SnsMessage {
  const m = {
    Type: 'Notification',
    MessageId: 'm-1',
    TopicArn: 'arn:aws:sns:eu-central-1:1:t',
    Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'x' } }),
    Timestamp: '2026-11-04T12:00:00Z',
    SignatureVersion: '2',
    SigningCertURL: 'https://sns.eu-central-1.amazonaws.com/c.pem',
    Signature: '',
    ...over,
  } as SnsMessage
  return { ...m, Signature: createSign('RSA-SHA256').update(stringToSign(m)).sign(privateKey, 'base64') }
}

const post = (body: string) =>
  POST({
    request: new Request('https://x.test/api/mail/ses-events', {
      method: 'POST',
      body,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    }),
  } as never)

describe('POST /api/mail/ses-events', () => {
  beforeEach(() => {
    handled.length = 0
    _deps.fetchCert = async () => pem
  })

  it('hands a verified SNS message to the platform', async () => {
    const res = await post(JSON.stringify(snsBody()))
    expect(res.status).toBe(200)
    expect(handled.map((m) => m.MessageId)).toEqual(['m-1'])
  })

  it('refuses unsigned or forged messages before reading them', async () => {
    const forged = { ...snsBody(), Message: '{"eventType":"Bounce"}' }
    expect((await post(JSON.stringify(forged))).status).toBe(401)
    expect((await post(JSON.stringify({ eventType: 'Delivery' }))).status).toBe(401)
    expect((await post('not json')).status).toBe(400)
    expect(handled).toEqual([])
  })
})
