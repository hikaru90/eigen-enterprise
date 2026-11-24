import type { AttachmentView } from './view'
import { describe, expect, it } from 'vitest'
import { clipboardFiles, matchUploadedAttachments } from './paste'

const makeFile = (name: string, type: string, content = 'x', lastModified = 1000) =>
  new File([content], name, { type, lastModified })

const itemOf = (kind: string, file: File | null) => ({
  kind,
  getAsFile: () => file,
})

describe('clipboardFiles', () => {
  const fixedNow = new Date('2026-11-24T18:05:09.000Z')

  it('returns empty for null, undefined, or text-only clipboard', () => {
    expect(clipboardFiles(null, fixedNow)).toEqual([])
    expect(clipboardFiles(undefined, fixedNow)).toEqual([])
    expect(
      clipboardFiles({ items: [itemOf('string', null)], files: [] }, fixedNow),
    ).toEqual([])
  })

  it('reads files from data.items and skips null getAsFile results', () => {
    const f = makeFile('screenshot.png', 'image/png', 'abc')
    const out = clipboardFiles(
      { items: [itemOf('string', null), itemOf('file', null), itemOf('file', f)] },
      fixedNow,
    )
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('screenshot.png')
    expect(out[0].type).toBe('image/png')
  })

  it('reads files from data.files when data.items is absent or empty', () => {
    const f1 = makeFile('diagram.png', 'image/png', '1234')
    const f2 = makeFile('notes.txt', 'text/plain', 'hi')
    expect(clipboardFiles({ files: [f1, f2] }, fixedNow).map((f) => f.name)).toEqual([
      'diagram.png',
      'notes.txt',
    ])
    expect(clipboardFiles({ items: [], files: [f1] }, fixedNow).map((f) => f.name)).toEqual([
      'diagram.png',
    ])
  })

  it('deduplicates identical files populated in both data.items and data.files while keeping extras', () => {
    const itemFile = makeFile('image.png', 'image/png', 'same-bytes', 1000)
    const filesCopy = makeFile('image.png', 'image/png', 'same-bytes', 1005)
    const extraFile = makeFile('diagram.png', 'image/png', 'other', 1005)

    const out = clipboardFiles(
      {
        items: [itemOf('file', itemFile)],
        files: [filesCopy, extraFile],
      },
      fixedNow,
    )

    expect(out).toHaveLength(2)
    expect(out.map((f) => f.name)).toEqual(['pasted-image-20261124-180509-1.png', 'diagram.png'])
  })

  it('preserves multiset duplicates when two distinct items have matching metadata', () => {
    const a = makeFile('image.png', 'image/png', 'same', 1000)
    const b = makeFile('image.png', 'image/png', 'same', 1001)
    const copyA = makeFile('image.png', 'image/png', 'same', 1002)

    const out = clipboardFiles(
      {
        items: [itemOf('file', a), itemOf('file', b)],
        files: [copyA],
      },
      fixedNow,
    )

    expect(out).toHaveLength(2)
    expect(out.map((f) => f.name)).toEqual([
      'pasted-image-20261124-180509-1.png',
      'pasted-image-20261124-180509-2.png',
    ])
  })

  it('renames empty or generic image names using UTC timestamp and extension from mime', () => {
    const cases: Array<[string, string, string]> = [
      ['', 'image/png', 'pasted-image-20261124-180509-1.png'],
      ['image.png', 'image/png', 'pasted-image-20261124-180509-2.png'],
      ['image.jpg', 'image/jpeg', 'pasted-image-20261124-180509-3.jpg'],
      ['image.jpeg', 'image/jpeg', 'pasted-image-20261124-180509-4.jpg'],
      ['image.webp', 'image/webp', 'pasted-image-20261124-180509-5.webp'],
      ['image.gif', 'image/gif', 'pasted-image-20261124-180509-6.gif'],
      ['image.avif', 'image/avif', 'pasted-image-20261124-180509-7.avif'],
      ['blob', 'image/png', 'pasted-image-20261124-180509-8.png'],
      ['image.png', '', 'pasted-image-20261124-180509-9.png'],
    ]
    const out = clipboardFiles(
      { items: cases.map(([name, type], i) => itemOf('file', makeFile(name, type, String(i)))) },
      fixedNow,
    )
    expect(out.map((f) => f.name)).toEqual(cases.map(([, , expected]) => expected))
  })

  it('keeps meaningful image filenames and non-image files untouched', () => {
    const out = clipboardFiles(
      {
        files: [
          makeFile('diagram.png', 'image/png', '1'),
          makeFile('photo-2026.jpg', 'image/jpeg', '2'),
          makeFile('report.pdf', 'application/pdf', '3'),
          makeFile('blob', 'text/plain', '4'),
        ],
      },
      fixedNow,
    )
    expect(out.map((f) => f.name)).toEqual([
      'diagram.png',
      'photo-2026.jpg',
      'report.pdf',
      'blob',
    ])
  })
})

describe('matchUploadedAttachments', () => {
  const att = (fileId: string, name: string): AttachmentView => ({
    fileId,
    name,
    mime: 'image/png',
    size: 128,
    image: true,
  })

  it('matches exact names and keeps non-batch pending items untouched', () => {
    const existingReady = {
      key: 1,
      name: 'old.png',
      status: 'ready' as const,
      file: att('f0', 'old.png'),
      previewUrl: 'blob:old',
    }
    const uploading = {
      key: 2,
      name: 'snap.png',
      status: 'uploading' as const,
      previewUrl: 'blob:snap',
    }
    const result = matchUploadedAttachments([existingReady, uploading], [2], [att('f1', 'snap.png')])
    expect(result.dropped).toEqual([])
    expect(result.next).toEqual([
      existingReady,
      { ...uploading, status: 'ready', file: att('f1', 'snap.png'), name: 'snap.png' },
    ])
  })

  it('matches server-renamed duplicate filenames positionally instead of dropping them', () => {
    const uploading = {
      key: 10,
      name: 'image.png',
      status: 'uploading' as const,
      previewUrl: 'blob:dup',
    }
    const renamed = att('f2', 'image (2).png')
    const result = matchUploadedAttachments([uploading], [10], [renamed])
    expect(result.dropped).toEqual([])
    expect(result.next).toEqual([
      { ...uploading, status: 'ready', name: 'image (2).png', file: renamed },
    ])
  })

  it('handles a mixed batch with exact match, renamed duplicate, and a failed upload', () => {
    const p1 = { key: 1, name: 'exact.png', status: 'uploading' as const, previewUrl: 'blob:1' }
    const p2 = { key: 2, name: 'image.png', status: 'uploading' as const, previewUrl: 'blob:2' }
    const p3 = { key: 3, name: 'fail.pdf', status: 'uploading' as const, previewUrl: 'blob:3' }

    const uExact = att('f1', 'exact.png')
    const uRenamed = att('f2', 'image (2).png')

    const result = matchUploadedAttachments([p1, p2, p3], [1, 2, 3], [uRenamed, uExact])
    expect(result.next).toEqual([
      { ...p1, status: 'ready', name: 'exact.png', file: uExact },
      { ...p2, status: 'ready', name: 'image (2).png', file: uRenamed },
    ])
    expect(result.dropped).toEqual([p3])
  })
})
