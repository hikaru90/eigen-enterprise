import { stat } from 'node:fs/promises'
import { StreamingArchive, type ArchiveEntry } from './archive'
import { planCompanyExport, type Catalog, type TablePlan, type TableRule } from './plan'

/**
 * Builds the company export archive (plan/phase-export.md §3, X1): every
 * table of the company database as JSON Lines under `data/` (private rows as
 * metadata only, secrets never), the company's files under `files/`, and a
 * manifest, README and RECONNECT list. Ports keep it testable without the app.
 */

export const COMPANY_EXPORT_FORMAT = 1

export type ExportFile = {
  /** Path inside `files/`, e.g. `drive/Team/Plan.pdf`. */
  path: string
  open(): AsyncIterable<Uint8Array>
}

export type CompanyExportPorts = {
  /** Every table of the company database with its columns, catalog order. */
  catalog(): Promise<Catalog>
  /** Streams the planned SELECT's `row` column in batches. */
  rows(sql: string): AsyncIterable<readonly Record<string, unknown>[]>
  /** The company's files the export carries (private ones already left out). */
  files(): AsyncIterable<ExportFile>
}

export type CompanyExportInput = {
  file: string
  rules: Record<string, TableRule>
  excludedSchemas: Record<string, string>
  /** null until the company is named (Settings → Company or the founding interview). */
  company: { name: string | null }
  appVersion: string
  requestedBy: string
  now: () => Date
}

export type TableReport = { table: string; rows: number; privateRows: number; secretColumns: string[] }

export type CompanyExportManifest = {
  format: number
  appVersion: string
  company: string | null
  exportedAt: string
  requestedBy: string
  tables: TableReport[]
  excluded: { table: string; reason: string }[]
  entries: ArchiveEntry[]
}

/** `bytes`: the archive's size on disk. */
export type CompanyExportResult = { manifest: CompanyExportManifest; bytes: number }

async function* jsonLines(plan: Extract<TablePlan, { export: 'rows' }>, ports: CompanyExportPorts, report: TableReport) {
  const enc = new TextEncoder()
  for await (const batch of ports.rows(plan.sql)) {
    let chunk = ''
    for (const r of batch) {
      const row = r.row as Record<string, unknown>
      report.rows += 1
      if (row._private === true) report.privateRows += 1
      chunk += JSON.stringify(row) + '\n'
    }
    if (chunk) yield enc.encode(chunk)
  }
}

export async function buildCompanyExport(input: CompanyExportInput, ports: CompanyExportPorts): Promise<CompanyExportResult> {
  // The plan is checked before a single byte is written: an unclassified table stops here.
  const plan = planCompanyExport(await ports.catalog(), input.rules, input.excludedSchemas)
  const archive = new StreamingArchive(input.file)
  try {
    const tables: TableReport[] = []
    const excluded: { table: string; reason: string }[] = []
    for (const p of plan) {
      if (p.export === 'excluded') {
        excluded.push({ table: p.table, reason: p.reason })
        continue
      }
      const report: TableReport = { table: p.table, rows: 0, privateRows: 0, secretColumns: p.secret }
      await archive.add(`data/${p.table}.jsonl`, jsonLines(p, ports, report))
      tables.push(report)
    }
    for await (const f of ports.files()) await archive.add(`files/${f.path}`, f.open(), { store: true })

    const manifestBase = {
      format: COMPANY_EXPORT_FORMAT,
      appVersion: input.appVersion,
      company: input.company.name,
      exportedAt: input.now().toISOString(),
      requestedBy: input.requestedBy,
      tables,
      excluded,
    }
    await archive.addText('README.md', readme(manifestBase))
    await archive.addText('RECONNECT.md', reconnect(tables))
    const manifest: CompanyExportManifest = { ...manifestBase, entries: [...archive.list()] }
    // Written last: it lists every other entry with its sha256.
    await archive.addText('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
    await archive.finish()
    return { manifest, bytes: (await stat(input.file)).size }
  } catch (err) {
    await archive.abort()
    throw err
  }
}

function readme(m: Omit<CompanyExportManifest, 'entries'>): string {
  const privateRows = m.tables.reduce((n, t) => n + t.privateRows, 0)
  return `# ${m.company ?? 'Company'} export

Exported ${m.exportedAt} from eigenEnterprise ${m.appVersion} (export format ${m.format}).

This archive is everything the company owns, in open formats. You need no
eigenEnterprise to read it.

- \`data/<table>.jsonl\`: every table of the company database, one JSON object per line.
  Columns keep their database names. Times are ISO 8601. Binary values are hex (\`\\\\x…\`).
- \`files/\`: the company's files with their original bytes.
- \`manifest.json\`: every file in this archive with its size and sha256, the row
  count per table, and the tables left out with the reason.
- \`RECONNECT.md\`: the keys and connections to set up again. Secrets are never exported.

## Private data

A member's private items (${privateRows} rows here) are in this export as
metadata only: who they belong to, when they were made, who else was involved.
Their content is not, because nobody but that member can read it in the app.

## Left out on purpose

${m.excluded.length ? m.excluded.map((e) => `- \`${e.table}\`: ${e.reason}`).join('\n') : '- nothing'}
`
}

function reconnect(tables: TableReport[]): string {
  const withSecrets = tables.filter((t) => t.secretColumns.length > 0)
  return `# Set these up again

Secrets (API keys, tokens, passwords, private keys) never leave the system in
plain text. These tables held one; the rows are exported, the secret is not:

${withSecrets.length ? withSecrets.map((t) => `- \`${t.table}\` (${t.rows} rows): ${t.secretColumns.map((c) => `\`${c}\``).join(', ')}`).join('\n') : '- none'}
`
}
