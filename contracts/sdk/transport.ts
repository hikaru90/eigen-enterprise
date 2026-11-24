/**
 * The wire under the generated core-api SDK (`./core-api.ts`): one tool call
 * over the core's MCP endpoint (`POST /api/mcp`, streamable HTTP, JSON-RPC
 * `tools/call`), authenticated with an API key — the same surface every MCP
 * client and agent uses. Not generated; the SDK's types are.
 */

export type CoreApiTransport = {
  callTool(name: string, input: unknown): Promise<unknown>
}

/** A call the core refused or failed: the JSON-RPC error, or the tool's own error result. */
export class CoreApiCallError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly code: number | null,
  ) {
    super(message)
    this.name = 'CoreApiCallError'
  }
}

export type McpHttpTransportOptions = {
  /** The box's origin, e.g. https://os.example.com (no trailing path). */
  baseUrl: string
  /** An API key with MCP access (Settings → API keys). */
  apiKey: string
  /** Injected fetch (tests, other runtimes); the global fetch otherwise. */
  fetch?: typeof fetch
}

type JsonRpcResponse = {
  result?: {
    isError?: boolean
    structuredContent?: unknown
    content?: Array<{ type: string; text?: string }>
  }
  error?: { code?: number; message?: string }
}

let nextId = 1

export function mcpHttpTransport(options: McpHttpTransportOptions): CoreApiTransport {
  if (options.baseUrl.trim() === '') throw new Error('mcpHttpTransport: baseUrl is required')
  if (options.apiKey.trim() === '') throw new Error('mcpHttpTransport: apiKey is required')
  const endpoint = new URL('/api/mcp', options.baseUrl).toString()
  const doFetch = options.fetch ?? fetch
  return {
    async callTool(name, input) {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          // The streamable HTTP transport wants both accept types.
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'tools/call',
          params: { name, arguments: input },
        }),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new CoreApiCallError(
          name,
          `${name}: HTTP ${response.status}: ${text}`,
          response.status,
        )
      }
      const body = JSON.parse(text) as JsonRpcResponse
      if (body.error) {
        throw new CoreApiCallError(
          name,
          `${name}: ${body.error.message ?? 'error'}`,
          body.error.code ?? null,
        )
      }
      const result = body.result
      if (!result)
        throw new CoreApiCallError(name, `${name}: the response carries no result: ${text}`, null)
      const first = result.content?.find((part) => part.type === 'text')?.text
      if (result.isError)
        throw new CoreApiCallError(name, `${name}: ${first ?? 'tool error'}`, null)
      if (result.structuredContent !== undefined) return result.structuredContent
      if (first === undefined)
        throw new CoreApiCallError(name, `${name}: the result carries no content: ${text}`, null)
      return JSON.parse(first) as unknown
    },
  }
}
