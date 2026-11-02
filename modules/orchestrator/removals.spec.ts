import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * S1 removals (plan/phase-software-factory.md §6): the dev-agent module, its
 * pi skill, the kernel pi-engine / `pi` loop engine and the dead
 * AgentSessionLog (kernel_agent_session_events) are gone. Nothing under src/
 * or modules/ may reference them again.
 */

const ROOT = resolve(__dirname, '..', '..')
const SELF = relative(ROOT, __filename)

const REMOVED_NAMES = [
  'dev-agent.dispatch',
  'dev-agent.status',
  'dev-agent.logs',
  'dev-agent.merge',
  'dev-agent.abort',
  'orchestrator/dev-agent',
  'dev-agent-protocol',
  'pi-engine',
  'PiEngine',
  'piEngine',
  'AgentSessionLog',
  'sessionLog',
  'kernel_agent_session_events',
  'kernelAgentSessionEvents',
  'kernel_devagent_runs',
  'kernelDevagentRuns',
  'devagent.schema',
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|js|svelte|json|md)$/.test(entry)) out.push(path)
  }
  return out
}

describe('S1 removals', () => {
  it('no file under src/ or modules/ references a removed name', () => {
    const hits: string[] = []
    for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'modules'))]) {
      const rel = relative(ROOT, file)
      if (rel === SELF) continue
      const text = readFileSync(file, 'utf8')
      for (const name of REMOVED_NAMES) {
        if (text.includes(name)) hits.push(`${rel}: ${name}`)
      }
    }
    expect(hits).toEqual([])
  })
})
