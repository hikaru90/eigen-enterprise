import type { ExportFile } from './run'

/**
 * The company modules' data in the export (plan/phase-upgrades-u2.md D7): a
 * module persists only through `data.*`, into `extensions/<id>/…` of the
 * company data repo, so the export carries every such file as
 * `files/extensions/<id>/…` with its bytes. The repo is read through a port
 * (the live GitEngine's working tree), so a spec needs no repo on disk.
 */

export type ExtensionDataSource = {
  /** Every file path under `extensions/` (repo paths, sorted). */
  list(prefix: 'extensions/'): Promise<string[]>
  read(path: string): Promise<Uint8Array | null>
}

export async function* extensionExportFiles(source: ExtensionDataSource): AsyncIterable<ExportFile> {
  for (const path of await source.list('extensions/')) {
    if (!path.startsWith('extensions/')) {
      throw new Error(`company export: ${path} is outside extensions/ (the data source listed it there)`)
    }
    const bytes = await source.read(path)
    if (bytes === null) throw new Error(`company export: ${path} was listed but is gone`)
    yield {
      path,
      open: async function* () {
        yield bytes
      },
    }
  }
}

/** Two file streams, one after the other. */
export async function* concatFiles(...streams: AsyncIterable<ExportFile>[]): AsyncIterable<ExportFile> {
  for (const s of streams) yield* s
}
