import { CORE_API_VERSION } from '../../contracts/core-api-version'
import { moduleIdSchema, parseModuleManifestYaml } from '../../contracts/module-manifest'
import { CORE_API_TOOL_NAMES } from '../../contracts/sdk/core-api'
import { KernelError } from '$lib/kernel/errors'
import { APACHE_LICENSE_TEXT, MODULE_SDK_SOURCES } from '$lib/kernel/module-host/sdk-sources'

/**
 * `modules.scaffold` (plan/phase-upgrades-u2.md §8, §4.7, D9): a new module's
 * starting files — module.yaml, the Apache-2.0 LICENSE, the vendored SDK
 * (module-runtime, module-transport, test-kernel, and the core tool names of
 * this box's lock), one tool and a test that passes. The module runs under
 * Node 22's type stripping, so it needs no build step and no dependencies.
 */

export const SDK_DIR = 'vendor/eigen-sdk'

/** The README says it plainly: module code is public (§6.6). */
export const PUBLIC_CODE_NOTE =
  'Module code is open source (Apache-2.0) and shared with eigenEnterprise: everything in this folder is published when it is deployed. Never put secrets, customer data or anything private in code — secrets go in permissions.secrets (an admin sets their values), data goes through data.*.'

export type ScaffoldInput = { id: string; name: string; description: string }

const yamlString = (s: string) => JSON.stringify(s)

export function scaffoldFiles(input: ScaffoldInput): { path: string; content: string }[] {
  const idCheck = moduleIdSchema.safeParse(input.id)
  if (!idCheck.success) {
    throw new KernelError('invalid_input', `"${input.id}" is not a module id: ${idCheck.error.issues[0]!.message}`)
  }
  const major = CORE_API_VERSION.split('.')[0]
  const manifest = `manifest: eigen.module/1
id: ${input.id}
name: ${yamlString(input.name)}
version: 0.1.0
description: ${yamlString(input.description)}
license: Apache-2.0
requires: { core-api: '^${major}.0.0' }
runtime: { node: '22' }
build: []
test: [['node', '--experimental-strip-types', 'test.ts']]
start: ['node', '--experimental-strip-types', 'index.ts']
resources: { memoryMb: 128, cpuPercent: 25 }
uses:
  tools: []
  events: []
  slots: []
provides:
  tools:
    - name: hello
      summary: Say hello to someone
      input:
        type: object
        properties:
          name: { type: string, minLength: 1, maxLength: 100 }
        required: [name]
        additionalProperties: false
      output:
        type: object
        properties:
          greeting: { type: string }
        required: [greeting]
        additionalProperties: false
      auditClass: read
      approval: none
  events: []
  slots: []
permissions:
  background: false
  secrets: []
  network: []
  capabilities: []
`
  const parsed = (() => {
    try {
      return parseModuleManifestYaml(manifest)
    } catch (err) {
      throw new KernelError('invalid_input', `the module's name or description does not fit module.yaml: ${(err as Error).message}`)
    }
  })()
  return [
    { path: 'module.yaml', content: manifest },
    { path: 'LICENSE', content: APACHE_LICENSE_TEXT },
    {
      path: 'package.json',
      content: `${JSON.stringify({ name: `eigen-module-${parsed.id}`, version: '0.1.0', private: true, license: 'Apache-2.0', type: 'module' }, null, 2)}\n`,
    },
    {
      path: 'README.md',
      content: `# ${parsed.name}\n\n${parsed.description}\n\n${PUBLIC_CODE_NOTE}\n\n- \`module.yaml\` declares what the module uses and provides; the kernel enforces it.\n- \`tools.ts\` holds the tools, \`index.ts\` runs them, \`test.ts\` tests them with the in-memory test kernel.\n- \`${SDK_DIR}/\` is the vendored SDK (eem/1); do not edit it.\n`,
    },
    {
      path: 'tools.ts',
      content: `import type { ToolHandler } from './${SDK_DIR}/module-runtime.ts'

/** The tools this module provides (module.yaml provides.tools). */
export const tools: Record<string, ToolHandler> = {
  hello: (input) => ({ greeting: \`Hello, \${(input as { name: string }).name}!\` }),
}
`,
    },
    {
      path: 'index.ts',
      content: `import { defineModule } from './${SDK_DIR}/module-runtime.ts'
import { tools } from './tools.ts'

defineModule({ tools }).run()
`,
    },
    {
      path: 'test.ts',
      content: `import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { testKernel } from './${SDK_DIR}/test-kernel.ts'
import { tools } from './tools.ts'

const lockTools = JSON.parse(readFileSync(new URL('./${SDK_DIR}/core-tools.json', import.meta.url), 'utf8'))
const kernel = testKernel({ tools }, { uses: { tools: [] }, lockTools })
assert.deepEqual(await kernel.invoke('hello', { name: 'Ann' }), { greeting: 'Hello, Ann!' })
console.log('ok')
`,
    },
    { path: `${SDK_DIR}/module-runtime.ts`, content: MODULE_SDK_SOURCES['module-runtime.ts'] },
    { path: `${SDK_DIR}/module-transport.ts`, content: MODULE_SDK_SOURCES['module-transport.ts'] },
    { path: `${SDK_DIR}/test-kernel.ts`, content: MODULE_SDK_SOURCES['test-kernel.ts'] },
    { path: `${SDK_DIR}/core-tools.json`, content: `${JSON.stringify([...CORE_API_TOOL_NAMES], null, 2)}\n` },
  ]
}
