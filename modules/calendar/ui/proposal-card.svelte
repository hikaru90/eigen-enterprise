<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- mailHref and calendarHref come from the page, built on resolve() */
  import type { ProposalDto } from '../types'
  import type { SubmitFunction } from '@sveltejs/kit'
  import CalendarPlus from '@lucide/svelte/icons/calendar-plus'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { longDay } from './layout'

  /**
   * An appointment found agreed in a mail (plan/calendar.md §7, K7), on the
   * mail in the reader and in Calendar. Nothing is on the calendar or sent
   * until Accept: Accept adds the event and sends the invitation to the people
   * outside the company; Edit opens the event dialog prefilled (its Save
   * accepts); Dismiss closes it. Posts `?/acceptProposal` and
   * `?/dismissProposal` to the page it is on.
   */
  let {
    proposal,
    heading = 'Appointment in this mail',
    onedit,
    editHref,
    mailHref,
    calendarHref,
  }: {
    proposal: ProposalDto
    heading?: string
    /** Edit in place (Calendar opens its dialog) … */
    onedit?: () => void
    /** … or on Calendar (from the mail). */
    editHref?: string
    /** The mail it was found in (shown in Calendar). */
    mailHref?: string
    /** Where an accepted one is (its day in Calendar). */
    calendarHref?: string
  } = $props()

  let busy = $state(false)
  let error = $state<string | null>(null)

  const when = $derived(
    proposal.localStart.slice(0, 10) === proposal.localEnd.slice(0, 10)
      ? `${longDay(proposal.localStart.slice(0, 10))}, ${proposal.localStart.slice(11)} – ${proposal.localEnd.slice(11)}`
      : `${longDay(proposal.localStart.slice(0, 10))}, ${proposal.localStart.slice(11)} – ${longDay(proposal.localEnd.slice(0, 10))}, ${proposal.localEnd.slice(11)}`,
  )
  const guests = $derived(proposal.attendees.map((g) => g.name ?? g.email))
  const headingId = $derived(`proposal-${proposal.id}`)

  const decide: SubmitFunction = () => {
    busy = true
    error = null
    return async ({ result, update }) => {
      busy = false
      if (result.type === 'failure') {
        error = String((result.data as { error?: unknown } | undefined)?.error)
        return
      }
      if (result.type === 'error') {
        error = 'That didn’t work. Nothing was added or sent; try again in a moment.'
        return
      }
      await update()
    }
  }
</script>

{#if proposal.state !== 'dismissed'}
  <section class="grid gap-2 rounded-lg border border-border bg-card px-3 py-3 text-sm" aria-labelledby={headingId} data-testid="calendar-proposal">
    <h3 id={headingId} class="flex items-center gap-2 font-medium">
      <CalendarPlus class="size-4 shrink-0" aria-hidden="true" />
      {heading}
    </h3>
    <dl class="grid gap-1">
      <div><dt class="sr-only">Title</dt><dd class="font-medium">{proposal.title}</dd></div>
      <div><dt class="sr-only">When</dt><dd>{when} <span class="text-muted-foreground">({proposal.timeZone})</span></dd></div>
      {#if proposal.location}<div class="flex gap-1"><dt class="text-muted-foreground">Where:</dt><dd class="min-w-0 break-words">{proposal.location}</dd></div>{/if}
      {#if proposal.call}<div class="flex gap-1"><dt class="text-muted-foreground">Call:</dt><dd class="min-w-0 break-all">{proposal.call}</dd></div>{/if}
      <div class="flex gap-1"><dt class="text-muted-foreground">With:</dt><dd class="min-w-0 break-words">{guests.join(', ')}</dd></div>
      {#if mailHref}
        <div class="flex gap-1">
          <dt class="text-muted-foreground">From the mail:</dt>
          <dd class="min-w-0 truncate"><a class="underline underline-offset-4" href={mailHref}>{proposal.mail.subject || '(no subject)'}</a></dd>
        </div>
      {/if}
    </dl>

    {#if proposal.state === 'accepted'}
      <p class="text-[13px]" role="status" data-testid="calendar-proposal-accepted">
        Added to your calendar. The invitation went to {guests.join(', ')}.
        {#if calendarHref}<a class="underline underline-offset-4" href={calendarHref}>Open in Calendar</a>{/if}
      </p>
    {:else}
      <p class="text-[13px] text-muted-foreground">Nothing is on your calendar yet. Accept adds it and sends an invitation to {guests.join(', ')} from your address.</p>
      {#if error}<p class="text-[13px] text-destructive" role="alert" data-testid="calendar-proposal-error">{error}</p>{/if}
      <div class="flex flex-wrap items-center gap-2">
        <form method="POST" action="?/acceptProposal" use:enhance={decide}>
          <input type="hidden" name="proposalId" value={proposal.id} />
          <Button type="submit" size="sm" disabled={busy}>Accept</Button>
        </form>
        {#if onedit}
          <Button type="button" size="sm" variant="outline" disabled={busy} onclick={onedit}>Edit</Button>
        {:else if editHref}
          <Button href={editHref} size="sm" variant="outline">Edit</Button>
        {/if}
        <form method="POST" action="?/dismissProposal" use:enhance={decide}>
          <input type="hidden" name="proposalId" value={proposal.id} />
          <Button type="submit" size="sm" variant="ghost" disabled={busy}>Dismiss</Button>
        </form>
      </div>
    {/if}
  </section>
{/if}
