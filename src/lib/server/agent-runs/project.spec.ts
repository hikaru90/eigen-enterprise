import { describe, expect, it } from 'vitest'
import type { AgentEvent, SnapshotEvent } from '$lib/server/agent/pi-durable'
import { OWNER_INPUT_ENTRY_KIND, TURN_FAILED_ENTRY_KIND } from '$lib/server/agent/entry-kinds'
import { projectEvents, projectSnapshot } from './project'

const usage = {}
const assistant = (content: unknown[]) => ({ role: 'assistant', content, usage, stopReason: 'stop' })
const entry = (id: number, message: unknown) => ({ id, conversationId: 1, kind: 'x', model: [message] })

function snapshot(partial: Partial<SnapshotEvent>): SnapshotEvent {
  return {
    type: 'snapshot',
    entries: [],
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: {},
    ...partial,
  } as unknown as SnapshotEvent
}

describe('projectSnapshot', () => {
  it('projects the transcript into feed items and redacts secret-shaped tool args', () => {
    const snap = snapshot({
      entries: [
        entry(1, { role: 'user', content: 'deploy it', timestamp: 0 }),
        entry(
          2,
          assistant([
            { type: 'thinking', thinking: 'private chain of thought' },
            { type: 'text', text: 'On it.' },
            {
              type: 'toolCall',
              id: 'c1',
              name: 'repo.run',
              arguments: { cmd: 'npm test', apiKey: 'sk-live-123', nested: { access_token: 't' } },
            },
          ]),
        ),
        entry(3, {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'repo.run',
          content: [{ type: 'text', text: 'raw tool output' }],
          isError: false,
          timestamp: 0,
        }),
      ],
    } as never)
    const projected = projectSnapshot(snap)
    expect(projected.running).toBe(false)
    expect(projected.items).toEqual([
      { kind: 'user_input', text: 'deploy it' },
      { kind: 'assistant_text', text: 'On it.' },
      {
        kind: 'tool_start',
        toolCallId: 'c1',
        toolName: 'repo.run',
        args: { cmd: 'npm test', apiKey: '[REDACTED]', nested: { access_token: '[REDACTED]' } },
      },
      { kind: 'tool_end', toolCallId: 'c1', toolName: 'repo.run', outcome: 'ok' },
    ])
    // Metadata-only: tool output and thinking never leave the server.
    expect(JSON.stringify(projected)).not.toMatch(/raw tool output|chain of thought|sk-live/)
  })

  it('marks an active run and carries the in-flight partial text', () => {
    const projected = projectSnapshot(
      snapshot({
        run: { inputs: [] },
        generation: { attempt: 1, message: assistant([{ type: 'text', text: 'Hal' }]) },
      } as never),
    )
    expect(projected.running).toBe(true)
    expect(projected.items).toEqual([{ kind: 'text_delta', delta: 'Hal' }])
  })
})

describe('projectEvents', () => {
  it('maps run, text-delta, message and tool events; drops bookkeeping events', () => {
    const events = [
      { type: 'run_start', inputs: [] },
      { type: 'turn_start' },
      {
        type: 'message_update',
        usage,
        changes: [
          { type: 'text_delta', contentIndex: 0, delta: 'Hi' },
          { type: 'thinking_delta', contentIndex: 1, delta: 'secret thoughts' },
        ],
      },
      { type: 'message_end', entry: entry(5, assistant([{ type: 'text', text: 'Hi there' }])) },
      {
        type: 'tool_execution_start',
        toolCallId: 'c9',
        toolName: 'mail.send',
        args: { to: 'a@b.c', password: 'hunter2' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'c9',
        toolName: 'mail.send',
        entry: entry(6, { role: 'toolResult', toolCallId: 'c9', toolName: 'mail.send', content: [], isError: true, timestamp: 0 }),
      },
      { type: 'tool_execution_end', toolCallId: 'c10', toolName: 'x' },
      { type: 'usage_changed', usage: {} },
      { type: 'run_end', inputs: [] },
    ] as unknown as AgentEvent[]
    expect(projectEvents(events)).toEqual([
      { kind: 'run_start' },
      { kind: 'text_delta', delta: 'Hi' },
      { kind: 'assistant_text', text: 'Hi there' },
      { kind: 'tool_start', toolCallId: 'c9', toolName: 'mail.send', args: { to: 'a@b.c', password: '[REDACTED]' } },
      { kind: 'tool_end', toolCallId: 'c9', toolName: 'mail.send', outcome: 'error' },
      { kind: 'tool_end', toolCallId: 'c10', toolName: 'x', outcome: 'unfinished' },
      { kind: 'run_end' },
    ])
  })

  it('projects a committed user input message', () => {
    const events = [
      { type: 'message_end', entry: entry(1, { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 0 }) },
    ] as unknown as AgentEvent[]
    expect(projectEvents(events)).toEqual([{ kind: 'user_input', text: 'go' }])
  })

  it('a failed turn (its recorded entry) projects as run_failed, live and in a snapshot', () => {
    const failed = { id: 7, conversationId: 1, kind: TURN_FAILED_ENTRY_KIND, data: { reason: 'model_error', detail: 'gateway 502' } }
    const events = [
      { type: 'run_end', inputs: [] },
      { type: 'entry_appended', entry: failed },
    ] as unknown as AgentEvent[]
    expect(projectEvents(events)).toEqual([
      { kind: 'run_end' },
      { kind: 'run_failed', reason: 'model_error', detail: 'gateway 502' },
    ])
    expect(projectSnapshot(snapshot({ entries: [failed] as never })).items).toEqual([
      { kind: 'run_failed', reason: 'model_error', detail: 'gateway 502' },
    ])
  })

  it('a composed input shows only the owner\'s own words (structural, from its entry data)', () => {
    const composed = {
      id: 3,
      conversationId: 1,
      kind: OWNER_INPUT_ENTRY_KIND,
      data: { ownerText: 'make me a website' },
      model: [{ role: 'user', content: '[company onboarding context]\n…\n[/company onboarding context]\n\nmake me a website', timestamp: 0 }],
    }
    expect(projectEvents([{ type: 'message_end', entry: composed }] as unknown as AgentEvent[])).toEqual([
      { kind: 'user_input', text: 'make me a website' },
    ])
    // An app-made turn (no owner words) shows no Input line at all.
    const handoff = { ...composed, data: { ownerText: '' } }
    expect(projectSnapshot(snapshot({ entries: [handoff] as never })).items).toEqual([])
  })
})
