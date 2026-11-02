/**
 * Build-time brand preview renderer (plan/phase-brand-picker.md §3.2, B2b).
 *
 *   npm run brand:previews                         # styles.json → static/brand-previews + picker-index.json
 *   npm run brand:previews -- --input <styles.json> --out-dir <dir> --index <picker-index.json> [--force]
 *
 * Renders every node × light/dark at 2× DPR (640×440) with Playwright/Chromium,
 * waits for Google Fonts and fails loud when a family did not load, writes WebP
 * (via sharp), skips nodes whose rendered HTML hash is unchanged (cache file
 * `.hashes.json` in the output dir), then writes the validated picker index.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { pickerIndexSchema } from '../modules/brand/taxonomy/picker-index'
import {
  buildPickerIndex,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  previewDocuments,
  previewHash,
} from '../modules/brand/taxonomy/preview/index'

const RENDERER_VERSION = '1'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const input = resolve(arg('input', join(root, 'modules/brand/taxonomy/styles.json')))
const outDir = resolve(arg('out-dir', join(root, 'static/brand-previews')))
const indexPath = resolve(arg('index', join(root, 'modules/brand/taxonomy/picker-index.json')))
const force = process.argv.includes('--force')

async function main() {
  if (!existsSync(input)) throw new Error(`styles file not found: ${input}`)
  const styles = JSON.parse(readFileSync(input, 'utf8'))
  // Validate before rendering anything (throws with every error).
  const index = buildPickerIndex(styles, 'webp')
  const nodes = pickerIndexSchema.parse(styles).nodes
  mkdirSync(outDir, { recursive: true })

  const cachePath = join(outDir, '.hashes.json')
  const cache: Record<string, string> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf8'))
    : {}
  const docs = previewDocuments(nodes)
  const todo = docs.filter(({ node, mode, html }) => {
    const file = `${node.id}-${mode}.webp`
    return (
      force ||
      cache[file] !== previewHash(html, RENDERER_VERSION) ||
      !existsSync(join(outDir, file))
    )
  })

  console.log(
    `brand:previews — ${nodes.length} nodes, ${docs.length} images, ${todo.length} to render → ${outDir}`,
  )
  const browser = await chromium.launch()
  const failures: string[] = []
  try {
    const ctx = await browser.newContext({
      viewport: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    for (const { node, mode, html } of todo) {
      const file = `${node.id}-${mode}.webp`
      const t0 = performance.now()
      await page.setContent(html, { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      const families = [...new Set([node.fonts.heading, node.fonts.body, node.fonts.mono])]
      const missing = await page.evaluate((fams: string[]) => {
        const loaded = new Set(
          [...document.fonts]
            .filter((f) => f.status === 'loaded')
            .map((f) => f.family.replace(/^["']|["']$/g, '')),
        )
        return fams.filter((f) => !loaded.has(f))
      }, families)
      if (missing.length) {
        failures.push(`${file}: font(s) did not load: ${missing.join(', ')}`)
        continue
      }
      const png = await page.screenshot({ type: 'png', animations: 'disabled' })
      await sharp(png).webp({ quality: 90, effort: 4 }).toFile(join(outDir, file))
      cache[file] = previewHash(html, RENDERER_VERSION)
      console.log(`  ${file}  ${Math.round(performance.now() - t0)}ms`)
    }
  } finally {
    await browser.close()
    writeFileSync(
      cachePath,
      JSON.stringify(Object.fromEntries(Object.entries(cache).sort()), null, 2) + '\n',
    )
  }
  if (failures.length) throw new Error(`preview rendering failed:\n- ${failures.join('\n- ')}`)

  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
  console.log(`wrote ${indexPath}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
