import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import path from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * Settings → Backups end to end (plan/phase-backups.md K2), against a REAL
 * S3 (MinIO) and ee's real backup engine:
 *
 *   owner sets up the bucket → Test connection ok → Save → sees the recovery
 *   code exactly once (confirm checkbox) → Back up now → the run shows as
 *   succeeded → the objects are in the bucket → `ee restore --verify` with
 *   that recovery code decrypts and checks the snapshot. Members never see
 *   the page.
 *
 * ee runs as ee/e2e/backup-harness.ts on EE_CONTROL_SOCKET (the dev server
 * reads the same variable). Needs, besides DATABASE_URL:
 *   EE_CONTROL_SOCKET=<tmp>/ee.sock
 *   E2E_S3_ENDPOINT=http://127.0.0.1:9311 E2E_S3_ACCESS_KEY=… E2E_S3_SECRET_KEY=…
 *   (a MinIO: see ee/src/backup/minio.spec.ts for the container)
 *   E2E_PG_DUMP='["docker","exec","eigen-enterprise-db","pg_dump","--format=custom","-U","eigen","eigen"]'
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
const SOCKET = process.env.EE_CONTROL_SOCKET?.trim()
const S3 = process.env.E2E_S3_ENDPOINT?.trim()
const AK = process.env.E2E_S3_ACCESS_KEY?.trim() ?? ''
const SK = process.env.E2E_S3_SECRET_KEY?.trim() ?? ''
const PG_DUMP = process.env.E2E_PG_DUMP?.trim()

test.skip(
  !DATABASE_URL || !SOCKET || !S3 || !PG_DUMP,
  'needs DATABASE_URL, EE_CONTROL_SOCKET, E2E_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY and E2E_PG_DUMP (see the header)',
)

const ROOT = process.cwd()
const OUT = path.resolve('test-results/backups-e2e')
const SHOTS = path.resolve('test-results/backups-e2e/shots')
const BUCKET = 'ee-e2e-backups'
const PREFIX = `run-${Date.now()}`

let harness: ChildProcess | null = null
let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
let previousOwner: string | null = null
let ourOwner: string | null = null

function harnessGet(p: string): Promise<{ objects: Array<{ key: string; size: number }> }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: SOCKET, path: p, method: 'GET' }, (res) => {
      let raw = ''
      res.on('data', (d) => (raw += String(d)))
      res.on('end', () => resolve(JSON.parse(raw)))
    })
    req.on('error', reject)
    req.end()
  })
}

test.beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  // ee: the harness and the real CLI, bundled like ee.mjs.
  const esbuild = path.join(ROOT, 'ee/node_modules/.bin/esbuild')
  const banner = "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  execFileSync(esbuild, ['ee/e2e/backup-harness.ts', '--bundle', '--platform=node', '--target=node22', '--format=esm', `--outfile=${OUT}/harness.mjs`, banner], { cwd: ROOT })
  execFileSync(esbuild, ['ee/src/main.ts', '--bundle', '--platform=node', '--target=node22', '--format=esm', `--outfile=${OUT}/ee.mjs`, banner], { cwd: ROOT })
  // The bucket exists at the provider before the owner enters it (creating it is not ee's job).
  execFileSync('curl', ['-sS', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${AK}:${SK}`, '-X', 'PUT', `${S3}/${BUCKET}`])
  // At least one Drive blob in the harness's Drive dir, so blobs/<sha> is exercised.
  const drive = process.env.DRIVE_STORAGE_DIR ?? path.resolve('test-results/ee-drive')
  const content = Buffer.from(`backups e2e ${PREFIX}`)
  const sha = createHash('sha256').update(content).digest('hex')
  mkdirSync(path.join(drive, 'blobs', sha.slice(0, 2), sha.slice(2, 4)), { recursive: true })
  writeFileSync(path.join(drive, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha), content)
  const agentDb = path.join(process.env.EE_AGENT_STATE_DIR ?? path.resolve('test-results/ee-agent-state'), 'agent.sqlite')
  harness = spawn(process.execPath, [`${OUT}/harness.mjs`, SOCKET!, path.join(OUT, 'work'), PG_DUMP!, drive, agentDb], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    harness!.stdout!.on('data', (d) => String(d).includes('listening') && resolve())
    harness!.on('exit', (code) => reject(new Error(`backup harness exited ${code}`)))
  })
})

test.afterAll(async () => {
  harness?.kill('SIGTERM')
  if (ourOwner) await sql()`update "user" set role = 'admin' where id = ${ourOwner}`
  if (previousOwner) await sql()`update "user" set role = 'owner' where id = ${previousOwner}`
  await _sql?.end()
})

/** The single-owner index: the current owner (if any) steps aside for this run and is put back after. */
async function becomeOwner(context: BrowserContext, page: Page): Promise<void> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const [prev] = await sql()`select id from "user" where role = 'owner'`
  if (prev) {
    previousOwner = prev.id as string
    await sql()`update "user" set role = 'admin' where id = ${previousOwner}`
  }
  const [me] = await sql()`update "user" set role = 'owner' where email = ${email} returning id`
  if (!me) throw new Error(`could not make ${email} the owner`)
  ourOwner = me.id as string
}

test('owner sets up backups, keeps the recovery code, backs up now; the bucket holds the snapshot', async ({ page, context, browser }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await becomeOwner(context, page)

  await page.goto('/settings/backups')
  await expect(page.getByTestId('settings-nav-backups')).toBeVisible()
  await expect(page.getByTestId('backups-health')).toHaveAttribute('data-state', 'unconfigured')
  await page.screenshot({ path: `${SHOTS}/1-unconfigured.png`, fullPage: true })

  await page.getByLabel('Endpoint', { exact: true }).fill(S3!)
  await page.getByLabel('Region', { exact: true }).fill('us-east-1')
  await page.getByLabel('Bucket', { exact: true }).fill(BUCKET)
  await page.getByLabel('Folder in the bucket (optional)', { exact: true }).fill(PREFIX)
  await page.getByLabel('Addressing', { exact: true }).selectOption('path')
  await page.getByLabel('Access key', { exact: true }).fill(AK)
  // Save waits for a passing test of exactly these values.
  await page.getByLabel('Secret key', { exact: true }).fill('not-the-secret')
  await expect(page.getByTestId('backups-save')).toBeDisabled()
  await page.getByTestId('backups-test').click()
  await expect(page.getByTestId('backups-test-error')).toContainText(/SignatureDoesNotMatch|InvalidAccessKeyId|403/)
  await expect(page.getByTestId('backups-save')).toBeDisabled()
  await page.getByLabel('Secret key', { exact: true }).fill(SK)
  await page.getByTestId('backups-test').click()
  await expect(page.getByTestId('backups-test-ok')).toBeVisible()
  await expect(page.getByTestId('backups-save')).toBeEnabled()
  await page.getByLabel('Back up every night at', { exact: true }).selectOption('2')
  await page.getByLabel('Keep backups for (days)', { exact: true }).fill('14')
  await page.screenshot({ path: `${SHOTS}/2-tested.png`, fullPage: true })
  await page.getByTestId('backups-save').click()

  // The recovery code, once.
  const panel = page.getByTestId('backups-recovery-code')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText("Without it, your backups can't be read")
  const code = await page.getByTestId('backups-recovery-code-value').inputValue()
  expect(code).toMatch(/^([0-9A-Z]{6}-){8}[0-9A-Z]{6}$/)
  await page.screenshot({ path: `${SHOTS}/3-recovery-code.png`, fullPage: true })
  await expect(page.getByTestId('backups-recovery-code-done')).toBeDisabled()
  await page.getByTestId('backups-recovery-code-stored').check()
  await page.getByTestId('backups-recovery-code-done').click()
  await expect(panel).toBeHidden()
  await page.reload()
  await expect(page.getByTestId('backups-recovery-code')).toHaveCount(0)
  expect(await page.content()).not.toContain(code)
  await expect(page.getByTestId('backups-health')).toHaveAttribute('data-state', 'ok')
  await expect(page.getByTestId('backups-status')).toContainText(/every night at 02:\d\d UTC and keeps\s+14 days/)

  // Back up now → the run appears and succeeds.
  await page.getByTestId('backups-run-now').click()
  const row = page.getByTestId('backups-run').first()
  await expect(row).toHaveAttribute('data-status', 'succeeded', { timeout: 120_000 })
  await expect(row).toContainText('By hand')
  await expect(row).toContainText(/\d+(\.\d)? (B|KB|MB)/)
  await page.screenshot({ path: `${SHOTS}/4-run-succeeded.png`, fullPage: true })
  expect(errors).toEqual([])

  // The bucket holds the snapshot: files + manifest + Drive blobs.
  const { objects } = await harnessGet('/harness/objects')
  const keys = objects.map((o) => o.key)
  const manifest = keys.find((k) => /\/snapshots\/\d{8}T\d{6}Z\/manifest\.json$/.test(k))
  expect(manifest, keys.join('\n')).toBeTruthy()
  const snap = manifest!.replace(/manifest\.json$/, '')
  for (const f of ['db.dump', 'ee-state.tar.gz']) expect(keys).toContain(`${snap}${f}`)
  expect(keys.some((k) => k.startsWith(`${PREFIX}/blobs/`))).toBe(true)

  // The recovery code the owner saw opens it: `ee restore --verify` decrypts and checks every byte.
  const verify = execFileSync(
    process.execPath,
    [`${OUT}/ee.mjs`, 'restore', '--verify', '--snapshot', 'latest', '--endpoint', S3!, '--region', 'us-east-1', '--bucket', BUCKET, '--prefix', PREFIX, '--addressing', 'path', '--access-key-id', AK],
    { input: `${SK}\n${code}\n`, encoding: 'utf8' },
  )
  expect(verify).toMatch(/✓ snapshot \d{8}T\d{6}Z is complete and decrypts/)
  writeFileSync(`${OUT}/verify.txt`, verify)

  // A member never sees Backups.
  const memberCtx = await browser.newContext()
  const memberPage = await memberCtx.newPage()
  await registerUser(memberCtx, memberPage, { emailDomain: 'test.eigen' })
  await memberPage.goto('/settings')
  await expect(memberPage.getByTestId('settings-nav-backups')).toHaveCount(0)
  expect((await memberPage.goto('/settings/backups'))?.status()).toBe(403)
  await memberCtx.close()
})
