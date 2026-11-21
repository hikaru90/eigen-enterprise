<script lang="ts">
  import type { NextUp, NextUpItem } from '../types'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import { onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { AgentReport } from '$lib/errors/agent-report'
  import { loadNextUp, type LoadNextUp } from '../client'
  import { NEXT_UP_KIND_LABELS, channelHref } from '../types'
  import LogContactForm from './log-contact-form.svelte'

  /**
   * "Next up" (Contribute 057ebd74): a compact strip of the 5–10 people the
   * assistant suggests writing to or answering next, each with a one-line
   * reason and one click to write (their mail address) or to log the contact.
   * The pick is the AI's, cached for a few hours; "Suggest again" asks anew.
   * Without an AI provider it says so — no list made up instead. A contact
   * logged here drops out (it has been acted on).
   */
  let {
    today,
    load = loadNextUp,
    askStage = true,
    logError = null,
  }: {
    today: string
    /** Fetches the pick (tests pass a double). */
    load?: LoadNextUp
    /** The log form offers "Where they are now" (the pipeline list). */
    askStage?: boolean
    /** The page's log failure, for the contact it was sent for. */
    logError?: { id: string; message: string; agent?: AgentReport | null } | null
  } = $props()

  type View =
    | { status: 'loading' }
    | { status: 'ready'; nextUp: NextUp }
    | { status: 'unavailable'; message: string }
    | { status: 'error'; message: string; agent: AgentReport | null }

  let view = $state<View>({ status: 'loading' })
  let busy = $state(false)
  let openId = $state<string | null>(null)

  const opened = $derived(
    view.status === 'ready'
      ? (view.nextUp.items.find((i) => i.contact.id === openId) ?? null)
      : null,
  )

  async function run(refresh: boolean): Promise<void> {
    busy = true
    try {
      const out = await load(refresh)
      view = out.ok
        ? { status: 'ready', nextUp: out.nextUp }
        : out.unavailable
          ? { status: 'unavailable', message: out.message }
          : { status: 'error', message: out.message, agent: out.agent ?? null }
    } catch (err) {
      view = {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        agent: null,
      }
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void run(false)
  })

  function writeHref(item: NextUpItem): string | null {
    const mail = item.contact.channels.find((c) => c.type === 'email')
    return mail ? channelHref(mail) : null
  }

  const timeOf = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

  async function logged(): Promise<void> {
    openId = null
    await run(false)
  }
</script>

<section
  aria-labelledby="next-up-title"
  aria-busy={busy}
  class="rounded-xl border border-border bg-card px-3 py-3 sm:px-4"
  data-testid="next-up"
>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex min-w-0 items-center gap-2">
      <span class="mark mark-yellow size-6 rounded-full" aria-hidden="true"
        ><Sparkles class="size-3.5" strokeWidth={2} /></span
      >
      <h2 id="next-up-title" class="text-[15px] leading-snug font-medium">Next up</h2>
      {#if view.status === 'ready'}
        <span class="text-xs text-muted-foreground" data-testid="next-up-when"
          >Suggested by the assistant at {timeOf(view.nextUp.generatedAt)}</span
        >
      {/if}
    </div>
    {#if view.status !== 'unavailable'}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onclick={() => run(true)}
        data-testid="next-up-refresh"
      >
        <RefreshCw class={busy ? 'animate-spin' : ''} aria-hidden="true" />
        Suggest again
      </Button>
    {/if}
  </div>

  {#if view.status === 'loading'}
    <p class="mt-2 text-sm text-muted-foreground" data-testid="next-up-loading">
      Finding who to write to next…
    </p>
  {:else if view.status === 'unavailable'}
    <p class="mt-2 text-sm text-muted-foreground" data-testid="next-up-unavailable">
      {view.message}
    </p>
  {:else if view.status === 'error'}
    <ErrorNotice
      error={view.message}
      agent={view.agent}
      attempted="Loading who to write to next (/api/contacts/next-up)"
      class="mt-2"
      testid="next-up-error"
    />
  {:else if view.nextUp.items.length === 0}
    <p class="mt-2 text-sm text-muted-foreground" data-testid="next-up-empty">
      Nobody to write to right now. Add contacts or put them in your pipeline and the assistant
      suggests who’s next.
    </p>
  {:else}
    <ol
      class="mt-3 flex snap-x gap-2 overflow-x-auto pb-1"
      aria-label="Who to write to next"
      data-testid="next-up-items"
    >
      {#each view.nextUp.items as item (item.contact.id)}
        {@const href = writeHref(item)}
        <li
          class="flex w-64 shrink-0 snap-start flex-col gap-1.5 rounded-lg border border-border bg-background px-3 py-2.5"
          data-testid="next-up-item"
          data-kind={item.kind}
        >
          <div class="min-w-0">
            <a
              class="block truncate text-sm font-medium hover:underline"
              href={resolve(`/m/email/people/${item.contact.id}`)}>{item.contact.name}</a
            >
            {#if item.contact.organisation}<p class="truncate text-xs text-muted-foreground">
                {item.contact.organisation}
              </p>{/if}
          </div>
          <p class="line-clamp-2 text-xs" data-testid="next-up-reason">{item.reason}</p>
          <div class="mt-auto flex flex-wrap gap-1.5 pt-1">
            {#if href}
              <Button
                variant="outline"
                size="sm"
                {href}
                aria-label={`${NEXT_UP_KIND_LABELS[item.kind]}: ${item.contact.name}`}
              >
                {NEXT_UP_KIND_LABELS[item.kind]}
              </Button>
            {:else}
              <Button
                variant="outline"
                size="sm"
                href={resolve(`/m/email/people/${item.contact.id}`)}
                aria-label={`${NEXT_UP_KIND_LABELS[item.kind]}: open ${item.contact.name}`}
              >
                {NEXT_UP_KIND_LABELS[item.kind]}
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={openId === item.contact.id}
              aria-label={`Log contact with ${item.contact.name}`}
              onclick={() => (openId = openId === item.contact.id ? null : item.contact.id)}
            >
              Log contact
            </Button>
          </div>
        </li>
      {/each}
    </ol>
    {#if opened}
      <div class="mt-3">
        {#key opened.contact.id}
          <LogContactForm
            contactId={opened.contact.id}
            name={opened.contact.name}
            {today}
            {askStage}
            error={logError && logError.id === opened.contact.id ? logError.message : null}
            agent={logError && logError.id === opened.contact.id ? (logError.agent ?? null) : null}
            oncancel={() => (openId = null)}
            ondone={logged}
          />
        {/key}
      </div>
    {/if}
  {/if}
</section>
