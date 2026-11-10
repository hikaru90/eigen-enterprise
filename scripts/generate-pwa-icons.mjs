// Renders the installable-app icons (src/lib/pwa/manifest.ts) from static/favicon.svg.
// Run after the favicon changes: node scripts/generate-pwa-icons.mjs
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(path.join(root, 'static/favicon.svg'))
const out = (name) => path.join(root, 'static', name)
// The app's light background (app.html theme-color) behind the maskable icon.
const BACKGROUND = '#e8ede5'

await sharp(svg, { density: 512 }).resize(192, 192).png().toFile(out('pwa-192.png'))
await sharp(svg, { density: 512 }).resize(512, 512).png().toFile(out('pwa-512.png'))

// Maskable: launchers crop to a circle/squircle, so the mark sits inside the
// 80% safe zone (the mark ends up ~60% wide) on a full-bleed background.
const inner = await sharp(svg, { density: 512 }).resize(420, 420).png().toBuffer()
await sharp({ create: { width: 512, height: 512, channels: 4, background: BACKGROUND } })
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile(out('pwa-512-maskable.png'))

console.log('wrote static/pwa-192.png, static/pwa-512.png, static/pwa-512-maskable.png')
