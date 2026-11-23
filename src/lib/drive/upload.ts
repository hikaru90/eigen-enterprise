import { DriveApiError, formatSize, type DriveItem, type OnConflict, type UploadResult } from './api'

/**
 * Uploading into Drive, files or whole folders (from the folder picker or
 * dropped from the desktop). The folder tree is recreated where the upload
 * lands — folders first, parents before children — then each file goes up in
 * its own request into its folder (so one request never carries more than one
 * file's bytes, and progress moves file by file). Nothing is skipped quietly:
 * every file that doesn't land is named in `failures` with why.
 *
 * A file whose name is already in its folder is never doubled or overwritten
 * unasked: it goes up under `fail`, and a clash asks the person (`resolve`):
 * replace (a new revision of that file), keep both (“name (2).ext”) or skip
 * it — for this file, or for every later clash too (`all`).
 */

/** One file and the folders it sits in, relative to where the upload lands (`[]`: right there). */
export type UploadEntry = { file: File; dirs: string[] }
export type UploadFailure = { path: string; reason: string }
/** What to create and upload: `folders` parents first; `failures` already known (unreadable items). */
export type UploadPlan = { folders: string[][]; files: UploadEntry[]; failures: UploadFailure[] }
export type UploadProgress = { done: number; total: number; current: string }
export type UploadOutcome = {
  /** New files (kept-both copies included). */
  uploaded: number
  /** Existing files that got the upload as a new revision. */
  replaced: number
  /** Paths the person chose to leave out at a clash. */
  skipped: string[]
  folders: number
  failures: UploadFailure[]
  /** Why the upload stopped early (a refusal that isn't about one file), else null. */
  stopped: string | null
}
export type UploadApi = {
  createFolder: (parentId: string | null, name: string) => Promise<DriveItem>
  upload: (folderId: string | null, files: File[], onConflict: OnConflict) => Promise<UploadResult>
}
/** A clash to ask about: the file's path in the upload, the server's sentence, the file that is there, and whether more files follow. */
export type UploadConflict = { path: string; name: string; message: string; existing: DriveItem; more: boolean }
/** The person's answer: `skip` is Cancel for this file; `all` answers every later clash the same way. */
export type ConflictDecision = { choice: 'replace' | 'keep_both' | 'skip'; all: boolean }
export type ConflictResolver = (conflict: UploadConflict) => Promise<ConflictDecision>

const joined = (dirs: string[], name?: string) =>
  [...dirs, ...(name === undefined ? [] : [name])].join('/')

/** Picked files: from the folder picker each carries its path ("Trip/day 1/a.jpg"); plain picks have none. */
export function entriesFromPicked(files: File[]): UploadEntry[] {
  return files.map((file) => {
    const parts = file.webkitRelativePath ? file.webkitRelativePath.split('/').filter(Boolean) : []
    return { file, dirs: parts.slice(0, -1) }
  })
}

/** A dropped item, read while the drop event lasts (the browser empties `items` right after). */
export type DropSource =
  | { kind: 'file'; file: File }
  | { kind: 'dir'; entry: FileSystemDirectoryEntry }
  | { kind: 'unreadable'; name: string }

/** Call inside the drop handler itself: folders come as directory entries, files as themselves. */
export function droppedSources(data: DataTransfer): DropSource[] {
  const out: DropSource[] = []
  for (const item of [...data.items]) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry()
    if (entry?.isDirectory) {
      out.push({ kind: 'dir', entry: entry as FileSystemDirectoryEntry })
      continue
    }
    const file = item.getAsFile()
    out.push(
      file ? { kind: 'file', file } : { kind: 'unreadable', name: entry?.name ?? 'A dropped item' },
    )
  }
  return out
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** All of a directory's children (readEntries hands them out in batches until an empty one). */
async function children(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail))
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

/** Walks dropped folders into a plan: every folder (empty ones too), every file, and what couldn't be read. */
export async function collectDropped(sources: DropSource[]): Promise<UploadPlan> {
  const files: UploadEntry[] = []
  const folders: string[][] = []
  const failures: UploadFailure[] = []
  async function walk(dir: FileSystemDirectoryEntry, dirs: string[]) {
    folders.push(dirs)
    let list: FileSystemEntry[]
    try {
      list = await children(dir)
    } catch (err) {
      failures.push({ path: joined(dirs), reason: `Couldn’t read this folder: ${message(err)}` })
      return
    }
    for (const child of list) {
      if (child.isDirectory) await walk(child as FileSystemDirectoryEntry, [...dirs, child.name])
      else {
        try {
          const file = await new Promise<File>((ok, fail) =>
            (child as FileSystemFileEntry).file(ok, fail),
          )
          files.push({ file, dirs })
        } catch (err) {
          failures.push({
            path: joined(dirs, child.name),
            reason: `Couldn’t read this file: ${message(err)}`,
          })
        }
      }
    }
  }
  for (const source of sources) {
    if (source.kind === 'file') files.push({ file: source.file, dirs: [] })
    else if (source.kind === 'dir') await walk(source.entry, [source.entry.name])
    else failures.push({ path: source.name, reason: 'The browser didn’t hand over this item.' })
  }
  return planUpload(files, folders, failures)
}

/** The plan for these files: each folder they need (and `extraFolders`, e.g. empty ones) once, parents first. */
export function planUpload(
  files: UploadEntry[],
  extraFolders: string[][] = [],
  failures: UploadFailure[] = [],
): UploadPlan {
  const seen = new Map<string, string[]>()
  const add = (dirs: string[]) => {
    for (let depth = 1; depth <= dirs.length; depth++) {
      const path = dirs.slice(0, depth)
      seen.set(joined(path), path)
    }
  }
  for (const dirs of extraFolders) add(dirs)
  for (const entry of files) add(entry.dirs)
  const folders = [...seen.values()].sort((a, b) => a.length - b.length)
  return { folders, files, failures }
}

/** A refusal about this one item (bad name, too large); anything else stops the upload. */
const aboutTheItem = (err: unknown) =>
  err instanceof DriveApiError && (err.status === 400 || err.status === 413)

function tooLargeReason(err: unknown, file: File): string {
  // The server's own size sentence when it gave one; a bare 413 is the request limit in front of it.
  if (err instanceof DriveApiError && err.status === 413 && err.code === null)
    return `“${file.name}” is ${formatSize(file.size)}, more than the server takes in one upload.`
  return message(err)
}

/** Runs a plan into `targetId`: folders, then files one request each, reporting progress after each step. */
export async function runUpload(
  plan: UploadPlan,
  targetId: string | null,
  api: UploadApi,
  resolve: ConflictResolver,
  onProgress: (p: UploadProgress) => void = () => {},
): Promise<UploadOutcome> {
  const failures = [...plan.failures]
  const total = plan.files.length
  const ids = new Map<string, string | null>([['', targetId]])
  /** Folder path → the reason it (or a folder above it) wasn't created. */
  const missing = new Map<string, string>()
  let created = 0
  let stopped: string | null = null
  const idOf = (path: string) => {
    const id = ids.get(path)
    if (id === undefined)
      throw new Error(`Upload plan out of order: folder “${path}” comes after what goes in it.`)
    return id
  }

  for (const dirs of plan.folders) {
    const path = joined(dirs)
    const parent = joined(dirs.slice(0, -1))
    if (stopped) {
      missing.set(path, 'not uploaded: the upload stopped')
      continue
    }
    const above = missing.get(parent)
    if (above !== undefined) {
      missing.set(path, above)
      continue
    }
    onProgress({ done: 0, total, current: `Creating folder ${path}` })
    try {
      const folder = await api.createFolder(idOf(parent), dirs[dirs.length - 1]!)
      ids.set(path, folder.id)
      created++
    } catch (err) {
      failures.push({ path, reason: `Couldn’t create this folder: ${message(err)}` })
      missing.set(path, `not uploaded: its folder “${path}” couldn’t be created`)
      if (!aboutTheItem(err)) stopped = message(err)
    }
  }

  let uploaded = 0
  let replaced = 0
  const skipped: string[] = []
  /** An “apply to all” answer, once given. */
  let always: ConflictDecision['choice'] | null = null
  const count = (out: UploadResult, path: string) => {
    for (const item of out.uploaded) {
      if (item.outcome === 'replaced') replaced++
      else uploaded++
    }
    for (const reason of out.errors) failures.push({ path, reason })
  }
  let done = 0
  for (const [index, entry] of plan.files.entries()) {
    const dir = joined(entry.dirs)
    const path = joined(entry.dirs, entry.file.name)
    if (stopped) {
      failures.push({ path, reason: 'not uploaded: the upload stopped' })
      continue
    }
    const gone = missing.get(dir)
    if (gone !== undefined) {
      failures.push({ path, reason: gone })
      done++
      continue
    }
    onProgress({ done, total, current: path })
    try {
      const folder = idOf(dir)
      const first = await api.upload(folder, [entry.file], always === 'replace' || always === 'keep_both' ? always : 'fail')
      count(first, path)
      for (const clash of first.conflicts) {
        const decision: ConflictDecision =
          always !== null
            ? { choice: always, all: true }
            : await resolve({
                path,
                name: clash.name,
                message: clash.error,
                existing: clash.existing,
                more: index < plan.files.length - 1,
              })
        if (decision.all) always = decision.choice
        if (decision.choice === 'skip') skipped.push(path)
        else count(await api.upload(folder, [entry.file], decision.choice), path)
      }
    } catch (err) {
      failures.push({
        path,
        reason: aboutTheItem(err) ? tooLargeReason(err, entry.file) : message(err),
      })
      if (!aboutTheItem(err)) stopped = message(err)
    }
    done++
  }
  onProgress({ done, total, current: '' })
  return { uploaded, replaced, skipped, folders: created, failures, stopped }
}
