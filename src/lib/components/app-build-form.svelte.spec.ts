import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import AppBuildForm from './app-build-form.svelte'

const suggestion = {
  fields: {
    runtime: 'node@22',
    install: 'npm ci --omit=dev',
    build: '',
    start: 'node server/main.js',
    portEnv: '',
    health: '/health',
    staticDir: '',
  },
  kind: 'web',
  confidence: 0.8,
  reasons: ['README says the server entry is server/main.js'],
  warnings: ['Check that the app reads PORT'],
  catalogGap: null,
  filesRead: ['README.md', 'package.json'],
}

const target = { name: 'shop', repo: 'kindred/shop', branch: 'main' }

function deferredFetch() {
  let resolve!: (r: Response) => void
  const fn = vi.fn(() => new Promise<Response>((r) => (resolve = r)))
  vi.stubGlobal('fetch', fn)
  return {
    fn,
    respond: (status: number, body: unknown) =>
      resolve(new Response(JSON.stringify(body), { status })),
  }
}

afterEach(() => vi.unstubAllGlobals())

const input = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLInputElement

describe('app-build-form.svelte: Let AI fill this out', () => {
  it('shows a spinner while reading, then fills and highlights the fields with reasons and warnings', async () => {
    const f = deferredFetch()
    render(AppBuildForm, { props: { nodeVersions: ['22'], target } })
    await page.getByRole('button', { name: 'Let AI fill this out' }).click()
    await expect.element(page.getByText('Reading the repo…')).toBeInTheDocument()
    expect(f.fn).toHaveBeenCalledWith(
      '/m/website/apps/suggest',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(target) }),
    )
    f.respond(200, { suggestion })
    await expect
      .element(page.getByText('README says the server entry is server/main.js'))
      .toBeInTheDocument()
    await expect.element(page.getByText('Check that the app reads PORT')).toBeInTheDocument()
    expect(input('useForm').checked).toBe(true)
    expect(input('start').value).toBe('node server/main.js')
    expect(input('install').value).toBe('npm ci --omit=dev')
    expect(input('health').value).toBe('/health')
    expect((document.querySelector('[name="runtime"]') as HTMLSelectElement).value).toBe('node@22')
    expect(input('start').dataset.aiSet).toBe('true')
    expect(input('build').dataset.aiSet).toBeUndefined()

    // The owner can still edit before deploying.
    await page.getByLabelText('Start command').fill('node server/index.js')
    expect(input('start').value).toBe('node server/index.js')
  })

  it('a failure shows a plain message, never a raw error', async () => {
    const f = deferredFetch()
    render(AppBuildForm, { props: { nodeVersions: ['22'], target } })
    await page.getByRole('button', { name: 'Let AI fill this out' }).click()
    f.respond(400, { error: "The AI couldn't fill this in right now." })
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent("The AI couldn't fill this in right now.")
  })

  it('a catalog gap is said plainly and the runtime is left for the owner', async () => {
    const f = deferredFetch()
    render(AppBuildForm, { props: { nodeVersions: ['22'], target } })
    await page.getByRole('button', { name: 'Let AI fill this out' }).click()
    f.respond(200, {
      suggestion: {
        ...suggestion,
        fields: { ...suggestion.fields, runtime: null },
        catalogGap:
          "This repo looks like it needs python@3.12, which this server doesn't provide yet.",
      },
    })
    await expect.element(page.getByText(/needs python@3\.12/)).toBeInTheDocument()
    expect(input('start').value).toBe('node server/main.js')
  })

  it('without a repo picked, the button says what to do first', async () => {
    render(AppBuildForm, { props: { nodeVersions: ['22'], target: null } })
    await expect.element(page.getByRole('button', { name: 'Let AI fill this out' })).toBeDisabled()
    await expect.element(page.getByText('Pick a repo first.')).toBeInTheDocument()
  })
})
