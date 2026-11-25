/** Browser client for /api/drive/*: every call throws the server's plain error sentence (and its agent report) on failure. */
import { shownErrorOf, type AgentReport } from '$lib/errors/agent-report'

/** Where an item in the unified Drive overview comes from. */
export type DriveOrigin = 'mine' | 'shared' | 'messages' | 'source'

export type DriveItem = {
  type: 'folder' | 'file'
  id: string
  name: string
  parentId: string | null
  ownerId: string
  updatedAt: string | Date
  trashedAt: string | Date | null
  /** Set when the item itself is archived (who: a member id or the agent's id). */
  archivedAt?: string | Date | null
  archivedBy?: string | null
  /** Search results: archived itself or inside an archived folder. */
  inArchive?: boolean
  size?: number
  mime?: string
  /** Files: when the file is from (its own recorded date, else when it was uploaded or added). */
  dated?: { at: string | Date; kind: 'taken' | 'created' | 'uploaded' | 'added' }
  /** Unified overview: which Drive origin this top-level item came from, and its label. */
  origin?: DriveOrigin
  originLabel?: string
}
export type Crumb = { id: string; name: string }
/** One folder's archived items in the Archived view. */
export type ArchiveGroup = {
  key: string
  folder: Crumb | null
  root: PathRoot
  path: Crumb[]
  items: Array<
    DriveItem & { canEdit?: boolean; canManage?: boolean; archivedByName: string | null }
  >
}
export type ArchiveSuggestion = { file: DriveItem; root: PathRoot; path: Crumb[]; reason: string }
export type ArchiveSuggestions = {
  olderThanDays: number
  considered: number
  more: boolean
  suggestions: ArchiveSuggestion[]
}
export type ItemRef = Pick<DriveItem, 'type' | 'id'>
export type Unarchived = { item: DriveItem; stillIn: Crumb | null }
/** One item a bulk act could not do, and why (a plain sentence). */
export type BatchFailure = ItemRef & { error: string }
/**
 * A listing row's owner name (null: not a member) and sharing (null: not told
 * — you don't manage it); `readOnlyFrom` names the source a read-only copy
 * comes from (e.g. "GitHub"), else null.
 */
export type ItemDescription = {
  ownerName: string | null
  shared: boolean | null
  readOnlyFrom: string | null
}
export type AccessLevel = 'view' | 'edit' | 'manage'
export type GrantSubject =
  { kind: 'user'; userId: string } | { kind: 'group'; groupId: string } | { kind: 'company' }
export type GrantEntry = { subject: GrantSubject; level: AccessLevel }
export type ShareTargets = {
  people: Array<{ id: string; name: string; email: string }>
  groups: Array<{ id: string; name: string }>
}

export type LockHolder = { userId: string; sessionId: string; since: string; name: string }
export type LockView =
  { state: 'held'; since: string } | { state: 'locked'; holder: LockHolder } | { state: 'free' }
export type Revision = {
  id: string
  fileId: string
  size: number
  authorId: string
  createdAt: string
  /** Set when this revision brought back an earlier one. */
  restoredFrom?: { id: string; authorId: string; createdAt: string }
}
/** Where a Drive path starts ("My drive", "Shared with me", "Messages"). */
export type PathRoot = { label: string; href: string }

/** An app preview as ee reports it (plan/phase-drive-app-preview.md). */
export type PreviewState = 'installing' | 'starting' | 'running' | 'failed' | 'stopped'
export type AppPreview = {
  id: string
  folderName: string
  state: PreviewState
  host: string
  url: string
  script: 'dev' | 'start' | null
  startedAt: string
  lastSeenAt: string
  error: string | null
  log: string[]
}
export type WebApp = { script: 'dev' | 'start'; lockfile: string | null }
/** A folder's web app facts and its preview; managed false: this server runs no apps (reason says why). */
export type AppStatus = {
  folder: { id: string; name: string }
  webApp: WebApp | null
  previewId: string
  managed: boolean
  reason: string | null
  preview: AppPreview | null
}

/**
 * When an uploaded file's name is already in its folder: `replace` gives that
 * file the upload as a new revision, `keep_both` adds it as “name (2).ext”,
 * `fail` leaves it out and reports the clash in `conflicts`.
 */
export type OnConflict = 'replace' | 'keep_both' | 'fail'
/** What one upload request did: the files that landed (and how), the per-file refusals, and the clashes under `fail`. */
export type UploadResult = {
  uploaded: Array<DriveItem & { outcome: 'created' | 'replaced' | 'kept_both' }>
  errors: string[]
  conflicts: Array<{ name: string; error: string; existing: DriveItem }>
}

/** A failed Drive call: the server's sentence, its code, (for `locked`) who holds the edit lock, (for `busy`) the app that is running. */
export class DriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly holder: LockHolder | null,
    readonly running: AppPreview | null = null,
    /** The server's agent report (`{ error, agent }`), when it sent one. */
    readonly agent: AgentReport | null = null,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = (await res.json().catch(() => null)) as
    (T & { error?: string; code?: string; holder?: LockHolder; running?: AppPreview }) | null
  if (!res.ok) {
    const shown = shownErrorOf(body)
    throw new DriveApiError(
      shown?.error ?? `Drive request failed (${res.status}).`,
      res.status,
      body?.code ?? null,
      body?.holder ?? null,
      body?.running ?? null,
      shown?.agent ?? null,
    )
  }
  return body as T
}
const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const driveApi = {
  listFolder: (parentId: string | null) =>
    call<{
      folder: DriveItem | null
      path: Array<{ id: string; name: string }>
      items: DriveItem[]
      canEdit: boolean
    }>(`/api/drive/folders?parent=${encodeURIComponent(parentId ?? '')}`),
  createFolder: (parentId: string | null, name: string) =>
    call<DriveItem>('/api/drive/folders', send('POST', { parentId, name })),
  createDocument: (folderId: string | null, kind: 'md' | 'csv' | 'xlsx', name?: string) =>
    call<DriveItem>(
      '/api/drive/documents',
      send('POST', { folderId, kind, ...(name ? { name } : {}) }),
    ),
  /** An .xls/.ods shown read-only → an editable .xlsx next to it (drive.make_xlsx_copy); `notKept`: what the copy lacks. */
  makeXlsxCopy: (fileId: string) =>
    call<{ file: DriveItem; source: DriveItem; notKept: string[] }>(
      `/api/drive/files/${fileId}/xlsx-copy`,
      send('POST', {}),
    ),
  /** `onConflict`: what happens when a file of that name is already in the folder (see UploadResult). */
  upload: (folderId: string | null, files: File[], onConflict: OnConflict) => {
    const form = new FormData()
    if (folderId) form.set('folderId', folderId)
    form.set('onConflict', onConflict)
    for (const f of files) form.append('file', f)
    return call<UploadResult>('/api/drive/upload', {
      method: 'POST',
      body: form,
    })
  },
  rename: (item: Pick<DriveItem, 'type' | 'id'>, name: string) =>
    call<DriveItem>(`/api/drive/items/${item.type}/${item.id}`, send('PATCH', { name })),
  move: (item: Pick<DriveItem, 'type' | 'id'>, folderId: string | null) =>
    call<DriveItem>(`/api/drive/items/${item.type}/${item.id}`, send('PATCH', { folderId })),
  trash: (item: Pick<DriveItem, 'type' | 'id'>) =>
    call<{ ok: true }>(`/api/drive/items/${item.type}/${item.id}`, { method: 'DELETE' }),
  deleteForever: (item: Pick<DriveItem, 'type' | 'id'>) =>
    call<{ ok: true }>(`/api/drive/items/${item.type}/${item.id}?forever=1`, { method: 'DELETE' }),
  restore: (item: Pick<DriveItem, 'type' | 'id'>) =>
    call<DriveItem>(`/api/drive/items/${item.type}/${item.id}/restore`, { method: 'POST' }),
  archive: (item: ItemRef) =>
    call<DriveItem>(`/api/drive/items/${item.type}/${item.id}/archive`, { method: 'POST' }),
  unarchive: (item: ItemRef) =>
    call<Unarchived>(`/api/drive/items/${item.type}/${item.id}/archive`, { method: 'DELETE' }),
  /** Archives several items in one go; `errors` says which couldn't be and why. */
  archiveMany: (items: ItemRef[]) =>
    call<{ archived: DriveItem[]; errors: Array<ItemRef & { error: string }> }>(
      '/api/drive/archive',
      send('POST', { items }),
    ),
  /** Unarchives several items in one go; `errors` says which couldn't be and why. */
  unarchiveMany: (items: ItemRef[]) =>
    call<{ unarchived: Unarchived[]; errors: BatchFailure[] }>(
      '/api/drive/archive',
      send('DELETE', { items }),
    ),
  /*
   * The selection bar's acts (at most 100 items per call; the bar sends a
   * larger selection in chunks): each answers per item — what was done, and
   * under `errors` which items could not be and why.
   */
  moveMany: (items: ItemRef[], folderId: string | null) =>
    call<{ moved: DriveItem[]; errors: BatchFailure[] }>(
      '/api/drive/batch/move',
      send('POST', { items, folderId }),
    ),
  trashMany: (items: ItemRef[]) =>
    call<{ trashed: DriveItem[]; errors: BatchFailure[] }>(
      '/api/drive/batch/trash',
      send('POST', { items }),
    ),
  restoreMany: (items: ItemRef[]) =>
    call<{ restored: DriveItem[]; errors: BatchFailure[] }>(
      '/api/drive/batch/restore',
      send('POST', { items }),
    ),
  deleteForeverMany: (items: ItemRef[]) =>
    call<{ deleted: Array<ItemRef & { name: string }>; errors: BatchFailure[] }>(
      '/api/drive/batch/delete-forever',
      send('POST', { items }),
    ),
  /** Adds the grants to each item (never lowers or removes access). */
  shareMany: (items: ItemRef[], grants: GrantEntry[]) =>
    call<{ shared: DriveItem[]; errors: BatchFailure[] }>(
      '/api/drive/batch/share',
      send('POST', { items, grants }),
    ),
  /** The AI's suggestions among files unchanged for `olderThanDays` (archives nothing). */
  suggestArchive: (olderThanDays: number) =>
    call<ArchiveSuggestions>('/api/drive/archive/suggestions', send('POST', { olderThanDays })),
  grants: (item: Pick<DriveItem, 'type' | 'id'>) =>
    call<{ grants: GrantEntry[] }>(`/api/drive/items/${item.type}/${item.id}/grants`),
  setGrants: (item: Pick<DriveItem, 'type' | 'id'>, grants: GrantEntry[]) =>
    call<{ grants: GrantEntry[] }>(
      `/api/drive/items/${item.type}/${item.id}/grants`,
      send('PUT', { grants }),
    ),
  shareTargets: () => call<ShareTargets>('/api/drive/share-targets'),
  restoreRevision: (fileId: string, revisionId: string, session?: string) =>
    call<{ file: DriveItem }>(
      `/api/drive/files/${fileId}/revisions`,
      send('POST', { restore: revisionId, ...(session ? { session } : {}) }),
    ),
  revisions: (fileId: string) =>
    call<{ revisions: Revision[] }>(`/api/drive/files/${fileId}/revisions`),
  revisionText: (fileId: string, revisionId: string) =>
    call<{ revision: Revision; content: string }>(
      `/api/drive/files/${fileId}/revisions/${revisionId}`,
    ),
  readText: (fileId: string) => call<{ content: string }>(`/api/drive/files/${fileId}/text`),
  writeText: (fileId: string, content: string, session: string) =>
    call<{ file: DriveItem }>(`/api/drive/files/${fileId}/text`, send('PUT', { content, session })),
  /** A last save while the page goes away (keepalive outlives the unload); its result is not waited for. */
  writeTextOnExit: (fileId: string, content: string, session: string) =>
    fetch(`/api/drive/files/${fileId}/text`, {
      ...send('PUT', { content, session }),
      keepalive: true,
    }).then(() => undefined),
  /** The file's bytes (what an office viewer opens). */
  readBytes: async (fileId: string): Promise<Uint8Array> => {
    const res = await fetch(`/api/drive/files/${fileId}/content`)
    if (!res.ok)
      throw new DriveApiError(
        (await res.text()) || `Loading the file failed (${res.status}).`,
        res.status,
        null,
        null,
      )
    return new Uint8Array(await res.arrayBuffer())
  },
  /**
   * Saves new bytes into a PDF/Word/PowerPoint/Excel file as a revision
   * (`session`: the editor holding the edit lock; `base`: SHA-256 of the
   * content the editor started from — a newer save in between is refused
   * with code `conflict`).
   */
  writeBytes: (fileId: string, bytes: Uint8Array, session: string, base?: string) =>
    call<{ file: DriveItem }>(
      `/api/drive/files/${fileId}/content?session=${encodeURIComponent(session)}${base ? `&base=${base}` : ''}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes.slice().buffer as ArrayBuffer,
      },
    ),
  lockStatus: (fileId: string) => call<LockView>(`/api/drive/files/${fileId}/lock`),
  acquireLock: (fileId: string, session: string, takeover = false) =>
    call<LockView>(`/api/drive/files/${fileId}/lock`, send('POST', { session, takeover })),
  heartbeatLock: (fileId: string, session: string) =>
    call<LockView>(`/api/drive/files/${fileId}/lock`, send('PUT', { session })),
  /** A folder's web app and its preview (marks a running preview seen). */
  appStatus: (folderId: string) => call<AppStatus>(`/api/drive/folders/${folderId}/app`),
  /** Run (or restart) the folder's app from a fresh copy; `busy` → DriveApiError with `running`. */
  runApp: (folderId: string) =>
    call<{ preview: AppPreview }>(`/api/drive/folders/${folderId}/app`, { method: 'POST' }),
  stopApp: (folderId: string) =>
    call<{ preview: AppPreview }>(`/api/drive/folders/${folderId}/app`, { method: 'DELETE' }),
  /** Stop another folder's app by its preview id ("Another app is running"). */
  stopPreview: (previewId: string) =>
    call<{ preview: AppPreview }>(`/api/drive/apps/${previewId}`, { method: 'DELETE' }),
  /** Fire-and-forget on page exit (keepalive survives the unload). */
  releaseLock: (fileId: string, session: string) =>
    fetch(`/api/drive/files/${fileId}/lock?session=${encodeURIComponent(session)}`, {
      method: 'DELETE',
      keepalive: true,
    }).then(() => undefined),
}

export function formatSize(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
