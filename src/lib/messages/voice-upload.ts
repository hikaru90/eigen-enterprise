import type { AttachmentView } from './view'

/**
 * A dictated recording, uploaded into the conversation's Drive folder exactly as the
 * recorder made it (never transcoded), to be posted as the message's voice clip next to
 * its transcript (`voiceClips` on POST …/messages).
 */

/** The recorder's container → the file's extension (what the Drive and a download show). */
const EXTENSION: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "Voice message 2026-11-19 14.03.07.webm" — when it was recorded, in the person's local time. */
export function voiceFileName(mime: string, at: Date): string {
  const container = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  const ext = EXTENSION[container]
  if (!ext) throw new Error(`the recording has no known audio format (${mime || 'none'})`)
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`
  return `Voice message ${day} ${time}.${ext}`
}

/** Uploads one recording; the uploaded file, or an Error in the server's words. */
export async function uploadVoiceRecording(conversationId: string, clip: Blob, at = new Date()): Promise<AttachmentView> {
  const form = new FormData()
  form.append('file', new File([clip], voiceFileName(clip.type, at), { type: clip.type }))
  const res = await fetch(`/api/messages/conversations/${encodeURIComponent(conversationId)}/attachments`, { method: 'POST', body: form })
  const body = (await res.json().catch(() => ({}))) as { uploaded?: AttachmentView[]; errors?: string[]; error?: string }
  if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`)
  const [file] = body.uploaded ?? []
  if (!file) throw new Error(body.errors?.join(' ') || 'the recording was not uploaded')
  return file
}
