/** Email platform tool names (namespace `email`), owned by the email module. */
export const EMAIL_PLATFORM_READ_TOOLS = [
  'email.domain_list',
  'email.sender_list',
  'email.log_list',
  'email.log_get',
  'email.suppression_list',
  'email.template_list',
  'email.template_get',
] as const

/** Every one of these waits on the approval gate (modules/index APPROVAL_REQUIRED_TOOLS). */
export const EMAIL_PLATFORM_WRITE_TOOLS = [
  'email.domain_add',
  'email.domain_recheck',
  'email.sender_add',
  'email.suppression_add',
  'email.suppression_remove',
  'email.send_template',
] as const
