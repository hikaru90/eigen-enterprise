import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem } from '$lib/drive/api'
import type { UploadConflict } from '$lib/drive/upload'
import UploadConflictDialog from './upload-conflict-dialog.svelte'

const existing: DriveItem = {
  type: 'file',
  id: 'f-1',
  name: 'q3.pdf',
  parentId: 'reports',
  ownerId: 'u1',
  updatedAt: '2026-11-20T09:00:00.000Z',
  trashedAt: null,
  size: 2048,
}
const conflict = (more: boolean, extra: Partial<DriveItem> = {}): UploadConflict => ({
  path: 'q3.pdf',
  name: 'q3.pdf',
  message: '“q3.pdf” already exists in Reports.',
  existing: { ...existing, ...extra },
  more,
})

describe('upload conflict dialog: a name already in the folder (bug f45acdef)', () => {
  it('says which file is there and offers Replace, Keep both and Cancel; Replace keeps the old version restorable', async () => {
    const onanswer = vi.fn()
    render(UploadConflictDialog, { props: { conflict: conflict(false), onanswer } })
    const dialog = page.getByTestId('drive-upload-conflict')
    await expect.element(dialog).toBeVisible()
    await expect.element(dialog).toHaveTextContent('This file already exists')
    await expect.element(dialog).toHaveTextContent('“q3.pdf” already exists in Reports.')
    await expect.element(dialog).toHaveTextContent('its current version stays in the file’s history')
    // A single file: nothing to apply to.
    expect(page.getByTestId('drive-upload-conflict-all').elements()).toHaveLength(0)
    await page.getByTestId('drive-upload-conflict-replace').click()
    expect(onanswer).toHaveBeenCalledExactlyOnceWith({ choice: 'replace', all: false })
  })

  it('Keep both and Cancel answer for this file only unless “apply to all” is ticked', async () => {
    const keep = vi.fn()
    const first = render(UploadConflictDialog, { props: { conflict: conflict(true), onanswer: keep } })
    await expect.element(page.getByTestId('drive-upload-conflict-all')).toHaveTextContent('Do the same for the other files that clash')
    await page.getByTestId('drive-upload-conflict-keep').click()
    expect(keep).toHaveBeenCalledExactlyOnceWith({ choice: 'keep_both', all: false })
    await first.unmount()

    const cancel = vi.fn()
    render(UploadConflictDialog, { props: { conflict: conflict(true), onanswer: cancel } })
    await page.getByTestId('drive-upload-conflict-all').click()
    await page.getByTestId('drive-upload-conflict-cancel').click()
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ choice: 'skip', all: true })
  })

  it('Escape is Cancel for this file', async () => {
    const onanswer = vi.fn()
    render(UploadConflictDialog, { props: { conflict: conflict(true), onanswer } })
    await expect.element(page.getByTestId('drive-upload-conflict')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(onanswer).toHaveBeenCalledExactlyOnceWith({ choice: 'skip', all: false })
  })

  it('an archived file there is named as archived (it is not in the listing)', async () => {
    render(UploadConflictDialog, { props: { conflict: conflict(false, { archivedAt: '2026-11-01T00:00:00.000Z' }), onanswer: vi.fn() } })
    await expect.element(page.getByTestId('drive-upload-conflict')).toHaveTextContent('It is archived')
  })
})
