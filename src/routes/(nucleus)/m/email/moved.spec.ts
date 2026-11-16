import { describe, expect, it } from 'vitest'

/**
 * The Email area regrouped around the three kinds of mail (Contribute d7080d17, 2026-11-16):
 * Company mail → Transactional mail, Lists and Flows → Marketing mail. Old links keep working.
 */
const company = await import('./company/[...rest]/+page.server')
const contacts = await import('./contacts/[...rest]/+page.server')
const flows = await import('./flows/[...rest]/+page.server')
const marketing = await import('./marketing/+page.server')

const location = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e as { status: number; location: string }
  }
  throw new Error('expected a redirect')
}
const at = (rest: string, search = '') => ({ params: { rest }, url: new URL(`https://os.test/x${search}`) }) as never

describe('moved Email pages', () => {
  it.each([
    [company, '', '', '/m/email/transactional'],
    [contacts, '', '', '/m/email/marketing/lists'],
    [contacts, 'abc', '?tab=pending', '/m/email/marketing/lists/abc?tab=pending'],
    [flows, '', '', '/m/email/marketing/flows'],
    [flows, 'f1', '', '/m/email/marketing/flows/f1'],
  ] as const)('%# %s%s → %s', (mod, rest, search, want) => {
    expect(location(() => mod.load(at(rest, search)))).toMatchObject({ status: 308, location: want })
  })
  it('/m/email/marketing opens its lists', () => {
    expect(location(() => marketing.load(at('', '?x=1')))).toMatchObject({ status: 307, location: '/m/email/marketing/lists?x=1' })
  })
})
