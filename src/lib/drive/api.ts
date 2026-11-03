/** Browser client for /api/drive/*: every call throws the server's plain error sentence on failure. */

export type DriveItem = {
  type: 'folder' | 'file'
  id: string
  name: string
  parentId: string | null
  ownerId: string
  updatedAt: string | Date
  trashedAt: string | Date | null
  size?: number
  mime?: string
}
export type AccessLevel = 'view' | 'edit' | 'manage'
export type GrantSubject = { kind: 'user'; userId: string } | { kind: 'group'; groupId: string } | { kind: 'company' }
export type GrantEntry = { subject: GrantSubject; level: AccessLevel }
export type ShareTargets = { people: Array<{ id: string; name: string; email: string }>; groups: Array<{ id: string; name: string }> }

export type LockHolder = { userId: string; sessionId: string; since: string; name: string }
export type LockView = { state: 'held'; since: string } | { state: 'locked'; holder: LockHolder } | { state: 'free' }
export type Revision = { id: string; fileId: string; size: number; authorId: string; createdAt: string }

/** A failed Drive call: the server's sentence, its code, and (for `locked`) who holds the edit lock. */
export class DriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly holder: LockHolder | null,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = (await res.json().catch(() => null)) as (T & { error?: string; code?: string; holder?: LockHolder }) | null
  if (!res.ok) throw new DriveApiError(body?.error ?? `Drive request failed (${res.status}).`, res.status, body?.code ?? null, body?.holder ?? null)
  return body as T
}
const send = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const driveApi = {
  listFolder: (parentId: string | null) =>
    call<{ folder: DriveItem | null; path: Array<{ id: string; name: string }>; items: DriveItem[]; canEdit: boolean }>(
      `/api/drive/folders?parent=${encodeURIComponent(parentId ?? '')}`,
    ),
  createFolder: (parentId: string | null, name: string) => call<DriveItem>('/api/drive/folders', send('POST', { parentId, name })),
  createDocument: (folderId: string | null, kind: 'md' | 'csv', name?: string) =>
    call<DriveItem>('/api/drive/documents', send('POST', { folderId, kind, ...(name ? { name } : {}) })),
  upload: (folderId: string | null, files: File[]) => {
    const form = new FormData()
    if (folderId) form.set('folderId', folderId)
    for (const f of files) form.append('file', f)
    return call<{ uploaded: DriveItem[]; errors: string[] }>('/api/drive/upload', { method: 'POST', body: form })
  },
  rename: (item: Pick<DriveItem, 'type' | 'id'>, name: string) => call<DriveItem>(`/api/drive/items/${item.type}/${item.id}`, send('PATCH', { name })),
  move: (item: Pick<DriveItem, 'type' | 'id'>, folderId: string | null) =>
    call<DriveItem>(`/api/drive/items/${item.type}/${item.id}`, send('PATCH', { folderId })),
  trash: (item: Pick<DriveItem, 'type' | 'id'>) => call<{ ok: true }>(`/api/drive/items/${item.type}/${item.id}`, { method: 'DELETE' }),
  deleteForever: (item: Pick<DriveItem, 'type' | 'id'>) => call<{ ok: true }>(`/api/drive/items/${item.type}/${item.id}?forever=1`, { method: 'DELETE' }),
  restore: (item: Pick<DriveItem, 'type' | 'id'>) => call<DriveItem>(`/api/drive/items/${item.type}/${item.id}/restore`, { method: 'POST' }),
  grants: (item: Pick<DriveItem, 'type' | 'id'>) => call<{ grants: GrantEntry[] }>(`/api/drive/items/${item.type}/${item.id}/grants`),
  setGrants: (item: Pick<DriveItem, 'type' | 'id'>, grants: GrantEntry[]) =>
    call<{ grants: GrantEntry[] }>(`/api/drive/items/${item.type}/${item.id}/grants`, send('PUT', { grants })),
  shareTargets: () => call<ShareTargets>('/api/drive/share-targets'),
  restoreRevision: (fileId: string, revisionId: string, session?: string) =>
    call<unknown>(`/api/drive/files/${fileId}/revisions`, send('POST', { restore: revisionId, ...(session ? { session } : {}) })),
  revisions: (fileId: string) => call<{ revisions: Revision[] }>(`/api/drive/files/${fileId}/revisions`),
  revisionText: (fileId: string, revisionId: string) => call<{ revision: Revision; content: string }>(`/api/drive/files/${fileId}/revisions/${revisionId}`),
  readText: (fileId: string) => call<{ content: string }>(`/api/drive/files/${fileId}/text`),
  writeText: (fileId: string, content: string, session: string) => call<unknown>(`/api/drive/files/${fileId}/text`, send('PUT', { content, session })),
  acquireLock: (fileId: string, session: string, takeover = false) => call<LockView>(`/api/drive/files/${fileId}/lock`, send('POST', { session, takeover })),
  heartbeatLock: (fileId: string, session: string) => call<LockView>(`/api/drive/files/${fileId}/lock`, send('PUT', { session })),
  /** Fire-and-forget on page exit (keepalive survives the unload). */
  releaseLock: (fileId: string, session: string) =>
    fetch(`/api/drive/files/${fileId}/lock?session=${encodeURIComponent(session)}`, { method: 'DELETE', keepalive: true }).then(() => undefined),
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
