import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser, signOut } from './test-helpers'

/**
 * T1 proof (plan/phase-workspace.md): invite link → passkey, no email.
 * An admin creates an invite link and copies it; member B opens it in a
 * second browser context (CDP virtual WebAuthn authenticator — real
 * WebAuthn, no bypass), joins, creates a passkey, signs out and back in with
 * the passkey. The admin puts B in a new group "Sales", then removes B — B's
 * session is gone. Screenshots: TEAM_SHOTS (default test-results/team).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey promotes its admin in the test DB')

const SHOTS = process.env.TEAM_SHOTS ?? 'test-results/team'

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newAdmin(context: BrowserContext, page: Page): Promise<string> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const updated = await sql()`
    update "user" set role = 'admin', onboarding_completed = true where email = ${email} returning id`
  if (updated.length !== 1) throw new Error(`could not promote ${email} to admin`)
  return email
}

async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

test('invite link → passkey (no email) → group → remove ends the session', async ({ browser }) => {
  test.setTimeout(180_000)
  await sql()`delete from member_group where lower(name) = 'sales'`

  // ── Admin A invites B and copies the link ──
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ownerCtx.grantPermissions(['clipboard-read', 'clipboard-write'])
  const owner = await ownerCtx.newPage()
  await newAdmin(ownerCtx, owner)

  const bEmail = `member-b-${Date.now()}@kindred-e2e.example`
  await owner.goto('/settings/members')
  await expect(owner.getByTestId('members-roles')).toContainText('Owner')
  await expect(owner.getByTestId('members-roles')).toContainText('Admin')
  await expect(owner.getByTestId('members-roles')).toContainText('Member')
  await owner.locator('#invite-email').fill(bEmail)
  await owner.locator('#invite-role').selectOption('member')
  await owner.getByRole('button', { name: 'Create invite link' }).click()
  const linkBox = owner.getByTestId('invite-link')
  await expect(linkBox).toContainText(bEmail)
  await owner.getByTestId('invite-link-copy').click()
  await expect(owner.getByTestId('invite-link-copy')).toHaveText('Copied')
  const inviteUrl = await owner.evaluate(() => navigator.clipboard.readText())
  expect(inviteUrl).toMatch(/\/invite\?token=[A-Za-z0-9_-]{20,}$/)
  await expect(owner.getByTestId('invite-link-url')).toHaveValue(inviteUrl)
  await owner.screenshot({ path: `${SHOTS}/1-owner-invite-link.png`, fullPage: true })

  // ── B opens the link in their own browser, joins, creates a passkey ──
  const bCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const b = await bCtx.newPage()
  await addVirtualAuthenticator(bCtx, b)
  await b.goto(inviteUrl)
  await expect(b.getByRole('heading', { level: 1 })).toContainText('Join')
  await expect(b.getByTestId('invite-start')).toContainText(bEmail)
  await b.screenshot({ path: `${SHOTS}/2-member-invite.png`, fullPage: true })
  await b.locator('#invite-name').fill('Bea Member')
  await b.getByTestId('invite-join').click()
  await expect(b.getByTestId('invite-passkey-step')).toBeVisible()
  await b.screenshot({ path: `${SHOTS}/3-member-passkey-step.png`, fullPage: true })
  // No email was sent to B at any point (W-4).
  const mails = await sql()`select 1 from mail_fake_sent where to_address = ${bEmail}`
  expect(mails.length).toBe(0)
  await b.getByTestId('invite-create-passkey').click()
  await b.waitForURL((u) => !u.pathname.startsWith('/invite'), { timeout: 30_000 })

  const [bRow] = await sql()`select id, role, name from "user" where email = ${bEmail}`
  expect(bRow).toMatchObject({ role: 'member', name: 'Bea Member' })
  const pk = await sql()`select id from passkey where user_id = ${bRow!.id}`
  expect(pk.length).toBe(1)

  // ── B signs out and back in with the passkey ──
  await signOut(b)
  const me1 = await b.request.get('/api/auth/get-session')
  expect(await me1.json()).toBeNull()
  await b.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await b.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 })
  const me2 = (await (await b.request.get('/api/auth/get-session')).json()) as { user: { email: string } }
  expect(me2.user.email).toBe(bEmail)
  await b.screenshot({ path: `${SHOTS}/4-member-signed-in-with-passkey.png`, fullPage: true })

  // ── A creates the group "Sales" with B ──
  await owner.goto('/settings/members')
  await expect(owner.getByTestId('member-row').filter({ hasText: bEmail })).toBeVisible()
  const create = owner.getByTestId('group-create')
  await create.locator('#new-group-name').fill('Sales')
  await create.locator('#new-group-desc').fill('Everyone who sells')
  await create.getByLabel('Bea Member').check()
  await create.getByRole('button', { name: 'Create group' }).click()
  const salesRow = owner.getByTestId('group-row').filter({ hasText: 'Sales' })
  await expect(salesRow.getByTestId('group-members')).toHaveText('Bea Member')
  await salesRow.locator('summary').click()
  await owner.screenshot({ path: `${SHOTS}/5-owner-group-sales.png`, fullPage: true })
  const created = await sql()`select type, payload from kernel_events where type = 'members.group_created' and payload->>'name' = 'Sales' order by ts desc limit 1`
  expect(created.length).toBe(1)

  // ── A removes B: B's sessions end ──
  const sessionsBefore = await sql()`select id from session where user_id = ${bRow!.id}`
  expect(sessionsBefore.length).toBeGreaterThan(0)
  await owner.getByTestId('member-row').filter({ hasText: bEmail }).getByRole('button', { name: 'Remove' }).click()
  await expect(owner.getByTestId('member-row').filter({ hasText: bEmail })).toHaveCount(0)
  await expect(salesRow.getByTestId('group-members')).toHaveText('No members yet')
  await owner.screenshot({ path: `${SHOTS}/6-owner-after-remove.png`, fullPage: true })
  const sessionsAfter = await sql()`select id from session where user_id = ${bRow!.id}`
  expect(sessionsAfter.length).toBe(0)

  const me3 = await b.request.get('/api/auth/get-session')
  expect(await me3.json()).toBeNull()
  await b.goto('/settings/passkeys')
  await b.waitForURL(/\/login/)
  await b.screenshot({ path: `${SHOTS}/7-member-session-gone.png`, fullPage: true })

  // Cleanup: the group (B is already gone).
  await sql()`delete from member_group where lower(name) = 'sales'`
  await ownerCtx.close()
  await bCtx.close()
})
