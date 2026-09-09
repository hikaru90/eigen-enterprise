import { chromium } from 'playwright'
import { normalizeColor, type ElementFacts, type SiteFacts } from './facts-digest'
import { assertPublicUrl } from './ssrf-guard'

/**
 * Headless site capture (phase-2d M2): computed-style facts + a height-capped
 * full-page screenshot. Navigation errors fail loud — no partial captures.
 */

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

export async function captureSite(rawUrl: string): Promise<CaptureResult> {
  const url = await assertPublicUrl(rawUrl)
  const browser = await chromium.launch({ headless: true })
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
          const styles = await handle.evaluate((el, props) => {
            const computed = getComputedStyle(el)
            return Object.fromEntries(props.map((prop) => [prop, computed[prop]]))
          }, [...STYLE_PROPERTIES])
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

    const scrollHeight = await page.evaluate(
      () => document.documentElement.scrollHeight,
    )
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
