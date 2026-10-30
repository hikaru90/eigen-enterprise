import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { applyBatch, feedFromSnapshot } from '$lib/agent-runs/feed'
import AgentRunFeed from './agent-run-feed.svelte'

describe('agent-run-feed.svelte', () => {
  it('renders run markers, user input, streamed assistant text and tool lines', async () => {
    let state = feedFromSnapshot({ running: false, items: [{ kind: 'user_input', text: 'ship it' }] })
    state = applyBatch(state, [
      { kind: 'run_start' },
      { kind: 'tool_start', toolCallId: 'c1', toolName: 'repo.run', args: { cmd: 'npm test', apiKey: '[REDACTED]' } },
      { kind: 'tool_end', toolCallId: 'c1', toolName: 'repo.run', outcome: 'error' },
      { kind: 'text_delta', delta: 'Working' },
    ])
    render(AgentRunFeed, { feed: state, connection: 'live' })

    const feed = page.getByRole('log', { name: 'Run events' })
    await expect.element(feed).toBeInTheDocument()
    await expect.element(page.getByText('ship it')).toBeInTheDocument()
    await expect.element(page.getByText('Run started')).toBeInTheDocument()
    await expect.element(page.getByTestId('run-feed-tool')).toHaveTextContent('repo.run')
    await expect.element(page.getByTestId('run-feed-tool')).toHaveTextContent('failed')
    await expect.element(page.getByTestId('run-feed-tool')).toHaveTextContent('[REDACTED]')
    await expect.element(page.getByTestId('run-feed-assistant')).toHaveTextContent('Working')
    await expect.element(page.getByTestId('run-feed-status')).toHaveTextContent('Running')
  })

  it('shows the empty state and the connection state when idle', async () => {
    render(AgentRunFeed, {
      feed: feedFromSnapshot({ running: false, items: [] }),
      connection: 'connecting',
    })
    await expect.element(page.getByText('No events yet.')).toBeInTheDocument()
    await expect.element(page.getByTestId('run-feed-status')).toHaveTextContent('Connecting')
  })
})
