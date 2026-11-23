import type { CheckUpdated } from './detect'
import { updated } from '$app/state'

/**
 * The app-wide stale-build state (src/lib/app-update/detect.ts). `detected`:
 * a lazy load failed and the server runs a newer build — the root layout's
 * banner says "reload". `inline`: how many inline update notices are on the
 * page; while one is showing, the banner stays away so the person reads the
 * sentence once.
 */
export const appUpdate = $state({ detected: false, inline: 0 })

/** SvelteKit's check: `/_app/version.json` against this tab's build (`kit.version`). False in dev. */
export const checkUpdated: CheckUpdated = () => updated.check()

/** A full page load: fresh HTML and the new build's chunks. A browser affordance, not a company action. */
export function reloadPage(): void {
  location.reload()
}
