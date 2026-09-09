#!/usr/bin/env node
/**
 * Tier-1 corpus ingest (phase-2d M3, owner-run).
 *
 *   node modules/brand/corpus/ingest-tier1.mjs            # both sources
 *   node modules/brand/corpus/ingest-tier1.mjs --only=daisyui
 *   node modules/brand/corpus/ingest-tier1.mjs --only=tweakcn
 *
 * Sources:
 *  - daisyUI: the bundled per-theme CSS of the `daisyui` devDependency
 *    (theme/<name>.css), mapped to shadcn roles via mapping.ts.
 *  - tweakcn: ONE curated explicit raw URL — the built-in preset registry of
 *    jnsahaj/tweakcn (public/r/registry.json), already shadcn-var-shaped.
 *
 * mapping lives in corpus/mapping.ts; this script imports it directly —
 * node >= 22.18 strips TS types natively (guarded below, fail loud).
 *
 * No network beyond the explicit tweakcn registry URL. Loud per-item errors,
 * skip + log invalid items, count summary at the end. After running this,
 * regrow the index: npx vitest run modules/brand/corpus/build.spec.ts
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const nativeTypeStripping =
  nodeMajor > 23 || (nodeMajor === 23 && nodeMinor >= 6) || (nodeMajor === 22 && nodeMinor >= 18)
if (!nativeTypeStripping) {
  fail('node >= 22.18 required: this script imports corpus/mapping.ts and relies on native TS type stripping')
}
const { corpusSlug, daisyUiThemeToItem, tweakcnPresetToItem } = await import('./mapping.ts')

const here = path.dirname(fileURLToPath(import.meta.url))
const itemsDir = path.join(here, 'items')
const daisyUiThemeDir = path.join(here, '../../../node_modules/daisyui/theme')
const TWEAKCN_REGISTRY_URL = 'https://raw.githubusercontent.com/jnsahaj/tweakcn/main/public/r/registry.json'

/** Curated explicit list of tweakcn built-in preset ids (jnsahaj/tweakcn, MIT). */
const TWEAKCN_PRESET_IDS = [
  'modern-minimal', 't3-chat', 'twitter', 'mocha-mousse', 'bubblegum', 'doom-64',
  'catppuccin', 'graphite', 'perpetuity', 'kodama-grove', 'cosmic-night', 'tangerine',
  'quantum-rose', 'nature', 'bold-tech', 'elegant-luxury', 'amber-minimal', 'supabase',
  'neo-brutalism', 'solar-dusk', 'claymorphism', 'cyberpunk', 'pastel-dreams', 'clean-slate',
  'caffeine', 'ocean-breeze', 'retro-arcade', 'midnight-bloom', 'candyland', 'northern-lights',
  'vintage-paper', 'sunset-horizon', 'starry-night', 'claude', 'vercel', 'mono',
]

const only = (() => {
  const arg = process.argv.find((a) => a.startsWith('--only='))
  if (!arg) return null
  const value = arg.slice('--only='.length)
  if (value !== 'daisyui' && value !== 'tweakcn') {
    throw new Error(`--only must be "daisyui" or "tweakcn", got: "${value}"`)
  }
  return value
})()

function fail(message) {
  console.error(`ingest-tier1: ${message}`)
  process.exit(1)
}

function writeItem(item, slug) {
  const file = path.join(itemsDir, `${slug}.json`)
  writeFileSync(file, `${JSON.stringify(item, null, 2)}\n`)
  return file
}

function ingestDaisyUi() {
  if (!readdirSafe(daisyUiThemeDir)) {
    fail(`daisyUI theme dir not found at ${daisyUiThemeDir} — run "npm i -D daisyui" first`)
  }
  const daisyPkg = JSON.parse(readFileSync(path.join(here, '../../../node_modules/daisyui/package.json'), 'utf8'))
  const themeFiles = readdirSync(daisyUiThemeDir).filter((f) => f.endsWith('.css')).sort()
  let ok = 0
  let failed = 0
  for (const file of themeFiles) {
    const themeName = file.replace(/\.css$/, '')
    try {
      const cssText = readFileSync(path.join(daisyUiThemeDir, file), 'utf8')
      const item = daisyUiThemeToItem({ themeName, cssText, packageVersion: daisyPkg.version })
      writeItem(item, corpusSlug('daisyui', themeName))
      ok += 1
    } catch (err) {
      failed += 1
      console.error(`[skip] daisyUI theme "${themeName}": ${err instanceof Error ? err.message : err}`)
    }
  }
  return { ok, failed }
}

function readdirSafe(dir) {
  try {
    readdirSync(dir)
    return true
  } catch {
    return false
  }
}

async function ingestTweakcn() {
  let response
  try {
    response = await fetch(TWEAKCN_REGISTRY_URL)
  } catch (err) {
    fail(`cannot fetch tweakcn registry (${TWEAKCN_REGISTRY_URL}): ${err instanceof Error ? err.message : err}`)
  }
  if (!response.ok) fail(`tweakcn registry fetch failed: HTTP ${response.status}`)
  const registry = await response.json()
  const byId = new Map((registry.items ?? []).map((preset) => [preset.name, preset]))

  let ok = 0
  let failed = 0
  for (const id of TWEAKCN_PRESET_IDS) {
    const preset = byId.get(id)
    if (!preset) {
      failed += 1
      console.error(`[skip] tweakcn preset "${id}": not present in registry — update TWEAKCN_PRESET_IDS`)
      continue
    }
    try {
      const item = tweakcnPresetToItem(preset, TWEAKCN_REGISTRY_URL)
      writeItem(item, corpusSlug('tweakcn', id))
      ok += 1
    } catch (err) {
      failed += 1
      console.error(`[skip] tweakcn preset "${id}": ${err instanceof Error ? err.message : err}`)
    }
  }
  return { ok, failed }
}

mkdirSync(itemsDir, { recursive: true })

const results = {}
if (only !== 'tweakcn') results.daisyui = ingestDaisyUi()
if (only !== 'daisyui') results.tweakcn = await ingestTweakcn()

let total = 0
for (const [source, { ok, failed }] of Object.entries(results)) {
  console.info(`${source}: ${ok} ingested, ${failed} skipped`)
  total += ok
}
console.info(`total: ${total} tier-1 corpus items written to modules/brand/corpus/items/`)
if (total === 0) fail('no tier-1 items ingested — nothing to commit')
if (total < TWEAKCN_PRESET_IDS.length + 30) {
  console.warn(`warning: only ${total} items — expected ~${TWEAKCN_PRESET_IDS.length + 30}; inspect skipped entries above`)
}
