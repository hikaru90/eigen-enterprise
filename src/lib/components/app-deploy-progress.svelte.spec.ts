import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import AppDeployProgress, { type DeployProgressView } from './app-deploy-progress.svelte'

const at = '2026-10-21T10:00:00.000Z'
const failed: DeployProgressView = {
  jobId: '',
  name: 'twodown',
  state: 'failed',
  stage: 'failed',
  stages: [
    { stage: 'fetching', at },
    { stage: 'building', at },
    { stage: 'starting', at },
    { stage: 'health', at },
    { stage: 'failed', at },
  ],
  failedStage: 'health',
  error:
    'twodown failed while waiting for its health check: the app crashed on start (exit status 1, 3 restarts).',
  deployId: '11111111-1111-4111-8111-111111111111',
  lines: ["Error: Cannot find module '/srv/index.js'", "  code: 'MODULE_NOT_FOUND'"],
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('app-deploy-progress.svelte', () => {
  it('a failure shows the plain cause, the log tail and "Ask AI"; the answer offers "Apply and redeploy"', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    let polls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/diagnose')) {
          return json({
            cause: 'The start command runs index.js, which the repo does not have.',
            fix: 'Start it with node server.js.',
            suggestedContractChanges: { start: 'node server.js' },
            contractSource: 'form',
          })
        }
        if (url.endsWith('/deploy')) return json({ jobId: 'job-2' })
        polls++
        return json(
          polls < 2
            ? {
                ...failed,
                jobId: 'job-2',
                state: 'running',
                stage: 'building',
                stages: failed.stages.slice(0, 2),
                failedStage: null,
                error: null,
                lines: ['added 57 packages'],
              }
            : {
                ...failed,
                jobId: 'job-2',
                state: 'live',
                stage: 'live',
                failedStage: null,
                error: null,
                lines: ['listening'],
              },
        )
      }),
    )
    const onlive = vi.fn()
    render(AppDeployProgress, { name: 'twodown', initial: failed, onlive })

    await expect.element(page.getByRole('alert')).toHaveTextContent(/crashed on start/)
    await expect.element(page.getByLabelText('Deploy log')).toHaveTextContent(/MODULE_NOT_FOUND/)
    await expect.element(page.getByText(/Health check — failed/)).toBeInTheDocument()

    await page.getByRole('button', { name: 'Ask AI what went wrong' }).click()
    await expect.element(page.getByText(/which the repo does not have/)).toBeInTheDocument()
    await expect.element(page.getByText('Start command: node server.js')).toBeInTheDocument()
    expect(calls[0]).toEqual({
      url: '/m/website/apps/twodown/diagnose',
      body: { deployId: failed.deployId },
    })

    await page.getByRole('button', { name: 'Apply and redeploy' }).click()
    await expect.element(page.getByRole('status', { name: 'Deploying' })).toBeInTheDocument()
    expect(calls[1]).toEqual({
      url: '/m/website/apps/twodown/deploy',
      body: { changes: { start: 'node server.js' } },
    })
    await expect.element(page.getByText('twodown is live.'), { timeout: 5000 }).toBeInTheDocument()
    expect(onlive).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.url.includes('/deploy-progress?job=job-2')).length).toBe(2)
  })

  it('follow(jobId) from a click shows the spinner, the current stage and the live log', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          ...failed,
          jobId: 'j1',
          state: 'running',
          stage: 'health',
          stages: failed.stages.slice(0, 4),
          failedStage: null,
          error: null,
          lines: ['Server listening?'],
        }),
      ),
    )
    const { component } = render(AppDeployProgress, { name: '' })
    void component.follow('j1', 'twodown')
    await expect.element(page.getByRole('status', { name: 'Deploying' })).toBeInTheDocument()
    await expect.element(page.getByText('Deploying twodown…')).toBeInTheDocument()
    await expect.element(page.getByLabelText('Deploy log')).toHaveTextContent('Server listening?')
    expect(
      page
        .getByText(/Health check/)
        .element()
        .getAttribute('aria-current'),
    ).toBe('step')
  })
})
