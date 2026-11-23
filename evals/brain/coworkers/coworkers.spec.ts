import type { ScriptedRequest } from './gateway'
import type { ScriptCast } from './scripts'
import { describe, expect, it } from 'vitest'
import { COMPANY } from '../fixture/company'
import { coworkersMarkdown } from '../report'
import { COWORKER_LEAKS, validateCoworkerSuite } from '../suites/coworkers'
import { completionOf, scriptedRequestOf, startScriptedGateway } from './gateway'
import { LAUNCH_THOUGHT_MARKER, launchScript, pingPongScript } from './scripts'
import { cosine } from './suite'

const cast: ScriptCast = {
  asker: { name: 'Priya Raman', handle: 'priya' },
  marketing: { name: 'Marketing', handle: 'marketing' },
  gtm: { name: 'GTM', handle: 'gtm' },
  designer: { name: 'Designer', handle: 'designer' },
}
const turn = (who: keyof Omit<ScriptCast, 'asker'>, from: keyof ScriptCast, over: Partial<ScriptedRequest> = {}): ScriptedRequest => ({
  model: 'm',
  system: `# Your role\nYou are ${cast[who].name} (@${cast[who].handle}), an AI co-worker`,
  input: `${cast[from].name} (@${cast[from].handle}, person):\nhello`,
  lastRole: 'user',
  tools: ['memory.capture_thought'],
  ...over,
})

describe('the scripted gateway', () => {
  it('reads a request the way a script needs it: model, every system message, the latest user message, the tools', () => {
    const req = scriptedRequestOf({
      model: 'openai/gpt-5-mini',
      messages: [
        { role: 'system', content: 'A' },
        { role: 'user', content: 'first' },
        { role: 'system', content: 'B' },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
        { role: 'tool', content: 'ok' },
      ],
      tools: [{ type: 'function', function: { name: 'memory.capture_thought' } }],
    })
    expect(req).toEqual({ model: 'openai/gpt-5-mini', system: 'A\n\nB', input: 'second', lastRole: 'tool', tools: ['memory.capture_thought'] })
  })

  it('answers with native tool_calls or content, always reporting the call’s cost', () => {
    const call = completionOf('m', { toolCall: { name: 'memory.capture_thought', arguments: { raw: 'x' } } }) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> }; finish_reason: string }>; usage: { cost: number } }
    expect(call.choices[0]!.finish_reason).toBe('tool_calls')
    expect(JSON.parse(call.choices[0]!.message.tool_calls[0]!.function.arguments)).toEqual({ raw: 'x' })
    expect(call.usage.cost).toBeGreaterThan(0)
    expect(completionOf('m', { content: 'hi' })).toMatchObject({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })
  })

  it('refuses a request no script answers when it has no upstream (never made-up text)', async () => {
    const gw = await startScriptedGateway({ upstream: null })
    try {
      gw.setScript((r) => (r.model === 'yes' ? { content: 'scripted' } : null))
      const post = (model: string) =>
        fetch(`${gw.origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'q' }] }) })
      const ok = await post('yes')
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe('scripted')
      expect((await post('no')).status).toBe(500)
      expect(gw.requests.map((r) => r.answered)).toEqual(['script', 'refused'])
    } finally {
      await gw.close()
    }
  })
})

describe('the Does scripts', () => {
  it('launch: Marketing captures its plan, asks GTM, then the Designer, then answers the asker; others answer Marketing', () => {
    const s = launchScript(cast, 'Flows')
    expect(s(turn('marketing', 'asker'))).toEqual({ toolCall: { name: 'memory.capture_thought', arguments: { raw: expect.stringContaining(LAUNCH_THOUGHT_MARKER) } } })
    expect(s(turn('marketing', 'asker', { lastRole: 'tool' }))).toEqual({ content: expect.stringContaining('@gtm') })
    expect(s(turn('gtm', 'marketing'))).toEqual({ content: expect.stringContaining('@marketing') })
    expect(s(turn('marketing', 'gtm'))).toEqual({ content: expect.stringContaining('@designer') })
    expect(s(turn('designer', 'marketing'))).toEqual({ content: expect.stringContaining('@marketing') })
    expect(s(turn('marketing', 'designer'))).toEqual({ content: expect.stringMatching(/^@priya /) })
    // Not a co-worker turn (e.g. the brain, enrichment): not this script's request.
    expect(s({ ...turn('marketing', 'asker'), system: 'You are the company brain.' })).toBeNull()
  })

  it('ping-pong: the two keep mentioning each other; a third is not scripted', () => {
    const s = pingPongScript(cast, ['marketing', 'gtm'])
    expect(s(turn('marketing', 'asker'))).toEqual({ content: 'ping 1 @gtm' })
    expect(s(turn('gtm', 'marketing'))).toEqual({ content: 'pong 2 @marketing' })
    expect(s(turn('designer', 'marketing'))).toBeNull()
  })
})

describe('the co-workers suite', () => {
  it('is valid against the fixture, and refuses a leak test a co-worker may read', () => {
    expect(validateCoworkerSuite(COMPANY)).toEqual([])
    const original = COWORKER_LEAKS[0]!.protects
    COWORKER_LEAKS[0]!.protects = ['msg-launch-brief']
    try {
      expect(validateCoworkerSuite(COMPANY)).toContain('CK01: marketing may read msg-launch-brief, so it is no leak test for it')
    } finally {
      COWORKER_LEAKS[0]!.protects = original
    }
  })

  it('Different measures cosine similarity of embeddings and fails loud on unusable vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
    expect(() => cosine([1], [1, 2])).toThrow(/length/)
    expect(() => cosine([0, 0], [1, 0])).toThrow(/zero vector/)
  })

  it('the summary says pass, FAIL or why a part was skipped — never nothing', () => {
    const md = coworkersMarkdown({
      keeps: {
        leaks: [{ id: 'CK05', concept: 'drive-private', pass: false, leaked: [{ coworker: 'gtm', sourceId: 'drive-ony-salary', tools: ['drive.read'] }] }],
        reach: [],
        readOnly: { pass: true, views: [], wrong: [] },
        writeProbe: { pass: true, probes: [], unchanged: true },
      },
      does: { skipped: 'skipped: needs the scripted model' },
      different: { skipped: 'skipped: needs real models' },
    }).join('\n')
    expect(md).toContain('FAIL CK05 drive-private: gtm ← drive-ony-salary (drive.read)')
    expect(md).toContain('- Does: skipped: needs the scripted model')
    expect(md).toContain('- Different: skipped: needs real models')
  })
})
