import { z } from 'zod'

/**
 * Files attached to an assistant message (Contribute: "Allow users to attach documents in the
 * AI assistant"). A file is read once, when it is attached (POST /api/assistant/attachments):
 * a text file as is, a PDF or an image by the company's model through the gateway. What it
 * read travels with the message (POST /api/chat) into the agent's turn; the stored turn keeps
 * only the name, kind and size for the chips. Shared by the composer and the server, so it
 * imports nothing from node.
 */

const MB = 1024 * 1024

export const ASSISTANT_ATTACHMENT_LIMITS = {
  /** Files on one message. */
  maxFiles: 5,
  /** Characters of text one file may carry (about 15k tokens) — longer is refused, never cut. */
  maxTextChars: 60_000,
  /** Characters of text all files of one message may carry together. */
  maxTotalTextChars: 150_000,
  /**
   * Upload sizes. Images stay within 5 MB, the strictest per-image cap among the providers
   * the gateway reaches; PDFs within 10 MB (the brand-guide limits, modules/brand/extract).
   */
  maxBytes: { pdf: 10 * MB, image: 5 * MB, text: 1 * MB },
} as const

export const ASSISTANT_ATTACHMENT_KINDS = ['pdf', 'image', 'text'] as const
export type AssistantAttachmentKind = (typeof ASSISTANT_ATTACHMENT_KINDS)[number]

/** What a chip shows (and what the stored turn keeps). */
export type AssistantAttachmentMeta = {
  name: string
  kind: AssistantAttachmentKind
  sizeBytes: number
}

/** A read attachment: the chip's facts plus the text the model reads with the message. */
export type AssistantAttachment = AssistantAttachmentMeta & { text: string }

/** For the file picker's accept attribute (the server decides by the file's content, not this). */
export const ASSISTANT_ATTACHMENT_ACCEPT = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/*',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
].join(',')

export const ASSISTANT_ATTACHMENT_LIMITS_TEXT = `PDFs up to ${ASSISTANT_ATTACHMENT_LIMITS.maxBytes.pdf / MB} MB, images (PNG, JPEG, WebP) up to ${ASSISTANT_ATTACHMENT_LIMITS.maxBytes.image / MB} MB, text files (like .txt, .md, .csv) up to ${ASSISTANT_ATTACHMENT_LIMITS.maxBytes.text / MB} MB — at most ${ASSISTANT_ATTACHMENT_LIMITS.maxFiles} files per message.`

export const ASSISTANT_ATTACHMENT_KIND_LABEL: Record<AssistantAttachmentKind, string> = {
  pdf: 'PDF',
  image: 'image',
  text: 'text file',
}

/** "512 B", "2 KB", "1.2 MB". */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

export const assistantAttachmentMetaSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(ASSISTANT_ATTACHMENT_KINDS),
  sizeBytes: z.number().int().nonnegative(),
})

export const assistantAttachmentSchema = assistantAttachmentMetaSchema.extend({
  text: z.string().max(ASSISTANT_ATTACHMENT_LIMITS.maxTextChars),
})

const storedAttachmentsSchema = z.array(assistantAttachmentMetaSchema)

/**
 * The chips of a stored user turn (chat_message.metadata.attachments, written by POST
 * /api/chat). None stored: []. A malformed list fails loud — it is only ever our own write.
 */
export function storedAttachmentMetas(
  metadata: Record<string, unknown> | null | undefined,
): AssistantAttachmentMeta[] {
  const raw = metadata?.attachments
  if (raw === undefined) return []
  const parsed = storedAttachmentsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`stored chat message has malformed attachments: ${parsed.error.message}`)
  }
  return parsed.data
}
