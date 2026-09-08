import type { KernelRegistry } from './registry'
import { toJSONSchema, type ZodType } from 'zod'

/** JSON Schema (draft 2020-12 via zod v4) for a tool's input — shared by MCP listing + OpenAPI. */
export function toolInputJsonSchema(schema: ZodType): Record<string, unknown> {
  return toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
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
