/** Email platform tool names (namespace `email`), owned by the email module. */
export const EMAIL_PLATFORM_READ_TOOLS = [
  'email.domain_list',
  'email.sender_list',
  'email.log_list',
  'email.log_get',
  'email.suppression_list',
  'email.template_list',
  'email.template_get',
  'email.contact_lists',
  'email.flow_list',
  'email.list_contacts',
  'email.reputation_get',
] as const

/** Every one of these waits on the approval gate (modules/index APPROVAL_REQUIRED_TOOLS). */
export const EMAIL_PLATFORM_WRITE_TOOLS = [
  'email.domain_add',
  'email.domain_recheck',
  'email.sender_add',
  'email.suppression_add',
  'email.suppression_remove',
  'email.send_template',
  'email.contact_add',
  'email.domain_set_receiving',
  'email.domain_set_tracking',
  'email.layout_create',
  'email.layout_update',
  'email.template_create',
  'email.template_update',
  'email.template_send_test',
  'email.flow_create',
  'email.flow_update',
  'email.flow_set_status',
  'email.list_create',
  'email.list_update',
  'email.list_import',
  'email.sender_set_default',
  'email.setup_events',
  'email.setup_receiving',
  'email.reputation_check',
  'email.reputation_resume',
  // Destructive: removes a domain, a layout, a template, a flow, a list, a person on a list, a sender.
  'email.domain_delete',
  'email.layout_delete',
  'email.template_delete',
  'email.flow_delete',
  'email.list_delete',
  'email.contact_remove',
  'email.sender_remove',
] as const

/** The write tools that remove something (approvalRisk 'destructive'). */
export const EMAIL_PLATFORM_DESTRUCTIVE_TOOLS = [
  'email.domain_delete',
  'email.layout_delete',
  'email.template_delete',
  'email.flow_delete',
  'email.list_delete',
  'email.contact_remove',
  'email.sender_remove',
] as const satisfies readonly (typeof EMAIL_PLATFORM_WRITE_TOOLS)[number][]
