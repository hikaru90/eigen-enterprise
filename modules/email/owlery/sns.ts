import type { SesCredentials } from './ses'
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns'

/**
 * Amazon SNS, only for SES delivery events: one topic per company, one HTTPS
 * subscription pointing at /api/mail/ses-events. SNS then sends a
 * SubscriptionConfirmation there, which the callback confirms (sns-signature.ts
 * verifies every message first).
 */
export type SnsApi = {
  /** CreateTopic is idempotent for the same name. */
  createTopic(name: string): Promise<string>
  /**
   * Subscribe an HTTPS endpoint. A new subscription is pending until SNS's
   * SubscriptionConfirmation reaches the endpoint (`confirmed: false`); one
   * that already exists and was confirmed comes back with its ARN.
   */
  subscribeHttps(topicArn: string, endpoint: string): Promise<{ confirmed: boolean }>
}

export type SnsFactory = (credentials: SesCredentials) => SnsApi

/** A setup problem already phrased for the owner (not an AWS error). */
export class EventsSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EventsSetupError'
  }
}

export const awsSns: SnsFactory = (c) => {
  const client = new SNSClient({
    region: c.region,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  })
  return {
    async createTopic(name) {
      const out = await client.send(new CreateTopicCommand({ Name: name }))
      if (!out.TopicArn) throw new Error('Amazon SNS created the topic but returned no ARN')
      return out.TopicArn
    },
    async subscribeHttps(topicArn, endpoint) {
      if (!endpoint.startsWith('https://')) {
        throw new EventsSetupError(
          `Amazon only delivers to an https address, and this callback is ${endpoint}. Open ee at its public https address and set it up again from there.`,
        )
      }
      const out = await client.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: 'https', Endpoint: endpoint }))
      return { confirmed: typeof out.SubscriptionArn === 'string' && out.SubscriptionArn.startsWith('arn:') }
    },
  }
}
