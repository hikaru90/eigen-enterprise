import type { AreaTab } from '$lib/shell/area-nav'

/** The setup sections: SES account, domains, senders, templates, flows, logs, the API. */
export const EMAIL_SETUP_TABS: readonly AreaTab[] = [
  { id: 'account', label: 'Account', href: '/m/email/setup' },
  { id: 'domains', label: 'Domains', href: '/m/email/domains' },
  { id: 'senders', label: 'Senders', href: '/m/email/senders' },
  { id: 'templates', label: 'Templates', href: '/m/email/templates' },
  { id: 'layouts', label: 'Layouts', href: '/m/email/layouts' },
  { id: 'flows', label: 'Flows', href: '/m/email/flows' },
  { id: 'logs', label: 'Logs', href: '/m/email/logs' },
  { id: 'suppression', label: 'Suppression', href: '/m/email/suppression' },
  { id: 'api', label: 'API', href: '/m/email/api' },
]

/**
 * The Email area's sections (plan/phase-polish-1.md P-6): mail first, contacts,
 * and everything about how mail is set up behind one Setup tab. Kept beside the
 * routes: the shell's area-nav lists only the shell-owned areas.
 */
export const EMAIL_TABS: readonly AreaTab[] = [
  { id: 'mail', label: 'Mail', href: '/m/email' },
  { id: 'contacts', label: 'Contacts', href: '/m/email/contacts' },
  {
    id: 'setup',
    label: 'Setup',
    href: '/m/email/setup',
    match: EMAIL_SETUP_TABS.map((t) => t.href),
  },
]
