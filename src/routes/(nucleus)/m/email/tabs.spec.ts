import { describe, expect, it } from 'vitest'
import { currentAreaTab } from '$lib/shell/area-nav'
import { EMAIL_SETUP_TABS, EMAIL_TABS } from './tabs'

describe('Email area tabs (your inbox first, setup behind one tab)', () => {
  it('shows mail first and puts the setup sections behind Setup', () => {
    expect(EMAIL_TABS.map((t) => t.label)).toEqual(['Inbox', 'Mail', 'Lists', 'Setup'])
    expect(EMAIL_SETUP_TABS.map((t) => t.label)).toEqual([
      'Account',
      'Domains',
      'Senders',
      'Mailboxes',
      'Templates',
      'Layouts',
      'Flows',
      'Logs',
      'Suppression',
      'API',
    ])
  })
  it('calls the audience lists "Lists" (people you know live in Contacts); the route stays', () => {
    expect(EMAIL_TABS.find((t) => t.id === 'contacts')).toEqual({ id: 'contacts', label: 'Lists', href: '/m/email/contacts' })
  })
  it.each([
    ['/m/email', 'mail'],
    ['/m/email/inbox', 'inbox'],
    ['/m/email/inbox/attachments/1', 'inbox'],
    ['/m/email/contacts/abc', 'contacts'],
    ['/m/email/setup', 'setup'],
    ['/m/email/domains/1', 'setup'],
    ['/m/email/senders', 'setup'],
    ['/m/email/mailboxes', 'setup'],
    ['/m/email/templates/1', 'setup'],
    ['/m/email/layouts', 'setup'],
    ['/m/email/flows/1', 'setup'],
    ['/m/email/logs/1', 'setup'],
    ['/m/email/suppression', 'setup'],
    ['/m/email/api', 'setup'],
  ] as const)('%s → %s', (path, id) => {
    expect(currentAreaTab(EMAIL_TABS, path)).toBe(id)
  })
  it.each([
    ['/m/email/setup', 'account'],
    ['/m/email/domains/1', 'domains'],
    ['/m/email/logs/1', 'logs'],
    ['/m/email/mailboxes', 'mailboxes'],
    ['/m/email/api', 'api'],
  ] as const)('setup section %s → %s', (path, id) => {
    expect(currentAreaTab(EMAIL_SETUP_TABS, path)).toBe(id)
  })
})
