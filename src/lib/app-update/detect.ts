/**
 * Version skew after a release (bug 593f7e08). Every release is its own build
 * under `releases/<id>` (ee/src/reconcile.ts), so a tab opened before an
 * install still asks for the old hashed `_app/immutable/chunks/*.js` — which
 * no longer exist — the first time it lazy-loads something (a Drive viewer, an
 * editor, a route). Whether a failed load is that, or a real failure, is not
 * read from the error text: the server's deployed version is asked
 * (SvelteKit's `updated.check()`, `/_app/version.json` against this tab's
 * build) and only a changed version turns the failure into "reload".
 *
 * Pure: the version check is passed in (src/lib/app-update/state.svelte.ts
 * wires SvelteKit's), so this is unit-tested in node.
 */

/** The sentence a person sees when the app changed under their open tab. */
export const APP_UPDATED_SENTENCE = 'eigenEnterprise was updated — reload to open this.'

/** Resolves true when the server runs a different build than this tab. */
export type CheckUpdated = () => Promise<boolean>

/** A load failed because a new release replaced this tab's build. `cause` is the original failure. */
export class AppUpdatedError extends Error {
  constructor(cause: unknown) {
    super(APP_UPDATED_SENTENCE, { cause })
    this.name = 'AppUpdatedError'
  }
}

/**
 * What to show for a failed load: an `AppUpdatedError` when the deployed
 * version changed, else the original error. A failing version check (offline,
 * server down) proves nothing about an update, so the real error stays.
 */
export async function explainLoadFailure(error: unknown, check: CheckUpdated): Promise<unknown> {
  let changed: boolean
  try {
    changed = await check()
  } catch {
    return error
  }
  return changed ? new AppUpdatedError(error) : error
}

/** Runs a lazy load once; a failure rejects with what `explainLoadFailure` says to show. Never retries. */
export async function loadChunk<T>(load: () => Promise<T>, check: CheckUpdated): Promise<T> {
  try {
    return await load()
  } catch (err) {
    throw await explainLoadFailure(err, check)
  }
}

/**
 * The `beforeNavigate` rule: once the app was updated, an in-app navigation
 * becomes a full page load of its target (fresh HTML, fresh chunks) instead
 * of a client navigation into a build that is gone. Navigations that already
 * unload the page are left to the browser.
 */
export function fullReloadHref(
  nav: { willUnload: boolean; to: { url: URL } | null },
  appUpdated: boolean,
): string | null {
  if (!appUpdated || nav.willUnload || !nav.to) return null
  return nav.to.url.href
}

/**
 * App-wide: every lazy import Vite builds goes through its preload helper,
 * which dispatches `vite:preloadError` on window when the import fails. When
 * the version check says the app changed, `onUpdated` runs (the shell shows
 * the reload notice). The event is never cancelled: the import still rejects
 * and its own caller still shows its error — nothing is swallowed.
 */
export function watchStaleChunks(target: EventTarget, check: CheckUpdated, onUpdated: () => void): () => void {
  const onPreloadError = () => {
    void check().then(
      (changed) => {
        if (changed) onUpdated()
      },
      (err: unknown) => console.warn('[app-update] the version check after a failed load failed', err),
    )
  }
  target.addEventListener('vite:preloadError', onPreloadError)
  return () => target.removeEventListener('vite:preloadError', onPreloadError)
}
