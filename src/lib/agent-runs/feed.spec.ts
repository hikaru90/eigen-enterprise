import { describe, expect, it } from 'vitest'
import { applyBatch, feedFromSnapshot } from './feed'

describe('agent run feed reducer', () => {
  it('builds lines from a snapshot and keeps the running flag', () => {
    const state = feedFromSnapshot({
      running: true,
      items: [
        { kind: 'user_input', text: 'hi' },
        { kind: 'assistant_text', text: 'hello' },
        { kind: 'tool_start', toolCallId: 'c1', toolName: 'list_projects', args: {} },
      ],
    })
    expect(state.running).toBe(true)
    expect(state.lines.map((l) => [l.kind, l.text, l.status])).toEqual([
      ['user', 'hi', 'done'],
      ['assistant', 'hello', 'done'],
      ['tool', 'list_projects', 'running'],
    ])
  })

  it('streams text deltas into one assistant line, then finalizes it with the message', () => {
    let state = feedFromSnapshot({ running: false, items: [] })
    state = applyBatch(state, [{ kind: 'run_start' }])
    state = applyBatch(state, [
      { kind: 'text_delta', delta: 'Hel' },
      { kind: 'text_delta', delta: 'lo' },
    ])
    expect(state.running).toBe(true)
    const streaming = state.lines.at(-1)!
    expect([streaming.kind, streaming.text, streaming.status]).toEqual([
      'assistant',
      'Hello',
      'running',
    ])
    state = applyBatch(state, [{ kind: 'assistant_text', text: 'Hello.' }, { kind: 'run_end' }])
    expect(state.running).toBe(false)
    const assistants = state.lines.filter((l) => l.kind === 'assistant')
    expect(assistants.map((l) => [l.text, l.status])).toEqual([['Hello.', 'done']])
    expect(state.lines.map((l) => l.kind)).toEqual(['run', 'assistant', 'run'])
  })

  it('closes a running tool line on its end event with the outcome', () => {
    let state = feedFromSnapshot({ running: true, items: [] })
    state = applyBatch(state, [
      { kind: 'tool_start', toolCallId: 'c1', toolName: 'a', args: { q: 1 } },
      { kind: 'tool_start', toolCallId: 'c2', toolName: 'b', args: {} },
    ])
    state = applyBatch(state, [
      { kind: 'tool_end', toolCallId: 'c2', toolName: 'b', outcome: 'error' },
      { kind: 'tool_end', toolCallId: 'c1', toolName: 'a', outcome: 'ok' },
    ])
    expect(state.lines.map((l) => [l.text, l.status])).toEqual([
      ['a', 'done'],
      ['b', 'error'],
    ])
  })

  it('never mutates the previous state (pure reducer)', () => {
    const before = feedFromSnapshot({ running: false, items: [{ kind: 'user_input', text: 'x' }] })
    const frozen = JSON.stringify(before)
    applyBatch(before, [{ kind: 'text_delta', delta: 'y' }])
    expect(JSON.stringify(before)).toBe(frozen)
  })

  it('a failed turn shows an error line and the run end (live and snapshot read the same)', () => {
    let live = feedFromSnapshot({ running: false, items: [] })
    live = applyBatch(live, [{ kind: 'run_start' }, { kind: 'user_input', text: 'hi' }])
    live = applyBatch(live, [{ kind: 'run_end' }])
    live = applyBatch(live, [{ kind: 'run_failed', reason: 'model_error', detail: 'gateway 502' }])
    expect(live.running).toBe(false)
    expect(live.lines.map((l) => [l.kind, l.text])).toEqual([
      ['run', 'Run started'],
      ['user', 'hi'],
      ['error', 'Turn failed (model_error): gateway 502'],
      ['run', 'Run ended without an answer'],
    ])
    const snap = feedFromSnapshot({
      running: false,
      items: [{ kind: 'user_input', text: 'hi' }, { kind: 'run_failed', reason: 'model_error', detail: 'gateway 502' }],
    })
    expect(snap.lines.map((l) => [l.kind, l.text])).toEqual([
      ['user', 'hi'],
      ['error', 'Turn failed (model_error): gateway 502'],
      ['run', 'Run ended without an answer'],
    ])
  })
})

