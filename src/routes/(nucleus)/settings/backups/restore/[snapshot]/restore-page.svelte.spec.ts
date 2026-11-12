import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import RestorePage from './+page.svelte'

const SNAP = '20261101T031700Z'
const base = { managed: true, configured: true, snapshotId: SNAP, takenAt: '2026-11-01T03:17:00.000Z', companyName: 'Acme GmbH', job: null }
const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  kind: 'restore',
  snapshotId: SNAP,
  author: 'human:u-owner',
  status: 'running',
  step: 'restoring-database',
  startedAt: 't',
  updatedAt: 't',
  endedAt: null,
  checked: { files: [{ name: 'db.dump', size: 10 }], blobs: 2, blobBytes: 20 },
  error: null,
  log: ['→ restoring the company database (os)'],
  announced: false,
  ...over,
})
const props = (restore: Record<string, unknown>, form: unknown = null) => ({ data: { restore }, form, params: { snapshot: SNAP } }) as never
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('Settings → Backups → Restore page', () => {
  it('says what is lost and that it is whole-company only; restore stays disabled until the exact name and a code are typed', async () => {
    render(RestorePage, props(base))
    await expect.element(page.getByTestId('restore-confirm')).toHaveTextContent('Everything since that moment is lost')
    await expect.element(page.getByTestId('restore-confirm')).toHaveTextContent('whole-company only')
    const submit = page.getByTestId('restore-submit')
    await expect.element(submit).toBeDisabled()
    await page.getByTestId('restore-confirm-name').fill('Acme GmbH')
    await expect.element(submit).toBeDisabled()
    await page.getByTestId('restore-code').fill('EE1-AAAAA')
    await expect.element(submit).toBeEnabled()
    await page.getByTestId('restore-confirm-name').fill('acme gmbh')
    await expect.element(submit).toBeDisabled()
    await expect.element(page.getByTestId('restore-code')).toHaveAttribute('type', 'password')
  })

  it('shows the refusal next to the form', async () => {
    render(RestorePage, props(base, { action: 'restore', error: "this recovery code does not open this company's backups" }))
    await expect.element(page.getByTestId('restore-error')).toHaveTextContent('does not open')
  })

  it('a running restore shows its steps, reconnects through the outage, and ends on the result', async () => {
    const answers = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } })),
      () => Promise.resolve(jsonRes({ job: job({ status: 'succeeded', step: 'done', endedAt: 't2' }) })),
    ]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => (answers.shift() ?? answers.at(-1)!)())
    render(RestorePage, props({ ...base, job: job() }))
    await expect.element(page.getByTestId('restore-progress')).toHaveAttribute('data-step', 'restoring-database')
    await expect.element(page.getByTestId('restore-steps').getByText('Put back the database…')).toBeInTheDocument()
    await expect.element(page.getByTestId('restore-offline'), { timeout: 5000 }).toBeInTheDocument()
    await expect.element(page.getByTestId('restore-done'), { timeout: 8000 }).toHaveTextContent('Restored.')
    expect(fetchMock.mock.calls[0]![0]).toContain('/settings/backups/job')
  })

  it('back but signed out (the session is newer than the backup): says so and links to sign in', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ message: 'no' }, 403))
    render(RestorePage, props({ ...base, job: job({ step: 'starting' }) }))
    await expect.element(page.getByTestId('restore-signed-out'), { timeout: 5000 }).toHaveTextContent('Sign in again')
  })

  it('a failed restore shows the cause and lets the owner start over', async () => {
    render(RestorePage, props({ ...base, job: job({ status: 'failed', step: 'verifying', error: 'db.dump: content hash … — nothing on this server was changed' }) }))
    await expect.element(page.getByTestId('restore-failed')).toHaveTextContent('nothing on this server was changed')
    await page.getByText('Start over').click()
    await expect.element(page.getByTestId('restore-confirm')).toBeInTheDocument()
  })
})
