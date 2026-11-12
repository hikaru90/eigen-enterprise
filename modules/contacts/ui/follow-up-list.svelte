<script lang="ts">
  import type { FollowUpDto } from '../types'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { FOLLOW_UP_WINDOW_DAYS, relativeDays } from '../types'
  import ChannelLinks from './channel-links.svelte'
  import LogContactForm from './log-contact-form.svelte'

  /**
   * "Follow up next" — who to write to next: what is overdue, due today and
   * coming up, soonest first, each with its next step and a way to reach
   * them. "Log contact" records you were in touch and sets the next one.
   */
  let {
    followUps,
    today,
    logError = null,
  }: {
    followUps: readonly FollowUpDto[]
    today: string
    /** The log form's failure, for the row it was sent from (that row's form stays open). */
    logError?: { id: string; message: string } | null
  } = $props()

  /** undefined = untouched (a log that failed without JS reopens its row); null = all closed. */
  let openId = $state<string | null | undefined>(undefined)
  const open = $derived(openId === undefined ? (logError?.id ?? null) : openId)

  const DUE_LABEL = { overdue: 'Overdue', today: 'Today', upcoming: 'Coming up' } as const
</script>

{#if followUps.length === 0}
  <p class="text-sm text-muted-foreground" data-testid="follow-ups-empty">
    Nothing to follow up in the next {FOLLOW_UP_WINDOW_DAYS} days. Give a contact a next follow-up and it shows up here.
  </p>
{:else}
  <ol class="divide-y divide-border rounded-lg border border-border" data-testid="follow-ups">
    {#each followUps as f (f.id)}
      <li class="grid gap-2 px-4 py-3 sm:px-5" data-testid="follow-up-row" data-due={f.due}>
        <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div class="min-w-0">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span
                class="text-xs font-medium {f.due === 'overdue'
                  ? 'text-destructive'
                  : f.due === 'today'
                    ? 'text-foreground'
                    : 'text-muted-foreground'}"
                data-testid="follow-up-when">{DUE_LABEL[f.due]} · {relativeDays(f.daysFromToday)}</span
              >
              <a class="text-sm font-medium hover:underline" href={resolve(`/m/contacts/${f.id}`)}>{f.name}</a>
              {#if f.organisation}<span class="text-xs text-muted-foreground">{f.organisation}</span>{/if}
            </div>
            {#if f.nextStep}<p class="mt-0.5 text-sm" data-testid="follow-up-step">{f.nextStep}</p>{/if}
            <div class="mt-1"><ChannelLinks channels={f.channels} limit={2} /></div>
          </div>
          {#if open !== f.id}
            <Button variant="outline" size="sm" onclick={() => (openId = f.id)}>Log contact</Button>
          {/if}
        </div>
        {#if open === f.id}
          <LogContactForm
            contactId={f.id}
            name={f.name}
            {today}
            error={logError && logError.id === f.id ? logError.message : null}
            oncancel={() => (openId = null)}
            ondone={() => (openId = null)}
          />
        {/if}
      </li>
    {/each}
  </ol>
{/if}
