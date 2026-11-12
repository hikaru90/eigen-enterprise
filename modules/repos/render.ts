import type { BranchSnap, CommitLite, NotCopied, PullSnap, RepoSnapshot, SummaryState } from './snapshot-types'

/**
 * Snapshot → the Markdown files of one repo's Drive folder
 * (plan/github-drive.md §4). Pure: the same snapshot renders the same bytes,
 * so the Drive writer only rewrites what really changed. Nothing here reads
 * the clock — every window is measured from `snapshot.takenAt`.
 *
 * Layout: GitHub / <owner> / <repo> / Overview.md · Branches.md ·
 * Pull requests.md · Activity.md · Docs/<repo path>.
 */

export type RenderedItem =
  | { kind: 'folder'; key: string; parentKey: string | null; name: string }
  /** `content: null` = a doc whose blob did not change: keep the Drive copy as it is. */
  | { kind: 'file'; key: string; parentKey: string | null; name: string; content: string | null }

export const ownerKey = (owner: string) => `owner:${owner.toLowerCase()}`
export const repoKey = (repoId: number) => `repo:${repoId}`

export const GENERATED_FILES = ['Overview.md', 'Branches.md', 'Pull requests.md', 'Activity.md'] as const
export const DOCS_FOLDER = 'Docs'

const DAY_MS = 86_400_000
export const ACTIVE_DAYS = 30
export const QUIET_DAYS = 90
export const PR_BODY_MAX = 1500

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
const day = (iso: string) => iso.slice(0, 10)
const short = (sha: string) => sha.slice(0, 7)
/** One table cell: no pipes or line breaks. */
const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`
const commitLink = (c: CommitLite) => `[${short(c.sha)}](${c.htmlUrl})`
const author = (c: CommitLite) => c.authorLogin ?? c.authorName

const NOT_COPIED_REASON: Record<NotCopied['reason'], string> = {
  file_size: 'over 256 KB',
  file_count: 'over the 300 file limit',
  total_size: 'over the 10 MB limit for the repo',
}

function cutoff(s: RepoSnapshot, days: number): string {
  return new Date(new Date(s.takenAt).getTime() - days * DAY_MS).toISOString()
}

function recentCount(b: BranchSnap, since: string): number {
  return b.recent.filter((c) => c.date >= since).length
}

/** Default branch first, then the most recently committed. */
function orderedBranches(s: RepoSnapshot): BranchSnap[] {
  const date = (b: BranchSnap) => b.lastCommit?.date ?? ''
  return [...s.branches].sort((a, b) => {
    if (a.name === s.repo.defaultBranch) return -1
    if (b.name === s.repo.defaultBranch) return 1
    return date(b).localeCompare(date(a)) || a.name.localeCompare(b.name)
  })
}

const openPulls = (s: RepoSnapshot) => s.pulls.filter((p) => p.state === 'open').sort((a, b) => b.number - a.number)

function aheadBehind(s: RepoSnapshot, b: BranchSnap): string {
  if (b.name === s.repo.defaultBranch) return 'default branch'
  if (b.aheadBy === null || b.behindBy === null) return '—'
  return `${b.aheadBy} ahead, ${b.behindBy} behind`
}

function lastCommitCell(c: CommitLite | null): string {
  if (!c) return '—'
  return `${commitLink(c)} ${cell(c.subject)} — ${cell(author(c))}, ${day(c.date)}`
}

const RETRY = 'The assistant tries again after the next sync that finds changes.'

function whatsGoingOn(state: SummaryState): string[] {
  const { summary, problem } = state
  const out: string[] = []
  if (summary) {
    out.push(`_Written by the assistant · ${when(summary.writtenAt)}_`, '')
    if (problem?.kind === 'no_model') out.push(`_Out of date. ${problem.message} Until then this summary is not updated._`, '')
    if (problem?.kind === 'failed') out.push(`_Out of date: updating it failed at ${when(problem.at)}. ${problem.message} ${RETRY}_`, '')
    out.push(summary.summary.trim())
    if (summary.highlights.length > 0) out.push('')
    for (const h of summary.highlights) out.push(`- ${h.text}${h.ref ? ` (${h.ref})` : ''}`)
  } else if (problem?.kind === 'no_model') {
    out.push(`_No summary. ${problem.message} The pages below are kept in sync without it._`)
  } else if (problem?.kind === 'failed') {
    out.push(`_No summary yet: writing it failed at ${when(problem.at)}. ${problem.message} ${RETRY}_`)
  } else {
    out.push('_No summary yet. The assistant writes one after a sync that finds changes._')
  }
  return out
}

function overview(s: RepoSnapshot, summary: SummaryState): string {
  const out: string[] = [`# ${s.repo.fullName}`, '', "## What's going on", '', ...whatsGoingOn(summary)]
  out.push('', '## About', '')
  if (s.repo.description) out.push(s.repo.description, '')
  out.push(
    `- On GitHub: [${s.repo.fullName}](${s.repo.htmlUrl})${s.repo.private ? ' (private)' : ''}`,
    `- Default branch: \`${s.repo.defaultBranch}\``,
    `- Last push: ${s.repo.pushedAt ? when(s.repo.pushedAt) : 'never'}`,
    `- Open pull requests: ${openPulls(s).length}`,
  )
  if (s.repo.archived) out.push('- Archived on GitHub (read-only there too)')

  const since = cutoff(s, ACTIVE_DAYS)
  const active = orderedBranches(s).filter((b) => recentCount(b, since) > 0)
  out.push('', `## Active branches (last ${ACTIVE_DAYS} days)`, '')
  if (active.length === 0) out.push(`No branch had a commit in the last ${ACTIVE_DAYS} days.`)
  else {
    out.push('| Branch | Commits | Against the default branch | Last commit |', '| --- | --- | --- | --- |')
    for (const b of active) out.push(`| \`${cell(b.name)}\` | ${recentCount(b, since)} | ${aheadBehind(s, b)} | ${lastCommitCell(b.lastCommit)} |`)
  }

  out.push('', '## Docs', '')
  out.push(
    s.docs.copied.length === 0
      ? `No Markdown files on \`${s.repo.defaultBranch}\`.`
      : `${s.docs.copied.length} Markdown file${s.docs.copied.length === 1 ? '' : 's'} from \`${s.repo.defaultBranch}\`${s.docs.commitSha ? ` @ \`${short(s.docs.commitSha)}\`` : ''}, in the Docs folder.`,
  )
  if (s.docs.truncated) out.push('', '_GitHub cut the file list of this repo short, so only part of the docs were copied._')
  if (s.docs.notCopied.length > 0) {
    out.push('', '### Not copied (size limit)', '')
    for (const n of [...s.docs.notCopied].sort((a, b) => a.path.localeCompare(b.path))) out.push(`- \`${n.path}\` — ${kb(n.size)}, ${NOT_COPIED_REASON[n.reason]}`)
  }
  return `${out.join('\n')}\n`
}

function branchesFile(s: RepoSnapshot): string {
  const quietBefore = cutoff(s, QUIET_DAYS)
  const open = openPulls(s)
  const prFor = (b: BranchSnap) => {
    const p = open.filter((x) => x.headRef === b.name)
    return p.length === 0 ? '—' : p.map((x) => `[#${x.number}](${x.htmlUrl})`).join(', ')
  }
  const row = (b: BranchSnap) => `| \`${cell(b.name)}\` | ${lastCommitCell(b.lastCommit)} | ${aheadBehind(s, b)} | ${prFor(b)} |`
  const head = ['| Branch | Last commit | Against the default branch | Open pull request |', '| --- | --- | --- | --- |']
  const all = orderedBranches(s)
  const quiet = all.filter((b) => b.name !== s.repo.defaultBranch && b.lastCommit !== null && b.lastCommit.date < quietBefore)
  const lively = all.filter((b) => !quiet.includes(b))
  const out = [`# Branches of ${s.repo.fullName}`, '', `${all.length} branch${all.length === 1 ? '' : 'es'}. The default branch is \`${s.repo.defaultBranch}\`.`, '']
  if (lively.length > 0) out.push(...head, ...lively.map(row))
  out.push('', '## Quiet branches', '', `No commit in the last ${QUIET_DAYS} days.`, '')
  if (quiet.length === 0) out.push('None.')
  else out.push(...head, ...quiet.map(row))
  return `${out.join('\n')}\n`
}

function pullBlock(p: PullSnap): string[] {
  const out = [
    `### [#${p.number}](${p.htmlUrl}) ${p.title}`,
    '',
    `- By ${p.authorLogin ?? 'unknown'} · \`${p.headRef}\` → \`${p.baseRef}\`${p.draft ? ' · draft' : ''}`,
    `- Opened ${when(p.createdAt)} · updated ${when(p.updatedAt)}`,
  ]
  if (p.labels.length > 0) out.push(`- Labels: ${p.labels.join(', ')}`)
  if (p.requestedReviewers.length > 0) out.push(`- Review requested from: ${p.requestedReviewers.join(', ')}`)
  const body = p.body?.trim()
  if (body) {
    const cut = body.length > PR_BODY_MAX ? `${body.slice(0, PR_BODY_MAX)}…` : body
    out.push('', ...cut.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')))
  }
  out.push('')
  return out
}

function pullsFile(s: RepoSnapshot): string {
  const open = openPulls(s)
  const since = cutoff(s, ACTIVE_DAYS)
  const done = s.pulls
    .filter((p) => p.state === 'closed' && p.closedAt !== null && p.closedAt >= since)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
  const out = [`# Pull requests of ${s.repo.fullName}`, '', `## Open (${open.length})`, '']
  if (open.length === 0) out.push('No open pull requests.', '')
  else for (const p of open) out.push(...pullBlock(p))
  out.push(`## Merged or closed in the last ${ACTIVE_DAYS} days`, '')
  if (done.length === 0) out.push('None.')
  for (const p of done) {
    const what = p.merged ? `merged ${when(p.mergedAt ?? p.closedAt!)}` : `closed ${when(p.closedAt!)}`
    out.push(`- [#${p.number}](${p.htmlUrl}) ${p.title} — ${p.authorLogin ?? 'unknown'}, \`${p.headRef}\` → \`${p.baseRef}\`, ${what}`)
  }
  return `${out.join('\n')}\n`
}

function activityFile(s: RepoSnapshot): string {
  const since = cutoff(s, ACTIVE_DAYS)
  const seen = new Set<string>()
  const commits: Array<{ branch: string; c: CommitLite }> = []
  for (const b of orderedBranches(s)) {
    for (const c of b.recent) {
      if (c.date < since || seen.has(c.sha)) continue
      seen.add(c.sha)
      commits.push({ branch: b.name, c })
    }
  }
  commits.sort((a, b) => b.c.date.localeCompare(a.c.date) || a.c.sha.localeCompare(b.c.sha))
  const out = [`# Activity in ${s.repo.fullName}`, '', `The last ${ACTIVE_DAYS} days, newest first.`]
  if (commits.length === 0) out.push('', 'No commits.')
  const days = new Map<string, Map<string, CommitLite[]>>()
  for (const { branch, c } of commits) {
    const d = days.get(day(c.date)) ?? new Map<string, CommitLite[]>()
    d.set(branch, [...(d.get(branch) ?? []), c])
    days.set(day(c.date), d)
  }
  for (const [d, branches] of days) {
    out.push('', `## ${d}`)
    for (const [branch, list] of branches) {
      out.push('', `### \`${branch}\``, '')
      for (const c of list) out.push(`- ${c.subject} — ${author(c)} · ${commitLink(c)}`)
    }
  }
  return `${out.join('\n')}\n`
}

export function render(snapshot: RepoSnapshot, summary: SummaryState): RenderedItem[] {
  const s = snapshot
  const owner = ownerKey(s.repo.owner)
  const repo = repoKey(s.repo.id)
  const items: RenderedItem[] = [
    { kind: 'folder', key: owner, parentKey: null, name: s.repo.owner },
    { kind: 'folder', key: repo, parentKey: owner, name: s.repo.name },
    { kind: 'file', key: `${repo}/Overview.md`, parentKey: repo, name: 'Overview.md', content: overview(s, summary) },
    { kind: 'file', key: `${repo}/Branches.md`, parentKey: repo, name: 'Branches.md', content: branchesFile(s) },
    { kind: 'file', key: `${repo}/Pull requests.md`, parentKey: repo, name: 'Pull requests.md', content: pullsFile(s) },
    { kind: 'file', key: `${repo}/Activity.md`, parentKey: repo, name: 'Activity.md', content: activityFile(s) },
  ]
  if (s.docs.copied.length === 0) return items
  const docsKey = `${repo}/${DOCS_FOLDER}`
  items.push({ kind: 'folder', key: docsKey, parentKey: repo, name: DOCS_FOLDER })
  const folders = new Set<string>()
  for (const doc of [...s.docs.copied].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = doc.path.split('/')
    let parent = docsKey
    for (const seg of segments.slice(0, -1)) {
      const key = `${parent}/${seg}`
      if (!folders.has(key)) {
        folders.add(key)
        items.push({ kind: 'folder', key, parentKey: parent, name: seg })
      }
      parent = key
    }
    items.push({ kind: 'file', key: `${docsKey}/${doc.path}`, parentKey: parent, name: segments.at(-1)!, content: doc.text ?? null })
  }
  return items
}
