import type { BundleStorage } from './bundles'
import type { HubModuleVersion, ModuleHubStore } from './store'
import type { ModuleSummaryDto } from './types'
import { z } from 'zod'
import type { AiTaskId } from '$lib/ai-usage/tasks'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { assertOutputScript, outputLanguageInstruction } from '$lib/server/llm/output-language'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { BUNDLE_LOCKFILES, type BundleEntry } from '../../contracts/module-bundle'
import { MODULE_MANIFEST_FILE } from '../../contracts/module-manifest'
import { bundleEntries } from './service'

/**
 * The summary of one published version (plan/phase-upgrades-u2.md §7): one
 * gateway call (cost tracked, on the company's AI provider) writes what the
 * module does, what it touches and what it sends out. Summarising is new
 * text, so it is the LLM's job; post-model code checks the schema only.
 *
 * Input: the receipted manifest plus at most 60 KB of source — the entry file
 * (the `start` argument that names a file in the bundle) first, then the other
 * text files from the smallest up, so as many files as fit are seen whole.
 */

export const SUMMARY_SOURCE_BUDGET = 60 * 1024
export const SUMMARY_MAX_ATTEMPTS = 3
const FIELD_MAX = 600

const outputSchema = z.strictObject({
  does: z.string().trim().min(1).max(FIELD_MAX),
  touches: z.string().trim().min(1).max(FIELD_MAX),
  sends_out: z.string().trim().min(1).max(FIELD_MAX),
})

export type SummaryChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  task: AiTaskId
  responseFormat?: 'json_object'
}) => Promise<unknown>

export type SummarizeDeps = {
  store: ModuleHubStore
  bundles: BundleStorage
  chat: SummaryChat
  /** The person the call is attributed to (the company owner) and the DB/provider context it runs in. */
  runAsOwner: <T>(fn: (userId: string) => Promise<T>) => Promise<T>
  /** The language that person reads in (their preferred language); runs inside runAsOwner. */
  language: (userId: string) => Promise<string>
  now: () => Date
}

/** Thrown after 3 answers off the schema: no summary is stored. */
export class SummaryFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SummaryFailedError'
  }
}

type FileEntry = Extract<BundleEntry, { type: 'file' }>

function asText(e: FileEntry): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(e.content)
  } catch {
    return null
  }
}

const NOT_SOURCE = new Set<string>([MODULE_MANIFEST_FILE, 'LICENSE', ...BUNDLE_LOCKFILES])

/** The source the summary reads: the entry file first, then by size, within the budget (the last one cut). */
export function summarySource(version: Pick<HubModuleVersion, 'manifest'>, entries: readonly BundleEntry[], budget = SUMMARY_SOURCE_BUDGET): { path: string; text: string; cut: boolean }[] {
  const files = entries.filter((e): e is FileEntry => e.type === 'file' && !NOT_SOURCE.has(e.path))
  const entry = files.find((f) => version.manifest.start.includes(f.path))
  const rest = files.filter((f) => f !== entry).sort((a, b) => a.size - b.size || a.path.localeCompare(b.path))
  const out: { path: string; text: string; cut: boolean }[] = []
  let left = budget
  for (const f of entry ? [entry, ...rest] : rest) {
    if (left <= 0) break
    const text = asText(f)
    if (text === null) continue
    const bytes = Buffer.byteLength(text)
    if (bytes <= left) {
      out.push({ path: f.path, text, cut: false })
      left -= bytes
    } else {
      out.push({ path: f.path, text: Buffer.from(text).subarray(0, left).toString('utf8'), cut: true })
      left = 0
    }
  }
  return out
}

export function buildSummaryMessages(version: Pick<HubModuleVersion, 'manifest'>, entries: readonly BundleEntry[], language: string): ChatMessage[] {
  const system = [
    'You describe an eigenEnterprise module for the owner of the module hub, who reviews modules that companies built and published as open source.',
    'Write three short plain paragraphs from the manifest and the source below:',
    '"does": what the module does for the people who use it;',
    '"touches": which company data it reads and changes (the core tools and events it uses, and what it keeps in its own data);',
    '"sends_out": what leaves the company through it (mail, messages, anything sent outside) — say so plainly when nothing does.',
    'Describe only what the manifest and the code show; never guess intent and never judge the authors.',
    'Return JSON only: { "does": "...", "touches": "...", "sends_out": "..." }, each at most 600 characters.',
    outputLanguageInstruction(language),
  ].join('\n')
  const source = summarySource(version, entries)
    .map((f) => `--- ${f.path}${f.cut ? ' (cut)' : ''}\n${f.text}`)
    .join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Manifest (module.yaml as JSON):\n${JSON.stringify(version.manifest)}\n\nSource:\n${source}` },
  ]
}

export function parseSummaryOutput(response: unknown): ModuleSummaryDto {
  const parsed = outputSchema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) throw new Error(`Summary output failed the schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  return { does: parsed.data.does, touches: parsed.data.touches, sendsOut: parsed.data.sends_out }
}

/** Writes (or rewrites) the summary of one version and stores it. The gateway's own errors surface as is. */
export async function summarizeVersion(deps: SummarizeDeps, bundleSha256: string): Promise<ModuleSummaryDto> {
  const { version, entries } = await bundleEntries(deps, bundleSha256)
  const summary = await deps.runAsOwner(async (userId) => {
    // Wish d0a0c775: the summary is asked in the owner's language, and a foreign script is refused loud.
    const language = await deps.language(userId)
    const messages = buildSummaryMessages(version, entries, language)
    const source = messages.map((m) => m.content).join('\n')
    let lastError = ''
    for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt++) {
      const response = await deps.chat({ userId, messages, temperature: 0, task: 'contribute.module_summary', responseFormat: 'json_object' })
      let parsed: ModuleSummaryDto
      try {
        parsed = parseSummaryOutput(response)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        continue
      }
      assertOutputScript(`${parsed.does}\n${parsed.touches}\n${parsed.sendsOut}`, { language, what: 'module summary', source })
      return parsed
    }
    throw new SummaryFailedError(`The module summary gave no valid answer in ${SUMMARY_MAX_ATTEMPTS} attempts: ${lastError}`)
  })
  await deps.store.setSummary(version.bundleSha256, summary, deps.now())
  return summary
}
