/**
 * The three kinds of mail (Contribute d7080d17; owner 2026-11-16: "those are the 3 pillars of mailings. and they
 * have real life and legal consequences and differentiations"). The Email area is grouped by them; each tab says
 * in one line what it holds, and the info pop-over (mail-kinds-info.svelte) states the rules in plain words.
 * Every rule here describes what the product does today (mailbox privacy: mailboxes page; one-click unsubscribe
 * headers and the {{ unsubscribe_url }} variable: modules/email/platform/flows/service.ts; the suppression list:
 * modules/email/platform/suppression.ts) or what the law asks of the sender.
 */
export type MailKind = 'personal' | 'transactional' | 'marketing'

export const MAIL_KIND_ORDER: readonly MailKind[] = ['personal', 'transactional', 'marketing']

export const MAIL_KINDS: Record<MailKind, { label: string; line: string; rules: readonly string[] }> = {
  personal: {
    label: 'Personal mail',
    line: 'Mail between people: your own inbox and the mailboxes you share, like info@.',
    rules: [
      'One person writes to another. It is confidential: only the mailbox’s owner — or, for a shared address, its group — can read it. Not even the company owner or admins can open someone else’s mailbox.',
      'Writing to someone you have a reason to write to — a reply, an offer they asked for — is fine. Sending the same advertising to many people from your inbox is marketing mail, and its rules apply.',
    ],
  },
  transactional: {
    label: 'Transactional mail',
    line: 'Automatic mail the company sends because someone did something: sign-in codes, receipts, confirmations, notifications.',
    rules: [
      'The recipient caused it and needs it, so no consent is needed — a password reset or a receipt has to arrive.',
      'It must contain no advertising. Add an offer or a newsletter teaser and it counts as marketing mail, which needs consent.',
      'Addresses on the suppression list (hard bounces, spam complaints) still get nothing.',
    ],
  },
  marketing: {
    label: 'Marketing mail',
    line: 'Newsletters and campaigns to your lists — only for people who agreed to get them.',
    rules: [
      'Only to people who agreed beforehand. In Germany and the EU that is the law (UWG §7, GDPR/DSGVO): without prior consent, advertising mail can cost a warning letter (Abmahnung) or a fine. Turn on double opt-in for a list so you can prove each consent.',
      'Every mail lets people unsubscribe: mail from a flow carries a one-click unsubscribe that mail apps show as a button; put {{ unsubscribe_url }} in the template for a visible link too. Whoever unsubscribes gets no more mail from that list.',
      'Addresses on the suppression list never get mail.',
    ],
  },
}

/** The kind of mail an Email tab shows; Contacts and Setup show none. */
export function mailKindOfTab(tab: string | null): MailKind | null {
  if (tab === 'inbox') return 'personal'
  if (tab === 'transactional') return 'transactional'
  if (tab === 'marketing') return 'marketing'
  return null
}
