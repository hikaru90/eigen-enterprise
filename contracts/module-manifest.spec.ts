import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_EVENTS } from '$lib/kernel/event-catalog'
import { CHAT_GATEWAY_MODULE_ID } from '$lib/kernel/gateway'
import { moduleManifests } from '../modules/index'
import { RECAP_MODULE_ID } from '../modules/recap/types'
import { CORE_API_VERSION } from './core-api-version'
import lock from './core-api.lock.json' with { type: 'json' }
import {
  activityTemplateProblems,
  canonicalManifestJson,
  CORE_MODULE_IDS,
  kernelModuleId,
  manifestCatalogGaps,
  manifestSha256,
  MODULE_MANIFEST_FILE,
  ModuleManifestError,
  parseModuleManifest,
  parseModuleManifestYaml,
  providedEventType,
  providedToolName,
  RESERVED_MODULE_IDS,
  safeParseModuleManifest,
  safeParseModuleManifestYaml,
  satisfiesCoreApi,
  toolNamespace,
  workloadName,
} from './module-manifest'

const HELLO_YAML = readFileSync(
  join(import.meta.dirname, 'fixtures/modules/hello', MODULE_MANIFEST_FILE),
  'utf8',
)

const tool = (over: Record<string, unknown> = {}) => ({
  name: 'create',
  summary: 'Create an invoice',
  input: {
    type: 'object',
    properties: { customer: { type: 'string' } },
    required: ['customer'],
  },
  output: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] },
  auditClass: 'mutate',
  approvalRisk: 'internal',
  approval: 'mode',
  activity: 'Created invoice {output.number} for {input.customer}',
  ...over,
})

const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifest: 'eigen.module/1',
  id: 'invoices',
  name: 'Invoices',
  version: '0.1.0',
  description: 'Write and send invoices.',
  license: 'Apache-2.0',
  requires: { 'core-api': '^1.0.0' },
  runtime: { node: '22' },
  build: [
    ['npm', 'ci'],
    ['npm', 'run', 'build'],
  ],
  test: [['npm', 'test']],
  start: ['node', 'dist/index.js'],
  uses: { tools: ['contacts.get', 'email.send_mail'], events: ['contacts.created'], slots: [] },
  provides: { tools: [tool()], events: [{ name: 'sent' }], slots: [] },
  permissions: { background: false, secrets: ['STRIPE_API_KEY'], network: [], capabilities: [] },
  ...over,
})

const problems = (value: unknown) => {
  const r = safeParseModuleManifest(value)
  return r.ok ? [] : r.problems
}
const refused = (value: unknown, path: string) =>
  expect(problems(value).map((p) => p.path)).toContain(path)

describe('module.yaml v1: accepted', () => {
  it('accepts the plan example and fills the defaults', () => {
    const m = parseModuleManifest(valid())
    expect(m.resources).toEqual({ memoryMb: 256, cpuPercent: 50 })
    expect(m.provides.tools[0]!.roles).toEqual(['admin', 'member', 'agent'])
    expect(m.provides.tools[0]!.timeoutMs).toBe(30_000)
  })

  it('parses the hello fixture from YAML', () => {
    const m = parseModuleManifestYaml(HELLO_YAML)
    expect(m.id).toBe('hello')
    expect(m.uses.tools).toEqual(['members.list'])
    expect(m.provides.tools.map((t) => t.name)).toEqual(['greet'])
  })

  it('accepts a read tool without approvalRisk or activity', () => {
    const t = tool({ auditClass: 'read', approval: 'none' })
    delete (t as Record<string, unknown>).approvalRisk
    delete (t as Record<string, unknown>).activity
    expect(problems(valid({ provides: { tools: [t] } }))).toEqual([])
  })

  it('accepts a minimal manifest (uses, provides, permissions, resources default)', () => {
    const m = valid()
    for (const k of ['uses', 'provides', 'permissions', 'resources']) delete m[k]
    const parsed = parseModuleManifest(m)
    expect(parsed.uses).toEqual({ tools: [], events: [], slots: [] })
    expect(parsed.permissions).toEqual({
      background: false,
      secrets: [],
      network: [],
      capabilities: [],
    })
  })
})

describe('module.yaml v1: refused', () => {
  it('refuses reserved words and every core module id', () => {
    for (const id of [...RESERVED_MODULE_IDS, ...CORE_MODULE_IDS].filter((i) => i.length >= 2))
      refused(valid({ id }), 'id')
  })

  it('refuses x- names (the kernel adds the prefix)', () => {
    refused(valid({ id: 'x-invoices' }), 'id')
  })

  it('refuses malformed ids', () => {
    for (const id of [
      'a',
      'Invoices',
      '1nv',
      'in--voices',
      'invoices-',
      'in_voices',
      'a'.repeat(25),
    ])
      refused(valid({ id }), 'id')
  })

  it('refuses unknown keys anywhere (strict)', () => {
    refused(valid({ owner: 'someone' }), '')
    refused(valid({ requires: { 'core-api': '^1.0.0', node: '22' } }), 'requires')
    refused(valid({ provides: { tools: [tool({ extra: 1 })] } }), 'provides.tools[0]')
  })

  it('refuses a non-caret core-api range', () => {
    for (const range of ['1.0.0', '~1.0.0', '>=1.0.0', '^1', '^1.0', '*', '^1.0.0 || ^2.0.0'])
      refused(valid({ requires: { 'core-api': range } }), 'requires.core-api')
  })

  it('refuses a licence other than Apache-2.0', () => {
    refused(valid({ license: 'MIT' }), 'license')
  })

  it('refuses a bad activity placeholder', () => {
    for (const activity of [
      'Created {number}',
      'Created {output.number.deep}',
      'Created {input.missing}',
      'Created {secrets.KEY}',
      'Created {output.number',
      'Created output.number}',
      'Created {}',
    ])
      refused(valid({ provides: { tools: [tool({ activity })] } }), 'provides.tools[0].activity')
  })

  it('requires approvalRisk and activity unless read', () => {
    const t = tool()
    delete (t as Record<string, unknown>).approvalRisk
    delete (t as Record<string, unknown>).activity
    const p = problems(valid({ provides: { tools: [t] } })).map((x) => x.path)
    expect(p).toContain('provides.tools[0].approvalRisk')
    expect(p).toContain('provides.tools[0].activity')
  })

  it('refuses schemas zod cannot read, and non-object tool schemas', () => {
    refused(
      valid({ provides: { tools: [tool({ input: { type: 'bogus' } })] } }),
      'provides.tools[0].input',
    )
    refused(
      valid({ provides: { tools: [tool({ output: { $ref: '#/nope' } })] } }),
      'provides.tools[0].output',
    )
    refused(
      valid({ provides: { tools: [tool({ input: { type: 'string' } })] } }),
      'provides.tools[0].input',
    )
    const noOutput = tool()
    delete (noOutput as Record<string, unknown>).output
    refused(valid({ provides: { tools: [noOutput] } }), 'provides.tools[0].output')
  })

  it('refuses bad tool names, roles, timeouts and duplicates', () => {
    refused(valid({ provides: { tools: [tool({ name: 'Create' })] } }), 'provides.tools[0].name')
    refused(
      valid({ provides: { tools: [tool({ name: 'a'.repeat(42) })] } }),
      'provides.tools[0].name',
    )
    refused(
      valid({ provides: { tools: [tool({ roles: ['owner'] })] } }),
      'provides.tools[0].roles[0]',
    )
    refused(
      valid({ provides: { tools: [tool({ timeoutMs: 120_001 })] } }),
      'provides.tools[0].timeoutMs',
    )
    refused(valid({ provides: { tools: [tool(), tool()] } }), 'provides.tools')
    refused(valid({ uses: { tools: ['contacts.get', 'contacts.get'] } }), 'uses.tools')
  })

  it('refuses network egress, too many secrets and ee-owned env names', () => {
    refused(valid({ permissions: { network: ['api.stripe.com'] } }), 'permissions.network')
    const many = Array.from({ length: 11 }, (_, i) => `KEY_${i}`)
    refused(valid({ permissions: { secrets: many } }), 'permissions.secrets')
    for (const name of ['EE_MODULE_TOKEN', 'PATH', 'NODE_ENV', 'lower'])
      refused(valid({ permissions: { secrets: [name] } }), 'permissions.secrets[0]')
  })

  it('refuses resources and commands out of range', () => {
    refused(valid({ resources: { memoryMb: 2048 } }), 'resources.memoryMb')
    refused(valid({ resources: { cpuPercent: 5 } }), 'resources.cpuPercent')
    refused(valid({ test: [] }), 'test')
    refused(valid({ build: Array.from({ length: 17 }, () => ['true']) }), 'build')
    refused(valid({ start: [] }), 'start')
    refused(valid({ runtime: { node: '20' } }), 'runtime.node')
  })

  it('reports YAML syntax errors with their line, and throws a ModuleManifestError', () => {
    const r = safeParseModuleManifestYaml('manifest: eigen.module/1\nid: [unclosed\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems[0]!.line).toBeGreaterThan(0)
    expect(() => parseModuleManifestYaml('id: hello\n')).toThrow(ModuleManifestError)
  })
})

describe('activity templates', () => {
  const schemas = { input: { properties: { a: {} } }, output: { properties: { b: {} } } }
  it('accepts plain text and declared placeholders', () => {
    expect(activityTemplateProblems('Did {input.a} → {output.b}', schemas)).toEqual([])
    expect(activityTemplateProblems('Nothing to fill', schemas)).toEqual([])
  })
})

describe('derived names', () => {
  it('derives the kernel id, namespace, workload and provided names', () => {
    expect(kernelModuleId('time-off')).toBe('x-time-off')
    expect(toolNamespace('time-off')).toBe('x_time_off')
    expect(workloadName('time-off')).toBe('mod-time-off')
    expect(providedToolName('time-off', 'request')).toBe('x_time_off.request')
    expect(providedEventType('invoices', 'sent')).toBe('x_invoices.sent')
  })
})

describe('canonical identity', () => {
  it('is the same for any key order and for spelled-out defaults', () => {
    const a = valid()
    const b = Object.fromEntries(
      Object.entries(valid({ resources: { memoryMb: 256, cpuPercent: 50 } })).reverse(),
    )
    expect(canonicalManifestJson(a)).toBe(canonicalManifestJson(b))
    expect(manifestSha256(a)).toBe(manifestSha256(b))
    expect(manifestSha256(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('YAML and JSON spellings of hello agree', () => {
    const fromYaml = parseModuleManifestYaml(HELLO_YAML)
    expect(manifestSha256(JSON.parse(JSON.stringify(fromYaml)))).toBe(manifestSha256(fromYaml))
  })

  it('changes with any content change, and refuses an invalid manifest', () => {
    expect(manifestSha256(valid({ version: '0.1.1' }))).not.toBe(manifestSha256(valid()))
    expect(() => canonicalManifestJson(valid({ license: 'MIT' }))).toThrow(ModuleManifestError)
  })
})

describe('satisfiesCoreApi (caret only)', () => {
  it.each([
    ['^1.0.0', '1.0.0', true],
    ['^1.0.0', '1.9.3', true],
    ['^1.2.0', '1.1.9', false],
    ['^1.0.0', '2.0.0', false],
    ['^1.2.3', '1.2.2', false],
    ['^0.2.3', '0.2.9', true],
    ['^0.2.3', '0.3.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
  ])('%s with %s → %s', (range, version, ok) => {
    expect(satisfiesCoreApi(range, version)).toBe(ok)
  })

  it('fails loud on a non-caret range or a bad version', () => {
    expect(() => satisfiesCoreApi('>=1.0.0', '1.0.0')).toThrow(/caret/)
    expect(() => satisfiesCoreApi('^1.0.0', '1.0')).toThrow()
  })

  it('this box satisfies hello', () => {
    expect(
      satisfiesCoreApi(parseModuleManifestYaml(HELLO_YAML).requires['core-api'], CORE_API_VERSION),
    ).toBe(true)
  })
})

describe('catalog gaps (the lockfile that cannot lie)', () => {
  const catalog = {
    tools: lock.tools.map((t) => t.name),
    events: Object.keys(CORE_EVENTS),
    slots: [] as string[],
  }

  it('hello needs nothing the core lacks', () => {
    expect(manifestCatalogGaps(parseModuleManifestYaml(HELLO_YAML), catalog)).toEqual([])
  })

  it('names every missing tool, event, slot and capability', () => {
    const m = parseModuleManifest(
      valid({
        uses: {
          tools: ['contacts.get', 'nope.tool'],
          events: ['nope.happened'],
          slots: ['nav.entry'],
        },
        permissions: { capabilities: ['chromium'] },
      }),
    )
    expect(manifestCatalogGaps(m, { ...catalog, capabilities: [] })).toEqual([
      'uses.tools:nope.tool',
      'uses.events:nope.happened',
      'uses.slots:nav.entry',
      'permissions.capabilities:chromium',
    ])
  })
})

describe('CORE_MODULE_IDS stays in step with the core', () => {
  it('lists every module id the core registers or emits as', () => {
    const core = new Set<string>([
      ...moduleManifests.map((m) => m.id),
      CHAT_GATEWAY_MODULE_ID,
      RECAP_MODULE_ID,
      ...Object.values(CORE_EVENTS).map((e) => e.module),
      ...lock.tools.map((t) => t.module),
    ])
    const listed = new Set<string>([...CORE_MODULE_IDS, ...RESERVED_MODULE_IDS])
    expect([...core].filter((id) => !listed.has(id))).toEqual([])
  })
})
