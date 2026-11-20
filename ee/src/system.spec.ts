import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { durableWrite, RealSystem, type DurableFs } from './system.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('durable state writes (a crash never leaves an empty journal)', () => {
  it('flushes the data to disk BEFORE the rename, then flushes the directory entry', async () => {
    const calls: string[] = []
    const fs: DurableFs = {
      mkdir: async () => void calls.push('mkdir'),
      open: async (p: string, flags: string) => {
        calls.push(`open ${p.endsWith('.json') ? 'dir-or-file' : p.includes('.ee-tmp-') ? 'tmp' : 'dir'} ${flags}`)
        return {
          writeFile: async () => void calls.push('write'),
          chmod: async () => void calls.push('chmod'),
          sync: async () => void calls.push('sync'),
          close: async () => void calls.push('close'),
        }
      },
      rename: async () => void calls.push('rename'),
    }
    await durableWrite('/var/lib/ee/journal.json', '{"version":1}\n', 0o600, fs)
    expect(calls).toEqual(['mkdir', 'open tmp w', 'write', 'chmod', 'sync', 'close', 'rename', 'open dir r', 'sync', 'close'])
  })

  it('a failed write leaves the old file untouched and fails loud', async () => {
    const fs: DurableFs = {
      mkdir: async () => {},
      open: async () => ({
        writeFile: async () => {
          throw new Error('ENOSPC: no space left on device')
        },
        chmod: async () => {},
        sync: async () => {},
        close: async () => {},
      }),
      rename: async () => {
        throw new Error('rename must not run after a failed write')
      },
    }
    await expect(durableWrite('/var/lib/ee/journal.json', 'x', 0o600, fs)).rejects.toThrow(/ENOSPC/)
  })

  it('on a real disk: content and mode land, no temp file is left behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ee-sys-'))
    dirs.push(dir)
    const path = join(dir, 'state', 'journal.json')
    const sys = new RealSystem()
    await sys.writeFile(path, '{"a":1}\n', 0o600)
    await sys.writeFile(path, '{"a":2}\n', 0o600)
    expect(await readFile(path, 'utf8')).toBe('{"a":2}\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(dir, 'state'))).toEqual(['journal.json'])
  })
})
