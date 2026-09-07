import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the email module (single source of truth for the manifest). */
export const EMAIL_TOOL_NAMES = ['email.send_mail', 'email.add_contact', 'email.list_contacts'] as const

export const emailManifest: ModuleManifest = {
  id: 'email',
  name: 'Email',
  version: '0.1.0',
  description: 'Transactional email and onboarding contact book sync via Owlery.',
  tools: [...EMAIL_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
