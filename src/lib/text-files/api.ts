import type { CaptureAttachedFile } from '$lib/capture/capture-result-types'

/** Whose a note is and who may read it (shared Memory, plan/shared-memory-voice-agent-tools.md §1). */
export type TextFileSharing = {
  ownerId: string
  owner: { id: string; name: string }
  /** 'company' = every member reads it (default); 'private' = its owner only. */
  visibility: 'private' | 'company'
  /** The reader owns it; a colleague's shared note is read-only. */
  editable: boolean
}

export type TextFileRecord = {
  id: string
  title: string
  body: string
  author?: 'user' | 'agent'
  authorLabel?: string | null
  authorKeyId?: string | null
  createdAt: string
  updatedAt: string
} & TextFileSharing

export type TextFileSearchHit = {
  id: string
  title: string
  preview: string
  lexicalScore: number
  updatedAt: string
  author?: 'user' | 'agent'
  authorLabel?: string | null
  authorKeyId?: string | null
} & TextFileSharing

/** The person's own notes, or what colleagues share with everyone. */
export type TextFileListScope = 'mine' | 'team'

export type TextFileLinkedThought = {
  id: string
  normalizedText: string
}

export type TextFileListCursor = {
  updatedAt: string
  id: string
}

export async function fetchTextFiles(
  limit = 20,
  cursor?: TextFileListCursor,
  view?: string,
  scope: TextFileListScope = 'mine',
): Promise<TextFileRecord[]> {
  const params = new URLSearchParams({ limit: String(limit), scope })
  if (cursor) {
    params.set('cursor_updated_at', cursor.updatedAt)
    params.set('cursor_id', cursor.id)
  }
  if (view && view !== 'all') {
    if (view === 'user') {
      params.set('authorLayerKey', 'user')
    } else {
      params.set('authorLayerKey', view)
    }
  }
  const res = await fetch(`/api/text-files?${params}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      typeof err === 'object' && err && 'message' in err
        ? String(err.message)
        : `Failed to list text files (${res.status})`,
    )
  }
  const data = (await res.json()) as { textFiles: TextFileRecord[] }
  return data.textFiles
}

export async function searchTextFiles(
  query: string,
  topK = 20,
  view?: string,
  scope: TextFileListScope = 'mine',
): Promise<TextFileSearchHit[]> {
  const params = new URLSearchParams({ q: query, limit: String(topK), scope })
  if (view && view !== 'all') {
    if (view === 'user') {
      params.set('authorLayerKey', 'user')
    } else {
      params.set('authorLayerKey', view)
    }
  }
  const res = await fetch(`/api/text-files?${params}`)
  if (!res.ok) {
    throw new Error(`Failed to search text files (${res.status})`)
  }
  const data = (await res.json()) as { results: TextFileSearchHit[] }
  return data.results
}

export async function fetchTextFile(fileId: string): Promise<TextFileRecord> {
  const res = await fetch(`/api/text-files/${fileId}`)
  if (!res.ok) {
    throw new Error(`Failed to load text file (${res.status})`)
  }
  const data = (await res.json()) as { textFile: TextFileRecord }
  return data.textFile
}

export async function fetchLinkedThoughts(fileId: string): Promise<TextFileLinkedThought[]> {
  const res = await fetch(`/api/text-files/${fileId}/thoughts`)
  if (!res.ok) {
    throw new Error(`Failed to load linked thoughts (${res.status})`)
  }
  const data = (await res.json()) as { linkedThoughts: TextFileLinkedThought[] }
  return data.linkedThoughts
}

export async function createTextFile(input: {
  title?: string
  body?: string
  /** true = only the person can read it; default = shared with everyone. */
  private?: boolean
}): Promise<TextFileRecord> {
  const res = await fetch('/api/text-files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      typeof err === 'object' && err && 'message' in err
        ? String(err.message)
        : `Failed to create text file (${res.status})`,
    )
  }
  const data = (await res.json()) as { textFile: TextFileRecord }
  return data.textFile
}

export async function updateTextFile(
  fileId: string,
  input: { title?: string; body?: string },
): Promise<TextFileRecord> {
  const res = await fetch(`/api/text-files/${fileId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      typeof err === 'object' && err && 'message' in err
        ? String(err.message)
        : `Failed to update text file (${res.status})`,
    )
  }
  const data = (await res.json()) as { textFile: TextFileRecord }
  return data.textFile
}

/** The note's Private switch (memory.set_text_file_visibility). */
export async function setTextFileVisibility(
  fileId: string,
  isPrivate: boolean,
): Promise<{ textFileId: string; visibility: 'private' | 'company' }> {
  const res = await fetch(`/api/text-files/${fileId}/visibility`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ private: isPrivate }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      typeof err === 'object' && err && 'message' in err
        ? String(err.message)
        : `Failed to change who sees the note (${res.status})`,
    )
  }
  return (await res.json()) as { textFileId: string; visibility: 'private' | 'company' }
}

export async function deleteTextFile(fileId: string): Promise<void> {
  const res = await fetch(`/api/text-files/${fileId}`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(`Failed to delete text file (${res.status})`)
  }
}

export async function linkTextFileToThought(thoughtId: string, textFileId: string): Promise<void> {
  const res = await fetch(`/api/thoughts/${thoughtId}/text-files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ textFileId }),
  })
  if (!res.ok) {
    throw new Error(`Failed to link text file (${res.status})`)
  }
}

export async function unlinkTextFileFromThought(
  thoughtId: string,
  textFileId: string,
): Promise<void> {
  const res = await fetch(`/api/thoughts/${thoughtId}/text-files/${textFileId}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    throw new Error(`Failed to unlink text file (${res.status})`)
  }
}

export type { CaptureAttachedFile }
