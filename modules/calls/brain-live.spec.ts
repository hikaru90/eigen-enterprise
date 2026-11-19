import { describe, expect, it } from 'vitest'
import { BRAIN_CALL_SYSTEM_PROMPT, BRAIN_RECAP_SYSTEM_PROMPT } from './brain'
import { createLiveBrain, type LiveBrainDeps } from './brain-live'

/**
 * The live Company Brain: the assistant's answer path, run as the asker —
 * their Memory through composeAnswer and one gateway completion, both inside
 * their row-level-security session on the company's AI provider, the text
 * declared as Memory (never logged). Everything external is faked here.
 */

function fakes(opts: { memory?: string; reply?: string } = {}) {
  const log: string[] = []
  let scope: string | null = null
  const completions: Parameters<LiveBrainDeps['complete']>[0][] = []
  const deps: LiveBrainDeps = {
    onCompanyProvider: async (fn) => {
      log.push('company-provider')
      return fn()
    },
    withDbUser: async (userId, fn) => {
      log.push(`db-user:${userId}`)
      scope = userId
      try {
        return await fn()
      } finally {
        scope = null
      }
    },
    memoryAnswer: async (userId, question) => {
      log.push(`memory:${userId}:${scope}:${question}`)
      return opts.memory ?? 'Answer: Not in memory.'
    },
    complete: async (input) => {
      log.push(`complete:${input.userId}:${scope}`)
      completions.push(input)
      return { choices: [{ message: { content: opts.reply ?? ' Morgen. ' } }] }
    },
  }
  return { deps, log, completions }
}

const ask = {
  askerId: 'ben',
  askerName: 'Ben Example',
  question: 'Wann geht das Angebot raus?',
  callTitle: 'Sync',
  people: ['Ann Example', 'Ben Example'],
  heard: '[00:30] Ann Example: Das Angebot geht morgen raus.',
}

describe('createLiveBrain', () => {
  it('an answer: the asker’s Memory, then one completion — both as the asker, on the company provider', async () => {
    const { deps, log, completions } = fakes({ memory: 'Answer: Offer to Müller planned for Friday.' })
    expect(await createLiveBrain(deps).answer(ask)).toBe('Morgen.')
    expect(log).toEqual(['company-provider', 'db-user:ben', 'memory:ben:ben:Wann geht das Angebot raus?', 'complete:ben:ben'])
    const c = completions[0]!
    expect(c).toMatchObject({ userId: 'ben', contentOrigin: 'memory', temperature: 0, logContext: 'call_brain_answer' })
    expect(c.messages[0]).toEqual({ role: 'system', content: BRAIN_CALL_SYSTEM_PROMPT })
    expect(c.messages[1]!.content).toContain('Offer to Müller planned for Friday.')
    expect(c.messages[1]!.content).toContain('[00:30] Ann Example: Das Angebot geht morgen raus.')
  })

  it('a recap: the transcript only (no Memory), as whoever asked for it', async () => {
    const { deps, log, completions } = fakes({ reply: '- Decided: offer goes out tomorrow.' })
    const out = await createLiveBrain(deps).recap({ userId: 'ann', callTitle: 'Sync', people: ask.people, heard: ask.heard })
    expect(out).toBe('- Decided: offer goes out tomorrow.')
    expect(log).toEqual(['company-provider', 'db-user:ann', 'complete:ann:ann'])
    expect(completions[0]).toMatchObject({ userId: 'ann', contentOrigin: 'memory', logContext: 'call_brain_recap' })
    expect(completions[0]!.messages[0]).toEqual({ role: 'system', content: BRAIN_RECAP_SYSTEM_PROMPT })
  })

  it('fails loud on a reply without text', async () => {
    const { deps } = fakes()
    deps.complete = async () => ({ choices: [] })
    await expect(createLiveBrain(deps).answer(ask)).rejects.toThrow(/no answer/)
  })
})
