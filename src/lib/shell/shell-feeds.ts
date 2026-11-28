/** A live feed only the app shell reads (the sidebar's unread counter, everyone's presence). */
export type ShellFeed = {
  connect(): void
  close(): void
}

/**
 * The shell's live feeds open the first time the shell is shown, never while
 * a page runs full-screen without it. A call's own tab has no shell: opening
 * them there spent two of the browser's six HTTP/1.1 connections per host on
 * feeds nobody saw, and with the caller's main tab holding three more, the
 * call's lazily loaded LiveKit module waited forever for a connection
 * (the call stuck on "connecting"). Once open, a feed stays open until close().
 */
export class ShellFeeds {
  #open = false
  #closed = false
  private readonly feeds: ShellFeed[]

  constructor(feeds: (ShellFeed | null)[]) {
    this.feeds = feeds.filter((f): f is ShellFeed => f !== null)
  }

  /** Called on mount and after every navigation with whether the shell shows now. */
  sync(shellVisible: boolean): void {
    if (this.#open || this.#closed || !shellVisible) return
    this.#open = true
    for (const f of this.feeds) f.connect()
  }

  close(): void {
    this.#closed = true
    if (!this.#open) return
    this.#open = false
    for (const f of this.feeds) f.close()
  }
}
