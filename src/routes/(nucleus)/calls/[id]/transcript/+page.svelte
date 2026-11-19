<script lang="ts">
  import type { PageData } from './$types'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import { resolve } from '$app/paths'
  import BrainRecap from '$lib/calls/brain-recap.svelte'
  import { brainClient } from '$lib/calls/client'
  import { readingTurns } from '$lib/calls/format'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { docTitle } from '$lib/shell/title'

  /**
   * A call's transcript (call transcripts, option A): what each person said,
   * merged by time; one speaker in a row is one turn, timed on the call clock
   * (from when someone answered). Only people who were in the call get here.
   */
  let { data }: { data: PageData } = $props()

  const since = $derived(data.call.answeredAt ?? data.segments[0]?.startedAt ?? data.call.startedAt)
  const turns = $derived(readingTurns(data.segments, since))
  const when = $derived(new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(data.call.answeredAt ?? data.call.startedAt)))
  const live = $derived(data.call.state === 'scheduled' || data.call.state === 'ringing' || data.call.state === 'active')
  /** Over, and I switched the Company Brain on in it: the recap is offered (generated only on my click). */
  const recapOffered = $derived(!live && data.call.brain.turnedOnBy.includes(data.me))
  const brainApi = brainClient()
</script>

<svelte:head><title>{docTitle(`Transcript: ${data.call.title}`, 'Calls')}</title></svelte:head>

<PageFrame testid="call-transcript">
  <PageHeader title="Transcript" part="calls" description={`${data.call.title} · ${when}`} />
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-10">
    <a href={resolve('/calls')} class="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      ><ArrowLeft class="size-4" aria-hidden="true" /> Calls</a
    >
    {#if live}
      <p class="text-sm text-muted-foreground" role="status" data-testid="call-transcript-live">
        The call is still going: what is said now appears here when you reload.
      </p>
    {/if}
    {#if recapOffered}
      <BrainRecap callId={data.call.id} client={brainApi} />
    {/if}
    {#if turns.length === 0}
      <p class="rounded-xl bg-white p-6 text-center text-sm text-muted-foreground" data-testid="call-transcript-empty">
        Nothing was transcribed in this call.
      </p>
    {:else}
      <ol class="flex flex-col gap-3 rounded-xl bg-white p-4 sm:p-6" data-testid="call-transcript-turns">
        {#each turns as t (t.key)}
          <li class="grid grid-cols-[3.5rem_1fr] gap-3" data-testid="call-transcript-turn">
            <span class="pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{t.at}</span>
            <div class="min-w-0">
              <p class="text-sm font-semibold">
                {t.speakerName}{#if t.guest}<span class="ml-1.5 text-xs font-normal text-muted-foreground">Guest</span>{/if}
              </p>
              <p class="text-sm whitespace-pre-wrap">{t.text}</p>
            </div>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</PageFrame>
