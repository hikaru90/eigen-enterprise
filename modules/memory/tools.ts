import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import {
  ASSISTANT_NEVER_SHARES,
  assistantCaptureThought,
  assistantCreateTextFile,
  assistantUpdateTextFile,
  liveMemoryWriterOf,
  requireWriter,
  type MemoryWriter,
} from './assistant-writes'
import { MEMORY_TOOL_NAMES } from './manifest'
import { createOwnTaskTools, type OwnTaskToolDeps } from './own-task-tools'
import { createProjectScheduleTools, type ProjectScheduleToolDeps } from './project-schedule-tools'
import { createReminderTools, type ReminderToolDeps } from './reminder-tools'
import { createTaskTools, type TaskToolDeps } from './task-tools'
import { createThoughtTools, type ThoughtToolDeps } from './thought-tools'

/**
 * Kernel tool descriptors wrapping the existing MCP memory tool
 * implementations (src/lib/server/mcp/tools.ts). Handlers map the kernel
 * ToolContext to the McpToolContext the underlying functions expect:
 * the principal id is the user id. The heavy import is deferred to call time
 * so that bootstrapping the kernel never touches the DB or retrieval stack.
 * When the company brain acts for a person the principal IS that person
 * (CB3): reads see what that person may see under row-level security — their
 * own Memory plus the projects (with their tasks) and notes colleagues share
 * with everyone (plan/shared-memory-voice-agent-tools.md §1), never anyone's
 * private items or thoughts — and writes land with them, marked as coming
 * through the brain (see assistant-writes.ts). Colleagues' items are
 * read-only: a write to one fails loud (permission_denied). Every member
 * reaches these tools (role 'member').
 */

export type MemoryToolDeps = {
  /** Who a write lands with (live: liveMemoryWriterOf). */
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
  /** The tasks.* tools (task-tools.ts); they share writerOf unless given their own. */
  tasks?: TaskToolDeps
  /** The person's own Memory › Tasks tools (own-task-tools.ts); they share writerOf unless given their own. */
  ownTasks?: OwnTaskToolDeps
  /** The reminders.* tools (reminder-tools.ts); they share writerOf unless given their own. */
  reminders?: ReminderToolDeps
  /** Thoughts / entities / graph / connected-agent tools (thought-tools.ts). */
  thoughts?: ThoughtToolDeps
  /** Projects, scheduled tasks, timeline items (project-schedule-tools.ts); they share writerOf unless given their own. */
  projectSchedule?: ProjectScheduleToolDeps
}

/** Every member's own Memory: members, admins, and agent principals that are a person (MCP keys). */
export const MEMORY_TOOL_ROLES = ['admin', 'member', 'agent']

const WRITE_TOOLS = new Set<string>([
  'memory.capture_thought',
  'memory.create_text_file',
  'memory.update_text_file',
  'memory.set_project_visibility',
  'memory.set_text_file_visibility',
])

/** Visibility changes: the assistant may make things private for the person, never share them. */
const VISIBILITY_TOOLS = new Set<string>(['memory.set_project_visibility', 'memory.set_text_file_visibility'])

const optionalScope = z
  .enum(['mine', 'team', 'all'])
  .optional()
  .describe('mine = the person’s own, team = what colleagues share, all (default) = both.')

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
    case 'memory.create_text_file':
      return tools.runCreateTextFileTool(mcpCtx, input)
    case 'memory.update_text_file':
      return tools.runUpdateTextFileTool(mcpCtx, input)
    case 'memory.set_project_visibility':
      return tools.runSetProjectVisibilityTool(mcpCtx, input)
    case 'memory.set_text_file_visibility':
      return tools.runSetTextFileVisibilityTool(mcpCtx, input)
  }
  throw new Error(`no memory tool implementation wired for ${name}`)
}

async function runAssistantWrite(
  name: (typeof MEMORY_TOOL_NAMES)[number],
  userId: string,
  input: unknown,
): Promise<unknown> {
  switch (name) {
    case 'memory.capture_thought':
      return assistantCaptureThought(userId, input as Parameters<typeof assistantCaptureThought>[1])
    case 'memory.create_text_file':
      return assistantCreateTextFile(userId, input as Parameters<typeof assistantCreateTextFile>[1])
    case 'memory.update_text_file':
      return assistantUpdateTextFile(userId, input as Parameters<typeof assistantUpdateTextFile>[1])
  }
  throw new Error(`${name} is not a memory write`)
}

/** Kernel descriptors for the read-oriented memory surface plus capture and notes, the person's own tasks, the tasks.* and the reminders.* tools. */
export function createMemoryTools(opts: MemoryToolDeps = {}): ToolDescriptor[] {
  const writerOf = opts.writerOf ?? liveMemoryWriterOf

  async function handle(
    name: (typeof MEMORY_TOOL_NAMES)[number],
    ctx: ToolContext,
    input: unknown,
  ): Promise<unknown> {
    try {
      if (!WRITE_TOOLS.has(name)) return await runMemoryTool(name, ctx, input)
      const writer = requireWriter(await writerOf(ctx))
      if (writer.kind === 'self') {
        return await runMemoryTool(name, { principal: { id: writer.userId } }, input)
      }
      if (VISIBILITY_TOOLS.has(name)) {
        if ((input as { private?: unknown }).private !== true) {
          throw new KernelError('permission_denied', ASSISTANT_NEVER_SHARES)
        }
        return await runMemoryTool(name, { principal: { id: writer.userId } }, input)
      }
      return await runAssistantWrite(name, writer.userId, input)
    } catch (err) {
      // A colleague's shared project or note is read-only: say so as a permission error.
      const { isMemoryReadOnlyError } = await import('$lib/server/memory/memory-read-only')
      if (isMemoryReadOnlyError(err)) throw new KernelError('permission_denied', err.message)
      throw err
    }
  }

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
    permission: { roles: MEMORY_TOOL_ROLES },
    handler: (ctx, input) => handle(name, ctx, input),
  })

  return [
    tool(
      'memory.capture_thought',
      'Save a thought, task, idea or reminder to Memory (background enrichment: category, embedding, entities, graph links). Working for a person, it lands in their Memory as theirs; returns the thought id, not its text.',
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
      'List GTD projects with ordered task waterfalls, milestones, deadlines, and next actions: the person’s own and the ones colleagues share with everyone (each with its owner; a colleague’s project is read-only).',
      'read',
      z.object({
        author: z.enum(['user', 'all']).optional(),
        include_agent: z.boolean().optional(),
        scope: optionalScope,
      }),
    ),
    tool(
      'memory.get_project_timeline',
      'Get one project timeline (the person’s own or a colleague’s shared project): ordered task waterfall, milestones, target deadline, next action, owner.',
      'read',
      z.object({ project_entity_id: z.string().min(1) }),
    ),
    tool(
      'memory.list_text_files',
      'List notes (newest updated first), optionally paginated: the person’s own and the ones colleagues share with everyone (each with its owner; a colleague’s note is read-only).',
      'read',
      z.object({
        limit: optionalPositiveInt,
        cursor_updated_at: z.string().optional(),
        cursor_id: z.string().optional(),
        scope: optionalScope,
      }),
    ),
    tool(
      'memory.create_text_file',
      'Write a note (title and/or body text) into Memory › Notes. It is shared with everyone in the company unless private is true. Working for a person, it lands in their Notes marked as written by the assistant; returns the note id and title.',
      'mutate',
      z.object({
        title: z.string().optional(),
        body: z.string().optional(),
        private: z.boolean().optional().describe('true = only the person can read it; default false = shared with everyone.'),
        as_user: z.boolean().optional(),
        author: z.string().optional(),
      }),
      () => 'Wrote a note',
    ),
    tool(
      'memory.set_project_visibility',
      'Make one of the person’s projects private (only they see it and its tasks — no admin or owner override) or share it with everyone in the company (the default). Only the project’s owner; the Roadmap is always shared. Working for a person, the assistant may only make things private.',
      'mutate',
      z.object({
        project_entity_id: z.string().min(1),
        private: z.boolean(),
      }),
      (input) => ((input as { private?: boolean }).private ? 'Made a project private' : 'Shared a project with the company'),
    ),
    tool(
      'memory.set_text_file_visibility',
      'Make one of the person’s notes private (only they can read it — no admin or owner override) or share it with everyone in the company (the default). Only the note’s owner. Working for a person, the assistant may only make things private.',
      'mutate',
      z.object({
        text_file_id: z.string().min(1),
        private: z.boolean(),
      }),
      (input) => ((input as { private?: boolean }).private ? 'Made a note private' : 'Shared a note with the company'),
    ),
    tool(
      'memory.update_text_file',
      'Change the title and/or body of a note (body replaces the whole text). Working for a person, only notes the assistant wrote can be changed.',
      'mutate',
      z.object({
        text_file_id: z.string().min(1),
        title: z.string().optional(),
        body: z.string().optional(),
      }),
      () => 'Changed a note',
    ),
    tool(
      'memory.get_text_file',
      'Get one note by ID: the person’s own or a colleague’s shared note (with its owner; read-only).',
      'read',
      z.object({ text_file_id: z.string().min(1) }),
    ),
    tool(
      'memory.search_text_files',
      'Lexical keyword search over notes the person may read — their own and colleagues’ shared ones (no embeddings — use memory.retrieve_thoughts for hybrid search).',
      'read',
      z.object({
        query: z.string().min(1),
        top_k: optionalPositiveInt,
        author: optionalAuthorScope,
        include_agent: z.boolean().optional(),
        scope: optionalScope,
      }),
    ),
    ...createOwnTaskTools({ writerOf: opts.writerOf, ...opts.ownTasks }),
    ...createThoughtTools({ writerOf: opts.writerOf, ...opts.thoughts }),
    ...createTaskTools({ writerOf: opts.writerOf, ...opts.tasks }),
    ...createReminderTools({ writerOf: opts.writerOf, ...opts.reminders }),
    ...createProjectScheduleTools({ writerOf: opts.writerOf, ...opts.projectSchedule }),
  ]
}
