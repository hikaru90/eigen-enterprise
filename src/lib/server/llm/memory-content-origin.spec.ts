import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every gateway call made by Memory's code declares `contentOrigin: 'memory'`, so the gateway
 * keeps the person's text out of server logs, the AI usage log and PostHog (Contribute
 * 7fa15491). A new Memory call without it fails here instead of leaking quietly.
 */
const ROOT = path.resolve(import.meta.dirname, '../../../..')

/** Memory's server code: capture, enrichment, check-ins, retrieval, answers, consolidation. */
const MEMORY_DIRS = [
  'src/lib/server/capture',
  'src/lib/server/consolidation',
  'src/lib/server/grounding',
  'src/lib/server/memory',
  'src/lib/server/ontology',
  'src/lib/server/qa',
  'src/lib/server/retrieval',
]
/** Single Memory files outside those directories. */
const MEMORY_FILES = [
  'src/lib/server/llm/agent-loop.ts',
  'src/lib/server/llm/embedding.ts',
  'src/routes/api/capture/transcribe/+server.ts',
  'src/routes/api/capture/transcribe-chunk/+server.ts',
]

const GATEWAY_CALLS = ['llmChatCompletion', 'llmCreateEmbeddings', 'transcribeAudio']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : []
  })
}

/** The argument object of each `fn({ … })` call in `source`, braces balanced. */
function callArguments(source: string, fn: string): string[] {
  const args: string[] = []
  const opener = `${fn}({`
  let from = source.indexOf(opener)
  while (from !== -1) {
    const start = from + opener.length - 1
    let depth = 0
    let end = start
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++
      else if (source[end] === '}' && --depth === 0) break
    }
    args.push(source.slice(start, end + 1))
    from = source.indexOf(opener, end)
  }
  return args
}

describe("Memory's gateway calls declare their text as Memory", () => {
  const files = [
    ...MEMORY_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir))),
    ...MEMORY_FILES.map((file) => path.join(ROOT, file)),
  ]
  const calls = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8')
    return GATEWAY_CALLS.flatMap((fn) =>
      callArguments(source, fn).map((arg) => ({ file: path.relative(ROOT, file), fn, arg })),
    )
  })

  it('finds the Memory gateway calls it guards', () => {
    expect(calls.length).toBeGreaterThanOrEqual(40)
  })

  it.each(calls.map((c, i) => [`${c.file} ${c.fn} #${i}`, c] as const))(
    '%s passes contentOrigin: memory',
    (_name, call) => {
      expect(call.arg).toContain("contentOrigin: 'memory'")
    },
  )
})
