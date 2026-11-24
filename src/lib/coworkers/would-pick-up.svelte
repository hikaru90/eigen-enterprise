<script lang="ts">
  import type { PickupCounts, PickupItem } from './pickup-format'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { m } from '$lib/paraglide/messages.js'
  import ActionFeedback from './action-feedback.svelte'
  import { feedbackFor } from './action-result'

  /**
   * "Would pick up" on an AI co-worker's profile, for owner and admins
   * (plan/phase-ai-coworkers.md C7): whether it notices new messages in its
   * channels (coworkers.event_subscriptions_set), what became of the events it
   * heard (counts, skipped ones included), the shadow decisions of kind
   * coworkers.event_mine (decisions.log) with Jev's choice and confidence, the
   * agreement with people's marks (decisions.kinds) — and "Theirs / Not theirs"
   * on each row (decisions.label). Nothing here acts: the kind is in shadow.
   */
  let {
    coworkerId,
    noticing,
    lastDay,
    agreement,
    items,
    form = null,
  }: {
    coworkerId: string
    /** Switched on for channel messages. */
    noticing: boolean
    lastDay: PickupCounts
    /** From decisions.kinds: Jev against people's marks; null while nothing was compared. */
    agreement: { agreed: number; compared: number } | null
    items: PickupItem[]
    form?: unknown
  } = $props()

  const timeFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const subscriptionFeedback = $derived(feedbackFor(form, 'eventSubscriptions', coworkerId))
  const labelFeedback = $derived(feedbackFor(form, 'labelDecision', coworkerId))
</script>

<section class="rounded-lg border border-border bg-card p-4" aria-labelledby="would-pick-up" data-testid="would-pick-up">
  <h3 id="would-pick-up" class="text-sm font-semibold">{m.coworkers_pickup_heading()}</h3>
  <p class="mt-0.5 text-xs text-muted-foreground">{m.coworkers_pickup_intro()}</p>

  <form method="post" action="?/eventSubscriptions" use:enhance={() => ({ update }) => update({ reset: false })} class="mt-3 flex flex-wrap items-center gap-3">
    <input type="hidden" name="user_id" value={coworkerId} />
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" name="event_kinds" value="channel_message" checked={noticing} class="size-4" data-testid="pickup-notice" />
      {m.coworkers_pickup_notice()}
    </label>
    <Button type="submit" variant="outline" size="sm" data-testid="pickup-save">{m.coworkers_pickup_save()}</Button>
  </form>
  <ActionFeedback feedback={subscriptionFeedback} testid="pickup-save-feedback" />

  <p class="mt-3 text-xs text-muted-foreground" data-testid="pickup-counts">
    {m.coworkers_pickup_counts({
      decided: String(lastDay.observed + lastDay.queued),
      cap: String(lastDay.skipped_daily_cap),
      author: String(lastDay.skipped_author_cap),
      failed: String(lastDay.failed),
    })}
  </p>
  <p class="text-xs text-muted-foreground" data-testid="pickup-agreement">
    {agreement ? m.coworkers_pickup_agreement({ agreed: String(agreement.agreed), compared: String(agreement.compared) }) : m.coworkers_pickup_agreement_none()}
  </p>

  {#if items.length === 0}
    <p class="mt-3 text-sm text-muted-foreground" data-testid="pickup-empty">{m.coworkers_pickup_empty()}</p>
  {:else}
    <ul class="mt-3 divide-y divide-border text-sm">
      {#each items as it (it.id)}
        <li class="space-y-1 py-2" data-testid="pickup" data-choice={it.jevChoice ?? 'none'} data-label={it.humanChoice ?? 'none'}>
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span class="min-w-0">
              <span class="font-medium" data-testid="pickup-choice"
                >{it.jevChoice === 'yes'
                  ? m.coworkers_pickup_choice_yes()
                  : it.jevChoice === 'no'
                    ? m.coworkers_pickup_choice_no()
                    : m.coworkers_pickup_no_answer()}</span
              >
              {#if it.jevConfidence !== null}
                <span class="text-muted-foreground tabular-nums"> · {m.coworkers_pickup_confidence({ percent: String(Math.round(it.jevConfidence * 100)) })}</span>
              {/if}
            </span>
            <span class="flex flex-wrap items-baseline gap-x-3 text-muted-foreground">
              <span>#{it.channel}{it.privateChannel ? ` · ${m.coworkers_pickup_private()}` : ''}</span>
              <time datetime={it.at}>{timeFormat.format(new Date(it.at))}</time>
              {#if it.threadUrl}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a server-built link with its query (the event's thread) -->
                <a class="text-foreground underline-offset-4 hover:underline" href={it.threadUrl} data-testid="pickup-link">{m.coworkers_pickup_open()}</a>
              {/if}
            </span>
          </div>
          {#if it.excerpt}
            <p class="line-clamp-2 text-muted-foreground" data-testid="pickup-excerpt">{it.excerpt}</p>
          {/if}
          <div class="flex flex-wrap items-center gap-1.5">
            {#if it.humanChoice}
              <span class="text-xs text-muted-foreground" data-testid="pickup-labelled"
                >{it.humanChoice === 'yes' ? m.coworkers_pickup_labelled_yes() : m.coworkers_pickup_labelled_no()}</span
              >
            {/if}
            {#if it.jevChoice !== null}
              {#each ['yes', 'no'] as const as choice (choice)}
                <form method="post" action="?/labelDecision" use:enhance>
                  <input type="hidden" name="user_id" value={coworkerId} />
                  <input type="hidden" name="decision_id" value={it.id} />
                  <input type="hidden" name="choice" value={choice} />
                  <Button
                    type="submit"
                    variant={it.humanChoice === choice ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={it.humanChoice === choice}
                    data-testid="pickup-label-{choice}">{choice === 'yes' ? m.coworkers_pickup_label_yes() : m.coworkers_pickup_label_no()}</Button
                  >
                </form>
              {/each}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <ActionFeedback feedback={labelFeedback} testid="pickup-label-feedback" />
</section>
