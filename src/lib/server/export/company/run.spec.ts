import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { ExportPlanError, type TableRule } from './plan'
import { buildCompanyExport, type CompanyExportPorts } from './run'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'ee-company-export-'))
  dirs.push(d)
  return join(d, 'export.zip')
}

const rules: Record<string, TableRule> = {
  contact: { export: 'private-as-meta', privateWhen: 'NOT t.shared', meta: ['id', 'owner_id'], content: ['name'], secret: [] },
  session: { export: 'excluded', reason: 'sign-in sessions' },
  llm_key: { export: 'full', secret: ['api_key'] },
}

/** Rows the fake database "returns" per table (as the planned SELECT would shape them). */
function ports(over: Partial<CompanyExportPorts> = {}): CompanyExportPorts {
  const byTable: Record<string, Record<string, unknown>[]> = {
    contact: [{ id: 'c1', owner_id: 'u1', name: 'Ada' }, { id: 'c2', owner_id: 'u2', _private: true }],
    llm_key: [{ id: 'k1', provider: 'openrouter' }],
  }
  return {
    catalog: async () => ({ contact: ['id', 'owner_id', 'name'], session: ['id'], llm_key: ['id', 'provider', 'api_key'], 'cron.job': ['jobid'] }),
    rows: async function* (sql) {
      const table = /FROM "([a-z_]+)"/.exec(sql)![1]
      yield byTable[table].map((row) => ({ row }))
    },
    files: async function* () {
      yield { path: 'drive/Team/plan.txt', open: async function* () { yield new TextEncoder().encode('the plan') } }
    },
    ...over,
  }
}

const input = (file: string) => ({
  file,
  rules,
  excludedSchemas: { cron: 'server plumbing' },
  company: { name: 'Acme' },
  appVersion: '0.5.38',
  requestedBy: 'u1',
  now: () => new Date('2026-11-23T12:00:00Z'),
})

describe('buildCompanyExport', () => {
  it('writes every table, the files, README, RECONNECT and a manifest that lists every entry', async () => {
    const file = tmpFile()
    const { manifest, bytes } = await buildCompanyExport(input(file), ports())
    const zip = unzipSync(readFileSync(file))

    expect(Object.keys(zip).sort()).toEqual(
      ['README.md', 'RECONNECT.md', 'data/contact.jsonl', 'data/llm_key.jsonl', 'files/drive/Team/plan.txt', 'manifest.json'].sort(),
    )
    expect(strFromU8(zip['data/contact.jsonl']).trim().split('\n').map((l) => JSON.parse(l))).toEqual([
      { id: 'c1', owner_id: 'u1', name: 'Ada' },
      { id: 'c2', owner_id: 'u2', _private: true },
    ])
    expect(strFromU8(zip['files/drive/Team/plan.txt'])).toBe('the plan')
    expect(manifest.tables).toEqual([
      { table: 'contact', rows: 2, privateRows: 1, secretColumns: [] },
      { table: 'llm_key', rows: 1, privateRows: 0, secretColumns: ['api_key'] },
    ])
    expect(manifest.excluded).toEqual([
      { table: 'session', reason: 'sign-in sessions' },
      { table: 'cron.job', reason: 'server plumbing' },
    ])
    const written = JSON.parse(strFromU8(zip['manifest.json']))
    expect(written.entries.map((e: { path: string }) => e.path)).toEqual([
      'data/contact.jsonl', 'data/llm_key.jsonl', 'files/drive/Team/plan.txt', 'README.md', 'RECONNECT.md',
    ])
    expect(strFromU8(zip['RECONNECT.md'])).toContain('`llm_key` (1 rows): `api_key`')
    expect(strFromU8(zip['README.md'])).toContain('- `session`: sign-in sessions')
    expect(bytes).toBe(readFileSync(file).byteLength)
  })

  it('refuses before writing anything when a table has no rule', async () => {
    const file = tmpFile()
    const p = ports({ catalog: async () => ({ contact: ['id', 'owner_id', 'name'], session: ['id'], llm_key: ['id', 'provider', 'api_key'], brand_new: ['id'] }) })
    await expect(buildCompanyExport(input(file), p)).rejects.toBeInstanceOf(ExportPlanError)
    expect(existsSync(file)).toBe(false)
  })

  it('fails loud when reading a table fails', async () => {
    const p = ports({
      rows: async function* () {
        yield* []
        throw new Error('connection lost')
      },
    })
    const file = tmpFile()
    await expect(buildCompanyExport(input(file), p)).rejects.toThrow('connection lost')
    expect(existsSync(file)).toBe(false)
  })
})
