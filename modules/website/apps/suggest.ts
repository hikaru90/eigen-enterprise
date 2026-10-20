import { z } from 'zod'
import type { Catalog, EeClient, SourceFile, SourceTree } from '$lib/server/ee/client'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { AppUserError, commandProblem } from './contract'

/**
 * "Let AI fill this out" for the build form: the model reads the repo's
 * README and manifests (through ee's mirror, the only place private repos are
 * readable) and proposes runtime, commands, health path and folder to serve.
 *
 * Which files it sees is a fixed, declared list of well-known names — that
 * chooses inputs, it decides nothing. Every judgment (runtime, commands, kind)
 * is the model's, through the gateway with cost tracking, as JSON validated
 * by zod against the catalog. A runtime the catalog lacks is reported as a
 * catalog gap (D16), never swapped for one it has.
 */

/** Root-level files shown to the model, in this order. README* matches any extension. */
export const SUGGEST_FILE_NAMES = [
  'README',
  'package.json',
  'Procfile',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'svelte.config.js',
  'svelte.config.ts',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'astro.config.mjs',
  'astro.config.ts',
  'nuxt.config.ts',
  'remix.config.js',
  'angular.json',
  'tsconfig.json',
  'app.json',
  'static.json',
  'index.html',
  'Dockerfile',
] as const

/** Lockfiles: their presence (in the tree) says which installer to use; their content is noise. */
export const PRESENCE_ONLY_FILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'Cargo.lock',
] as const

/** ee's per-file cap (ee/src/sources.ts FILE_MAX_BYTES). */
const FILE_MAX_BYTES = 64 * 1024
/** Total file content in one prompt. */
export const SUGGEST_TOTAL_BYTES = 48 * 1024
const TREE_DEPTH = 2
const TREE_MAX_LINES = 300

function rank(path: string): number {
  if (path.includes('/')) return -1
  if (/^readme(\.[a-z0-9]+)?$/i.test(path)) return 0
  return SUGGEST_FILE_NAMES.indexOf(path as (typeof SUGGEST_FILE_NAMES)[number])
}

export function selectInputFiles(entries: SourceTree['entries']): string[] {
  return entries
    .filter((e) => e.type === 'blob' && e.size !== null && e.size <= FILE_MAX_BYTES)
    .map((e) => ({ path: e.path, r: rank(e.path) }))
    .filter((e) => e.r >= 0)
    .sort((a, b) => a.r - b.r || a.path.localeCompare(b.path))
    .map((e) => e.path)
}

/** The ids the model may choose: node@<major> per catalog version, and static. */
export function catalogRuntimeIds(catalog: Catalog): string[] {
  return [...catalog.runtimes.node.map((v) => `node@${v}`), 'static']
}

const answerSchema = z
  .object({
    runtime: z.string().min(1).max(60),
    install: z.string().max(400).nullable().optional(),
    build: z.string().max(400).nullable().optional(),
    start: z.string().max(400).nullable().optional(),
    portEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .nullable()
      .optional(),
    healthPath: z.string().startsWith('/').max(200),
    staticDir: z
      .string()
      .regex(/^[a-zA-Z0-9._/-]+$/)
      .nullable()
      .optional(),
    kind: z.enum(['web', 'service']),
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string().max(300)).max(8),
    warnings: z.array(z.string().max(300)).max(8),
  })
  .strict()

const ANSWER_SHAPE = {
  runtime: 'one of the allowed runtime ids, or the id of what the repo really needs if none fits',
  install: 'string | null — one command, e.g. "npm ci"',
  build: 'string | null — one command, e.g. "npm run build"',
  start: 'string | null — node only: one command, e.g. "node server.js"',
  portEnv: 'string | null — only if the app reads its port from a variable other than PORT',
  healthPath: 'string starting with / that answers 2xx when the app is up',
  staticDir: 'string | null — static only: the folder (after build) to serve, e.g. "dist"',
  kind: '"web" (has pages people open) | "service" (an API or worker without public pages)',
  confidence: 'number 0..1',
  reasons: 'string[] — short, each citing what in the repo led to a field',
  warnings: 'string[] — short, anything the owner should check before deploying',
}

export function buildSuggestMessages(i: {
  catalog: Catalog
  tree: SourceTree
  files: SourceFile[]
}): ChatMessage[] {
  const ids = catalogRuntimeIds(i.catalog)
  const system = [
    'You set up how a server builds and runs a git repository. Read the repo files and answer with ONE JSON object, no prose, no markdown fence.',
    `Allowed runtime ids: ${JSON.stringify(ids)}. "node@<major>" runs Node.js of that major version; "static" serves a folder of files (after the build) with no server process.`,
    'If the repo needs a runtime that is not allowed (another language, another Node.js major), put the id it needs (e.g. "python@3.12", "node@18") in runtime and say why in warnings. Never pretend an allowed runtime fits when it does not.',
    'How the server runs things: install, build and start each are ONE command run directly, not through a shell — no &&, ;, |, >, $VARS, quotes or cd. They run inside the repo root with the runtime on PATH. The app must listen on the port in the PORT environment variable (set portEnv only if the code reads another variable name). healthPath must answer HTTP 2xx once the app is up. A Dockerfile is information only: it is never used to build.',
    'Install only production dependencies when nothing needs building; when a build step needs dev dependencies, install all of them.',
    `JSON shape: ${JSON.stringify(ANSWER_SHAPE)}`,
  ].join('\n')

  const treeLines = i.tree.entries
    .slice(0, TREE_MAX_LINES)
    .map((e) => (e.type === 'tree' ? `${e.path}/` : e.path))
  const truncatedTree = i.tree.truncated || i.tree.entries.length > TREE_MAX_LINES
  let budget = SUGGEST_TOTAL_BYTES
  const fileBlocks: string[] = []
  for (const f of i.files) {
    if (budget <= 0) break
    const body = f.content.length > budget ? `${f.content.slice(0, budget)}\n[cut here]` : f.content
    budget -= Math.min(f.content.length, budget)
    fileBlocks.push(`--- ${f.path} ---\n${body}`)
  }
  const user = [
    `Files (top two levels${truncatedTree ? ', list cut short' : ''}):`,
    treeLines.join('\n'),
    '',
    fileBlocks.length > 0 ? fileBlocks.join('\n\n') : '(no README or manifest files found)',
    '',
    'Answer with the JSON object now.',
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export type SuggestChatFn = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  logContext?: string
  responseFormat?: 'json_object'
}) => Promise<unknown>

export type SuggestEe = Pick<EeClient, 'sourceTree' | 'sourceFile' | 'catalog'>

/** Field values named as the build form names its inputs. */
export type SuggestedFields = {
  /** A form runtime value (node@22, static); null on a catalog gap. */
  runtime: string | null
  install: string
  build: string
  start: string
  portEnv: string
  health: string
  staticDir: string
}

export type ContractSuggestion = {
  fields: SuggestedFields
  kind: 'web' | 'service'
  confidence: number
  reasons: string[]
  warnings: string[]
  /** A plain sentence when the repo needs a runtime this server lacks. */
  catalogGap: string | null
  filesRead: string[]
}

const UNREADABLE =
  "The AI couldn't read the repo well enough to fill this in. Try again, or fill the form in yourself."

async function defaultChat(input: Parameters<SuggestChatFn>[0]): Promise<unknown> {
  // Lazy: keeps the gateway (and its DB handle) out of unit tests.
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  return llmChatCompletion(input)
}

function parseAnswer(response: unknown): z.infer<typeof answerSchema> {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new AppUserError(UNREADABLE, {
      cause: new Error('gateway response has no choices[0].message.content'),
    })
  }
  let json: unknown
  try {
    // Parse-only cleanup: a model may wrap JSON in a fence despite json_object mode.
    json = JSON.parse(content.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, ''))
  } catch (err) {
    throw new AppUserError(UNREADABLE, { cause: err })
  }
  const parsed = answerSchema.safeParse(json)
  if (!parsed.success) throw new AppUserError(UNREADABLE, { cause: parsed.error })
  return parsed.data
}

function gapSentence(runtime: string, catalog: Catalog): string {
  const offered = catalog.runtimes.node.map((v) => `Node.js ${v}`).join(', ')
  return (
    `This repo looks like it needs ${runtime}, which this server doesn't provide yet ` +
    `(it provides ${offered || 'no Node.js'}, and static sites). Adding it is a change to Eigen itself — ` +
    'ask for it in the chat. The commands below are filled in as a starting point.'
  )
}

export async function suggestContract(
  deps: { ee: SuggestEe; chat?: SuggestChatFn },
  i: { userId: string; mirror: string; rev: string },
): Promise<ContractSuggestion> {
  const chat = deps.chat ?? defaultChat
  const [tree, catalog] = await Promise.all([
    deps.ee.sourceTree({ name: i.mirror, rev: i.rev, depth: TREE_DEPTH }),
    deps.ee.catalog(),
  ])
  const paths = selectInputFiles(tree.entries)
  const files = await Promise.all(
    paths.map((path) => deps.ee.sourceFile({ name: i.mirror, rev: i.rev, path })),
  )
  const response = await chat({
    userId: i.userId,
    messages: buildSuggestMessages({ catalog, tree, files }),
    temperature: 0,
    maxTokens: 1200,
    logContext: 'website_app_suggest',
    responseFormat: 'json_object',
  })
  const a = parseAnswer(response)

  const inCatalog = catalogRuntimeIds(catalog).includes(a.runtime)
  const fields: SuggestedFields = {
    runtime: inCatalog ? a.runtime : null,
    install: a.install ?? '',
    build: a.build ?? '',
    start: a.runtime === 'static' ? '' : (a.start ?? ''),
    portEnv: a.portEnv && a.portEnv !== 'PORT' ? a.portEnv : '',
    health: a.healthPath,
    staticDir: a.runtime === 'static' ? (a.staticDir ?? '') : '',
  }
  const warnings = [...a.warnings]
  for (const [label, raw] of [
    ['install command', fields.install],
    ['build command', fields.build],
    ['start command', fields.start],
  ] as const) {
    const problem = raw === '' ? null : commandProblem(label, raw)
    if (problem) warnings.push(problem)
  }
  return {
    fields,
    kind: a.kind,
    confidence: a.confidence,
    reasons: a.reasons,
    warnings,
    catalogGap: inCatalog ? null : gapSentence(a.runtime, catalog),
    filesRead: paths,
  }
}
