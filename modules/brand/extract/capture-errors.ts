/**
 * Typed failures of the site capture layer, re-exported from the shared
 * headless-browser lib so route handlers can recognise them (instanceof)
 * without loading Playwright.
 */
export { BROWSER_UNAVAILABLE_MESSAGE, BrowserUnavailableError } from '$lib/server/browser/executable'
