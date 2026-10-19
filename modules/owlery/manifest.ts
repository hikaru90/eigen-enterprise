import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the owlery module (single source of truth for the manifest). */
export const OWLERY_TOOL_NAMES = ['owlery.status', 'owlery.send_mail'] as const

/**
 * Owlery: the company's email, sent through the owner's own Amazon SES account.
 * This module alone holds the SES credentials and talks to SES; the rest of the
 * app sends through companyMail() from $lib/server/mail.
 */
export const owleryManifest: ModuleManifest = {
  id: 'owlery',
  name: 'Email',
  version: '0.1.0',
  description: "Sends the company's email (sign-in codes, notifications, agent mail) through its Amazon SES account.",
  tools: [...OWLERY_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}

export const OWLERY_MODULE_ID = owleryManifest.id
