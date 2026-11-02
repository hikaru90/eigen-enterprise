import type { ModuleManifest } from '$lib/kernel/modules'
import { OWLERY_TOOL_NAMES } from './owlery/manifest'

export const EMAIL_MODULE_ID = 'email'

/** Transactional-send tool names (namespace `email`). */
export const EMAIL_TOOL_NAMES = ['email.send_mail'] as const

/**
 * Email (plan/phase-platform.md step 1): the company's email through its own
 * Amazon SES account. One send tool, `email.send_mail`; the setup status is
 * `owlery.status` (namespace `owlery`). A system module: self-seeded active,
 * does nothing until set up.
 */
export const emailManifest: ModuleManifest = {
  id: EMAIL_MODULE_ID,
  name: 'Email',
  version: '0.3.0',
  description: "Your company's email: connect Amazon SES, sender addresses, and the mail the agent sends.",
  toolNamespaces: [EMAIL_MODULE_ID, 'owlery'],
  tools: [...EMAIL_TOOL_NAMES, ...OWLERY_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
