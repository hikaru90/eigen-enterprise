import { createSheetEditor } from './editor'
import { sheetValues } from './read'

/**
 * The workbook's text for agents and the Brain (see ../text.ts): one
 * `## Sheet: <name>` section per sheet of cells, its used range as a
 * Markdown table of the values as Excel shows them (formulas calculated;
 * drive.sheet_read gives the formulas themselves). Chart sheets are named
 * with a note. A broken file throws with the reason.
 */
export async function extractText(bytes: Uint8Array): Promise<string> {
  const ed = createSheetEditor(bytes)
  return ed.wb
    .sheets()
    .map((s) => {
      const head = `## Sheet: ${s.name}${s.state !== 'visible' ? ' (hidden)' : ''}`
      if (s.kind !== 'worksheet') return `${head}\n\n(A ${s.kind === 'chartsheet' ? 'chart sheet' : s.kind}: no cells.)\n`
      const { rows } = sheetValues(ed, s.name, null, 'en')
      if (rows.length === 0) return `${head}\n\n(Empty.)\n`
      const width = Math.max(...rows.map((r) => r.length))
      const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`
      return [head, '', line(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line), ''].join('\n')
    })
    .join('\n')
}
