import type { AreaTab } from '$lib/shell/area-nav'

/**
 * The setup sections: SES account (with its domains), senders, mailboxes (receiving addresses), templates, layouts,
 * logs, suppression, the API. Domains were their own tab until 2026-11-14 (owner: "shouldn't that be inside of account?"):
 * they are listed and added under Account now; a domain's DNS page stays at /m/email/domains/<id>. Flows moved to
 * Marketing mail on 2026-11-16 (Contribute d7080d17). Templates and layouts stay here: both transactional and
 * marketing mail use them.
 */
export const EMAIL_SETUP_TABS: readonly AreaTab[] = [
  { id: 'account', label: 'Account', href: '/m/email/setup', match: ['/m/email/domains'] },
  { id: 'senders', label: 'Senders', href: '/m/email/senders' },
  { id: 'mailboxes', label: 'Mailboxes', href: '/m/email/mailboxes' },
  { id: 'templates', label: 'Templates', href: '/m/email/templates' },
  { id: 'layouts', label: 'Layouts', href: '/m/email/layouts' },
  { id: 'logs', label: 'Logs', href: '/m/email/logs' },
  { id: 'suppression', label: 'Suppression', href: '/m/email/suppression' },
  { id: 'api', label: 'API', href: '/m/email/api' },
]

/**
 * Marketing mail's sections (2026-11-16, Contribute d7080d17): the lists people opted into (was the Lists tab at
 * /m/email/contacts), the flows that mail them (was Setup › Flows at /m/email/flows) and what those flows sent.
 */
export const EMAIL_MARKETING_TABS: readonly AreaTab[] = [
  { id: 'lists', label: 'Lists', href: '/m/email/marketing/lists', match: ['/m/email/marketing/lists'] },
  { id: 'flows', label: 'Flows', href: '/m/email/marketing/flows' },
  { id: 'sent', label: 'Sent', href: '/m/email/marketing/sent' },
]

/**
 * The Email area's sections, grouped by the three kinds of mail — they differ in law and in practice
 * (Contribute d7080d17, owner 2026-11-16: "those are the 3 pillars of mailings"):
 * - Personal mail: person-to-person, the inbox (was "Inbox"; /m/email lands here, plan/email-inbox.md S6).
 * - Transactional mail: the automatic mail the company sends because of something the recipient did
 *   (was "Company mail" at /m/email/company; owner and admins only).
 * - Marketing mail: lists, the flows on them and what they sent (was the "Lists" tab and Setup › Flows).
 * Then Contacts (the people you know; tab id `people`, route /m/email/people, here since 2026-11-13) and
 * everything about how mail is set up behind one Setup tab. Kept beside the routes: the shell's area-nav
 * lists only the shell-owned areas.
 */
export const EMAIL_TABS: readonly AreaTab[] = [
  { id: 'inbox', label: 'Personal mail', href: '/m/email/inbox', match: ['/m/email/inbox'] },
  { id: 'transactional', label: 'Transactional mail', href: '/m/email/transactional' },
  { id: 'marketing', label: 'Marketing mail', href: '/m/email/marketing/lists', match: ['/m/email/marketing'] },
  { id: 'people', label: 'Contacts', href: '/m/email/people' },
  {
    id: 'setup',
    label: 'Setup',
    href: '/m/email/setup',
    match: EMAIL_SETUP_TABS.flatMap((t) => [t.href, ...(t.match ?? [])]),
  },
]

/** The tabs this person sees: Transactional mail only for the owner and admins (its page refuses everyone else). */
export function emailTabs(viewer: { isAdmin: boolean }): readonly AreaTab[] {
  return viewer.isAdmin ? EMAIL_TABS : EMAIL_TABS.filter((t) => t.id !== 'transactional')
}

/** Marketing mail's sections for this person: what the flows sent is for the owner and admins only, like transactional mail. */
export function emailMarketingTabs(viewer: { isAdmin: boolean }): readonly AreaTab[] {
  return viewer.isAdmin ? EMAIL_MARKETING_TABS : EMAIL_MARKETING_TABS.filter((t) => t.id !== 'sent')
}
