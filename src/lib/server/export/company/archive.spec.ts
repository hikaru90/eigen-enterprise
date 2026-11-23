import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamingArchive } from './archive'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'ee-archive-'))
  dirs.push(d)
  return join(d, 'out.zip')
}

describe('StreamingArchive', () => {
  it('writes deflated and stored entries a standard unzip reads, with sha256 per entry', async () => {
    const file = tmpFile()
    const a = new StreamingArchive(file)
    await a.addText('README.md', '# hi\n')
    async function* blob() {
      yield new Uint8Array([1, 2, 3])
      yield new Uint8Array([4])
    }
    const b = await a.add('drive/x.bin', blob(), { store: true })
    await a.finish()

    const files = unzipSync(readFileSync(file))
    expect(strFromU8(files['README.md'])).toBe('# hi\n')
    expect([...files['drive/x.bin']]).toEqual([1, 2, 3, 4])
    expect(b).toEqual({
      path: 'drive/x.bin',
      bytes: 4,
      sha256: createHash('sha256').update(new Uint8Array([1, 2, 3, 4])).digest('hex'),
    })
    expect(a.list().map((e) => e.path)).toEqual(['README.md', 'drive/x.bin'])
  })

  it('refuses unsafe and duplicate paths', async () => {
    const a = new StreamingArchive(tmpFile())
    await expect(a.addText('../etc/passwd', 'x')).rejects.toThrow('not a safe entry path')
    await expect(a.addText('/abs', 'x')).rejects.toThrow('not a safe entry path')
    await a.addText('a.txt', 'x')
    await expect(a.addText('a.txt', 'y')).rejects.toThrow('two entries at a.txt')
    await a.finish()
  })

  it('never overwrites an existing file', async () => {
    const file = tmpFile()
    const a = new StreamingArchive(file)
    await a.finish()
    const b = new StreamingArchive(file)
    await expect(b.finish()).rejects.toThrow(/EEXIST/)
  })
})
