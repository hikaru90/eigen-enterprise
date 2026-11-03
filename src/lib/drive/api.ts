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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error ?? `Drive request failed (${res.status}).`)
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
  restoreRevision: (fileId: string, revisionId: string) => call<unknown>(`/api/drive/files/${fileId}/revisions`, send('POST', { restore: revisionId })),
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
