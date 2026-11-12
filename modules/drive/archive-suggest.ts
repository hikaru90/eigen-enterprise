import { z } from 'zod'
import { isLlmHttpError, isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { DriveError, formatBytes, type Actor, type ArchiveCandidate, type Crumb, type DriveService, type ItemView, type PathRoot } from './service'

/**
 * "Suggest what to archive" (contribute round 3, W4): the person asked for
 * help deciding which old files are no longer relevant. Plain facts choose
 * the candidates — files they can edit, unchanged for at least N days, the
 * oldest first, at most SUGGEST_MAX_CANDIDATES (a bounded prompt). Whether a
 * file looks done with is the model's judgment (AGENTS.md: LLM + JSON
 * schema): one call through the gateway, on the company's AI provider, cost
 * tracked (`drive_archive_suggest`). Post-LLM code only validates the JSON
 * against the schema and the candidate ids. Nothing is archived here: the
 * person reviews the suggestions and confirms.
 */

export const SUGGEST_MAX_CANDIDATES = 60
export const SUGGEST_MAX_ATTEMPTS = 3
export const SUGGEST_LOG_CONTEXT = 'drive_archive_suggest'
export const SUGGEST_MIN_DAYS = 30
export const SUGGEST_MAX_DAYS = 3650
/** What the UI and the agent tool start from: half a year without a change. */
export const SUGGEST_DEFAULT_DAYS = 180

export type SuggestChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  logContext?: string
  responseFormat?: 'json_object'
}) => Promise<unknown>

export type ArchiveSuggestion = { file: ItemView; root: PathRoot; path: Crumb[]; reason: string }
export type ArchiveSuggestions = {
  olderThanDays: number
  /** How many files the model looked at. */
  considered: number
  /** More files qualified than one look takes (the oldest were shown). */
  more: boolean
  suggestions: ArchiveSuggestion[]
}

const DAY_MS = 86_400_000

export const NO_PROVIDER_MESSAGE =
  'The company has no AI provider set up yet, so Drive can’t suggest what to archive. The owner sets one up under Settings → AI provider.'

const outputSchema = z
  .object({
    suggestions: z.array(
      z.object({
        file_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300),
      }),
    ),
  })
  .strict()

const JSON_SCHEMA = '{ "suggestions": [ { "file_id": "<id of a candidate>", "reason": "<one short sentence>" } ] }'

const day = (d: Date) => d.toISOString().slice(0, 10)
const where = (root: PathRoot, path: readonly Crumb[]) => [root.label, ...path.map((c) => c.name)].join(' / ')

export function buildSuggestMessages(candidates: readonly ArchiveCandidate[], today: Date): ChatMessage[] {
  const system = [
    'You help a person at a company keep their files tidy. They want to archive files that are no longer relevant: archived files leave the everyday view but are not deleted — they stay where they are, can still be opened and found by search, and can be brought back any time.',
    'You get files that have not changed for a while. Judge which of them look done with: e.g. superseded drafts or old versions, one-off exports, material of a finished project or a past period, duplicates. Files that are likely still used or referenced (handbooks, templates, contracts, policies, the current version of something) stay.',
    'Return JSON only, exactly this schema:',
    JSON_SCHEMA,
    'Rules:',
    '- file_id must be the id of one of the candidates. Never invent an id; name each file at most once.',
    '- reason: one short, plain sentence in English telling the person why this file looks done with, from what you can see (name, where it is, dates, its folder).',
    '- When unsure, leave the file out. Suggesting nothing is fine: { "suggestions": [] }.',
  ].join('\n')

  const rows = candidates.map((c) => ({
    id: c.file.id,
    name: c.file.name,
    where: where(c.root, c.path),
    type: c.file.mime ?? null,
    size: c.file.size === undefined ? null : formatBytes(c.file.size),
    created: day(c.createdAt),
    last_changed: day(c.file.updatedAt),
    folder: { live_files: c.folder.files, newest_change_in_folder: day(c.folder.newestChange) },
  }))
  const user = [`Today: ${day(today)}`, 'Candidates (JSON, the longest unchanged first):', JSON.stringify(rows, null, 1)].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Validates the model's JSON against the schema and the candidate ids; reasons become one line. Throws on anything else. */
export function parseSuggestOutput(response: unknown, candidateIds: ReadonlySet<string>): Array<{ fileId: string; reason: string }> {
  const parsed = outputSchema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) throw new Error(`Suggestion output failed the schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  const seen = new Set<string>()
  return parsed.data.suggestions.map((s) => {
    if (!candidateIds.has(s.file_id)) throw new Error(`Suggested file_id "${s.file_id}" is not one of the candidates`)
    if (seen.has(s.file_id)) throw new Error(`Suggested file_id "${s.file_id}" twice`)
    seen.add(s.file_id)
    return { fileId: s.file_id, reason: s.reason.replace(/\s+/g, ' ') }
  })
}

/** A gateway failure as a plain Drive error; anything that isn't one stays a real failure. */
function gatewayError(err: unknown): unknown {
  if (isLlmNotConfiguredError(err)) return new DriveError('unavailable', NO_PROVIDER_MESSAGE, undefined, { cause: err })
  if (isLlmHttpError(err)) {
    return new DriveError('upstream', `The company’s AI provider refused the request (HTTP ${err.status}); try again later.`, undefined, { cause: err })
  }
  return err
}

/**
 * Exactly SUGGEST_MAX_ATTEMPTS tries at a readable answer, then a plain error —
 * never guessed suggestions. A missing provider or a refusal is not retried.
 */
export async function suggestArchive(
  deps: { drive: DriveService; chat: SuggestChat; now?: () => Date },
  input: { actor: Actor; olderThanDays: number },
): Promise<ArchiveSuggestions> {
  const days = input.olderThanDays
  if (!Number.isInteger(days) || days < SUGGEST_MIN_DAYS || days > SUGGEST_MAX_DAYS) {
    throw new DriveError('invalid', `Pick between ${SUGGEST_MIN_DAYS} days and ${SUGGEST_MAX_DAYS / 365} years.`)
  }
  const today = (deps.now ?? (() => new Date()))()
  const { candidates, more } = await deps.drive.archiveCandidates(input.actor, {
    changedBefore: new Date(today.getTime() - days * DAY_MS),
    limit: SUGGEST_MAX_CANDIDATES,
  })
  if (candidates.length === 0) return { olderThanDays: days, considered: 0, more: false, suggestions: [] }

  const messages = buildSuggestMessages(candidates, today)
  const byId = new Map(candidates.map((c) => [c.file.id, c]))
  const userId = input.actor.kind === 'user' ? input.actor.userId : input.actor.id
  let lastError = ''
  for (let attempt = 1; attempt <= SUGGEST_MAX_ATTEMPTS; attempt++) {
    let response: unknown
    try {
      response = await deps.chat({ userId, messages, temperature: 0, logContext: SUGGEST_LOG_CONTEXT, responseFormat: 'json_object' })
    } catch (err) {
      throw gatewayError(err)
    }
    try {
      const picked = parseSuggestOutput(response, new Set(byId.keys()))
      return {
        olderThanDays: days,
        considered: candidates.length,
        more,
        suggestions: picked.map(({ fileId, reason }) => {
          const c = byId.get(fileId)!
          return { file: c.file, root: c.root, path: c.path, reason }
        }),
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[drive.suggest_archive] attempt failed', { attempt, error: lastError.slice(0, 200) })
    }
  }
  throw new DriveError('upstream', `The AI’s answer couldn’t be read (${SUGGEST_MAX_ATTEMPTS} tries: ${lastError}). Try again.`)
}

/** The live gateway call: on the company's AI provider (the owner's), attributed to whoever asked. */
export const liveSuggestChat: SuggestChat = async (input) => {
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
  return onCompanyProvider(() => llmChatCompletion(input))
}
