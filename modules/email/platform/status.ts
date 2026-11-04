/**
 * Message statuses of the sent-mail log (ported from Owlery's emailStatuses).
 * Shared by the server and the Email pages (no server imports here).
 *
 * The order is the rank: a message's status only ever moves forward, so a late
 * "Delivery" event never overwrites "Opened" (SNS does not keep order).
 */
export const MESSAGE_STATUSES = [
  'scheduled',
  'queued',
  'sent',
  'delivery_delayed',
  'bounced',
  'rejected',
  'rendering_failure',
  'delivered',
  'opened',
  'clicked',
  'complained',
  'failed',
  'cancelled',
  'suppressed',
] as const

export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

const RANK = new Map<string, number>(MESSAGE_STATUSES.map((s, i) => [s, i]))

/** The status a message shows after `incoming` happened, given its `current` status. */
export function nextStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus {
  if (current === 'scheduled') return incoming
  return (RANK.get(incoming) ?? -1) > (RANK.get(current) ?? -1) ? incoming : current
}

export const STATUS_LABEL: Record<MessageStatus, string> = {
  scheduled: 'Scheduled',
  queued: 'Queued',
  sent: 'Sent',
  delivery_delayed: 'Delayed',
  bounced: 'Bounced',
  rejected: 'Rejected',
  rendering_failure: 'Rendering failed',
  delivered: 'Delivered',
  opened: 'Opened',
  clicked: 'Clicked',
  complained: 'Marked as spam',
  failed: 'Failed',
  cancelled: 'Cancelled',
  suppressed: 'Suppressed',
}

/** Problem states are shown in the destructive tone. */
export function isProblemStatus(s: MessageStatus): boolean {
  return s === 'bounced' || s === 'rejected' || s === 'rendering_failure' || s === 'complained' || s === 'failed' || s === 'suppressed'
}

export const SOURCE_LABEL: Record<string, string> = {
  system: 'System',
  agent: 'Assistant',
  api: 'API',
  test: 'Test',
  template: 'Template',
  flow: 'Flow',
  double_opt_in: 'Double opt-in',
}
