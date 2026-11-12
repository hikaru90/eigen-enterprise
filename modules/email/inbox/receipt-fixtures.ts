import { createSign, generateKeyPairSync } from 'node:crypto'
import { stringToSign, type SnsMessage } from '../platform/sns-signature'

/**
 * Test builders for SES receipt notifications (S3 action + topic) and the SNS
 * envelope around them, signed with a throwaway key the way
 * src/routes/api/mail/ses-events/server.spec.ts signs its fixtures.
 */

export const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:ee-inbound'
export const BUCKET = 'ee-acme-inbound'

export type Verdicts = { spam?: string; virus?: string; spf?: string; dkim?: string; dmarc?: string }

/** The Message of an SNS Notification for one received mail (AWS "notification contents", S3 action). */
export function received(
  o: { sesMessageId?: string; recipients?: string[]; verdicts?: Verdicts; dmarcPolicy?: string; bucket?: string; actionType?: string } = {},
) {
  const id = o.sesMessageId ?? 'ses-msg-1'
  const v = { spam: 'PASS', virus: 'PASS', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', ...o.verdicts }
  return {
    notificationType: 'Received',
    mail: {
      timestamp: '2026-11-12T09:00:05.000Z',
      source: 'bounce@sender.example',
      messageId: id,
      destination: o.recipients ?? ['ana.lind@example.com'],
      headersTruncated: false,
    },
    receipt: {
      timestamp: '2026-11-12T09:00:05.000Z',
      processingTimeMillis: 420,
      recipients: o.recipients ?? ['ana.lind@example.com'],
      spamVerdict: { status: v.spam },
      virusVerdict: { status: v.virus },
      spfVerdict: { status: v.spf },
      dkimVerdict: { status: v.dkim },
      dmarcVerdict: { status: v.dmarc },
      ...(o.dmarcPolicy ? { dmarcPolicy: o.dmarcPolicy } : {}),
      action: { type: o.actionType ?? 'S3', topicArn: TOPIC, bucketName: o.bucket ?? BUCKET, objectKeyPrefix: '', objectKey: id },
    },
  }
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
/** The signing certificate's public key, for the route's fetchCert. */
export const SIGNING_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()

export function signed(over: Partial<SnsMessage>): SnsMessage {
  const m = {
    Type: 'Notification',
    MessageId: 'sns-1',
    TopicArn: TOPIC,
    Message: JSON.stringify(received()),
    Timestamp: '2026-11-12T09:00:06Z',
    SignatureVersion: '2',
    SigningCertURL: 'https://sns.eu-central-1.amazonaws.com/c.pem',
    Signature: '',
    ...over,
  } as SnsMessage
  return { ...m, Signature: createSign('RSA-SHA256').update(stringToSign(m)).sign(privateKey, 'base64') }
}
