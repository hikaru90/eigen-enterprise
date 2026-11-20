import type { KernelRegistry } from './registry'
import { toJSONSchema, type ZodType } from 'zod'

type JsonSchema = Record<string, unknown>

/**
 * JSON Schema (draft 2020-12 via zod v4) for a tool's input — shared by MCP
 * listing, OpenAPI, the CLI and the agent runtime's LLM tool listings.
 *
 * Every consumer requires one top-level `type: "object"` schema: MCP rejects
 * the whole tools/list otherwise, and LLM tool APIs also refuse top-level
 * oneOf/anyOf/allOf. zod emits a bare `{oneOf}` / `{anyOf}` for a (discriminated)
 * union of objects, so such a union is advertised as ONE object schema (see
 * unionAsObjectSchema). This is the advertised shape only: calls are still
 * validated against the original zod schema by the registry.
 */
export function toolInputJsonSchema(schema: ZodType): JsonSchema {
  const json = toJSONSchema(schema, { io: 'input' }) as JsonSchema
  if (json.type === 'object' && !hasCombinator(json)) return json
  const branches = unionBranches(json)
  if (branches === null) {
    throw new Error(
      `tool input schema must be an object or a union of objects; got ${JSON.stringify(json)}`,
    )
  }
  return unionAsObjectSchema(json, branches)
}

const COMBINATORS = ['oneOf', 'anyOf', 'allOf'] as const

function hasCombinator(schema: JsonSchema): boolean {
  return COMBINATORS.some((key) => key in schema)
}

/** The object branches of a (nested) oneOf/anyOf union, or null when it is not a union of plain objects. */
function unionBranches(schema: JsonSchema): JsonSchema[] | null {
  const members = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined
  if (!Array.isArray(members) || 'allOf' in schema || ('oneOf' in schema && 'anyOf' in schema)) {
    return null
  }
  const out: JsonSchema[] = []
  for (const member of members) {
    if (member.type === 'object' && !hasCombinator(member)) {
      out.push(member)
      continue
    }
    if ('type' in member) return null
    const nested = unionBranches(member)
    if (nested === null) return null
    out.push(...nested)
  }
  return out
}

/**
 * One object schema describing a union of object shapes:
 * - properties: every property of any shape; a property whose shapes differ
 *   becomes `{type, enum}` when all are same-typed constants (a discriminator),
 *   else `{anyOf: [...distinct shapes]}` (combinators are fine below the top);
 * - required: the properties every shape requires;
 * - additionalProperties: false only when every shape forbids extras;
 * - description: the exact shapes, so per-shape requirements stay visible.
 */
function unionAsObjectSchema(root: JsonSchema, branches: JsonSchema[]): JsonSchema {
  const variants = new Map<string, JsonSchema[]>()
  for (const branch of branches) {
    const properties = (branch.properties ?? {}) as Record<string, JsonSchema>
    for (const [key, property] of Object.entries(properties)) {
      const seen = variants.get(key) ?? []
      if (!seen.some((s) => JSON.stringify(s) === JSON.stringify(property))) seen.push(property)
      variants.set(key, seen)
    }
  }

  const properties: Record<string, JsonSchema> = {}
  for (const [key, seen] of variants) properties[key] = mergeVariants(seen)

  const requiredBy = (branch: JsonSchema) => new Set((branch.required ?? []) as string[])
  const required = [...variants.keys()].filter((key) => branches.every((b) => requiredBy(b).has(key)))

  const shapes = branches.map((branch) => shapeSummary(branch)).join(' | ')
  const description = [root.description, `Exactly one of these shapes: ${shapes}`]
    .filter((part) => typeof part === 'string')
    .join(' ')

  const rest = Object.fromEntries(
    Object.entries(root).filter(([key]) => !(COMBINATORS as readonly string[]).includes(key)),
  )
  return {
    ...rest,
    type: 'object',
    properties,
    required,
    ...(branches.every((b) => b.additionalProperties === false) ? { additionalProperties: false } : {}),
    description,
  }
}

function mergeVariants(seen: JsonSchema[]): JsonSchema {
  if (seen.length === 1) return seen[0]
  const constants = seen.every(
    (s) => 'const' in s && Object.keys(s).every((key) => key === 'const' || key === 'type'),
  )
  if (constants && new Set(seen.map((s) => s.type)).size === 1) {
    return {
      ...(seen[0].type === undefined ? {} : { type: seen[0].type }),
      enum: seen.map((s) => s.const),
    }
  }
  return { anyOf: seen }
}

/** `{setting: "company_name", provider, value?}` — constants inline, optional keys marked. */
function shapeSummary(branch: JsonSchema): string {
  const properties = (branch.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set((branch.required ?? []) as string[])
  const keys = Object.entries(properties).map(([key, property]) => {
    if ('const' in property) return `${key}: ${JSON.stringify(property.const)}`
    return required.has(key) ? key : `${key}?`
  })
  return `{${keys.join(', ')}}`
}

/** JSON Schema (draft 2020-12 via zod v4) for a tool's output — advertised on the OpenAPI 200 response. */
export function toolOutputJsonSchema(schema: ZodType): Record<string, unknown> {
  return toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>
}

/**
 * Projection of an advertised tool schema onto the strict function subset
 * every MCP client accepts (MCP plus the OpenAPI/Gemini function subset).
 * One schema outside it is enough for a strict client to reject the whole
 * tools/list — Cloud Code did (2026-11-20): the zod-emitted `$schema` root
 * key, `"type": ["string", "null"]` unions, nested combinators from nullable
 * unions, records (`propertyNames` + `additionalProperties`), `const`,
 * `default`, `pattern`, `minLength`/`maxLength` and non-date `format`s.
 *
 * Advertising only — calls are still validated against the original zod
 * schema by the registry. The agent runtime and the OpenAPI document keep
 * the full schemas; only the MCP listing (and the CLI listing mirroring it)
 * projects.
 */
export function strictToolSchema(schema: JsonSchema): JsonSchema {
  return projectSubsetNode(schema)
}

const SUBSET_FORMATS = new Set(['date-time', 'date', 'time'])
const UNION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const

function isSchemaNode(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectSubsetNode(node: JsonSchema): JsonSchema {
  const unionKey = UNION_KEYS.find((key) => key in node)
  if (unionKey !== undefined) return projectSubsetUnion(node, unionKey)

  const out: JsonSchema = {}
  if (Array.isArray(node.type)) {
    const types = node.type.filter((type): type is string => typeof type === 'string')
    const scalar = types.find((type) => type !== 'null')
    if (scalar !== undefined) out.type = scalar
    if (types.includes('null')) out.nullable = true
  } else if (node.type !== undefined) {
    out.type = node.type
  }
  if ('const' in node) out.enum = [node.const]
  for (const key of [
    'title',
    'description',
    'enum',
    'nullable',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
  ] as const) {
    if (key in node) out[key] = node[key]
  }
  if (typeof node.format === 'string' && SUBSET_FORMATS.has(node.format)) out.format = node.format
  if ('items' in node) {
    if (!isSchemaNode(node.items)) {
      throw new Error(`array items must be a single schema; got ${JSON.stringify(node.items)}`)
    }
    out.items = projectSubsetNode(node.items)
  }
  if ('properties' in node && isSchemaNode(node.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, property]) => [
        key,
        projectSubsetNode(property as JsonSchema),
      ]),
    )
  }
  if ('required' in node) out.required = node.required
  return out
}

/**
 * One subset schema for a combinator node: same-typed branches merge (their
 * enums concatenate), a null branch becomes `nullable: true`, and anything
 * else collapses to an untyped schema whose description lists the projected
 * shapes — the honest shape when no single type is true.
 */
function projectSubsetUnion(root: JsonSchema, unionKey: (typeof UNION_KEYS)[number]): JsonSchema {
  const members = root[unionKey]
  if (!Array.isArray(members) || members.some((member) => !isSchemaNode(member))) {
    throw new Error(`combinator members must be schemas; got ${JSON.stringify(members)}`)
  }
  const projected = members.map((member) => projectSubsetNode(member))
  const nonNull = projected.filter((member) => member.type !== 'null')
  const nullable =
    nonNull.length !== projected.length || projected.some((member) => member.nullable === true)
  const rootDescription = typeof root.description === 'string' ? root.description : undefined

  if (nonNull.length === 0) {
    return { type: 'null', description: unionDescription(rootDescription, unionKey, projected) }
  }
  // A merge into one typed schema keeps every constraint the subset can
  // express; only a mixed collapse loses shapes, so only it advertises them.
  if (unionKey === 'allOf' || new Set(nonNull.map((member) => member.type)).size > 1) {
    return {
      ...(nullable ? { nullable: true } : {}),
      description: unionDescription(rootDescription, unionKey, projected),
    }
  }

  const out: JsonSchema = { type: nonNull[0].type }
  if (nonNull.every((member) => Array.isArray(member.enum))) {
    out.enum = [...new Set(nonNull.flatMap((member) => member.enum as unknown[]))]
  }
  const minimums = nonNull.map((member) => member.minimum).filter((v) => v !== undefined)
  if (minimums.length === nonNull.length) out.minimum = Math.max(...(minimums as number[]))
  const maximums = nonNull.map((member) => member.maximum).filter((v) => v !== undefined)
  if (maximums.length === nonNull.length) out.maximum = Math.min(...(maximums as number[]))
  if (nullable) out.nullable = true
  if (rootDescription !== undefined) out.description = rootDescription
  return out
}

function unionDescription(
  rootDescription: string | undefined,
  unionKey: (typeof UNION_KEYS)[number],
  projected: JsonSchema[],
): string {
  const lead = unionKey === 'allOf' ? 'All of' : 'One of'
  const shapes = projected.map((member) => JSON.stringify(member)).join(' | ')
  return [rootDescription, `${lead}: ${shapes}`]
    .filter((part): part is string => part !== undefined)
    .join(' ')
}

export type OpenApiSchema = Record<string, unknown>

const PROBLEM_SCHEMA: OpenApiSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
  },
  required: ['type', 'title', 'status', 'detail'],
  additionalProperties: false,
}

const PROBLEM_JSON_CONTENT = {
  'application/problem+json': { schema: { $ref: '#/components/schemas/problem' } },
}

export type OpenApiOperation = {
  operationId: string
  summary: string
  description?: string
  tags: string[]
  requestBody?: {
    required: true
    content: Record<'application/json', { schema: OpenApiSchema }>
  }
  responses: Record<string, { description: string; content?: Record<string, { schema: OpenApiSchema }> }>
}

export type OpenApiDocument = {
  openapi: '3.1.0'
  info: { title: string; version: string; description?: string }
  servers?: Array<{ url: string }>
  tags: Array<{ name: string }>
  components: {
    securitySchemes: Record<string, { type: 'http'; scheme: 'bearer' }>
    schemas: { problem: OpenApiSchema }
  }
  security: Array<Record<string, string[]>>
  paths: Record<string, { post: OpenApiOperation }>
}

export type GenerateOpenApiOptions = {
  title: string
  version: string
  description?: string
  /** Base URL for the `servers` block, e.g. https://app.example.com */
  serverUrl?: string
}

/**
 * OpenAPI 3.1 document for a kernel registry: one POST path per registered
 * tool (`/api/kernel/tools/{name}`), tagged by owning module, with a shared
 * bearerAuth security scheme. Documents the full registered surface —
 * activation gating is enforced at the HTTP layer, not in the document.
 */
export function generateOpenApi(
  registry: KernelRegistry,
  options: GenerateOpenApiOptions,
): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {}
  const tags = new Set<string>()

  for (const tool of registry.list()) {
    tags.add(tool.module)
    paths[`/api/kernel/tools/${tool.name}`] = {
      post: {
        operationId: tool.name.replaceAll('.', '_'),
        summary: tool.summary,
        description: `Owned by module "${tool.module}" (audit class: ${tool.auditClass}).`,
        tags: [tool.module],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: toolInputJsonSchema(tool.inputSchema) } },
        },
        responses: {
          '200': {
            description: 'Tool executed; returns the handler result as JSON.',
            content: {
              'application/json': {
                schema: tool.outputSchema === undefined ? {} : toolOutputJsonSchema(tool.outputSchema),
              },
            },
          },
          '400': {
            description: 'Invalid input (invalid_input) or handler failure.',
            content: PROBLEM_JSON_CONTENT,
          },
          '401': {
            description: 'Missing or invalid bearer credentials.',
            content: PROBLEM_JSON_CONTENT,
          },
          '403': {
            description: 'Permission denied, module inactive, or approval required.',
            content: PROBLEM_JSON_CONTENT,
          },
        },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      ...(options.description === undefined ? {} : { description: options.description }),
    },
    ...(options.serverUrl === undefined ? {} : { servers: [{ url: options.serverUrl }] }),
    tags: [...tags].sort().map((name) => ({ name })),
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: { problem: PROBLEM_SCHEMA },
    },
    security: [{ bearerAuth: [] }],
    paths,
  }
}
