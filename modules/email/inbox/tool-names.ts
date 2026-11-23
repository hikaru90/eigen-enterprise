/** Inbox tool names (namespace `email`): reading and working a mailbox, and mailbox administration. */
export const EMAIL_INBOX_READ_TOOLS = [
  'email.mailbox_list',
  'email.mailbox_admin',
  'email.mail_list',
  'email.mail_read',
] as const

/** Every one of these waits on the approval gate (modules/index APPROVAL_REQUIRED_TOOLS). */
export const EMAIL_INBOX_WRITE_TOOLS = [
  'email.mailbox_create_mine',
  'email.mailbox_assign',
  'email.mailbox_create_shared',
  'email.mailbox_set_disabled',
  'email.mailbox_alias_add',
  'email.mailbox_alias_remove',
  'email.label_create',
  'email.label_delete',
  'email.mail_label',
  'email.mail_move',
  'email.mail_mark_read',
  'email.mail_star',
  'email.mail_send',
  'email.log_cancel',
] as const
