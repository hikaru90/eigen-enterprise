import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

/**
 * The server's headless browser (chrome-headless-shell), shared by every
 * feature that renders or captures with it: brand site capture, brand
 * material and sheet PDF export, Drive artifact PDF export. Lives in the
 * shared server lib so no module reaches into another module's code.
 */

export { BROWSER_UNAVAILABLE_MESSAGE, BrowserUnavailableError } from './errors'
import { BrowserUnavailableError } from './errors'

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
