import type { ActivationStore } from './modules'

export type CachedActivationStoreOptions = {
  /**
   * Tell the other processes a module was switched (after the write). Omitted
   * = this process is the only one (tests, in-memory kernels).
   */
  announce?: (moduleId: string) => Promise<void>
}

/**
 * The activation set, cached in-process (the plugin gate reads it on every
 * request; the registry on every tool call). One read of the whole set fills
 * the cache; it is dropped when a module is switched on or off:
 * - in this process: every `set` writes through and invalidates;
 * - in another process (the `ee` CLI, a second app slot): the store's change
 *   announcement (Postgres NOTIFY, notifyActivationChange) reaches
 *   `invalidate()` through the listener in $lib/server/plugins/live.
 *
 * A read still in flight when the cache is dropped is never kept: the next
 * read asks the store again, so a switch is never lost to a race.
 */
export class CachedActivationStore implements ActivationStore {
  private cached: Promise<Map<string, boolean>> | null = null

  constructor(
    private readonly inner: ActivationStore,
    private readonly options: CachedActivationStoreOptions = {},
  ) {}

  async set(id: string, active: boolean): Promise<void> {
    try {
      await this.inner.set(id, active)
      await this.options.announce?.(id)
    } finally {
      // Also after a failed write: the stored state is unknown, read it again.
      this.invalidate()
    }
  }

  async get(id: string): Promise<boolean> {
    return (await this.load()).get(id) === true
  }

  async list(): Promise<Map<string, boolean>> {
    return new Map(await this.load())
  }

  /** Drop the cached set: the next read asks the store. */
  invalidate(): void {
    this.cached = null
  }

  private load(): Promise<Map<string, boolean>> {
    if (this.cached) return this.cached
    const loading = this.inner.list()
    this.cached = loading
    // A failed read is never cached: the next read tries again (and fails loud itself).
    loading.catch(() => {
      if (this.cached === loading) this.cached = null
    })
    return loading
  }
}
