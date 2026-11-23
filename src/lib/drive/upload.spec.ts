import { describe, expect, it, vi } from 'vitest'
import { DriveApiError, type DriveItem } from './api'
import {
  collectDropped,
  entriesFromPicked,
  planUpload,
  runUpload,
  type ConflictDecision,
  type DropSource,
  type UploadApi,
  type UploadConflict,
} from './upload'

const file = (name: string, relative = '', size = 1) => {
  const f = new File([new Uint8Array(size)], name)
  if (relative) Object.defineProperty(f, 'webkitRelativePath', { value: relative })
  return f
}

/** A directory entry as the browser's drop hands it out (readEntries in batches, then an empty one). */
function dir(name: string, kids: FileSystemEntry[], batch = 2): FileSystemDirectoryEntry {
  return {
    isDirectory: true,
    isFile: false,
    name,
    createReader: () => {
      let at = 0
      return {
        readEntries: (ok: (e: FileSystemEntry[]) => void) => {
          const out = kids.slice(at, at + batch)
          at += batch
          queueMicrotask(() => ok(out))
        },
      }
    },
  } as unknown as FileSystemDirectoryEntry
}
function fileEntry(name: string, fail?: string): FileSystemFileEntry {
  return {
    isDirectory: false,
    isFile: true,
    name,
    file: (ok: (f: File) => void, err: (e: Error) => void) =>
      queueMicrotask(() => (fail ? err(new Error(fail)) : ok(file(name)))),
  } as unknown as FileSystemFileEntry
}

const folderItem = (id: string, name: string): DriveItem => ({
  type: 'folder',
  id,
  name,
  parentId: null,
  ownerId: 'u1',
  updatedAt: '2026-11-19T00:00:00.000Z',
  trashedAt: null,
})

/** A file item the fake server says landed. */
const landed = (name: string, outcome: 'created' | 'replaced' | 'kept_both' = 'created') => ({
  ...folderItem(`u-${name}`, name),
  type: 'file' as const,
  outcome,
})

/** For runs where no name is taken: being asked is a test failure. */
const noClash = async (c: UploadConflict): Promise<ConflictDecision> => {
  throw new Error(`unexpected clash on ${c.path}`)
}

function fakeApi(taken: string[] = []): UploadApi & {
  created: Array<[string | null, string]>
  sent: Array<[string | null, string]>
  modes: string[]
} {
  let n = 0
  const created: Array<[string | null, string]> = []
  const sent: Array<[string | null, string]> = []
  const modes: string[] = []
  return {
    created,
    sent,
    modes,
    createFolder: async (parentId, name) => {
      created.push([parentId, name])
      return folderItem(`d${++n}`, name)
    },
    upload: async (folderId, files, onConflict) => {
      const uploaded = []
      const conflicts = []
      for (const f of files) {
        sent.push([folderId, f.name])
        modes.push(`${f.name}:${onConflict}`)
        const clash = taken.includes(f.name)
        if (clash && onConflict === 'fail')
          conflicts.push({
            name: f.name,
            error: `“${f.name}” already exists in Reports.`,
            existing: { ...folderItem(`old-${f.name}`, f.name), type: 'file' as const },
          })
        else if (clash && onConflict === 'keep_both') uploaded.push(landed(`${f.name} (2)`, 'kept_both'))
        else uploaded.push(landed(f.name, clash ? 'replaced' : 'created'))
      }
      return { uploaded, errors: [], conflicts }
    },
  }
}

describe('entriesFromPicked', () => {
  it('reads each file’s folders from the folder picker’s relative path; plain picks land right there', () => {
    expect(
      entriesFromPicked([file('a.jpg', 'Trip/day 1/a.jpg'), file('b.txt', 'Trip/b.txt')]).map(
        (e) => e.dirs,
      ),
    ).toEqual([['Trip', 'day 1'], ['Trip']])
    expect(entriesFromPicked([file('c.txt')])[0]!.dirs).toEqual([])
  })
})

describe('planUpload', () => {
  it('lists every folder once, parents before children', () => {
    const plan = planUpload(
      entriesFromPicked([file('a', 'T/x/y/a'), file('b', 'T/b'), file('c', 'T/x/c')]),
      [['T', 'empty']],
    )
    expect(plan.folders.map((d) => d.join('/'))).toEqual(['T', 'T/empty', 'T/x', 'T/x/y'])
  })
})

describe('collectDropped', () => {
  it('walks dropped folders in full (every batch), keeps empty folders, and names what it could not read', async () => {
    const sources: DropSource[] = [
      {
        kind: 'dir',
        entry: dir('Trip', [
          fileEntry('1.jpg'),
          fileEntry('2.jpg'),
          dir('day 2', [fileEntry('3.jpg')]),
          dir('empty', []),
          fileEntry('bad.raw', 'NotReadableError'),
        ]),
      },
      { kind: 'file', file: file('loose.txt') },
      { kind: 'unreadable', name: 'mystery' },
    ]
    const plan = await collectDropped(sources)
    expect(plan.files.map((e) => [...e.dirs, e.file.name].join('/')).sort()).toEqual([
      'Trip/1.jpg',
      'Trip/2.jpg',
      'Trip/day 2/3.jpg',
      'loose.txt',
    ])
    expect(plan.folders.map((d) => d.join('/'))).toEqual(['Trip', 'Trip/day 2', 'Trip/empty'])
    expect(plan.failures).toEqual([
      { path: 'Trip/bad.raw', reason: 'Couldn’t read this file: NotReadableError' },
      { path: 'mystery', reason: 'The browser didn’t hand over this item.' },
    ])
  })
})

describe('runUpload', () => {
  it('recreates the tree under the target, then uploads each file on its own into its folder, with progress', async () => {
    const api = fakeApi()
    const progress = vi.fn()
    const plan = planUpload(entriesFromPicked([file('a', 'T/a'), file('b', 'T/sub/b'), file('c')]))
    const out = await runUpload(plan, 'target', api, noClash, progress)
    expect(api.created).toEqual([
      ['target', 'T'],
      ['d1', 'sub'],
    ])
    expect(api.sent).toEqual([
      ['d1', 'a'],
      ['d2', 'b'],
      ['target', 'c'],
    ])
    expect(out).toEqual({ uploaded: 3, replaced: 0, skipped: [], folders: 2, failures: [], stopped: null })
    expect(api.modes).toEqual(['a:fail', 'b:fail', 'c:fail'])
    expect(progress).toHaveBeenCalledWith({ done: 0, total: 3, current: 'Creating folder T/sub' })
    expect(progress).toHaveBeenCalledWith({ done: 1, total: 3, current: 'T/sub/b' })
    expect(progress).toHaveBeenLastCalledWith({ done: 3, total: 3, current: '' })
  })

  it('names each file the server turned down (too large, bad name) and carries on with the rest', async () => {
    const api = fakeApi()
    api.upload = async (folderId, files) => {
      const f = files[0]!
      if (f.name === 'huge.bin')
        return { uploaded: [], errors: ['“huge.bin” is 120 MB; files can be at most 100 MB.'], conflicts: [] }
      if (f.name === 'giant.bin')
        throw new DriveApiError('Drive request failed (413).', 413, null, null)
      return { uploaded: [landed(f.name)], errors: [], conflicts: [] }
    }
    const plan = planUpload(
      entriesFromPicked([
        file('huge.bin', 'T/huge.bin'),
        file('giant.bin', 'T/giant.bin', 2048),
        file('ok.txt', 'T/ok.txt'),
      ]),
    )
    const out = await runUpload(plan, null, api, noClash)
    expect(out.uploaded).toBe(1)
    expect(out.stopped).toBeNull()
    expect(out.failures).toEqual([
      { path: 'T/huge.bin', reason: '“huge.bin” is 120 MB; files can be at most 100 MB.' },
      {
        path: 'T/giant.bin',
        reason: '“giant.bin” is 2.0 KB, more than the server takes in one upload.',
      },
    ])
  })

  it('a folder that can’t be created: it and everything in it are reported, its siblings still go up', async () => {
    const api = fakeApi()
    const create = api.createFolder
    api.createFolder = async (parentId, name) => {
      if (name === 'bad')
        throw new DriveApiError('A name can’t contain / or \\.', 400, 'invalid', null)
      return create(parentId, name)
    }
    const plan = planUpload(
      entriesFromPicked([file('a', 'T/bad/a'), file('b', 'T/bad/deep/b'), file('c', 'T/c')]),
    )
    const out = await runUpload(plan, null, api, noClash)
    expect(api.sent).toEqual([['d1', 'c']])
    expect(out.failures).toEqual([
      { path: 'T/bad', reason: 'Couldn’t create this folder: A name can’t contain / or \\.' },
      { path: 'T/bad/a', reason: 'not uploaded: its folder “T/bad” couldn’t be created' },
      { path: 'T/bad/deep/b', reason: 'not uploaded: its folder “T/bad” couldn’t be created' },
    ])
    expect(out.stopped).toBeNull()
  })

  it('stops at a refusal that isn’t about one file (no access, server down) and lists every file not uploaded', async () => {
    const api = fakeApi()
    api.upload = async () => {
      throw new DriveApiError('You can’t add files here.', 403, 'forbidden', null)
    }
    const plan = planUpload(entriesFromPicked([file('a'), file('b')]))
    const out = await runUpload(plan, 'f1', api, noClash)
    expect(out.stopped).toBe('You can’t add files here.')
    expect(out.failures).toEqual([
      { path: 'a', reason: 'You can’t add files here.' },
      { path: 'b', reason: 'not uploaded: the upload stopped' },
    ])
  })

  it('a name already there asks, with the file that is there; replace and keep both send it again as decided', async () => {
    const api = fakeApi(['a.txt', 'b.txt'])
    const asked: UploadConflict[] = []
    const answers: ConflictDecision[] = [
      { choice: 'replace', all: false },
      { choice: 'keep_both', all: false },
    ]
    const plan = planUpload(entriesFromPicked([file('a.txt'), file('new.txt'), file('b.txt')]))
    const out = await runUpload(plan, 'reports', api, async (c) => {
      asked.push(c)
      return answers.shift()!
    })
    expect(asked.map((c) => [c.path, c.existing.id, c.message, c.more])).toEqual([
      ['a.txt', 'old-a.txt', '“a.txt” already exists in Reports.', true],
      ['b.txt', 'old-b.txt', '“b.txt” already exists in Reports.', false],
    ])
    expect(api.modes).toEqual(['a.txt:fail', 'a.txt:replace', 'new.txt:fail', 'b.txt:fail', 'b.txt:keep_both'])
    expect(out).toMatchObject({ uploaded: 2, replaced: 1, skipped: [], failures: [], stopped: null })
  })

  it('cancel leaves that file out (named, not a failure); the rest still go up', async () => {
    const api = fakeApi(['a.txt'])
    const plan = planUpload(entriesFromPicked([file('a.txt'), file('b.txt')]))
    const out = await runUpload(plan, null, api, async () => ({ choice: 'skip', all: false }))
    expect(api.modes).toEqual(['a.txt:fail', 'b.txt:fail'])
    expect(out).toMatchObject({ uploaded: 1, replaced: 0, skipped: ['a.txt'], failures: [] })
  })

  it('“apply to all” answers every later clash without asking again', async () => {
    const api = fakeApi(['a.txt', 'b.txt', 'c.txt'])
    const ask = vi.fn(async (): Promise<ConflictDecision> => ({ choice: 'replace', all: true }))
    const plan = planUpload(entriesFromPicked([file('a.txt'), file('b.txt'), file('new.txt'), file('c.txt')]))
    const out = await runUpload(plan, null, api, ask)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(api.modes).toEqual(['a.txt:fail', 'a.txt:replace', 'b.txt:replace', 'new.txt:replace', 'c.txt:replace'])
    expect(out).toMatchObject({ uploaded: 1, replaced: 3, skipped: [] })

    const skipping = fakeApi(['a.txt', 'b.txt'])
    const skipAll = vi.fn(async (): Promise<ConflictDecision> => ({ choice: 'skip', all: true }))
    const out2 = await runUpload(planUpload(entriesFromPicked([file('a.txt'), file('new.txt'), file('b.txt')])), null, skipping, skipAll)
    expect(skipAll).toHaveBeenCalledTimes(1)
    expect(skipping.modes).toEqual(['a.txt:fail', 'new.txt:fail', 'b.txt:fail'])
    expect(out2).toMatchObject({ uploaded: 1, replaced: 0, skipped: ['a.txt', 'b.txt'] })
  })
})
