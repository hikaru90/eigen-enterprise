import type { ManagedMailConfig } from '$lib/server/mail/managed-config'

/** eigenEnterprise Mail's EE_MAIL_* config for tests. */
export const MANAGED: ManagedMailConfig = {
  region: 'eu-central-1',
  accessKeyId: 'AKIAMANAGED',
  secretAccessKey: 'managed-secret',
  tenant: 'ee-box1',
  configSet: 'ee-box1',
  trackingConfigSet: 'ee-box1-tracking',
  eventsTopicArn: 'arn:aws:sns:eu-central-1:111111111111:ee-box1-events',
  inboundTopicArn: 'arn:aws:sns:eu-central-1:111111111111:ee-box1-inbound',
  inboundBucket: 'ee-mail-inbound',
  inboundPrefix: 'box1',
}
