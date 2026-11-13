import type { ModuleManifest } from '$lib/kernel/modules'

export const CONTACTS_MODULE_ID = 'contacts'

export const CONTACTS_TOOL_NAMES = [
  'contacts.list',
  'contacts.get',
  'contacts.follow_ups',
  'contacts.create',
  'contacts.update',
  'contacts.log_contact',
] as const

/** The agent's writes wait on the company's approval mode (APPROVAL_REQUIRED_TOOLS). */
export const CONTACTS_WRITE_TOOLS = ['contacts.create', 'contacts.update', 'contacts.log_contact'] as const

/**
 * Contacts (plan/contribute-round-3.md W1): the people the company knows —
 * name, organisation, how to reach them, where you met, why they matter
 * (tags: partner, customer, funder, investor, production, your own) and when
 * to follow up. Private to whoever adds a contact (plus the owner and admins)
 * until they share it with the company. Not Email's audience lists. A system
 * module (self-seeded active); the people's surface is /m/email/people, the
 * agent's is these tools.
 */
export const contactsManifest: ModuleManifest = {
  id: CONTACTS_MODULE_ID,
  name: 'Contacts',
  version: '0.1.0',
  description: 'The people you know: how to reach them, where you met, why they matter, and who to follow up with next.',
  tools: [...CONTACTS_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
