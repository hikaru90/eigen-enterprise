import 'dotenv/config'
import type { ItemResult } from './grade'
import type { Cost } from './report'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRAIN_EVAL_USAGE, orderForChat, parseBrainEvalArgs, providerEnvFor } from './cli'
import { COMPANY } from './fixture/company'
import { factsFor, fillPlaceholders, localDateOf } from './fixture/time'
import { validateFixture } from './fixture/validate'
import { ALL_ITEMS, validateSuites } from './suites'

/**
 * North-star eval runner (plan/phase-company-brain.md §9, CB0).
 *
 *   npm run eval:brain                                   # static, no model
 *   npm run eval:brain -- --mode chat --provider mock      # chat path vs the mock gateway
 *   npm run eval:brain -- --mode chat --provider platform  # real model, per release
 *
 * Writes evals/reports/brain/<date>-<sha>-<mode>.json + .md. App modules are
 * imported only after harness.ts pointed the env at the eval database.
 */

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const JUDGE_USER_ID = 'eb-judge'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function startMockGateway(): Promise<{ origin: string; child: ChildProcess }> {
  const port = await freePort()
  const child = spawn(process.execPath, [join(root, 'scripts/mock-gateway.mjs')], { env: { ...process.env, MOCK_GATEWAY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  const origin = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null) throw new Error(`the mock gateway exited (${child.exitCode})`)
    try {
      await fetch(`${origin}/models.dev.json`)
      return { origin, child }
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  child.kill()
  throw new Error('the mock gateway did not start within 5 s')
}

async function costSince(since: Date, memberIds: string[]): Promise<Cost> {
  const { appSql } = await import('$lib/server/db')
  const rows = await appSql<{ user_id: string; usd: string | null; calls: number }[]>`
    select user_id, sum(total_cost_usd::numeric)::text as usd, count(*)::int as calls
    from activity_call_log where created_at >= ${since.toISOString()}::timestamptz group by user_id`
  let brainUsd = 0
  let judgeUsd = 0
  let calls = 0
  for (const r of rows) {
    const usd = Number(r.usd ?? 0)
    calls += r.calls
    if (r.user_id === JUDGE_USER_ID) judgeUsd += usd
    else if (memberIds.includes(r.user_id)) brainUsd += usd
    else throw new Error(`gateway cost logged for an unexpected user ${r.user_id}`)
  }
  return { brainUsd, judgeUsd, totalUsd: brainUsd + judgeUsd, calls }
}

async function main(): Promise<void> {
  const args = parseBrainEvalArgs(process.argv.slice(2))
  const problems = [...validateFixture(COMPANY), ...validateSuites(COMPANY, ALL_ITEMS)]
  if (problems.length > 0) throw new Error(`the fixture or suites are invalid:\n${problems.join('\n')}`)

  const anchor = new Date()
  let mock: { origin: string; child: ChildProcess } | null = null
  try {
    if (args.provider === 'mock') mock = await startMockGateway()
    const providerEnv = args.provider ? providerEnvFor(args.provider, process.env, mock?.origin ?? null) : {}

    const { setUpEvalCompany } = await import('./harness')
    const company = await setUpEvalCompany(COMPANY, { anchor, enrichThoughts: args.provider === 'platform', env: providerEnv })
    const runStart = await (await import('./state')).dbNow()
    const { crawlCompany, staticResult, surfaceOf } = await import('./static')
    const stat = staticResult(COMPANY, surfaceOf(company), await crawlCompany(company, COMPANY))

    const items: ItemResult[] = []
    const notes: string[] = []
    if (args.mode === 'chat') {
      const { chatAs, tapToolCalls } = await import('./chat')
      const { gradeItem } = await import('./grade')
      const { checkState, dbNow } = await import('./state')
      const { gatewayJudge } = await import('./judge')
      if (args.provider === 'platform') {
        const { authDb } = await import('$lib/server/db/auth-db')
        const { user } = await import('$lib/server/db/auth.schema')
        // The judge's own identity (a harness account), so its cost is counted apart from the brain's.
        await authDb.insert(user).values({ id: JUDGE_USER_ID, name: 'Eval judge', email: 'judge@eval.invalid', emailVerified: true, role: 'member', accountKind: 'harness' })
      } else notes.push('mock provider: the chat path and structural grades are real; judge-graded parts are not graded (null).')
      const judge = args.provider === 'platform' ? gatewayJudge(JUDGE_USER_ID) : null
      const tap = tapToolCalls(company.boot.kernel.registry as unknown as Parameters<typeof tapToolCalls>[0])
      const facts = factsFor(COMPANY, anchor)
      const chosen = orderForChat(ALL_ITEMS.filter((i) => !args.only || args.only.includes(i.id)))
      for (const item of chosen) {
        const m = COMPANY.members.find((x) => x.key === item.asker)!
        const since = await dbNow()
        let turn
        try {
          turn = await chatAs({ id: m.id, name: m.name, email: m.email, role: m.role }, fillPlaceholders(item.prompt, facts))
        } catch (err) {
          turn = { reply: '', sessionId: null, error: err instanceof Error ? err.message : String(err), approvals: [], previews: [] }
        }
        const result = await gradeItem(item, { reply: turn.reply, error: turn.error, approvals: turn.approvals, calls: tap.take(m.id) }, {
          judge,
          f: COMPANY,
          facts,
          state: (check) => checkState(check, { f: COMPANY, seeded: company.seeded, since, anchor }),
        })
        items.push(result)
        console.log(`[eval:brain] ${result.id} ${result.pass === null ? '—' : result.pass ? 'pass' : 'FAIL'}${result.error ? ` (${result.error.slice(0, 100)})` : ''}`)
      }
    } else {
      notes.push(`static mode: no model was called. Chat scores need: ${BRAIN_EVAL_USAGE.split('\n')[2]!.trim()}`)
    }

    const cost = args.mode === 'chat' ? await costSince(runStart, COMPANY.members.map((m) => m.id)) : null
    const { buildReport, reportFileStem, toMarkdown } = await import('./report')
    const sha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim()
    const report = buildReport({
      mode: args.mode,
      provider: args.provider === 'platform' ? `platform (${providerEnv.PLATFORM_LLM_MODEL_CHAT})` : (args.provider ?? 'none'),
      sha,
      date: localDateOf(anchor, COMPANY.company.timeZone, 0),
      anchor,
      items,
      static: stat,
      cost,
      notes,
    })
    const dir = join(root, 'evals/reports/brain')
    await mkdir(dir, { recursive: true })
    const stem = reportFileStem(report)
    await writeFile(join(dir, `${stem}.json`), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(join(dir, `${stem}.md`), toMarkdown(report))
    console.log(toMarkdown(report).split('\n## Chat')[0])
    if (args.mode === 'chat') console.log(toMarkdown(report).split('| item |')[0].split('## Chat')[1] ?? '')
    console.log(`[eval:brain] wrote evals/reports/brain/${stem}.json and .md`)
    // The database stays for inspection (ee_eval_brain); the temp state dir goes.
    await company.tearDown({ dropDatabase: false })
  } finally {
    mock?.child.kill()
  }
}

let exitCode = 0
try {
  await main()
} catch (err) {
  exitCode = 1
  const cause = err instanceof Error && err.cause ? ` (cause: ${String((err.cause as { message?: unknown }).message ?? err.cause)})` : ''
  console.error('[eval:brain] failed:', err instanceof Error ? `${err.message}${cause}` : err)
} finally {
  const { closeAppDbPool } = await import('$lib/server/db')
  const { closeAuthDbPool } = await import('$lib/server/db/auth-db')
  await Promise.allSettled([closeAppDbPool(), closeAuthDbPool()])
  process.exit(exitCode)
}
