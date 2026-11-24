import type { AttachmentView } from './view'

export type ClipboardDataLike = {
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null
  files?: ArrayLike<File> | null
}

const GENERIC_IMAGE_NAMES = new Set([
  '',
  'image.png',
  'image.jpg',
  'image.jpeg',
  'image.webp',
  'image.gif',
  'image.avif',
  'blob',
])

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function utcStamp(now: Date): string {
  return (
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`
  )
}

function imageExt(file: File): string {
  const mime = file.type.split(';')[0]?.trim().toLowerCase() ?? ''
  if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime]
  const dot = file.name.lastIndexOf('.')
  if (dot > 0) {
    const ext = file.name.slice(dot + 1).toLowerCase()
    if (ext === 'jpeg') return 'jpg'
    if (ext === 'png' || ext === 'jpg' || ext === 'webp' || ext === 'gif' || ext === 'avif') {
      return ext
    }
  }
  return 'png'
}

function fileSignature(f: File): string {
  return `${f.name}\0${f.size}\0${f.type}`
}

/**
 * Extracts pasted files from both `DataTransfer.items` and `DataTransfer.files`,
 * deduplicating when the browser populates both, and renames empty or generic
 * image filenames (e.g. `image.png`, `blob`) into unique timestamped names.
 */
export function clipboardFiles(
  data: ClipboardDataLike | null | undefined,
  now: Date = new Date(),
): File[] {
  if (!data) return []
  const fromItems: File[] = []
  if (data.items) {
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i]
      if (item && item.kind === 'file') {
        const file = item.getAsFile()
        if (file) fromItems.push(file)
      }
    }
  }

  const remaining = new Map<string, number>()
  for (const f of fromItems) {
    const sig = fileSignature(f)
    remaining.set(sig, (remaining.get(sig) ?? 0) + 1)
  }

  const combined = [...fromItems]
  if (data.files) {
    for (let i = 0; i < data.files.length; i++) {
      const f = data.files[i]
      if (!f) continue
      const sig = fileSignature(f)
      const count = remaining.get(sig) ?? 0
      if (count > 0) {
        remaining.set(sig, count - 1)
      } else {
        combined.push(f)
      }
    }
  }

  const stamp = utcStamp(now)
  let pasteIdx = 0
  return combined.map((f) => {
    const lowerName = f.name.trim().toLowerCase()
    const isGenericName = GENERIC_IMAGE_NAMES.has(lowerName)
    const isImage =
      f.type.startsWith('image/') ||
      (isGenericName && lowerName !== '' && lowerName !== 'blob')
    if (!isImage || !isGenericName) return f
    const ext = imageExt(f)
    const renamed = `pasted-image-${stamp}-${++pasteIdx}.${ext}`
    return new File([f], renamed, { type: f.type, lastModified: f.lastModified })
  })
}

export type PendingAttachmentLike = {
  key: number
  name: string
  status: 'uploading' | 'ready'
  file?: AttachmentView
  voiceMs?: number
  previewUrl?: string
}

/**
 * Matches uploaded attachment DTOs back to a pending batch.
 * Matches exact filenames first, then falls back positionally for files the
 * server renamed on conflict (e.g. `keep_both` -> `image (2).png`).
 */
export function matchUploadedAttachments<T extends PendingAttachmentLike>(
  pending: readonly T[],
  batchKeys: readonly number[],
  uploaded: readonly AttachmentView[],
): { next: T[]; dropped: T[] } {
  const inBatch = new Set(batchKeys)
  const pool = [...uploaded]
  const resolved = new Map<number, AttachmentView>()

  for (const p of pending) {
    if (!inBatch.has(p.key)) continue
    const idx = pool.findIndex((u) => u.name === p.name)
    if (idx >= 0) {
      resolved.set(p.key, pool.splice(idx, 1)[0]!)
    }
  }

  for (const p of pending) {
    if (!inBatch.has(p.key) || resolved.has(p.key)) continue
    const file = pool.shift()
    if (file) resolved.set(p.key, file)
  }

  const next: T[] = []
  const dropped: T[] = []
  for (const p of pending) {
    if (!inBatch.has(p.key)) {
      next.push(p)
      continue
    }
    const file = resolved.get(p.key)
    if (!file) {
      dropped.push(p)
      continue
    }
    next.push({ ...p, status: 'ready', name: file.name, file } as T)
  }
  return { next, dropped }
}
