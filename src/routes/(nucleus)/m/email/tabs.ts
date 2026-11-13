import type { AreaTab } from '$lib/shell/area-nav'

/** The setup sections: SES account, domains, senders, mailboxes (receiving addresses), templates, flows, logs, the API. */
export const EMAIL_SETUP_TABS: readonly AreaTab[] = [
  { id: 'account', label: 'Account', href: '/m/email/setup' },
  { id: 'domains', label: 'Domains', href: '/m/email/domains' },
  { id: 'senders', label: 'Senders', href: '/m/email/senders' },
  { id: 'mailboxes', label: 'Mailboxes', href: '/m/email/mailboxes' },
  { id: 'templates', label: 'Templates', href: '/m/email/templates' },
  { id: 'layouts', label: 'Layouts', href: '/m/email/layouts' },
  { id: 'flows', label: 'Flows', href: '/m/email/flows' },
  { id: 'logs', label: 'Logs', href: '/m/email/logs' },
  { id: 'suppression', label: 'Suppression', href: '/m/email/suppression' },
  { id: 'api', label: 'API', href: '/m/email/api' },
]

/**
 * The Email area's sections (plan/phase-polish-1.md P-6, plan/email-inbox.md S6): your inbox first, the company's mail, the
 * audience lists, and everything about how mail is set up behind one Setup
 * tab. Kept beside the routes: the shell's area-nav lists only the shell-owned
 * areas. The lists tab was called "Contacts" until the Contacts module (the
 * people you know) arrived — renamed so the two aren't confused; its id and
 * route stay. Contacts itself lives here since 2026-11-13 (owner: no separate
 * nav entry): tab id `people`, label "Contacts", route /m/email/people.
 */
export const EMAIL_TABS: readonly AreaTab[] = [
  // Your own mail first: /m/email lands here (plan/email-inbox.md S6, Contribute eb674853).
  { id: 'inbox', label: 'Inbox', href: '/m/email/inbox', match: ['/m/email/inbox'] },
  // The company-wide pending + sent log (the landing view until S6), owner and admins only.
  { id: 'company', label: 'Company mail', href: '/m/email/company' },
  // The people you know (the Contacts plugin), every member's own.
  { id: 'people', label: 'Contacts', href: '/m/email/people' },
  { id: 'contacts', label: 'Lists', href: '/m/email/contacts' },
  {
    id: 'setup',
    label: 'Setup',
    href: '/m/email/setup',
    match: EMAIL_SETUP_TABS.map((t) => t.href),
  },
]

/** The tabs this person sees: Company mail only for the owner and admins (its page refuses everyone else). */
export function emailTabs(viewer: { isAdmin: boolean }): readonly AreaTab[] {
  return viewer.isAdmin ? EMAIL_TABS : EMAIL_TABS.filter((t) => t.id !== 'company')
}
