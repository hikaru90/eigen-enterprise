// End-to-end journey against an ee-installed box (ee/e2e/box.sh), driven in Chromium:
//   signup (first human = owner) → onboarding as it is → Settings → Hosting →
//   add the public website domain → public host serves only the website surface →
//   a second signup is refused (the company has an owner).
//
//   node ee/e2e/box-journey.mjs https://os.ee.localhost www.ee.localhost
//
// The box uses Caddy's local CA for reserved TLDs, so certificate errors are ignored here only.
import { chromium } from 'playwright'

const [, , consoleUrl = 'https://os.ee.localhost', publicHost = 'www.ee.localhost'] = process.argv
const headless = process.env.HEADED !== '1'
const email = process.env.OWNER_EMAIL ?? `owner-${Date.now()}@kindred.test`

function step(s) {
  console.log(`→ ${s}`)
}
function assert(cond, msg) {
  if (!cond) throw new Error(`✗ ${msg}`)
}

const browser = await chromium.launch({ headless })
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: consoleUrl })
  const page = await ctx.newPage()

  step('owner signs up (passwordless: email → emailed code)')
  await page.goto('/signup')
  await page.getByRole('button', { name: 'Create account' }).waitFor()
  await page.locator('#email').fill(email)
  await page.getByRole('checkbox', { name: /Terms of Service|AGB/i }).check()
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByTestId('auth-code-step').waitFor({ timeout: 30_000 })
  // Production boxes have no code harness: the code arrives by email. Pass it in to continue.
  const code = process.env.OWNER_CODE ?? (await new Promise((r) => {
    process.stdout.write(`  code emailed to ${email} — enter it: `)
    process.stdin.once('data', (d) => r(String(d).trim()))
  }))
  await page.locator('#code').fill(code)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL(/\/(\?|#|$)/, { timeout: 30_000 })

  step('the onboarding boot sequence greets the owner (unchanged)')
  await page.getByTestId('welcome-wizard').waitFor({ timeout: 30_000 })
  const begin = page.getByRole('button', { name: 'Begin' })
  if (await begin.isVisible({ timeout: 20_000 }).catch(() => false)) await begin.click()
  const nameAsk = page.getByRole('textbox', { name: 'Your name' })
  if (await nameAsk.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await nameAsk.fill('Alex')
    await nameAsk.press('Enter')
  }
  await page.screenshot({ path: 'dist/box-onboarding.png' })
  await page.getByTestId('skip-onboarding').click()
  await page.getByTestId('welcome-wizard').waitFor({ state: 'hidden', timeout: 15_000 })

  step('Settings → Hosting shows this server, managed by ee')
  await page.goto('/settings/hosting')
  await page.getByTestId('hosting-domains').waitFor()
  assert(!(await page.getByTestId('hosting-unmanaged').isVisible()), 'hosting page says the box is not managed by ee')
  const consoleHost = new URL(consoleUrl).hostname
  assert(await page.getByTestId('hosting-domains').getByText(consoleHost).isVisible(), `console host ${consoleHost} not listed`)

  step(`owner adds ${publicHost} as the public website`)
  await page.locator('input[name="host"]').fill(publicHost)
  await page.locator('select[name="role"]').selectOption('public')
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByTestId('hosting-feedback-addDomain').waitFor({ timeout: 120_000 })
  const feedback = await page.getByTestId('hosting-feedback-addDomain').innerText()
  assert(feedback === 'Done.', `adding the domain failed: ${feedback}`)
  await page.reload()
  assert(await page.getByTestId('hosting-domains').getByText(publicHost).isVisible(), `${publicHost} not listed after adding`)
  await page.screenshot({ path: 'dist/box-hosting.png', fullPage: true })

  step('the public host serves only the website surface')
  const pub = await browser.newContext({ ignoreHTTPSErrors: true })
  const r1 = await pub.request.get(`https://${publicHost}/login`, { maxRedirects: 0 })
  assert(r1.status() === 404, `public host must not serve /login (got ${r1.status()})`)
  const r2 = await pub.request.get(`https://${publicHost}/api/health`, { maxRedirects: 0 })
  assert(r2.status() === 404, `public host must not serve /api/health (got ${r2.status()})`)
  const r3 = await pub.request.get(`https://${publicHost}/`, { maxRedirects: 0 })
  assert([200, 404].includes(r3.status()), `public root reaches the website module (got ${r3.status()})`)
  console.log(`  public "/" → ${r3.status()} (${r3.status() === 404 ? 'no published home page yet' : 'home page'})`)

  step('a second signup is refused: the company already has an owner')
  const other = await (await browser.newContext({ ignoreHTTPSErrors: true, baseURL: consoleUrl })).newPage()
  await other.goto('/signup')
  await other.getByRole('button', { name: 'Create account' }).waitFor()
  // Without the stranger's inbox we can only check the code step does not let anyone in by itself.
  await other.locator('#email').fill(`stranger-${Date.now()}@example.test`)
  await other.getByRole('checkbox', { name: /Terms of Service|AGB/i }).check()
  await other.getByRole('button', { name: 'Create account' }).click()
  await other.waitForTimeout(3000)
  assert(new URL(other.url()).pathname === '/signup', `stranger was let in (now at ${other.url()})`)

  console.log('✓ box journey passed')
} finally {
  await browser.close()
}
