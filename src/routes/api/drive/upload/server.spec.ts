import { describe, expect, it, vi } from 'vitest'
import { DriveError, UploadConflictError } from '$lib/server/drive'

const { holder } = vi.hoisted(() => ({ holder: { drive: null as unknown } }))
vi.mock('$lib/server/drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/drive')>()
  return { ...actual, driveService: async () => holder.drive }
})

const { POST } = await import('./+server')

function post(fields: Array<[string, string | File]>) {
  const form = new FormData()
  for (const [k, v] of fields) form.append(k, v)
  return POST({
    locals: { user: { id: 'alice' } },
    url: new URL('http://localhost/api/drive/upload'),
    request: new Request('http://localhost/api/drive/upload', { method: 'POST', body: form }),
  } as never)
}
const file = (name: string) => new File(['hi'], name, { type: 'text/plain' })

describe('POST /api/drive/upload: a name already in the folder (bug f45acdef)', () => {
  it('needs the decision: no onConflict (or an unknown one) is refused before anything lands', async () => {
    const upload = vi.fn()
    holder.drive = { upload }
    for (const fields of [[['file', file('a.txt')]], [['file', file('a.txt')], ['onConflict', 'overwrite']]] as Array<Array<[string, string | File]>>) {
      const res = await post(fields)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: 'invalid', error: 'Say what to do when a file of that name is already there: onConflict replace, keep_both or fail.' })
    }
    expect(upload).not.toHaveBeenCalled()
  })

  it('passes the decision to the service and reports a clash per file, with the existing file, next to what landed', async () => {
    const existing = { type: 'file', id: 'f-1', name: 'a.txt' }
    const upload = vi.fn(async (_actor: unknown, _folder: unknown, f: { name: string }) => {
      if (f.name === 'a.txt') throw new UploadConflictError('“a.txt” already exists in Reports.', existing as never)
      if (f.name === 'big.bin') throw new DriveError('too_large', '“big.bin” is too large.')
      return { type: 'file', id: 'f-2', name: f.name, outcome: 'created' }
    })
    holder.drive = { upload }
    const res = await post([
      ['folderId', 'reports'],
      ['onConflict', 'fail'],
      ['file', file('a.txt')],
      ['file', file('b.txt')],
      ['file', file('big.bin')],
    ])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      uploaded: [{ type: 'file', id: 'f-2', name: 'b.txt', outcome: 'created' }],
      errors: ['“big.bin” is too large.'],
      conflicts: [{ name: 'a.txt', error: '“a.txt” already exists in Reports.', existing }],
    })
    expect(upload.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      ['reports', 'fail'],
      ['reports', 'fail'],
      ['reports', 'fail'],
    ])
  })

  it('replace and keep_both go through as asked', async () => {
    const upload = vi.fn(async () => ({ type: 'file', id: 'f-1', name: 'a.txt', outcome: 'replaced' }))
    holder.drive = { upload }
    const res = await post([
      ['onConflict', 'replace'],
      ['file', file('a.txt')],
    ])
    expect(await res.json()).toMatchObject({ uploaded: [{ outcome: 'replaced' }], conflicts: [] })
    expect(upload.mock.calls[0]![1]).toBeNull()
    expect(upload.mock.calls[0]![3]).toBe('replace')
  })
})
