import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { cachedCertFetcher, isSnsUrl, SnsSignatureError, stringToSign, verifySnsMessage, type SnsMessage } from './sns-signature'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const certPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const CERT_URL = 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc.pem'

function signed(m: Omit<SnsMessage, 'Signature' | 'SignatureVersion' | 'SigningCertURL'>, version: '1' | '2' = '2', certUrl = CERT_URL): SnsMessage {
  const unsigned = { ...m, SignatureVersion: version, SigningCertURL: certUrl, Signature: 'x' } as SnsMessage
  const sig = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256').update(stringToSign(unsigned)).sign(privateKey, 'base64')
  return { ...unsigned, Signature: sig }
}

const notification = {
  Type: 'Notification' as const,
  MessageId: 'm-1',
  TopicArn: 'arn:aws:sns:eu-central-1:1:ee-events',
  Message: '{"eventType":"Delivery"}',
  Timestamp: '2026-11-04T12:00:00.000Z',
}

const confirmation = {
  Type: 'SubscriptionConfirmation' as const,
  MessageId: 'm-2',
  TopicArn: 'arn:aws:sns:eu-central-1:1:ee-events',
  Message: 'You have chosen to subscribe…',
  Timestamp: '2026-11-04T12:00:00.000Z',
  SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
  Token: 't',
}

const fetchCert = async () => certPem

describe('stringToSign', () => {
  it('uses the AWS key order; Subject only when present', () => {
    const m = signed(notification)
    expect(stringToSign(m)).toBe(
      'Message\n{"eventType":"Delivery"}\nMessageId\nm-1\nTimestamp\n2026-11-04T12:00:00.000Z\nTopicArn\narn:aws:sns:eu-central-1:1:ee-events\nType\nNotification\n',
    )
    expect(stringToSign({ ...m, Subject: 'S' })).toContain('MessageId\nm-1\nSubject\nS\nTimestamp')
    expect(stringToSign(signed(confirmation))).toContain('SubscribeURL\nhttps://sns.')
  })
})

describe('verifySnsMessage', () => {
  it('accepts genuine SignatureVersion 1 and 2 messages', async () => {
    await expect(verifySnsMessage(signed(notification, '1'), fetchCert)).resolves.toMatchObject({ MessageId: 'm-1' })
    await expect(verifySnsMessage(signed(notification, '2'), fetchCert)).resolves.toMatchObject({ MessageId: 'm-1' })
    await expect(verifySnsMessage(signed(confirmation), fetchCert)).resolves.toMatchObject({ Token: 't' })
  })

  it('rejects a tampered message', async () => {
    const m = signed(notification)
    await expect(verifySnsMessage({ ...m, Message: '{"eventType":"Bounce"}' }, fetchCert)).rejects.toThrow(/does not verify/)
  })

  it('rejects a certificate that is not served by Amazon SNS (before fetching it)', async () => {
    const fetcher = vi.fn(fetchCert)
    for (const url of [
      'https://evil.example.com/cert.pem',
      'http://sns.eu-central-1.amazonaws.com/cert.pem',
      'https://sns.eu-central-1.amazonaws.com.evil.com/cert.pem',
      'https://sns.eu-central-1.amazonaws.com/cert.txt',
    ]) {
      await expect(verifySnsMessage(signed(notification, '2', url), fetcher)).rejects.toBeInstanceOf(SnsSignatureError)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects bodies that are not SNS messages and confirmations without a token', async () => {
    await expect(verifySnsMessage({ eventType: 'Delivery' }, fetchCert)).rejects.toThrow(/not an Amazon SNS message/)
    const { Token: _t, ...noToken } = confirmation
    await expect(verifySnsMessage(signed(noToken as typeof confirmation), fetchCert)).rejects.toThrow(/Token/)
  })
})

describe('isSnsUrl / cachedCertFetcher', () => {
  it('only SNS https hosts', () => {
    expect(isSnsUrl(confirmation.SubscribeURL)).toBe(true)
    expect(isSnsUrl('https://sns.cn-north-1.amazonaws.com.cn/x')).toBe(true)
    expect(isSnsUrl('https://user:pw@sns.eu-central-1.amazonaws.com/x')).toBe(false)
    expect(isSnsUrl('not a url')).toBe(false)
  })

  it('fetches each certificate once and retries after a failure', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return calls === 1 ? new Response('nope', { status: 500 }) : new Response(certPem)
    }) as unknown as typeof fetch
    const get = cachedCertFetcher(fetchImpl)
    await expect(get(CERT_URL)).rejects.toThrow(/HTTP 500/)
    await expect(get(CERT_URL)).resolves.toBe(certPem)
    await expect(get(CERT_URL)).resolves.toBe(certPem)
    expect(calls).toBe(2)
  })
})
