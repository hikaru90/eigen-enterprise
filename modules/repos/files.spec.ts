import { readFileSync } from 'node:fs'
import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { repoSources } from '$lib/server/db/repos.schema'
import { isDriveName, treeFolderName } from './names'
import { mimeForFile, pickFiles } from './snapshot'

/**
 * The per-file rules of the full mirror that are pure functions: Drive's name
 * rule, the tree folder's name, the MIME type, and the 0161 migration's
 * expand/contract shape (plan/phase-substrate.md D15).
 */

const enc = new TextEncoder()

describe('isDriveName (exactly Drive’s checkName in modules/drive/source-writer.ts)', () => {
  it('accepts ordinary names and refuses what Drive refuses', () => {
    expect(isDriveName('index.ts')).toBe(true)
    expect(isDriveName('2.x')).toBe(true)
    expect(isDriveName('x'.repeat(255))).toBe(true)
    for (const bad of ['', ' notes.md', 'notes.md ', '\tx', 'x'.repeat(256), 'a/b', 'a\\b', '.', '..']) expect(isDriveName(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('pickFiles: names Drive refuses go to "name", never a batch failure', () => {
  const f = (path: string) => ({ path, size: 1, sha: 'a'.repeat(40), mode: '100644' })
  it('a segment with leading whitespace, a 300-character segment', () => {
    const out = pickFiles([f('docs/ notes.md'), f(`src/${'y'.repeat(300)}.ts`), f('docs/trailing /x.md'), f('ok.md')], 'all')
    expect(out.copied.map((e) => e.path)).toEqual(['ok.md'])
    expect(out.notCopied.map((n) => [n.path, n.reason])).toEqual([
      ['docs/ notes.md', 'name'],
      [`src/${'y'.repeat(300)}.ts`, 'name'],
      ['docs/trailing /x.md', 'name'],
    ])
  })
})

describe('treeFolderName (the default-branch folder’s display name; the key never changes)', () => {
  it('replaces each / with -', () => {
    expect(treeFolderName('main')).toBe('main')
    expect(treeFolderName('release/2.x')).toBe('release-2.x')
    expect(treeFolderName('team/a/b')).toBe('team-a-b')
  })
  it('falls back to "default branch" when the result still is no Drive name', () => {
    expect(treeFolderName('b'.repeat(300))).toBe('default branch')
  })
})

describe('mimeForFile (extension table first, then a byte-format check)', () => {
  it('uses the extension table copied from Drive’s MIME_BY_EXT', () => {
    expect(mimeForFile('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(mimeForFile('README.md', enc.encode('# x'))).toBe('text/markdown')
    expect(mimeForFile('Report.PDF', new Uint8Array([0xff]))).toBe('application/pdf')
    expect(mimeForFile('package.json', enc.encode('{}'))).toBe('application/json')
    expect(mimeForFile('page.html', enc.encode('<p>'))).toBe('text/html')
  })
  it('no entry: strict UTF-8 is text, anything else is bytes', () => {
    expect(mimeForFile('index.ts', enc.encode('export {}'))).toBe('text/plain; charset=utf-8')
    expect(mimeForFile('Makefile', enc.encode('all:'))).toBe('text/plain; charset=utf-8')
    expect(mimeForFile('blob.bin', new Uint8Array([0xc3, 0x28]))).toBe('application/octet-stream')
  })
})

describe('migration 0161 is expand/contract (D15): the old blue-green slot keeps working', () => {
  const sql = readFileSync('drizzle/0161_repo_files.sql', 'utf8')
  it('does not drop repo_sources.doc_shas; the drop ships one release later', () => {
    expect(sql).not.toMatch(/DROP\s+COLUMN[^;]*doc_shas/i)
    expect(sql).toContain('dropped in a later release (D15)')
  })
  it('the Drizzle schema still knows the column (defaulted, so new code never writes it)', () => {
    const col = getTableColumns(repoSources).docShas
    expect(col?.name).toBe('doc_shas')
    expect(col?.hasDefault).toBe(true)
  })
})
