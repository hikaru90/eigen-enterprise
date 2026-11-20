import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { Revision } from '$lib/drive/api'
import RevisionsPanel from './revisions-panel.svelte'

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }))
// The read-only Markdown/CSV views are not used for office files.
vi.mock('./csv-editor.svelte', () => ({ default: () => undefined }))
vi.mock('./markdown-editor.svelte', () => ({ default: () => undefined }))

const revisions: Revision[] = [
  { id: 'r2', fileId: 'f1', size: 2048, authorId: 'u1', createdAt: '2026-11-20T12:05:00.000Z' },
  { id: 'r1', fileId: 'f1', size: 1024, authorId: 'u1', createdAt: '2026-11-20T10:00:00.000Z' },
]

describe('revisions panel: office files', () => {
  it('each version downloads as that file; an earlier one can be restored', async () => {
    const onrestore = vi.fn(async () => undefined)
    render(RevisionsPanel, { props: { fileId: 'f1', kind: 'office', revisions, authors: { u1: 'Ada Owner' }, canRestore: true, onrestore } })
    const downloads = page.getByTestId('drive-revision-download')
    await expect.element(downloads.first()).toHaveAttribute('href', '/api/drive/files/f1/content?revision=r2')
    await expect.element(downloads.nth(1)).toHaveAttribute('href', '/api/drive/files/f1/content?revision=r1')
    expect(page.getByTestId('drive-revision-view').elements()).toHaveLength(0)
    // Only the earlier version offers Restore (the newest is the current one).
    expect(page.getByTestId('drive-revision-restore').elements()).toHaveLength(1)
    await page.getByTestId('drive-revision-restore').click()
    expect(onrestore).toHaveBeenCalledWith('r1')
  })

  it('without edit rights there is no Restore', async () => {
    render(RevisionsPanel, { props: { fileId: 'f1', kind: 'office', revisions, authors: {}, canRestore: false, onrestore: vi.fn() } })
    await expect.element(page.getByTestId('drive-revision-download').first()).toBeVisible()
    expect(page.getByTestId('drive-revision-restore').elements()).toHaveLength(0)
  })
})
