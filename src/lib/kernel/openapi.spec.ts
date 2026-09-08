import type { ToolDescriptor } from './types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { generateOpenApi, toolInputJsonSchema, toolOutputJsonSchema } from './openapi'
import { KernelRegistry } from './registry'

function makeTool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: 'memory.echo',
    module: 'memory',
    summary: 'echoes its input',
    inputSchema: z.object({ value: z.string(), count: z.number().optional() }),
    permission: { roles: ['admin'] },
    auditClass: 'read',
    handler: async (_ctx, input) => ({ echoed: input }),
    ...overrides,
  }
}

function makeFixtureRegistry() {
  const registry = new KernelRegistry()
  registry.register(makeTool())
  registry.register(
    makeTool({
      name: 'email.send_mail',
      module: 'email',
      summary: 'sends one transactional email',
      inputSchema: z.object({ to: z.string(), subject: z.string() }),
      auditClass: 'external',
    }),
  )
  return registry
}

describe('toolInputJsonSchema', () => {
  it('converts zod to JSON Schema with required fields', () => {
    const schema = toolInputJsonSchema(z.object({ value: z.string(), count: z.number().optional() }))
    expect(schema).toMatchObject({ type: 'object', required: ['value'] })
    expect(schema.properties).toMatchObject({ value: { type: 'string' } })
  })
})

describe('toolOutputJsonSchema', () => {
  it('compiles a zod output schema with io: output', () => {
    const schema = toolOutputJsonSchema(z.object({ echoed: z.string(), sent: z.boolean() }))
    expect(schema).toMatchObject({ type: 'object', required: ['echoed', 'sent'] })
    expect(schema.properties).toMatchObject({ echoed: { type: 'string' }, sent: { type: 'boolean' } })
  })
})

describe('generateOpenApi 200 response schemas', () => {
  it('advertises the compiled output schema when the descriptor has one', () => {
    const registry = new KernelRegistry()
    registry.register(makeTool({ outputSchema: z.object({ echoed: z.object({ value: z.string() }) }) }))
    const doc = generateOpenApi(registry, { title: 't', version: 'v' })

    const schema =
      doc.paths['/api/kernel/tools/memory.echo'].post.responses['200'].content?.['application/json']
        .schema
    expect(schema).toMatchObject({ type: 'object', required: ['echoed'] })
    expect(schema?.properties).toMatchObject({ echoed: { type: 'object' } })
  })

  it('keeps an empty schema for tools without outputSchema', () => {
    const doc = generateOpenApi(makeFixtureRegistry(), { title: 't', version: 'v' })
    const schema =
      doc.paths['/api/kernel/tools/memory.echo'].post.responses['200'].content?.['application/json']
        .schema
    expect(schema).toEqual({})
  })
})

describe('generateOpenApi', () => {
  it('produces a 3.1 document with bearerAuth and per-tool POST paths', () => {
    const doc = generateOpenApi(makeFixtureRegistry(), {
      title: 'eigenEnterprise kernel',
      version: '0.3.0',
      description: 'Kernel tool surface',
      serverUrl: 'https://app.example.com',
    })

    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({
      title: 'eigenEnterprise kernel',
      version: '0.3.0',
      description: 'Kernel tool surface',
    })
    expect(doc.servers).toEqual([{ url: 'https://app.example.com' }])
    expect(doc.security).toEqual([{ bearerAuth: [] }])
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' })
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/kernel/tools/email.send_mail',
      '/api/kernel/tools/memory.echo',
    ])
  })

  it('tags paths by module and summarizes from the descriptor', () => {
    const doc = generateOpenApi(makeFixtureRegistry(), { title: 't', version: 'v' })
    const op = doc.paths['/api/kernel/tools/memory.echo'].post
    expect(op.tags).toEqual(['memory'])
    expect(op.summary).toBe('echoes its input')
    expect(op.operationId).toBe('memory_echo')
    expect(doc.tags).toEqual([{ name: 'email' }, { name: 'memory' }])
  })

  it('emits a required JSON body whose schema types match the zod input schema', () => {
    const doc = generateOpenApi(makeFixtureRegistry(), { title: 't', version: 'v' })

    const echo = doc.paths['/api/kernel/tools/memory.echo'].post
    expect(echo.requestBody?.required).toBe(true)
    const echoSchema = echo.requestBody?.content['application/json'].schema
    expect(echoSchema).toMatchObject({ type: 'object', required: ['value'] })
    expect(echoSchema?.properties).toMatchObject({
      value: { type: 'string' },
      count: { type: 'number' },
    })

    const send = doc.paths['/api/kernel/tools/email.send_mail'].post
    expect(send.requestBody?.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['to', 'subject'],
    })
  })

  it('describes error responses per audit-relevant failure modes', () => {
    const doc = generateOpenApi(makeFixtureRegistry(), { title: 't', version: 'v' })
    const responses = doc.paths['/api/kernel/tools/email.send_mail'].post.responses
    expect(Object.keys(responses).sort()).toEqual(['200', '400', '401', '403'])
    expect(responses['200'].content?.['application/json']).toBeDefined()
  })

  it('renders an empty document for an empty registry', () => {
    const doc = generateOpenApi(new KernelRegistry(), { title: 't', version: 'v' })
    expect(doc.paths).toEqual({})
    expect(doc.tags).toEqual([])
  })
})
