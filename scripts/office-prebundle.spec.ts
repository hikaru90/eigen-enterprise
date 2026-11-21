import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bareImports, officePrebundle } from './office-prebundle.mjs'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('office pre-bundle list (dev only: no mid-interaction reloads)', () => {
  it('collects bare package imports, skipping types, relative/$lib/node:, and ?url assets', () => {
    const src = `
      import { a } from 'pdf-lib'
      import Icon from '@lucide/svelte/icons/sticky-note'
      import type { Node } from 'prosemirror-model'
      import { type EditorState, Plugin } from 'prosemirror-state'
      import x from './local'
      import y from '$lib/drive/api'
      import { join } from 'node:path'
      const w = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      const lib = await import('pdfjs-dist')
      export { z } from 'fflate'
    `
    expect([...bareImports(src)].sort()).toEqual(['@lucide/svelte/icons/sticky-note', 'fflate', 'pdf-lib', 'pdfjs-dist', 'prosemirror-state'])
  })

  it('scans the office folder (not specs or test utils) into a sorted, de-duplicated list', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'office-scan-'))
    dirs.push(root)
    await mkdir(path.join(root, 'pdf', 'test-utils'), { recursive: true })
    await writeFile(path.join(root, 'pdf', 'viewer.svelte'), `<script lang="ts">import X from '@lucide/svelte/icons/x'\nimport { a } from 'pdf-lib'</script>`)
    await writeFile(path.join(root, 'pdf', 'ops.ts'), `import { a } from 'pdf-lib'`)
    await writeFile(path.join(root, 'pdf', 'ops.spec.ts'), `import { it } from 'vitest'`)
    await writeFile(path.join(root, 'pdf', 'test-utils', 'build.ts'), `import { zipSync } from 'only-in-tests'`)
    // The agent-text extractors run only on the server (plan §3): never in the browser bundle.
    await writeFile(path.join(root, 'pdf', 'text.ts'), `const lib = await import('pdfjs-dist/legacy/build/pdf.mjs')`)
    // Svelte itself is the plugin's to handle, never pre-bundled.
    await writeFile(path.join(root, 'pdf', 'store.ts'), `import { onMount } from 'svelte'\nimport { fade } from 'svelte/transition'`)
    expect(officePrebundle(root)).toEqual(['@lucide/svelte/icons/x', 'pdf-lib'])
  })

  it('the real office code: every icon the M3 editors use is covered', () => {
    const list = officePrebundle(path.join(process.cwd(), 'src/lib/office'))
    for (const dep of ['@lucide/svelte/icons/sticky-note', '@lucide/svelte/icons/message-square-plus', 'pdf-lib/dist/pdf-lib.esm.js', 'prosemirror-view', '@xmldom/xmldom']) {
      expect(list).toContain(dep)
    }
  })
})
