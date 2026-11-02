// W1 owner journey (plan/phase-module-readiness.md §2) against an ee-installed box
// (ee/e2e/box.sh), driven in Chromium through the real console — no API shortcuts:
//
//   claim (or reuse a saved owner session) → connect a PUBLIC repo → deploy → health →
//   open the app on its own host → env var + secret → Redeploy → logs + deploy history →
//   per-app mail access → change the app's domain → remove the app.
//
//   node ee/e2e/box-journey.mjs
//
// Env:
//   CONSOLE_URL   console origin                   (default https://os.ee.localhost)
//   CLAIM_URL     claim link from `ee claim-link`  (claims the box as OWNER_EMAIL)
//   OWNER_STATE   Playwright storageState file; reused when it exists, written after a claim
//   OWNER_EMAIL   claim e-mail                     (default owner@ee.localhost)
//   REPO_URL      public repo to deploy            (default heroku/node-js-getting-started)
//   APP_NAME      app name                         (default journey-<random>)
//   SHOTS         screenshot directory             (default dist/box-journey)
//   HEADED=1      watch it
//
// Neither CLAIM_URL nor OWNER_STATE → fails before touching the box. The box uses
// Caddy's local CA for reserved TLDs, so certificate errors are ignored here only.
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const consoleUrl = process.env.CONSOLE_URL ?? 'https://os.ee.localhost'
const claimUrl = process.env.CLAIM_URL
const ownerState = process.env.OWNER_STATE
const email = process.env.OWNER_EMAIL ?? 'owner@ee.localhost'
const repoUrl = process.env.REPO_URL ?? 'https://github.com/heroku/node-js-getting-started'
const appName = process.env.APP_NAME ?? `journey-${Date.now().toString(36).slice(-5)}`
const shots = path.resolve(process.env.SHOTS ?? 'dist/box-journey')
const headless = process.env.HEADED !== '1'
const DEPLOY_TIMEOUT = 15 * 60_000

if (!claimUrl && !(ownerState && existsSync(ownerState))) {
  console.error('need CLAIM_URL (ee claim-link) or an existing OWNER_STATE file')
  process.exit(2)
}
mkdirSync(shots, { recursive: true })

let n = 0
const results = []
let current = ''
function step(s) {
  current = s
  console.info(`→ ${s}`)
}
function pass() {
  results.push({ step: current, ok: true })
}
function assert(cond, msg) {
  if (!cond) throw new Error(`✗ ${msg}`)
}
async function shot(page, label) {
  const file = path.join(shots, `${String(++n).padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.info(`  shot ${file}`)
}
/** The app page's settings live in a <details>; open it before using them. */
async function openSettings(page) {
  const details = page.locator('details', { has: page.getByText('App settings', { exact: true }) })
  if (!(await details.evaluate((d) => d.open))) {
    await details.locator('summary').click()
  }
}
/** Waits for the deploy panel to settle; a failed deploy fails the step with its own words. */
async function waitDeploy(page) {
  const panel = page.locator(
    '[data-testid="deploy-progress"][data-state="live"], [data-testid="deploy-progress"][data-state="failed"]',
  )
  await panel.first().waitFor({ timeout: DEPLOY_TIMEOUT })
  if ((await panel.first().getAttribute('data-state')) === 'failed') {
    throw new Error(`✗ deploy failed: ${await panel.first().innerText()}`)
  }
}
/** Every form on the app page answers with role=status (message) or role=alert (error). */
async function formAnswer(page) {
  const answer = page.locator('header [role="status"], header [role="alert"]').first()
  await answer.waitFor({ timeout: 120_000 })
  return { ok: (await answer.getAttribute('role')) === 'status', text: await answer.innerText() }
}

const browser = await chromium.launch({ headless })
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  baseURL: consoleUrl,
  viewport: { width: 1280, height: 900 },
  ...(ownerState && existsSync(ownerState) && !claimUrl ? { storageState: ownerState } : {}),
})
const page = await ctx.newPage()
let appHost
try {
  if (claimUrl) {
    step(`claim the box as ${email}`)
    await page.goto(claimUrl)
    await page.getByTestId('claim-form').waitFor()
    await shot(page, 'claim')
    await page.locator('#email').fill(email)
    await page.getByRole('button', { name: 'Claim' }).click()
    await page.waitForURL((u) => u.pathname !== '/claim', { timeout: 60_000 })
    if (ownerState) await ctx.storageState({ path: ownerState })
    pass()
  }

  step('Website → Add an app: connect a public repo by link')
  await page.goto('/m/website/apps/new')
  await page.getByTestId('step-repository').waitFor()
  await page.locator('#repo-link').fill(repoUrl)
  await page.getByTestId('check-link').click()
  await page.getByTestId('step-access').waitFor({ timeout: 60_000 })
  assert(
    /Public repo/.test(await page.getByTestId('access-badge').innerText()),
    'access step does not call it a public repo',
  )
  await shot(page, 'access-public')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByTestId('step-app').waitFor({ timeout: 60_000 })
  pass()

  step(`configure + deploy as "${appName}"`)
  await page.locator('#app-name').fill(appName)
  appHost = await page.locator('#app-host').inputValue()
  assert(appHost.length > 0, 'no domain suggested for a web app')
  await page.getByText('Build settings', { exact: true }).click()
  await page.getByText(/This repo has no ee.json/).click()
  const form = page.locator('form[action="?/deploy"]')
  const runtime = form.locator('select[name="runtime"]')
  await runtime.selectOption(await runtime.locator('option').first().getAttribute('value'))
  await form.locator('input[name="health"]').fill('/')
  await form.locator('input[name="install"]').fill('npm ci')
  await form.locator('input[name="start"]').fill('node index.js')
  await shot(page, 'app-form')
  await form.getByRole('button', { name: 'Deploy' }).click()
  pass()

  step('the deploy passes the health gate and goes live')
  await waitDeploy(page).finally(() => shot(page, 'deployed'))
  await page.getByTestId('open-app').click()
  await page.waitForURL(new RegExp(`/m/website/apps/${appName}$`))
  pass()

  step('the app page says pushes need a Redeploy (D-3)')
  assert(
    /press Redeploy after you push/.test(await page.getByTestId('deploy-mode').innerText()),
    'D-3 copy missing on a public-repo app',
  )
  await shot(page, 'app-page')
  pass()

  step(`open the app on https://${appHost}`)
  const appPage = await ctx.newPage()
  const r = await appPage.goto(`https://${appHost}/`)
  assert(r && r.status() === 200, `app host answered ${r?.status()}`)
  await shot(appPage, 'app-served')
  await appPage.close()
  pass()

  step('set an environment variable')
  await openSettings(page)
  await page.getByLabel('Variable name').fill('JOURNEY_FLAG')
  await page.getByLabel('Variable value').fill('on')
  await page.getByRole('button', { name: 'Set', exact: true }).click()
  let a = await formAnswer(page)
  assert(a.ok, `env: ${a.text}`)
  await page.getByText('JOURNEY_FLAG').first().waitFor()
  pass()

  step('set a secret (same sealed store, value never shown again)')
  await page.reload()
  await openSettings(page)
  await page.getByLabel('Variable name').fill('JOURNEY_TOKEN')
  await page.getByLabel('Variable value').fill('s3cret-value')
  await page.getByRole('button', { name: 'Set', exact: true }).click()
  a = await formAnswer(page)
  assert(a.ok, `secret: ${a.text}`)
  await page.reload()
  await openSettings(page)
  const names = (await page.getByTestId('env-names').innerText()).split('\n').join(' ')
  for (const k of ['JOURNEY_FLAG', 'JOURNEY_TOKEN']) {
    assert(names.split(k).length === 2, `${k} must be listed exactly once (got: ${names})`)
  }
  assert(!(await page.content()).includes('s3cret-value'), 'secret value echoed on the page')
  await shot(page, 'env-secret')
  pass()

  step('Redeploy and wait for live')
  await page.reload()
  // Same head + same config is a no-op by design (ee is desired-state): the panel must still
  // settle on live, never hang or fail.
  await page.getByRole('button', { name: 'Redeploy' }).click()
  await waitDeploy(page).finally(() => shot(page, 'redeployed'))
  await page.reload()
  pass()

  step('logs and deploy history are shown')
  assert((await page.getByTestId('deploy-history').innerText()).trim().length > 0, 'empty history')
  assert((await page.getByTestId('app-logs').innerText()).trim().length > 0, 'empty logs')
  await shot(page, 'logs-history')
  pass()

  step('allow the app to send email')
  await openSettings(page)
  await page.getByRole('button', { name: 'Allow this app to send email' }).click()
  await page.getByRole('button', { name: 'Turn off' }).waitFor({ timeout: 120_000 })
  await shot(page, 'mail-on')
  pass()

  const newHost = `${appName}-2.${appHost.split('.').slice(1).join('.')}`
  step(`change the app's domain to ${newHost}`)
  await page.reload()
  await openSettings(page)
  await page.getByLabel(`Replace ${appHost}`).fill(newHost)
  await page.getByLabel(`Replace ${appHost}`).press('Enter')
  a = await formAnswer(page)
  assert(a.ok, `domain: ${a.text}`)
  await page.reload()
  await openSettings(page)
  await page.getByText(newHost, { exact: true }).first().waitFor()
  const served = await ctx.request.get(`https://${newHost}/`)
  assert(served.status() === 200, `new host answered ${served.status()}`)
  await shot(page, 'domain-changed')
  appHost = newHost
  pass()

  step('remove the app')
  await openSettings(page)
  await page.getByRole('button', { name: 'Remove this app…' }).click()
  await page.getByRole('button', { name: 'Remove app' }).click()
  await page.waitForURL((u) => !u.pathname.endsWith(`/apps/${appName}`), { timeout: 120_000 })
  await shot(page, 'removed')
  const gone = await ctx.request.get(`https://${appHost}/`, { maxRedirects: 0 })
  assert(gone.status() !== 200, `removed app still served (${gone.status()})`)
  pass()

  console.info('✓ box journey passed')
} catch (e) {
  results.push({ step: current, ok: false, error: String(e?.message ?? e) })
  await shot(page, 'FAILED').catch(() => {})
  console.error(e)
  process.exitCode = 1
} finally {
  for (const r of results) {
    console.info(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}${r.error ? `  — ${r.error}` : ''}`)
  }
  await browser.close()
}
