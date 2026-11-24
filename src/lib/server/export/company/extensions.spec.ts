import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { concatFiles, extensionExportFiles } from './extensions'
import { buildCompanyExport, type ExportFile } from './run'

async function collect(files: AsyncIterable<ExportFile>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for await (const f of files) {
    const parts: Uint8Array[] = []
    for await (const chunk of f.open()) parts.push(chunk)
    out[f.path] = Buffer.concat(parts).toString('utf8')
  }
  return out
}

describe('the company modules’ data in the export (U2 D7)', () => {
  it('carries every file under extensions/<id>/ with its bytes, after the other files', async () => {
    const repo = new Map([
      ['extensions/hello/greetings/ann.json', '{"n":1}\n'],
      ['extensions/invoices/2026/0001.json', '{"total":12}\n'],
    ])
    const files = await collect(
      concatFiles(
        (async function* () {
          yield { path: 'drive/plan.txt', open: async function* () { yield Buffer.from('plan') } }
        })(),
        extensionExportFiles({
          list: async () => [...repo.keys()].sort(),
          read: async (p) => (repo.has(p) ? Buffer.from(repo.get(p)!) : null),
        }),
      ),
    )
    expect(files).toEqual({
      'drive/plan.txt': 'plan',
      'extensions/hello/greetings/ann.json': '{"n":1}\n',
      'extensions/invoices/2026/0001.json': '{"total":12}\n',
    })
  })

  it('the archive holds files/extensions/hello/…', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ee-ext-export-'))
    try {
      const file = join(dir, 'export.zip')
      await buildCompanyExport(
        {
          file,
          rules: {},
          excludedSchemas: {},
          company: { name: 'Acme' },
          appVersion: '0.5.39',
          requestedBy: 'u1',
          now: () => new Date('2026-11-24T12:00:00Z'),
        },
        {
          catalog: async () => ({}),
          rows: async function* () {},
          files: () =>
            extensionExportFiles({
              list: async () => ['extensions/hello/greetings/ann.json'],
              read: async () => Buffer.from('{"n":1}\n'),
            }),
        },
      )
      const zip = unzipSync(readFileSync(file))
      expect(strFromU8(zip['files/extensions/hello/greetings/ann.json']!)).toBe('{"n":1}\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a listed file that is gone, or one outside extensions/, stops the export loudly', async () => {
    await expect(
      collect(extensionExportFiles({ list: async () => ['extensions/hello/a.json'], read: async () => null })),
    ).rejects.toThrow(/listed but is gone/)
    await expect(
      collect(extensionExportFiles({ list: async () => ['secrets/x.age'], read: async () => Buffer.from('x') })),
    ).rejects.toThrow(/outside extensions/)
  })
})
