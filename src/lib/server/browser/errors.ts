/**
 * Typed failures of the headless browser, kept apart from executable.ts so
 * code can recognise them (instanceof) without loading node:fs or Playwright.
 */

export const BROWSER_UNAVAILABLE_MESSAGE =
  "Capturing a website needs a browser on the server, and this install doesn't have one. Upload your brand guide instead."

/**
 * The headless browser is not installed on this server (releases install
 * node_modules with --ignore-scripts and ship no browser). Detected by
 * checking the executable before the launch, never by reading a launch
 * error's text. Callers outside brand capture rewrap it with their own wording.
 */
export class BrowserUnavailableError extends Error {
  readonly code = 'browser_unavailable' as const
  /** Where the browser was expected; null when none is configured. */
  readonly executablePath: string | null

  constructor(executablePath: string | null) {
    super(BROWSER_UNAVAILABLE_MESSAGE)
    this.name = 'BrowserUnavailableError'
    this.executablePath = executablePath
  }
}
