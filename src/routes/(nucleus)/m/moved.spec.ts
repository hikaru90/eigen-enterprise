import { describe, expect, it } from 'vitest'
import { load as contacts } from './contacts/[...rest]/+page.server'
import { load as repos } from './repos/[...rest]/+page.server'

/** Old addresses keep working (owner, 2026-11-13): Contacts moved into Email, GitHub repos into Drive. */
const at = (load: typeof contacts | typeof repos, rest: string, url: string) => () =>
  load({ params: { rest }, url: new URL(url) } as never)

describe('moved pages redirect permanently', () => {
  it.each([
    [contacts, '', 'http://x/m/contacts', '/m/email/people'],
    [contacts, 'new', 'http://x/m/contacts/new', '/m/email/people/new'],
    [contacts, 'abc', 'http://x/m/contacts/abc?tab=1', '/m/email/people/abc?tab=1'],
    [repos, '', 'http://x/m/repos', '/drive/github'],
  ] as const)('%#: %s → %s', (load, rest, url, location) => {
    expect(at(load, rest, url)).toThrow(expect.objectContaining({ status: 308, location }))
  })
})
