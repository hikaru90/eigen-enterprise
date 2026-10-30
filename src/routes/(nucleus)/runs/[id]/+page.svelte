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

<svelte:head><title>Run {data.run.id} · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <a href={resolve('/(nucleus)/runs')} class="text-xs text-foreground/55 hover:underline">
    ← Agent runs
  </a>
  <header class="mt-2 flex min-w-0 flex-col gap-1" data-testid="run-header">
    <h1 class="text-xl font-semibold tracking-tight">Run {data.run.id}</h1>
    <p class="flex min-w-0 flex-wrap items-center gap-x-3 text-sm text-foreground/55">
      <span>{data.run.agentId}</span>
      <code class="truncate font-mono text-xs">{data.run.conversationKey}</code>
      <span class="text-xs">Started {when(data.run.createdAt)}</span>
    </p>
  </header>

  <div class="mt-6">
    <AgentRunFeed {feed} {connection} />
  </div>
</div>
