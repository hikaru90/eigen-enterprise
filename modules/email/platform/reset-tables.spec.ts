import { describe, expect, it } from 'vitest'
import { mailboxes } from '$lib/server/db/inbox.schema'
import { mailDomains } from '$lib/server/db/email.schema'
import { EMAIL_PLATFORM_TABLES } from './store'

describe('the e2e email reset (MAIL_TRANSPORT=fake)', () => {
  it('clears mailboxes before domains: mailbox_addresses.domain_id is ON DELETE RESTRICT', () => {
    const tables: readonly unknown[] = EMAIL_PLATFORM_TABLES
    expect(tables).toContain(mailboxes)
    expect(tables.indexOf(mailboxes)).toBeLessThan(tables.indexOf(mailDomains))
  })
})
