import { ASSISTANT_ATTACHMENT_LIMITS, type AssistantAttachment } from './attachments'

export type ComposerAttachmentItem =
  | { key: string; status: 'reading'; name: string; sizeBytes: number }
  | {
      key: string
      status: 'ready'
      name: string
      sizeBytes: number
      attachment: AssistantAttachment
    }

/**
 * The files waiting in the assistant composer. Each chosen file is read right away (POST
 * /api/assistant/attachments) so a refusal shows before sending; a read file waits as a chip
 * until the message goes out (or the member removes it).
 */
export class ComposerAttachments {
  items = $state<ComposerAttachmentItem[]>([])
  /** Why files were refused, shown under the composer until the next choice. */
  errors = $state<string[]>([])

  #fetch: typeof globalThis.fetch
  #seq = 0

  constructor(fetch: typeof globalThis.fetch) {
    this.#fetch = fetch
  }

  get reading(): boolean {
    return this.items.some((item) => item.status === 'reading')
  }

  get ready(): AssistantAttachment[] {
    return this.items.flatMap((item) => (item.status === 'ready' ? [item.attachment] : []))
  }

  /** Read the chosen files; more than a message can carry are refused in words. */
  add(files: File[]): Promise<void> {
    this.errors = []
    const room = ASSISTANT_ATTACHMENT_LIMITS.maxFiles - this.items.length
    const accepted = files.slice(0, Math.max(room, 0))
    if (accepted.length < files.length) {
      this.errors = [
        `A message can carry at most ${ASSISTANT_ATTACHMENT_LIMITS.maxFiles} files; ${files.length - accepted.length} not attached.`,
      ]
    }
    return Promise.all(accepted.map((file) => this.#read(file))).then(() => undefined)
  }

  remove(key: string): void {
    this.items = this.items.filter((item) => item.key !== key)
  }

  clear(): void {
    this.items = []
    this.errors = []
  }

  /** Put already-read files back as ready chips (Edit gives a sent message's files back). */
  restore(attachments: AssistantAttachment[]): void {
    this.errors = []
    this.items = attachments.map((attachment) => {
      this.#seq += 1
      return {
        key: `attachment-${this.#seq}`,
        status: 'ready' as const,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes,
        attachment,
      }
    })
  }

  /** The read files for the message being sent; the composer is empty afterwards. */
  take(): AssistantAttachment[] {
    const ready = this.ready
    this.clear()
    return ready
  }

  async #read(file: File): Promise<void> {
    this.#seq += 1
    const key = `attachment-${this.#seq}`
    this.items.push({ key, status: 'reading', name: file.name, sizeBytes: file.size })
    let outcome: { attachment: AssistantAttachment } | { refusal: string }
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await this.#fetch('/api/assistant/attachments', { method: 'POST', body: form })
      const body = (await res.json().catch(() => null)) as {
        attachment?: AssistantAttachment
        error?: unknown
      } | null
      if (res.ok && body?.attachment) {
        outcome = { attachment: body.attachment }
      } else if (!res.ok && typeof body?.error === 'string') {
        // The route's refusals ({ error }) are plain sentences written for the member; an
        // unexpected failure has no `error` field and gets the fixed sentence below.
        outcome = { refusal: body.error }
      } else {
        throw new Error(`attachment read failed: HTTP ${res.status}`)
      }
    } catch (err) {
      console.error('[assistant] attachment failed', err)
      outcome = { refusal: `“${file.name}” could not be attached. Please try again.` }
    }
    // Removed (or a new conversation) while reading: nothing to put back.
    if (!this.items.some((item) => item.key === key)) return
    if ('attachment' in outcome) {
      const { attachment } = outcome
      this.items = this.items.map((item) =>
        item.key === key
          ? {
              key,
              status: 'ready',
              name: attachment.name,
              sizeBytes: attachment.sizeBytes,
              attachment,
            }
          : item,
      )
    } else {
      this.items = this.items.filter((item) => item.key !== key)
      this.errors = [...this.errors, outcome.refusal]
    }
  }
}
