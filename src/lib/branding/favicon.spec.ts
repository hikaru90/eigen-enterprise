import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const staticDir = path.resolve(here, '../../../static')

describe('favicon brand assets', () => {
	it('static/favicon.ico exists, is non-empty, and is a valid multi-size ICO', () => {
		const file = path.join(staticDir, 'favicon.ico')
		const buf = readFileSync(file)
		expect(buf.length).toBeGreaterThan(0)
		// ICO header: reserved=0, type=1, count>=2 (16/32/48)
		expect(buf.readUInt16LE(0)).toBe(0)
		expect(buf.readUInt16LE(2)).toBe(1)
		expect(buf.readUInt16LE(4)).toBeGreaterThanOrEqual(2)
	})

	it('static/favicon.svg exists, is non-empty, and parses as SVG', () => {
		const file = path.join(staticDir, 'favicon.svg')
		const buf = readFileSync(file)
		expect(buf.length).toBeGreaterThan(0)
		expect(buf.length).toBeLessThan(16_384)
		const text = buf.toString('utf-8')
		expect(text).toContain('<svg')
		expect(text).toContain('xmlns="http://www.w3.org/2000/svg"')
		expect(text.trim().endsWith('</svg>')).toBe(true)
	})

	it('the root layout links favicon.svg and favicon.ico while the company has no monogram icon', () => {
		// The icon links live in the root layout's head (they follow the company's
		// identity, src/lib/pwa/identity.ts); the product's are the unbranded branch.
		const layout = readFileSync(path.resolve(staticDir, '../src/routes/+layout.svelte'), 'utf-8')
		const unbranded = layout.slice(layout.indexOf('{:else}'), layout.indexOf('{/if}', layout.indexOf('{:else}')))
		expect(unbranded).toContain('rel="icon"')
		expect(unbranded).toContain('href="/favicon.svg"')
		expect(unbranded).toContain('href="/favicon.ico"')
	})
})
