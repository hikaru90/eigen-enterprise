/**
 * The Messages live feed (SSE) that survives a phone sleeping. The browser
 * reconnects an EventSource on its own while it is CONNECTING, but gives up
 * (CLOSED) when an installed app is suspended long enough; resume() — called
 * when the app is visible or online again — reopens it after the last event
 * seen, and the hub catches up everything missed in between.
 */

const CLOSED = 2

export type StreamSource = {
  readonly readyState: number
  addEventListener(type: string, fn: (e: MessageEvent) => void): void
  close(): void
}

export type ResumableStreamOptions = {
  url: (after: number) => string
  /** The event id the page loaded at. */
  initialCursor: number
  events: readonly string[]
  onEvent: (type: string, data: unknown) => void
  onStatus: (status: 'live' | 'reconnecting') => void
  create?: (url: string) => StreamSource
}

export class ResumableStream {
  private source: StreamSource | null = null
  private cursor: number
  private stopped = false

  constructor(private readonly opts: ResumableStreamOptions) {
    this.cursor = opts.initialCursor
  }

  connect(): void {
    if (this.stopped) return
    const create = this.opts.create ?? ((url: string) => new EventSource(url))
    const source = create(this.opts.url(this.cursor))
    source.addEventListener('open', () => this.opts.onStatus('live'))
    source.addEventListener('error', () => this.opts.onStatus('reconnecting'))
    for (const type of this.opts.events) {
      source.addEventListener(type, (e) => {
        const id = Number(e.lastEventId)
        if (Number.isInteger(id) && id > this.cursor) this.cursor = id
        this.opts.onEvent(type, JSON.parse(e.data as string))
      })
    }
    this.source = source
  }

  /** Reopen a stream the browser gave up on; a live or reconnecting one is left alone. */
  resume(): void {
    if (this.stopped || !this.source || this.source.readyState !== CLOSED) return
    this.source.close()
    this.connect()
  }

  close(): void {
    this.stopped = true
    this.source?.close()
  }
}
