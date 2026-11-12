import type { HighlightKind, PullSnap, RepoSnapshot, RepoSummary } from './snapshot-types'
import { z } from 'zod'
import { isLlmHttpError, isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { HIGHLIGHT_KINDS } from './snapshot-types'

/**
 * The assistant's "What's going on" per repo (plan/github-drive.md §6).
 *
 * `diffSnapshots` is plain bookkeeping — which commit shas, branch names and
 * PR states are new since the last sync. What it means is the model's job
 * (AGENTS.md: LLM + JSON schema): one gateway call with that delta and the
 * previous summary, on the company's AI provider, cost tracked under the
 * `repos_summary` log context. Post-LLM code only validates the JSON.
 *
 * No model selected: the gateway refuses before sending anything
 * (LlmNotConfiguredError, it never picks a default) and the summarizer
 * answers `no_model` — the pages still sync.
 */

export const SUMMARY_LOG_CONTEXT = 'repos_summary'
export const SUMMARY_MAX_ATTEMPTS = 3
export const SUMMARY_MAX_CHARS = 1200
export const HIGHLIGHTS_MAX = 8
/** Bounds on what one prompt carries. */
export const PROMPT_COMMITS_MAX = 60
export const PROMPT_PULLS_MAX = 30
export const FIRST_SENTENCE_MAX = 200

export const NO_MODEL_MESSAGE = 'No model is selected for summaries. The owner selects one under Settings → AI provider.'

export type DeltaCommit = { branch: string; sha: string; subject: string; author: string; date: string }
export type DeltaPull = { number: number; title: string; author: string | null; headRef: string; baseRef: string; draft: boolean }

export type SyncDelta = {
  /** No previous snapshot: everything in the window counts as new. */
  first: boolean
  newCommits: DeltaCommit[]
  branchesCreated: string[]
  branchesDeleted: string[]
  prsOpened: DeltaPull[]
  prsMerged: DeltaPull[]
  prsClosed: DeltaPull[]
}

const pullLite = (p: PullSnap): DeltaPull => ({
  number: p.number,
  title: p.title,
  author: p.authorLogin,
  headRef: p.headRef,
  baseRef: p.baseRef,
  draft: p.draft,
})

/** What is new in `next` compared with `prev`, by sha, branch name and PR state. */
export function diffSnapshots(prev: RepoSnapshot | null, next: RepoSnapshot): SyncDelta {
  const seen = new Set<string>()
  for (const b of prev?.branches ?? []) {
    for (const c of b.recent) seen.add(c.sha)
    if (b.lastCommit) seen.add(b.lastCommit.sha)
  }
  const newCommits: DeltaCommit[] = []
  for (const b of next.branches) {
    for (const c of b.recent) {
      if (seen.has(c.sha)) continue
      seen.add(c.sha)
      newCommits.push({ branch: b.name, sha: c.sha, subject: c.subject, author: c.authorLogin ?? c.authorName, date: c.date })
    }
  }
  newCommits.sort((a, b) => b.date.localeCompare(a.date) || a.sha.localeCompare(b.sha))

  const prevBranches = new Set((prev?.branches ?? []).map((b) => b.name))
  const nextBranches = new Set(next.branches.map((b) => b.name))
  const branchesCreated = prev ? [...nextBranches].filter((n) => !prevBranches.has(n)).sort() : []
  const branchesDeleted = [...prevBranches].filter((n) => !nextBranches.has(n)).sort()

  const before = new Map((prev?.pulls ?? []).map((p) => [p.number, p]))
  const opened: DeltaPull[] = []
  const merged: DeltaPull[] = []
  const closed: DeltaPull[] = []
  for (const p of [...next.pulls].sort((a, b) => a.number - b.number)) {
    const old = before.get(p.number)
    if (p.state === 'open') {
      // New since the last sync, or reopened. An old PR that only now shows up is not news.
      const isNew = !prev || (old ? old.state === 'closed' : p.createdAt > prev.takenAt)
      if (isNew) opened.push(pullLite(p))
    } else if (!old || old.state === 'open') {
      if (!old && prev && (p.closedAt ?? '') <= prev.takenAt) continue
      ;(p.merged ? merged : closed).push(pullLite(p))
    }
  }
  return { first: prev === null, newCommits, branchesCreated, branchesDeleted, prsOpened: opened, prsMerged: merged, prsClosed: closed }
}

export function deltaIsEmpty(d: SyncDelta): boolean {
  return (
    !d.first &&
    d.newCommits.length === 0 &&
    d.branchesCreated.length === 0 &&
    d.branchesDeleted.length === 0 &&
    d.prsOpened.length === 0 &&
    d.prsMerged.length === 0 &&
    d.prsClosed.length === 0
  )
}

/** The summary's first sentence (for the assistant's prompt block): cut at the first sentence end or line break. */
export function firstSentence(text: string): string {
  const t = text.trim().split(/\r?\n/)[0]!.trim()
  const m = /^.*?[.!?](?=\s|$)/.exec(t)
  const s = m ? m[0] : t
  return s.length > FIRST_SENTENCE_MAX ? `${s.slice(0, FIRST_SENTENCE_MAX - 1)}…` : s
}

// ── the schema ────────────────────────────────────────────────────────────────

const outputSchema = z
  .object({
    summary: z.string().trim().min(1).max(SUMMARY_MAX_CHARS),
    highlights: z
      .array(
        z
          .object({
            kind: z.enum(HIGHLIGHT_KINDS),
            text: z.string().trim().min(1).max(300),
            ref: z
              .string()
              .trim()
              .max(120)
              .nullable()
              .transform((v) => (v === null || v === '' ? null : v)),
          })
          .strict(),
      )
      .max(HIGHLIGHTS_MAX),
  })
  .strict()

const JSON_SCHEMA = `{
  "summary": "<2 to 4 plain sentences; the first one stands on its own>",
  "highlights": [ { "kind": branch | pr | commit | release | other, "text": "<one short line>", "ref": "<#PR number, branch name or short commit sha>" | null } ]
}`

export type SummaryInput = { snapshot: RepoSnapshot; delta: SyncDelta; previous: RepoSummary | null }

export function buildSummaryMessages(input: SummaryInput): ChatMessage[] {
  const s = input.snapshot
  const system = [
    "You keep a short \"What's going on\" note for a GitHub repo, for people at a company who don't read GitHub every day.",
    'You get what changed since the last sync (new commits, branches created or deleted, pull requests opened, merged or closed), the repo as it stands now, and your previous note.',
    'Write the new note: what the team is working on and what moved. Keep what is still true from the previous note; drop what is no longer true.',
    'Return JSON only, exactly this schema:',
    JSON_SCHEMA,
    'Rules:',
    '- Use only the facts given. Never invent a feature, a person, a date or a number.',
    `- summary: 2 to 4 plain sentences in English, at most ${SUMMARY_MAX_CHARS} characters. The first sentence is shown on its own, so it must make sense alone.`,
    `- highlights: at most ${HIGHLIGHTS_MAX}, the most important changes first. ref is a PR as "#<number>", a branch name, or a 7-character commit sha; null when none fits.`,
    '- "first": true means this is the first sync: describe the repo as it stands.',
  ].join('\n')
  const open = s.pulls.filter((p) => p.state === 'open')
  const facts = {
    repo: s.repo.fullName,
    description: s.repo.description,
    defaultBranch: s.repo.defaultBranch,
    lastPush: s.repo.pushedAt,
    syncedAt: s.takenAt,
    openPullRequests: { count: open.length, newest: open.slice(0, PROMPT_PULLS_MAX).map(pullLite) },
    branches: s.branches.length,
  }
  const d = input.delta
  const changes = {
    first: d.first,
    newCommits: { count: d.newCommits.length, newest: d.newCommits.slice(0, PROMPT_COMMITS_MAX).map((c) => ({ ...c, sha: c.sha.slice(0, 7) })) },
    branchesCreated: d.branchesCreated,
    branchesDeleted: d.branchesDeleted,
    pullRequestsOpened: d.prsOpened.slice(0, PROMPT_PULLS_MAX),
    pullRequestsMerged: d.prsMerged.slice(0, PROMPT_PULLS_MAX),
    pullRequestsClosedWithoutMerge: d.prsClosed.slice(0, PROMPT_PULLS_MAX),
  }
  const previous = input.previous ? { summary: input.previous.summary, highlights: input.previous.highlights, writtenAt: input.previous.writtenAt } : null
  const user = [
    'The repo now (JSON):',
    JSON.stringify(facts),
    'What changed since the last sync (JSON):',
    JSON.stringify(changes),
    'Your previous note (JSON, null if none):',
    JSON.stringify(previous),
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export type SummaryOutput = { summary: string; highlights: Array<{ kind: HighlightKind; text: string; ref: string | null }> }

/** Validates the model's JSON against the schema. Throws on anything else. */
export function parseSummaryOutput(response: unknown): SummaryOutput {
  const parsed = outputSchema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`summary failed the schema: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`)
  }
  return parsed.data
}

// ── the call ──────────────────────────────────────────────────────────────────

export type SummaryChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  logContext?: string
  responseFormat?: 'json_object'
}) => Promise<unknown>

export type SummaryResult = ({ status: 'written' } & SummaryOutput) | { status: 'no_model'; message: string }

/** The port the poller calls after a sync that found changes. Throws when the call or its answer failed. */
export type ReposSummarizer = (input: SummaryInput) => Promise<SummaryResult>

export class SummaryUnreadableError extends Error {
  constructor(attempts: number, last: string) {
    super(`The summary could not be read (${attempts} tries: ${last})`)
    this.name = 'SummaryUnreadableError'
  }
}

/**
 * `account` is the company account the call is attributed to (the owner's,
 * whose settings hold the company's AI provider and model); null = no owner
 * yet, so no provider and no model.
 */
export function createSummarizer(deps: { chat: SummaryChat; account: () => Promise<string | null> }): ReposSummarizer {
  return async (input) => {
    const userId = await deps.account()
    if (!userId) return { status: 'no_model', message: NO_MODEL_MESSAGE }
    const messages = buildSummaryMessages(input)
    let last = ''
    for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt++) {
      let response: unknown
      try {
        response = await deps.chat({ userId, messages, temperature: 0, logContext: SUMMARY_LOG_CONTEXT, responseFormat: 'json_object' })
      } catch (err) {
        if (isLlmNotConfiguredError(err)) return { status: 'no_model', message: NO_MODEL_MESSAGE }
        throw err
      }
      try {
        return { status: 'written', ...parseSummaryOutput(response) }
      } catch (err) {
        last = err instanceof Error ? err.message.slice(0, 200) : String(err)
      }
    }
    throw new SummaryUnreadableError(SUMMARY_MAX_ATTEMPTS, last)
  }
}

/** A plain line for the page and Overview.md — never the provider's own text. */
export function summaryFailureMessage(err: unknown): string {
  if (isLlmHttpError(err)) return `The AI provider refused the request (HTTP ${err.status}).`
  if (err instanceof SummaryUnreadableError) return "The AI's answer could not be read."
  return 'Writing the summary failed.'
}

/** The live gateway call: the company's AI provider (the owner's account), cost tracked as `repos_summary`. */
export function liveSummarizer(): ReposSummarizer {
  return createSummarizer({
    chat: async (input) => {
      const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
      const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
      return onCompanyProvider(() => llmChatCompletion(input))
    },
    account: async () => (await import('$lib/server/llm/company-provider')).companyOwnerId(),
  })
}
