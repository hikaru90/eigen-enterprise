import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import UpdatesPage from './+page.svelte'

const NEW = 'eigenenterprise-0.5.17-aaaaaaaaaaaa'
const OLD_TARBALL = 'eigenenterprise-0.5.16-14424746613a-linux-arm64.tar.gz'
const NEW_TARBALL = `${NEW}-linux-arm64.tar.gz`
const latest = (over: Record<string, unknown> = {}) => ({
  ok: true,
  release: { name: NEW, version: '0.5.17', notes: '# eigenEnterprise 0.5.17\n\n- [updates] update from Settings\n', from: 'x', state: 'newer', ...over },
})
const base = (over: Record<string, unknown> = {}) => ({
  onBox: true,
  installed: { tarball: OLD_TARBALL, version: '0.5.16' },
  managed: false,
  source: { kind: 'github', repo: 'hikaru90/eigen-enterprise' },
  job: null,
  latest: latest(),
  ...over,
})
const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  release: NEW,
  from: 'x',
  author: 'human:u1',
  status: 'running',
  step: 'installing',
  startedAt: 't',
  updatedAt: 't',
  endedAt: null,
  installedBefore: OLD_TARBALL,
  installedAfter: null,
  safetyCopy: '/var/lib/ee/upgrades/2026-11-18T12-00-00Z',
  error: null,
  log: ['→ running the release installer'],
  announced: false,
  ...over,
})
const props = (updates: Record<string, unknown>, form: unknown = null) => ({ data: { updates }, form, params: {} }) as never
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('Settings → Updates page', () => {
  it('shows the running version, the newer release, its notes and the button', async () => {
    render(UpdatesPage, props(base()))
    await expect.element(page.getByTestId('updates-installed')).toHaveTextContent('0.5.16')
    await expect.element(page.getByTestId('updates-available')).toHaveTextContent('0.5.17')
    await expect.element(page.getByTestId('updates-notes')).toHaveTextContent('update from Settings')
    await expect.element(page.getByTestId('updates-start')).toHaveTextContent('Update to 0.5.17')
    await expect.element(page.getByTestId('updates-start-form')).toHaveAttribute('data-release', NEW)
  })

  it('up to date: says so, no button', async () => {
    render(UpdatesPage, props(base({ latest: latest({ name: 'eigenenterprise-0.5.16-14424746613a', version: '0.5.16', state: 'installed' }) })))
    await expect.element(page.getByTestId('updates-current')).toHaveTextContent('up to date')
    await expect.element(page.getByTestId('updates-start')).not.toBeInTheDocument()
  })

  it('a failed check is shown in plain words', async () => {
    render(UpdatesPage, props(base({ latest: { ok: false, error: 'could not check for updates: GET … → 503' } })))
    await expect.element(page.getByTestId('updates-check-error')).toHaveTextContent('GET … → 503')
  })

  it('a managed box: the hosting provider updates it, no button', async () => {
    render(UpdatesPage, props(base({ managed: true, latest: null })))
    await expect.element(page.getByTestId('updates-managed')).toHaveTextContent('hosting provider')
    await expect.element(page.getByTestId('updates-start')).not.toBeInTheDocument()
  })

  it("ee's refusal is shown next to the button", async () => {
    render(UpdatesPage, props(base(), { action: 'update', error: 'the newest release is now 0.5.18; check again' }))
    await expect.element(page.getByTestId('updates-error')).toHaveTextContent('check again')
  })

  it('a running update shows its steps, reconnects through the restart, and ends on the new version', async () => {
    const answers = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } })),
      () => Promise.resolve(jsonRes({ job: job({ status: 'succeeded', step: 'done', installedAfter: NEW_TARBALL }), installed: { tarball: NEW_TARBALL, version: '0.5.17' } })),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => (answers.shift() ?? answers.at(-1)!)())
    render(UpdatesPage, props(base({ job: job(), latest: null })))
    await expect.element(page.getByTestId('updates-progress')).toHaveAttribute('data-step', 'installing')
    await expect.element(page.getByTestId('updates-offline'), { timeout: 5000 }).toBeInTheDocument()
    await expect.element(page.getByTestId('updates-done'), { timeout: 10_000 }).toHaveTextContent('0.5.17')
  })

  it('a failed update names the error and the safety copy', async () => {
    render(
      UpdatesPage,
      props(base({ job: job({ status: 'failed', step: 'installing', error: 'the installer failed (exit 1)', endedAt: 't2' }) })),
    )
    await expect.element(page.getByTestId('updates-failed')).toHaveTextContent('the installer failed (exit 1)')
    await expect.element(page.getByTestId('updates-failed')).toHaveTextContent('/var/lib/ee/upgrades/2026-11-18T12-00-00Z/ROLLBACK.txt')
    // A newer release is still offered after a failure.
    await expect.element(page.getByTestId('updates-start')).toBeInTheDocument()
  })
})
