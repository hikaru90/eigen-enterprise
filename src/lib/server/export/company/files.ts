import type { ExportFile } from './run'
import type postgres from 'postgres'
import { join } from 'node:path'
import { env } from '$lib/server/env/private-env'
import { diskBlobStore, driveBlobKey, resolveDriveStorageDir, type BlobStore } from '../../../../../modules/drive/storage'
import { DM_FILE } from './rules'

/**
 * The company's files in the export (plan/phase-export.md §3):
 * - `files/drive/<folder path>/<name>`: every live Drive file under its real
 *   folder tree, with its current bytes;
 * - `files/blobs/<store>/<sha256>`: every other stored blob the tables point
 *   at by sha256 (older revisions, trashed files, brand social media, profile
 *   pictures, the company logo), so `data/` can be put back together exactly.
 * A DM's attachments are a DM's (rules.ts): they are not in it. A blob a table
 * points at but the disk doesn't have stops the export — never a silent gap.
 *
 * Blobs are sealed at rest (modules/drive/storage.ts); the export carries
 * their plaintext, unsealed as it streams: it is the owner's portable copy and
 * must open on a restore or elsewhere without this server's TENANT_MASTER_KEY.
 */

export type DriveFolderRow = { id: string; parent_id: string | null; name: string }
export type DriveFileRow = { id: string; folder_id: string | null; name: string }

/** One path segment a file system and a zip accept (a name is kept, only unsafe characters change). */
export function safeSegment(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[/\\\u0000-\u001f]/g, '_').trim()
  if (s === '' || s === '.' || s === '..') return '_'
  return s
}

/** Each live file's path in the tree; two files with one name in a folder get " (2)", " (3)". */
export function drivePaths(folders: DriveFolderRow[], files: DriveFileRow[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const folderPath = new Map<string, string>()
  const pathOf = (id: string, seen = new Set<string>()): string => {
    const cached = folderPath.get(id)
    if (cached !== undefined) return cached
    const f = byId.get(id)
    if (!f) throw new Error(`company export: Drive folder ${id} is missing (a file or folder points at it)`)
    if (seen.has(id)) throw new Error(`company export: Drive folder ${id} is inside itself`)
    seen.add(id)
    const p = f.parent_id ? `${pathOf(f.parent_id, seen)}/${safeSegment(f.name)}` : safeSegment(f.name)
    folderPath.set(id, p)
    return p
  }
  const taken = new Set<string>()
  const out = new Map<string, string>()
  for (const file of [...files].sort((a, b) => a.id.localeCompare(b.id))) {
    const dir = file.folder_id ? `${pathOf(file.folder_id)}/` : ''
    const name = safeSegment(file.name)
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let candidate = `${dir}${name}`
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${dir}${stem} (${n})${ext}`
    taken.add(candidate.toLowerCase())
    out.set(file.id, candidate)
  }
  return out
}

async function present(blobs: BlobStore, sha: string, what: string): Promise<() => AsyncIterable<Uint8Array>> {
  if (!(await blobs.has(sha))) throw new Error(`company export: ${what} is missing on disk (blob ${sha})`)
  return () => blobs.stream(sha)
}

export async function* companyExportFiles(sql: postgres.Sql): AsyncIterable<ExportFile> {
  const root = resolveDriveStorageDir(env)
  const key = driveBlobKey(env)
  const drive = diskBlobStore(root, key)
  const folders = await sql<DriveFolderRow[]>`SELECT id, parent_id, name FROM drive_folder WHERE trashed_at IS NULL`
  const live = await sql.unsafe<(DriveFileRow & { sha256: string })[]>(
    `SELECT t.id, t.folder_id, t.name, t.sha256 FROM drive_file t
     WHERE t.trashed_at IS NULL AND NOT ${DM_FILE('t.id')}
       AND (t.folder_id IS NULL OR t.folder_id IN (SELECT id FROM drive_folder WHERE trashed_at IS NULL))`,
  )
  const paths = drivePaths(folders, live)
  const inTree = new Set<string>()
  for (const f of live) {
    const path = paths.get(f.id)!
    const open = await present(drive, f.sha256, `Drive file ${f.id} (${f.name})`)
    inTree.add(f.sha256)
    yield { path: `drive/${path}`, open }
  }

  const driveShas = await sql.unsafe<{ sha256: string }[]>(
    `SELECT DISTINCT sha256 FROM (
       SELECT t.sha256 FROM drive_file t WHERE NOT ${DM_FILE('t.id')}
       UNION SELECT t.sha256 FROM drive_revision t WHERE NOT ${DM_FILE('t.file_id')}
     ) s ORDER BY sha256`,
  )
  for (const { sha256 } of driveShas) {
    if (inTree.has(sha256)) continue
    const open = await present(drive, sha256, `Drive blob ${sha256}`)
    yield { path: `blobs/drive/${sha256}`, open }
  }

  const stores: { store: string; query: string }[] = [
    { store: 'brand-social', query: `SELECT DISTINCT sha256 FROM brand_social_media WHERE sha256 IS NOT NULL ORDER BY 1` },
    { store: 'profile', query: `SELECT DISTINCT avatar_sha256 AS sha256 FROM "user" WHERE avatar_sha256 IS NOT NULL ORDER BY 1` },
    {
      store: 'company',
      query: `SELECT DISTINCT sha256 FROM (SELECT logo_sha256 AS sha256 FROM company_profile UNION SELECT logo_original_sha256 FROM company_profile) s WHERE sha256 IS NOT NULL ORDER BY 1`,
    },
  ]
  for (const { store, query } of stores) {
    for (const { sha256 } of await sql.unsafe<{ sha256: string }[]>(query)) {
      const open = await present(diskBlobStore(join(root, store), key), sha256, `${store} blob ${sha256}`)
      yield { path: `blobs/${store}/${sha256}`, open }
    }
  }
}
