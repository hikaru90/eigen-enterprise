import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { AppPreview, AppStatus } from '$lib/drive/api'
import AppPreviewPanel from './app-preview.svelte'

const { api } = vi.hoisted(() => ({
  api: { appStatus: vi.fn(), runApp: vi.fn(), stopApp: vi.fn(), stopPreview: vi.fn() },
}))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, ...api } }
})
const { DriveApiError } = await import('$lib/drive/api')

const preview = (over: Partial<AppPreview> = {}): AppPreview => ({
  id: 'pv3f9a0c12be47',
  folderName: 'shop',
  state: 'installing',
  host: 'pv3f9a0c12be47.preview.os.test',
  url: 'https://pv3f9a0c12be47.preview.os.test/',
  script: 'dev',
  startedAt: '2026-11-20T10:00:00.000Z',
  lastSeenAt: '2026-11-20T10:00:00.000Z',
  error: null,
  log: ['added 120 packages', 'VITE ready'],
  ...over,
})
const status = (over: Partial<AppStatus> = {}): AppStatus => ({
  folder: { id: 'f1', name: 'shop' },
  webApp: { script: 'dev', lockfile: 'package-lock.json' },
  previewId: 'pv3f9a0c12be47',
  managed: true,
  reason: null,
  preview: null,
  ...over,
})

describe('app-preview: Run a web app folder on its page', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.useRealTimers())

  it('an admin sees Run app on a web app folder; no lockfile warning when there is one', async () => {
    api.appStatus.mockResolvedValue(status())
    render(AppPreviewPanel, { props: { folderId: 'f1', canRun: true } })
    await expect.element(page.getByTestId('drive-app-run')).toHaveTextContent('Run app')
    await expect.element(page.getByText('npm run dev')).toBeInTheDocument()
    expect(page.getByTestId('drive-app-no-lockfile').elements()).toHaveLength(0)
    expect(api.appStatus).toHaveBeenCalledWith('f1')
  })

  it('without a lockfile, says Run will fail (Run stays offered, not hidden)', async () => {
    api.appStatus.mockResolvedValue(status({ webApp: { script: 'start', lockfile: null } }))
    render(AppPreviewPanel, { props: { folderId: 'f1', canRun: true } })
    await expect.element(page.getByTestId('drive-app-no-lockfile')).toHaveTextContent(/Run will fail until one is added/)
    await expect.element(page.getByTestId('drive-app-run')).toBeInTheDocument()
  })

  it('a member sees nothing for an idle web app folder, and a running app without controls', async () => {
    api.appStatus.mockResolvedValueOnce(status())
    const idle = render(AppPreviewPanel, { props: { folderId: 'f1', canRun: false } })
    await vi.waitFor(() => expect(api.appStatus).toHaveBeenCalled())
    expect(page.getByTestId('drive-app').elements()).toHaveLength(0)
    idle.unmount()
    api.appStatus.mockResolvedValueOnce(status({ preview: preview({ state: 'running' }) }))
    render(AppPreviewPanel, { props: { folderId: 'f1', canRun: false } })
    await expect.element(page.getByTestId('drive-app-frame')).toBeInTheDocument()
    expect(page.getByTestId('drive-app-stop').elements()).toHaveLength(0)
    expect(page.getByTestId('drive-app-restart').elements()).toHaveLength(0)
  })

  it('Run shows the state and log tail, then polls every 5 s while installing and every 30 s once running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    api.appStatus.mockResolvedValueOnce(status())
    api.runApp.mockResolvedValue({ preview: preview() })
    render(AppPreviewPanel, { props: { folderId: 'f1', canRun: true } })
    await page.getByTestId('drive-app-run').click()
    await expect.element(page.getByTestId('drive-app-state')).toHaveTextContent('Installing dependencies…')
    await expect.element(page.getByTestId('drive-app-log')).toHaveTextContent('VITE ready')
    expect(api.runApp).toHaveBeenCalledWith('f1')
    api.appStatus.mockResolvedValue(status({ preview: preview({ state: 'running' }) }))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(api.appStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.appStatus).toHaveBeenCalledTimes(2)
    await expect.element(page.getByTestId('drive-app-state')).toHaveTextContent('Running')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(api.appStatus).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.appStatus).toHaveBeenCalledTimes(3)
  })

  it('running: the frame on its own origin (sandboxed), Open in new tab, Restart and Stop', async () => {
    api.appStatus.mockResolvedValue(status({ preview: preview({ state: 'running' }) }))
    api.stopApp.mockResolvedValue({ preview: preview({ state: 'stopped' }) })
    api.runApp.mockResolvedValue({ preview: preview({ state: 'installing' }) })
    render(AppPreviewPanel, { props: { folderId: 'f1', canRun: true } })
    const frame = page.getByTestId('drive-app-frame')
    await expect.element(frame).toHaveAttribute('src', 'https://pv3f9a0c12be47.preview.os.test/')
    await expect.element(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
    await expect.element(page.getByTestId('drive-app-open')).toHaveAttribute('href', 'https://pv3f9a0c12be47.preview.os.test/')
    await expect.element(page.getByTestId('drive-app-open')).toHaveAttribute('target', '_blank')
    await page.getByTestId('drive-app-restart').click()
    expect(api.runApp).toHaveBeenCalledWith('f1')
    await expect.element(page.getByTestId('drive-app-state')).toHaveTextContent('Installing dependencies…')
    await page.getByTestId('drive-app-stop').click()
    expect(api.stopApp).toHaveBeenCalledWith('f1')
    await expect.element(page.getByTestId('drive-app-run')).toBeInTheDocument()
    expect(page.getByTestId('drive-app-frame').elements()).toHaveLength(0)
  })

  it('a failed start shows why and its log, with Restart', async () => {
    api.appStatus.mockResolvedValue(status({ preview: preview({ state: 'failed', error: 'add a lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock)' }) }))
    render(AppPreviewPanel, { props: { folderId: 'f1', canRun: true } })
    await expect.element(page.getByTestId('drive-app-failed')).toHaveTextContent('add a lockfile')
    await expect.element(page.getByTestId('drive-app-restart')).toBeInTheDocument()
    expect(page.getByTestId('drive-app-frame').elements()).toHaveLength(0)
  })

  it('another app running: names it and offers to stop it', async () => {
    api.appStatus.mockResolvedValue(status())
    const blog = preview({ id: 'pv000000000001', folderName: 'blog', state: 'running' })
    api.runApp.mockRejectedValueOnce(new DriveApiError('Another app is running: blog', 409, 'busy', null, blog))
    api.stopPreview.mockResolvedValue({ preview: { ...blog, state: 'stopped' } })
    render(AppPreviewPanel, { props: { folderId: 'f1', canRun: true } })
    await page.getByTestId('drive-app-run').click()
    await expect.element(page.getByTestId('drive-app-busy')).toHaveTextContent('Another app is running: blog')
    await page.getByTestId('drive-app-stop-other').click()
    expect(api.stopPreview).toHaveBeenCalledWith('pv000000000001')
    await expect.poll(() => page.getByTestId('drive-app-busy').elements().length).toBe(0)
  })

  it('without ee: says so up front, and Run fails loud with the server sentence', async () => {
    const sentence = 'Running apps needs the eigenEnterprise server (ee).'
    api.appStatus.mockResolvedValue(status({ managed: false, reason: sentence }))
    api.runApp.mockRejectedValueOnce(new DriveApiError(sentence, 503, 'unavailable', null))
    render(AppPreviewPanel, { props: { folderId: 'f1', canRun: true } })
    await expect.element(page.getByTestId('drive-app-unmanaged')).toHaveTextContent(sentence)
    await page.getByTestId('drive-app-run').click()
    await expect.element(page.getByTestId('drive-app-error')).toHaveTextContent(sentence)
  })
})
