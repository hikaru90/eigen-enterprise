/**
 * Typed failures of the site capture layer. Kept apart from capture.ts so
 * route handlers can recognise them (instanceof) without loading Playwright.
 */

export const BROWSER_UNAVAILABLE_MESSAGE =
  "Capturing a website needs a browser on the server, and this install doesn't have one. Upload your brand guide instead."

/**
 * The headless browser the capture launches is not installed on this server
 * (releases install node_modules with --ignore-scripts and ship no browser).
 * Detected by checking the executable before the launch, never by reading a
 * launch error's text.
 */
export class BrowserUnavailableError extends Error {
  readonly code = 'browser_unavailable' as const
  /** Where the capture expected the browser; null when Playwright has no build for this platform. */
  readonly executablePath: string | null

  constructor(executablePath: string | null) {
    super(BROWSER_UNAVAILABLE_MESSAGE)
    this.name = 'BrowserUnavailableError'
    this.executablePath = executablePath
  }
}
