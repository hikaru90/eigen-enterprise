import type { ModuleManifest } from '$lib/kernel/modules'
import { OWLERY_TOOL_NAMES } from './owlery/manifest'
import { EMAIL_PLATFORM_READ_TOOLS, EMAIL_PLATFORM_WRITE_TOOLS } from './platform/tool-names'

export const EMAIL_MODULE_ID = 'email'

/** Transactional-send tool names (namespace `email`). */
export const EMAIL_TOOL_NAMES = ['email.send_mail'] as const

/**
 * Email (plan/phase-platform.md step 1, plan/phase-polish-1.md P-6): the
 * company's email platform on its own Amazon SES account — domains, senders,
 * the sent-mail log, suppressions. One send tool, `email.send_mail`; the setup
 * status is `owlery.status` (namespace `owlery`). A system module: self-seeded
 * active, does nothing until set up.
 */
export const emailManifest: ModuleManifest = {
  id: EMAIL_MODULE_ID,
  name: 'Email',
  version: '0.4.0',
  description: "Your company's email: Amazon SES, sender domains and addresses, every mail sent, and sending from your apps.",
  toolNamespaces: [EMAIL_MODULE_ID, 'owlery'],
  tools: [...EMAIL_TOOL_NAMES, ...OWLERY_TOOL_NAMES, ...EMAIL_PLATFORM_READ_TOOLS, ...EMAIL_PLATFORM_WRITE_TOOLS],
  permissions: { roles: ['admin', 'agent'] },
}
