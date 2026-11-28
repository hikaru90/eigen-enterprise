import { expect, test, type BrowserContext, type Page } from './e2e-test'
import postgres from 'postgres'
import { completeProfileViaApi, gotoHydrated, profileNames, registerUser } from './test-helpers'

/**
 * Multiplayer presence (plan/phase-multiplayer-presence.md) with TWO members
 * in two browser contexts: B sits in Messages; A navigates to Drive → B's
 * sidebar shows A on the Drive entry, its name says so; A moves on to
 * Messages → A leaves the Drive stack and "Here with you" on B's top bar
 * names A.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its users in the test DB')

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newMember(context: BrowserContext, page: Page, name: string): Promise<void> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = 'member', name = ${name}, account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not prepare ${email}`)
  await completeProfileViaApi(page, profileNames(name))
}

test('Presence: A navigates, B sees where A is', async ({ browser }) => {
  test.setTimeout(120_000)
  const run = Date.now().toString(36)
  const nameA = `Ada Here ${run}`
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await newMember(ctxA, a, nameA)
  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await newMember(ctxB, b, `Ben Watch ${run}`)

  await gotoHydrated(b, '/messages')
  await gotoHydrated(a, '/drive')
  await expect(b.getByTestId('shell-sidebar').getByTestId('shell-nav-presence-drive')).toHaveAccessibleName(new RegExp(`^In Drive: .*${nameA}`), { timeout: 15_000 })

  await gotoHydrated(a, '/messages')
  await expect(b.getByTestId('shell-here-with-you')).toHaveAccessibleName(new RegExp(`Here with you: .*${nameA}`), { timeout: 15_000 })
  const aInDrive = b.getByTestId('shell-sidebar').getByRole('button', { name: new RegExp(`^In Drive: .*${nameA}`) })
  await expect(aInDrive).toHaveCount(0)

  await ctxA.close()
  await ctxB.close()
})
