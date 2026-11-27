import { describe, expect, it } from 'vitest'
import { currentAreaTab } from '$lib/shell/area-nav'
import {
  EMAIL_MARKETING_TABS,
  EMAIL_SETUP_TABS,
  EMAIL_TABS,
  emailMarketingTabs,
  emailTabs,
} from './tabs'

describe('Email area tabs (the three kinds of mail first, setup behind one tab)', () => {
  it('names the three kinds of mail — personal, transactional, marketing — then Contacts and Setup', () => {
    expect(EMAIL_TABS.map((t) => t.label)).toEqual([
      'Personal mail',
      'Transactional mail',
      'Marketing mail',
      'Contacts',
      'Setup',
    ])
    expect(EMAIL_SETUP_TABS.map((t) => t.label)).toEqual([
      'Account',
      'Senders',
      'Mailboxes',
      'Templates',
      'Layouts',
      'Logs',
      'Suppression',
      'Reputation',
      'API',
    ])
  })
  it('Marketing mail holds the lists, the flows on them and what they sent', () => {
    expect(EMAIL_MARKETING_TABS).toEqual([
      {
        id: 'lists',
        label: 'Lists',
        href: '/m/email/marketing/lists',
        match: ['/m/email/marketing/lists'],
      },
      { id: 'flows', label: 'Flows', href: '/m/email/marketing/flows' },
      { id: 'sent', label: 'Sent', href: '/m/email/marketing/sent' },
    ])
    expect(EMAIL_TABS.find((t) => t.id === 'marketing')).toEqual({
      id: 'marketing',
      label: 'Marketing mail',
      href: '/m/email/marketing/lists',
      match: ['/m/email/marketing'],
    })
  })
  it('what the flows sent is for the owner and admins only; every member sees the lists and flows', () => {
    expect(emailMarketingTabs({ isAdmin: true }).map((t) => t.id)).toEqual([
      'lists',
      'flows',
      'sent',
    ])
    expect(emailMarketingTabs({ isAdmin: false }).map((t) => t.id)).toEqual(['lists', 'flows'])
  })
  it('domains live under Account (no Domains tab since 2026-11-14)', () => {
    expect(EMAIL_SETUP_TABS[0]).toEqual({
      id: 'account',
      label: 'Account',
      href: '/m/email/setup',
      match: ['/m/email/domains'],
    })
  })
  it('Personal mail (the inbox) is where /m/email lands; Transactional mail is for the owner and admins only', () => {
    expect(EMAIL_TABS[0]).toEqual({
      id: 'inbox',
      label: 'Personal mail',
      href: '/m/email/inbox',
      match: ['/m/email/inbox'],
    })
    expect(EMAIL_TABS[1]).toEqual({
      id: 'transactional',
      label: 'Transactional mail',
      href: '/m/email/transactional',
    })
    expect(emailTabs({ isAdmin: true }).map((t) => t.id)).toEqual([
      'inbox',
      'transactional',
      'marketing',
      'people',
      'setup',
    ])
    expect(emailTabs({ isAdmin: false }).map((t) => t.id)).toEqual([
      'inbox',
      'marketing',
      'people',
      'setup',
    ])
  })
  it('has a Contacts tab (the people you know) — Contacts lives inside Email', () => {
    expect(EMAIL_TABS.find((t) => t.id === 'people')).toEqual({
      id: 'people',
      label: 'Contacts',
      href: '/m/email/people',
    })
  })
  it.each([
    ['/m/email/transactional', 'transactional'],
    ['/m/email/inbox', 'inbox'],
    ['/m/email/inbox/attachments/1', 'inbox'],
    ['/m/email/marketing/lists', 'marketing'],
    ['/m/email/marketing/lists/abc', 'marketing'],
    ['/m/email/marketing/flows/1', 'marketing'],
    ['/m/email/marketing/sent', 'marketing'],
    ['/m/email/people', 'people'],
    ['/m/email/people/new', 'people'],
    ['/m/email/people/abc', 'people'],
    ['/m/email/setup', 'setup'],
    ['/m/email/domains/1', 'setup'],
    ['/m/email/senders', 'setup'],
    ['/m/email/mailboxes', 'setup'],
    ['/m/email/templates/1', 'setup'],
    ['/m/email/layouts', 'setup'],
    ['/m/email/logs/1', 'setup'],
    ['/m/email/suppression', 'setup'],
    ['/m/email/reputation', 'setup'],
    ['/m/email/api', 'setup'],
  ] as const)('%s → %s', (path, id) => {
    expect(currentAreaTab(EMAIL_TABS, path)).toBe(id)
  })
  it.each([
    ['/m/email/setup', 'account'],
    ['/m/email/domains/1', 'account'],
    ['/m/email/domains', 'account'],
    ['/m/email/logs/1', 'logs'],
    ['/m/email/mailboxes', 'mailboxes'],
    ['/m/email/api', 'api'],
  ] as const)('setup section %s → %s', (path, id) => {
    expect(currentAreaTab(EMAIL_SETUP_TABS, path)).toBe(id)
  })
  it.each([
    ['/m/email/marketing/lists', 'lists'],
    ['/m/email/marketing/lists/abc', 'lists'],
    ['/m/email/marketing/flows', 'flows'],
    ['/m/email/marketing/flows/1', 'flows'],
    ['/m/email/marketing/sent', 'sent'],
  ] as const)('marketing section %s → %s', (path, id) => {
    expect(currentAreaTab(EMAIL_MARKETING_TABS, path)).toBe(id)
  })
})
