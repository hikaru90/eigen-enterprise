import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const EVENTS_STATUSES = ['not_set_up', 'waiting', 'ready', 'failed'] as const
export type EventsStatus = (typeof EVENTS_STATUSES)[number]

/**
 * Owlery email module settings (migration 0088; delivery-event columns 0114).
 * Consumed only by modules/email/owlery/store.
 */
export const owlerySettings = pgTable('owlery_settings', {
  id: text('id').primaryKey().default('owlery'),
  region: text('region').notNull(),
  accessKeyId: text('access_key_id').notNull(),
  sealedSecretAccessKey: text('sealed_secret_access_key').notNull(),
  /** The default sender: system mail (sign-in codes) and every send without its own from. */
  emailFrom: text('email_from').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  /** Delivery events (SES configuration set → SNS topic → /api/mail/ses-events). */
  eventsStatus: text('events_status').$type<EventsStatus>().notNull().default('not_set_up'),
  eventsError: text('events_error'),
  eventsTopicArn: text('events_topic_arn'),
  eventsCallbackUrl: text('events_callback_url'),
  configSet: text('config_set'),
  trackingConfigSet: text('tracking_config_set'),
})
