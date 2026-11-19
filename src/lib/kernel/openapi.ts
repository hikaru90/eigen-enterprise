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
