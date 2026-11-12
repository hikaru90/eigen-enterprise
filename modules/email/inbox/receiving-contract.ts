/**
 * The names S2 (receiving setup) and S3 (ingest) agree on
 * (plan/email-inbox.md). S2 provisions with them and stores what it created in
 * owlery_settings.receiving_* (OwleryReceiving); S3's ingest accepts a
 * notification only when its topic ARN and bucket match what is stored.
 */

/** Where SNS posts receipt notifications (relative to the console origin). */
export const INBOUND_CALLBACK_PATH = '/api/mail/ses-inbound'

/** The one receipt rule set ee creates and activates. A different active set is never replaced. */
export const INBOUND_RULE_SET = 'ee-inbound'

/** Rules inside the set are `ee-inbound-1..n`, at most this many recipients each (docs say 100 or 500; 100 is safe). */
export const INBOUND_RULE_PREFIX = 'ee-inbound-'
export const RECIPIENTS_PER_RULE = 100

/** SNS topic name for receipt notifications (delivery events have their own topic). */
export const INBOUND_TOPIC_NAME = 'ee-inbound'
