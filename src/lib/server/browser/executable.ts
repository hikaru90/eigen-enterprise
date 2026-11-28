import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

/**
 * The server's headless browser (chrome-headless-shell), shared by every
 * feature that renders or captures with it: brand site capture, brand
 * material and sheet PDF export, Drive artifact PDF export. Lives in the
 * shared server lib so no module reaches into another module's code.
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

/** Where the headless browser lives and whether it can run (injectable for tests). */
export type BrowserProbe = {
  /**
   * The chrome-headless-shell the server installed: ee sets EE_CAP_CHROMIUM for a
   * workload whose ee.json declares the chromium capability (ee/src/capabilities.ts).
   * Null on an install without it. A local run sets it in .env to use its own browser.
   */
  executablePath(): string | null
  isExecutable(path: string): Promise<boolean>
}

export const defaultBrowserProbe: BrowserProbe = {
  executablePath: () => process.env.EE_CAP_CHROMIUM || null,
  isExecutable: (path) =>
    access(path, constants.X_OK).then(
      () => true,
      () => false,
    ),
}

/** The browser executable to launch, or BrowserUnavailableError when it isn't installed. */
export async function requireBrowserExecutable(
  probe: BrowserProbe = defaultBrowserProbe,
): Promise<string> {
  const executablePath = probe.executablePath()
  if (executablePath === null || !(await probe.isExecutable(executablePath))) {
    throw new BrowserUnavailableError(executablePath)
  }
  return executablePath
}
