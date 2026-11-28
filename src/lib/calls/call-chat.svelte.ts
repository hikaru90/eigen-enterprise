import type { CallChatMessageDto, ChatClient } from './client'
import type { ShownError } from '$lib/errors/agent-report'
import { shownProblemOf } from './client'

/**
 * The chat of the call I am in (proposal bb05b451), a member's or a guest's
 * side — the same model, only the client differs (chatClient / guestChatClient).
 *
 * Lines arrive three ways, all merged by seq (a line can come twice):
 *   - receive(): a member's live stream (`call.chat` frames via LiveCalls.onChat);
 *   - catchUp(): a read on from my cursor — a guest's refresh timer, and for a
 *     member after the stream came back (frames are not replayed);
 *   - show() the first time: the whole chat from the start (I may have joined late).
 *
 * Unread: lines from others while the panel is closed (my own never count).
 * No effects: the panel calls show/hide/send; subscribe() tells the panel
 * after each change (it keeps the list scrolled to the newest line).
 */
export class CallChat {
  #messages = $state<CallChatMessageDto[]>([])
  #open = $state(false)
  /** The newest seq I have seen with the panel open. */
  #seen = $state(0)
  #problem = $state<ShownError | null>(null)
  #sending = $state(false)
  #loaded = false
  /** Reads run one after another (each from the cursor the previous left). */
  #reading: Promise<void> = Promise.resolve()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- subscriber callbacks are never rendered
  #listeners = new Set<() => void>()

  constructor(private readonly opts: { callId: string; me: string; client: ChatClient }) {}

  get messages(): CallChatMessageDto[] {
    return this.#messages
  }

  get open(): boolean {
    return this.#open
  }

  get problem(): ShownError | null {
    return this.#problem
  }

  get sending(): boolean {
    return this.#sending
  }

  get me(): string {
    return this.opts.me
  }

  /** The newest seq I have (0: none): a read on starts after it. */
  get cursor(): number {
    return this.#messages.at(-1)?.seq ?? 0
  }

  /** Lines from others I have not seen (0 while the panel is open). */
  get unread(): number {
    if (this.#open) return 0
    return this.#messages.filter((m) => m.seq > this.#seen && m.authorId !== this.opts.me).length
  }

  /** Called after every change of the lines. */
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  toggle(): void {
    if (this.#open) this.hide()
    else void this.show()
  }

  /** Open the panel: everything is seen; the first time, the whole chat is read. */
  async show(): Promise<void> {
    this.#open = true
    this.#seen = this.cursor
    if (this.#loaded) return
    this.#loaded = true
    await this.#read(0)
  }

  hide(): void {
    this.#open = false
  }

  /** A line from the live stream (any call's: only this call's are kept). */
  receive(callId: string, message: CallChatMessageDto): void {
    if (callId !== this.opts.callId) return
    this.#merge([message])
  }

  /** Read on from my cursor. */
  catchUp(): Promise<void> {
    return this.#read(null)
  }

  /** Write a line; false when nothing was sent (empty, or refused — the panel keeps the text). */
  async send(raw: string): Promise<boolean> {
    const body = raw.trim()
    if (body === '' || this.#sending) return false
    this.#sending = true
    try {
      this.#merge([await this.opts.client.postChat(this.opts.callId, body)])
      this.#problem = null
      return true
    } catch (err) {
      this.#problem = shownProblemOf(err, 'Not sent: ')
      return false
    } finally {
      this.#sending = false
    }
  }

  /** Paste (or drop) images: each becomes a line of its own; false when one was refused (shown). */
  async sendImages(files: readonly File[]): Promise<boolean> {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0 || this.#sending) return false
    this.#sending = true
    try {
      for (const file of images)
        this.#merge([await this.opts.client.postChatImage(this.opts.callId, file)])
      this.#problem = null
      return true
    } catch (err) {
      this.#problem = shownProblemOf(err, 'Image not sent: ')
      return false
    } finally {
      this.#sending = false
    }
  }

  /** Where a line's image is shown from. */
  imageUrl(imageId: string): string {
    return this.opts.client.imageUrl(this.opts.callId, imageId)
  }

  dismissProblem(): void {
    this.#problem = null
  }

  /** One read after the previous: from `from`, or (null) from the cursor at that time; pages on while there is more. */
  #read(from: number | null): Promise<void> {
    this.#reading = this.#reading.then(async () => {
      try {
        let since = from ?? this.cursor
        for (;;) {
          const page = await this.opts.client.readChat(this.opts.callId, since)
          this.#merge(page.messages)
          if (!page.hasMore || page.messages.length === 0) break
          since = page.messages.at(-1)!.seq
        }
      } catch (err) {
        console.error('[calls] reading the call chat failed', err)
        this.#problem = shownProblemOf(err, 'The chat could not be loaded: ')
      }
    })
    return this.#reading
  }

  #merge(lines: readonly CallChatMessageDto[]): void {
    const fresh = lines.filter((m) => !this.#messages.some((x) => x.seq === m.seq))
    if (fresh.length === 0) return
    this.#messages = [...this.#messages, ...fresh].sort((a, b) => a.seq - b.seq)
    if (this.#open) this.#seen = this.cursor
    for (const fn of [...this.#listeners]) fn()
  }
}
