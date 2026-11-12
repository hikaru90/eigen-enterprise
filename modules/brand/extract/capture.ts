import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { chromium } from 'playwright'
import { registry } from 'playwright-core/lib/server/registry/index'
import { BrowserUnavailableError } from './capture-errors'
import { normalizeColor, type ElementFacts, type SiteFacts } from './facts-digest'
import { assertPublicUrl } from './ssrf-guard'

/**
 * Headless site capture (phase-2d M2): computed-style facts + a height-capped
 * full-page screenshot. Navigation errors fail loud — no partial captures.
 * A server without the headless browser fails with BrowserUnavailableError
 * before anything else happens.
 */

/** Playwright's registry name for the browser a headless chromium launch runs. */
const HEADLESS_BROWSER = 'chromium-headless-shell'

/** Where the headless browser lives and whether it can run (injectable for tests). */
export type BrowserProbe = {
  /** Playwright's install path for this platform; null when it has no build for it. */
  executablePath(): string | null
  isExecutable(path: string): Promise<boolean>
}

export const defaultBrowserProbe: BrowserProbe = {
  executablePath: () => registry.findExecutable(HEADLESS_BROWSER)?.executablePath() ?? null,
  isExecutable: (path) =>
    access(path, constants.X_OK).then(
      () => true,
      () => false,
    ),
}

/** The browser executable the capture launches, or BrowserUnavailableError when it isn't installed. */
export async function requireBrowserExecutable(
  probe: BrowserProbe = defaultBrowserProbe,
): Promise<string> {
  const executablePath = probe.executablePath()
  if (executablePath === null || !(await probe.isExecutable(executablePath))) {
    throw new BrowserUnavailableError(executablePath)
  }
  return executablePath
}

export type CaptureDeps = { browser?: BrowserProbe }

const MAX_SAMPLES_PER_SELECTOR = 40
const VIEWPORT_WIDTH = 1280
const MAX_SCREENSHOT_HEIGHT = 4000
const NAVIGATION_TIMEOUT_MS = 20_000
const JPEG_QUALITY = 80

export const CAPTURED_SELECTORS = [
  'body',
  'h1',
  'h2',
  'h3',
  'p',
  'a',
  'button',
  'nav',
  'header',
  'footer',
  '[class*=card]',
  '[class*=btn]',
] as const

const STYLE_PROPERTIES = [
  'color',
  'backgroundColor',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'borderRadius',
  'boxShadow',
  'borderWidth',
  'borderStyle',
  'padding',
  'margin',
] as const

export type CaptureResult = {
  facts: SiteFacts
  screenshotB64: string
  title: string
}

export async function captureSite(rawUrl: string, deps: CaptureDeps = {}): Promise<CaptureResult> {
  // The launch runs exactly the executable checked here, so check and launch can't disagree.
  const executablePath = await requireBrowserExecutable(deps.browser)
  const url = await assertPublicUrl(rawUrl)
  const browser = await chromium.launch({ headless: true, executablePath })
  try {
    const page = await browser.newPage({
      viewport: { width: VIEWPORT_WIDTH, height: 800 },
    })
    try {
      await page.goto(url.toString(), {
        waitUntil: 'networkidle',
        timeout: NAVIGATION_TIMEOUT_MS,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`capture navigation failed for ${url}: ${message}`, { cause: err })
    }

    const title = await page.title()
    const themeColor = await page
      .$eval('meta[name="theme-color"]', (el) => el.getAttribute('content'))
      .catch(() => null)

    const selectors: Record<string, ElementFacts[]> = {}
    const colorCounts = new Map<string, number>()

    for (const selector of CAPTURED_SELECTORS) {
      const handles = await page.$$(selector)
      const sampled = handles.slice(0, MAX_SAMPLES_PER_SELECTOR)
      const collected: ElementFacts[] = []
      for (const handle of sampled) {
        try {
          const styles = await handle.evaluate(
            (el, props) => {
              const computed = getComputedStyle(el)
              return Object.fromEntries(props.map((prop) => [prop, computed[prop]]))
            },
            [...STYLE_PROPERTIES],
          )
          for (const key of ['color', 'backgroundColor'] as const) {
            const normalized = normalizeColor(styles[key])
            colorCounts.set(normalized, (colorCounts.get(normalized) ?? 0) + 1)
          }
          collected.push(styles as unknown as ElementFacts)
        } finally {
          await handle.dispose()
        }
      }
      for (const handle of handles.slice(MAX_SAMPLES_PER_SELECTOR)) {
        await handle.dispose()
      }
      selectors[selector] = collected
    }

    const colorCensus = [...colorCounts.entries()]
      .map(([color, count]) => ({ color, count }))
      .sort((a, b) => b.count - a.count || a.color.localeCompare(b.color))

    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    await page.setViewportSize({
      width: VIEWPORT_WIDTH,
      height: Math.min(Math.max(scrollHeight, 1), MAX_SCREENSHOT_HEIGHT),
    })
    const screenshot = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY })

    return {
      facts: { selectors, themeColor, title, colorCensus },
      screenshotB64: screenshot.toString('base64'),
      title,
    }
  } finally {
    await browser.close()
  }
}
