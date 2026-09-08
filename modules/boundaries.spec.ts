import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findCrossModuleImports, type CandidateFile } from '../src/lib/kernel/boundaries'

describe('findCrossModuleImports', () => {
  it('flags a relative static import that resolves into another module', () => {
    const violations = findCrossModuleImports([
      {
        path: 'modules/orchestrator/brain.ts',
        content: "import type { Brain } from '../chat-gateway/telegram'\n",
      },
    ])
    expect(violations).toEqual([
      {
        file: 'modules/orchestrator/brain.ts',
        imported: 'modules/chat-gateway/telegram',
        spec: '../chat-gateway/telegram',
      },
    ])
  })

  it('flags a literal modules/<other>/ specifier', () => {
    const violations = findCrossModuleImports([
      {
        path: 'modules/memory/tools.ts',
        content: "import { x } from 'modules/email/tools'\n",
      },
    ])
    expect(violations).toEqual([
      {
        file: 'modules/memory/tools.ts',
        imported: 'modules/email/tools',
        spec: 'modules/email/tools',
      },
    ])
  })

  it('flags a dynamic import() crossing modules', () => {
    const violations = findCrossModuleImports([
      {
        path: 'modules/memory/tools.ts',
        content: "const m = await import('../website/store')\n",
      },
    ])
    expect(violations).toEqual([
      {
        file: 'modules/memory/tools.ts',
        imported: 'modules/website/store',
        spec: '../website/store',
      },
    ])
  })

  it('flags export-from re-exports crossing modules', () => {
    const violations = findCrossModuleImports([
      {
        path: 'modules/memory/index.ts',
        content: "export { kind } from '../website/manifest'\n",
      },
    ])
    expect(violations).toEqual([
      {
        file: 'modules/memory/index.ts',
        imported: 'modules/website/manifest',
        spec: '../website/manifest',
      },
    ])
  })

  it('flags module code importing the composition root (modules/index)', () => {
    const violations = findCrossModuleImports([
      {
        path: 'modules/orchestrator/bootstrap.ts',
        content: "import { bootstrapKernel } from '../index'\n",
      },
    ])
    expect(violations).toEqual([
      {
        file: 'modules/orchestrator/bootstrap.ts',
        imported: 'modules/index',
        spec: '../index',
      },
    ])
  })

  it('does not flag same-module imports', () => {
    const violations = findCrossModuleImports([
      {
        path: 'modules/website/tools.ts',
        content: "import { defaultWebsiteStore } from './store'\n",
      },
      {
        path: 'modules/chat-gateway/telegram.ts',
        content: "import { chatGatewayEnv } from './env'\n",
      },
    ])
    expect(violations).toEqual([])
  })

  it('does not flag non-module and kernel specifiers', () => {
    const violations = findCrossModuleImports([
      {
        path: 'modules/email/tools.ts',
        content:
          "import { z } from 'zod'\nimport { randomUUID } from 'node:crypto'\nimport { ToolDescriptor } from '$lib/kernel/types'\nimport { db } from '$lib/server/db'\n",
      },
    ])
    expect(violations).toEqual([])
  })

  it('ignores files under modules/ root (composition root imports across by design)', () => {
    const violations = findCrossModuleImports([
      {
        path: 'modules/index.ts',
        content: "import { createEmailTools } from './email/tools'\n",
      },
      {
        path: 'modules/index.spec.ts',
        content: "import { emailManifest } from './email/manifest'\n",
      },
    ])
    expect(violations).toEqual([])
  })

  it('ignores files outside modules/', () => {
    const violations = findCrossModuleImports([
      {
        path: 'src/routes/page.svelte.ts',
        content: "import { createEmailTools } from '../../modules/email/tools'\n",
      },
    ])
    expect(violations).toEqual([])
  })
})

/** Recurse the real modules/ tree into detector input (repo-relative posix paths). */
function collectModuleFiles(dir = 'modules'): CandidateFile[] {
  const files: CandidateFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) files.push(...collectModuleFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push({ path, content: readFileSync(path, 'utf8') })
    }
  }
  return files
}

describe('module boundary guard (repo scan)', () => {
  it('no module imports another module’s code — cross-module work goes through kernelRegistry.execute()', () => {
    const violations = findCrossModuleImports(collectModuleFiles())
    const detail = violations
      .map((v) => `${v.file}: '${v.spec}' → ${v.imported}`)
      .join('\n  ')
    expect(violations, `cross-module imports found (rule 1: zero side doors):\n  ${detail}`).toEqual([])
  })
})
