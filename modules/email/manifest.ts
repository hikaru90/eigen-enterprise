import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the email module (single source of truth for the manifest). */
export const EMAIL_TOOL_NAMES = ['email.send_mail'] as const

export const emailManifest: ModuleManifest = {
  id: 'email',
  name: 'Transactional email',
  version: '0.2.0',
  description: "Send one transactional email from the company's sender address (delivered by the Owlery email module).",
  tools: [...EMAIL_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
