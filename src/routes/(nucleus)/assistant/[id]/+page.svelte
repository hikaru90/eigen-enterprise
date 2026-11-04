<script lang="ts">
  import type { PageData } from './$types'
  import { onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import {
    applyBatch,
    feedFromSnapshot,
    type FeedState,
    type RunBatch,
    type RunConnection,
    type RunSnapshot,
  } from '$lib/agent-runs/feed'
  import AgentRunFeed from '$lib/components/agent-run-feed.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()

  let feed = $state<FeedState>(feedFromSnapshot({ running: false, items: [] }))
  let connection = $state<RunConnection>('connecting')

  // The live feed (D8): one EventSource per open page — snapshot on connect
  // (and again on every reconnect, so the feed is replaced, never doubled),
  // then one batch per durable commit. Closed when the page goes away.
  onMount(() => {
    const source = new EventSource(`/api/agent/runs/${data.run.id}/events`)
    source.addEventListener('open', () => {
      connection = 'live'
    })
    source.addEventListener('snapshot', (event) => {
      feed = feedFromSnapshot(JSON.parse((event as MessageEvent<string>).data) as RunSnapshot)
      connection = 'live'
    })
    source.addEventListener('batch', (event) => {
      const batch = JSON.parse((event as MessageEvent<string>).data) as RunBatch
      feed = applyBatch(feed, batch.items)
    })
    source.addEventListener('end', () => {
      connection = 'ended'
      source.close()
    })
    source.addEventListener('error', () => {
      if (connection !== 'ended') connection = 'lost'
    })
    return () => source.close()
  })

  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => timeFormat.format(new Date(iso))
</script>

<svelte:head><title>{docTitle(data.run.title, 'Assistant')}</title></svelte:head>

<a
  href={resolve('/(nucleus)/assistant')}
  class="mt-6 inline-block text-xs text-muted-foreground hover:underline"
  data-testid="back-link">← Back to conversations</a
>
<header class="mt-2 flex min-w-0 flex-col gap-1" data-testid="run-header">
  <h2 class="text-base font-semibold tracking-tight wrap-break-word" data-testid="run-title">
    {data.run.title}
  </h2>
  <p class="flex min-w-0 flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
    <span class="text-xs">Started {when(data.run.createdAt)}</span>
    <span class="text-xs">Last activity {when(data.run.updatedAt)}</span>
  </p>
  <details class="text-xs text-muted-foreground">
    <summary class="cursor-pointer">Details</summary>
    <p class="mt-1">Conversation {data.run.id} · agent {data.run.agentId}</p>
    <code class="block truncate font-mono">{data.run.conversationKey}</code>
  </details>
</header>

<div class="mt-6">
  <AgentRunFeed {feed} {connection} />
</div>
