import { z } from 'zod'
import {
  ASSISTANT_ATTACHMENT_KIND_LABEL,
  ASSISTANT_ATTACHMENT_LIMITS,
  assistantAttachmentSchema,
  formatAttachmentSize,
  type AssistantAttachment,
  type AssistantAttachmentKind,
  type AssistantAttachmentMeta,
} from '$lib/components/assistant/attachments'
import type { GatewayCompleteFn } from '$lib/server/agent/gateway-model'
import { isLlmHttpError, isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatAttachment } from '$lib/server/llm/llm-client'
import { detectGuideMime } from '../../../../modules/brand/extract/guide'

/**
 * Reading a file attached to an assistant message (see $lib/components/assistant/attachments).
 * The type comes from the file's own content — its format signature, or valid UTF-8 text —
 * never from its name. A PDF or an image is read through the gateway by a model that reads them
 * (the company's chat model when it does, else the pool's vision pick, vision.ts), because the agent's durable
 * turn carries text only; the text it read goes into the turn. Every refusal is a plain
 * sentence for the person; nothing is ever cut short silently.
 */

const MB = 1024 * 1024
const MAX_FILENAME_LENGTH = 255
/** Enough room for maxTextChars of text (about 4 characters per token) plus slack. */
const READ_MAX_TOKENS = 20_000

export type AssistantAttachmentErrorCode =
  'empty' | 'invalid' | 'too_large' | 'unsupported_type' | 'unreadable' | 'provider_unavailable'

const STATUS: Record<AssistantAttachmentErrorCode, number> = {
  empty: 400,
  invalid: 400,
  too_large: 413,
  unsupported_type: 415,
  unreadable: 422,
  provider_unavailable: 503,
}

/** A refused attachment: a plain sentence for the person, a code and an HTTP status. */
export class AssistantAttachmentError extends Error {
  readonly code: AssistantAttachmentErrorCode
  readonly status: number

  constructor(code: AssistantAttachmentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AssistantAttachmentError'
    this.code = code
    this.status = STATUS[code]
  }
}

export type AttachmentReadDeps = {
  complete: GatewayCompleteFn
  /**
   * The pool model that reads PDFs and images for this caller (vision.ts resolveVisionModel):
   * the company's chat model when it reads them, else the vision pick; undefined for a provider
   * outside the pool, whose own chat model reads.
   */
  visionModel: (userId: string) => Promise<string | undefined>
}

type Detected =
  | { kind: 'pdf' }
  | { kind: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { kind: 'text'; text: string }

function detect(bytes: Uint8Array): Detected | null {
  const mime = detectGuideMime(bytes)
  if (mime === 'application/pdf') return { kind: 'pdf' }
  if (mime !== null) return { kind: 'image', mime }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  // A NUL byte never occurs in a text document; it marks a binary format.
  if (text.includes('\u0000')) return null
  return { kind: 'text', text }
}

function tooMuchText(name: string, chars: number): AssistantAttachmentError {
  return new AssistantAttachmentError(
    'too_large',
    `“${name}” holds about ${chars.toLocaleString('en-US')} characters of text; one file can carry at most ${ASSISTANT_ATTACHMENT_LIMITS.maxTextChars.toLocaleString('en-US')}. Attach the part you need.`,
  )
}

const READ_INSTRUCTIONS = [
  'You read a file that a person attached to their message for the company assistant. Another assistant will answer the message using only what you write, so be complete and faithful.',
  'Write out the full text content of the file, in its original language: no summary, no commentary, no introduction. Keep the structure: headings, lists, and tables as Markdown tables.',
  'For an image, or a page that is mostly visual (a chart, a photo, a diagram), first write out any text it contains, then describe what it shows in a few plain sentences.',
].join('\n')

function finishReason(response: unknown): unknown {
  return (response as { choices?: Array<{ finish_reason?: unknown }> })?.choices?.[0]?.finish_reason
}

function contentOf(response: unknown): string {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('gateway response is missing choices[0].message.content (string)')
  }
  return content
}

async function readWithModel(
  deps: AttachmentReadDeps,
  input: { userId: string; name: string; attachment: ChatAttachment },
): Promise<string> {
  let response: unknown
  try {
    const model = await deps.visionModel(input.userId)
    response = await deps.complete({
      ...(model ? { modelOverride: model } : {}),
      userId: input.userId,
      messages: [
        { role: 'system', content: READ_INSTRUCTIONS },
        {
          role: 'user',
          content: `The attached file is “${input.name}”.`,
          attachments: [input.attachment],
        },
      ],
      temperature: 0,
      maxTokens: READ_MAX_TOKENS,
      task: 'assistant.attachment_read',
    })
  } catch (err) {
    if (isLlmNotConfiguredError(err)) {
      throw new AssistantAttachmentError(
        'provider_unavailable',
        'No AI provider is set up yet, so attached files cannot be read.',
        { cause: err },
      )
    }
    if (isLlmHttpError(err)) {
      console.error('[assistant] attachment read failed', { name: input.name, status: err.status })
      throw new AssistantAttachmentError(
        'unreadable',
        `Your AI provider could not read “${input.name}”. Its model may not take PDFs or images; attach the text instead (for example as a .txt or .md file).`,
        { cause: err },
      )
    }
    throw err
  }
  if (finishReason(response) === 'length') {
    throw new AssistantAttachmentError(
      'too_large',
      `“${input.name}” is too long to read in full. Attach the pages you need.`,
    )
  }
  const text = contentOf(response).trim()
  if (!text) {
    throw new AssistantAttachmentError('unreadable', `No text could be read from “${input.name}”.`)
  }
  return text
}

/** Validates one uploaded file and reads its text (see the module comment). */
export async function readAssistantAttachment(
  deps: AttachmentReadDeps,
  input: { userId: string; filename: string; bytes: Uint8Array },
): Promise<AssistantAttachment> {
  const name = input.filename.trim()
  if (!name) throw new AssistantAttachmentError('invalid', 'The file needs a name.')
  if (name.length > MAX_FILENAME_LENGTH) {
    throw new AssistantAttachmentError(
      'invalid',
      `The file name can be at most ${MAX_FILENAME_LENGTH} characters.`,
    )
  }
  if (input.bytes.length === 0) throw new AssistantAttachmentError('empty', `“${name}” is empty.`)

  const detected = detect(input.bytes)
  if (!detected) {
    throw new AssistantAttachmentError(
      'unsupported_type',
      `“${name}” isn't a file the assistant can read. Attach a PDF, an image (PNG, JPEG, WebP) or a text file (like .txt, .md, .csv) — save other documents as PDF first.`,
    )
  }
  const limit = ASSISTANT_ATTACHMENT_LIMITS.maxBytes[detected.kind]
  if (input.bytes.length > limit) {
    const what = { pdf: 'PDFs', image: 'images', text: 'text files' }[detected.kind]
    throw new AssistantAttachmentError(
      'too_large',
      `“${name}” is ${(input.bytes.length / MB).toFixed(1)} MB; ${what} can be at most ${limit / MB} MB.`,
    )
  }

  const meta: AssistantAttachmentMeta = { name, kind: detected.kind, sizeBytes: input.bytes.length }
  let text: string
  if (detected.kind === 'text') {
    text = detected.text
  } else {
    const base64 = Buffer.from(input.bytes).toString('base64')
    const attachment: ChatAttachment =
      detected.kind === 'pdf'
        ? { type: 'pdf', filename: name, base64 }
        : { type: 'image', mime: detected.mime, base64 }
    text = await readWithModel(deps, { userId: input.userId, name, attachment })
  }
  if (!text.trim()) throw new AssistantAttachmentError('empty', `“${name}” has no text.`)
  if (text.length > ASSISTANT_ATTACHMENT_LIMITS.maxTextChars) throw tooMuchText(name, text.length)
  return { ...meta, text }
}

const chatAttachmentsSchema = z.array(assistantAttachmentSchema)

/** The attachments of a POST /api/chat body (none: []). Refusals are AssistantAttachmentError. */
export function parseChatAttachments(raw: unknown): AssistantAttachment[] {
  if (raw === undefined) return []
  const parsed = chatAttachmentsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AssistantAttachmentError(
      'invalid',
      'The attached files could not be read; attach them again.',
    )
  }
  const attachments = parsed.data
  if (attachments.length > ASSISTANT_ATTACHMENT_LIMITS.maxFiles) {
    throw new AssistantAttachmentError(
      'too_large',
      `A message can carry at most ${ASSISTANT_ATTACHMENT_LIMITS.maxFiles} files.`,
    )
  }
  const total = attachments.reduce((n, a) => n + a.text.length, 0)
  if (total > ASSISTANT_ATTACHMENT_LIMITS.maxTotalTextChars) {
    throw new AssistantAttachmentError(
      'too_large',
      `These files hold about ${total.toLocaleString('en-US')} characters of text together; one message can carry at most ${ASSISTANT_ATTACHMENT_LIMITS.maxTotalTextChars.toLocaleString('en-US')}. Send them in separate messages.`,
    )
  }
  return attachments
}

function attributeValue(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function kindLabel(kind: AssistantAttachmentKind): string {
  return ASSISTANT_ATTACHMENT_KIND_LABEL[kind]
}

/**
 * The agent's input for a member message with files: the message, then each file's full text
 * in an <attached_file> block naming it — what the model reads for this turn.
 */
export function composeAgentMessage(message: string, attachments: AssistantAttachment[]): string {
  if (attachments.length === 0) return message
  const blocks = attachments.map(
    (a) =>
      `<attached_file name="${attributeValue(a.name)}" type="${kindLabel(a.kind)}" size="${formatAttachmentSize(a.sizeBytes)}">\n${a.text}\n</attached_file>`,
  )
  return [message, ...blocks].filter((part) => part.length > 0).join('\n\n')
}

/** chat_message.metadata of the member's turn: the chips' facts, never the files' text. */
export function attachmentMetadata(
  attachments: AssistantAttachment[],
): { attachments: AssistantAttachmentMeta[] } | null {
  if (attachments.length === 0) return null
  return {
    attachments: attachments.map(({ name, kind, sizeBytes }) => ({ name, kind, sizeBytes })),
  }
}
