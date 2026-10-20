import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { MEMORY_TOOL_NAMES } from './manifest'

/**
 * Kernel tool descriptors wrapping the existing MCP memory tool
 * implementations (src/lib/server/mcp/tools.ts). Handlers map the kernel
 * ToolContext to the McpToolContext the underlying functions expect:
 * the principal id is the user id. The heavy import is deferred to call time
 * so that bootstrapping the kernel never touches the DB or retrieval stack.
 */

const optionalPositiveInt = z.number().int().positive().optional()
const optionalAuthorScope = z.enum(['user', 'agent', 'all']).optional()

async function runMemoryTool(
  name: (typeof MEMORY_TOOL_NAMES)[number],
  ctx: { principal: { id: string } },
  input: unknown,
): Promise<unknown> {
  const mcpCtx = { userId: ctx.principal.id }
  const tools = await import('$lib/server/mcp/tools')
  switch (name) {
    case 'memory.capture_thought':
      return tools.runCaptureThoughtTool(mcpCtx, input)
    case 'memory.retrieve_thoughts':
      return tools.runRetrieveThoughtsTool(mcpCtx, input)
    case 'memory.list_projects':
      return tools.runListProjectsTool(mcpCtx, input)
    case 'memory.get_project_timeline':
      return tools.runGetProjectTimelineTool(mcpCtx, input)
    case 'memory.list_text_files':
      return tools.runListTextFilesTool(mcpCtx, input)
    case 'memory.get_text_file':
      return tools.runGetTextFileTool(mcpCtx, input)
    case 'memory.search_text_files':
      return tools.runSearchTextFilesTool(mcpCtx, input)
  }
  throw new Error(`no memory tool implementation wired for ${name}`)
}

/** Kernel descriptors for the read-oriented memory surface plus capture. */
export function createMemoryTools(): ToolDescriptor[] {
  const tool = (
    name: (typeof MEMORY_TOOL_NAMES)[number],
    summary: string,
    auditClass: ToolDescriptor['auditClass'],
    inputSchema: ToolDescriptor['inputSchema'],
    activity?: ToolDescriptor['activity'],
  ): ToolDescriptor => ({
    name,
    module: 'memory',
    summary,
    auditClass,
    inputSchema,
    ...(activity === undefined ? {} : { activity }),
    permission: { roles: ['admin', 'agent'] },
    handler: (ctx, input) => runMemoryTool(name, ctx, input),
  })

  return [
    tool(
      'memory.capture_thought',
      'Capture and store a raw thought (background enrichment: embedding, entities, graph links).',
      'mutate',
      z.object({
        raw: z.string().min(1),
        captured_at: z.string().optional(),
        as_user: z.boolean().optional(),
        author: z.string().optional(),
      }),
      // The thought itself stays out of the audit line.
      () => 'Saved a thought',
    ),
    tool(
      'memory.retrieve_thoughts',
      'Read stored thoughts: recent browse (order=created_at) or hybrid semantic/lexical/graph search.',
      'read',
      z.object({
        query: z.string().optional(),
        order: z.enum(['created_at', 'relevance']).optional(),
        top_k: optionalPositiveInt,
        threshold: z.number().min(0).max(1).optional(),
        mode: z.enum(['fast', 'full']).optional(),
        detail: z.enum(['snippet', 'full']).optional(),
        author: optionalAuthorScope,
        include_agent: z.boolean().optional(),
        cursor_created_at: z.string().optional(),
        cursor_id: z.string().optional(),
      }),
    ),
    tool(
      'memory.list_projects',
      'List GTD projects with ordered task waterfalls, milestones, deadlines, and next actions.',
      'read',
      z.object({
        author: z.enum(['user', 'all']).optional(),
        include_agent: z.boolean().optional(),
      }),
    ),
    tool(
      'memory.get_project_timeline',
      'Get one project timeline: ordered task waterfall, milestones, target deadline, and next action.',
      'read',
      z.object({ project_entity_id: z.string().min(1) }),
    ),
    tool(
      'memory.list_text_files',
      'List user text notes (newest updated first), optionally paginated.',
      'read',
      z.object({
        limit: optionalPositiveInt,
        cursor_updated_at: z.string().optional(),
        cursor_id: z.string().optional(),
      }),
    ),
    tool(
      'memory.get_text_file',
      'Get one user text note by ID.',
      'read',
      z.object({ text_file_id: z.string().min(1) }),
    ),
    tool(
      'memory.search_text_files',
      'Lexical keyword search over user text notes (no embeddings — use memory.retrieve_thoughts for hybrid search).',
      'read',
      z.object({
        query: z.string().min(1),
        top_k: optionalPositiveInt,
        author: optionalAuthorScope,
        include_agent: z.boolean().optional(),
      }),
    ),
  ]
}
