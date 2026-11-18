/**
 * eigenEnterprise Mail (plan/managed-mail.md, Contract): a hosted box sends and
 * receives through the control plane's SES tenant. ee sets these os secrets
 * from `desired.mail`; all ten or none. A partial set fails loud at start.
 */

export type ManagedMailConfig = {
  region: string
  accessKeyId: string
  secretAccessKey: string
  tenant: string
  configSet: string
  trackingConfigSet: string
  eventsTopicArn: string
  inboundTopicArn: string
  inboundBucket: string
  inboundPrefix: string
}

export const MANAGED_MAIL_ENV = {
  region: 'EE_MAIL_REGION',
  accessKeyId: 'EE_MAIL_ACCESS_KEY_ID',
  secretAccessKey: 'EE_MAIL_SECRET_ACCESS_KEY',
  tenant: 'EE_MAIL_TENANT',
  configSet: 'EE_MAIL_CONFIG_SET',
  trackingConfigSet: 'EE_MAIL_TRACKING_CONFIG_SET',
  eventsTopicArn: 'EE_MAIL_EVENTS_TOPIC_ARN',
  inboundTopicArn: 'EE_MAIL_INBOUND_TOPIC_ARN',
  inboundBucket: 'EE_MAIL_INBOUND_BUCKET',
  inboundPrefix: 'EE_MAIL_INBOUND_PREFIX',
} as const satisfies Record<keyof ManagedMailConfig, string>

/** All set → the config; none → null (no managed mail); some → throws naming the missing ones. */
export function readManagedMailConfig(env: Record<string, string | undefined>): ManagedMailConfig | null {
  const entries = Object.entries(MANAGED_MAIL_ENV) as [keyof ManagedMailConfig, string][]
  const values = entries.map(([k, name]) => [k, name, env[name]?.trim() ?? ''] as const)
  const missing = values.filter(([, , v]) => v === '').map(([, name]) => name)
  if (missing.length === entries.length) return null
  if (missing.length > 0) {
    throw new Error(`eigenEnterprise Mail is only partly configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (all ten EE_MAIL_* or none).`)
  }
  return Object.fromEntries(values.map(([k, , v]) => [k, v])) as ManagedMailConfig
}
