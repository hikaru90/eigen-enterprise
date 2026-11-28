<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import ActionFeedback from './action-feedback.svelte'
  import { feedbackFor } from './action-result'
  import AiMark from './ai-mark.svelte'
  import { draftFromCoworker, emptyDraft, type CardDraft, type CoworkerLike } from './card-draft'
  import CoworkerFields from './coworker-fields.svelte'
  import CoworkerUsage from './coworker-usage.svelte'
  import type { AiBilling } from '$lib/ai-usage/billing'
  import type { AiAmounts } from '$lib/ai-usage/overview'
  import type { AiUsagePeriod } from '$lib/ai-usage/view'
  import CoworkerRhythms, { type RhythmItem, type RhythmTargetItem } from './coworker-rhythms.svelte'
  import MentionHandle from './mention-handle.svelte'
  import { modelFamily, modelName, type ChatModelOption } from './model-family'

  /**
   * One AI co-worker in Settings → Co-workers: its role card at a glance, and
   * the owner's and admins' controls — edit (coworkers.update), switch on/off
   * (coworkers.enable / disable), remove (coworkers.remove, after a second
   * click that names it; the tool always asks and that click is the approval).
   * Below it, its rhythms (C6).
   */
  type Coworker = CoworkerLike & {
    id: string
    /** Its @handle in Messages. */
    slug: string
    enabled: boolean
    accountableHuman: { id: string; name: string } | null
    accountableHumans?: { id: string; name: string }[]
  }

  let {
    coworker: c,
    models,
    seats,
    form = null,
    rhythms,
    timeZone,
    usage = null,
  }: {
    coworker: Coworker
    models: ChatModelOption[]
    seats: { id: string; name: string; kind: 'human' | 'coworker' }[]
    /** The page's last action answer, shown when it is about this co-worker. */
    form?: unknown
    /** Its rhythms and where a new one can post (coworkers.rhythm_list). */
    rhythms: { rhythms: RhythmItem[]; targets: RhythmTargetItem[] }
    /** The time zone a new rhythm starts in. */
    timeZone: string
    /** Its AI usage of the page's period (wish acdb941e); null: not shown. */
    usage?: { amounts: AiAmounts | null; billing: AiBilling | null; period: AiUsagePeriod } | null
  } = $props()

  let editing = $state(false)
  let confirmingRemove = $state(false)
  let card = $state<CardDraft>(emptyDraft())

  const family = $derived(modelFamily(c.modelId))
  const managerIds = $derived(
    c.reportsToUserIds && c.reportsToUserIds.length > 0
      ? c.reportsToUserIds
      : c.reportsToUserId
        ? [c.reportsToUserId]
        : [],
  )
  const managerNames = $derived(
    managerIds.map((id) => seats.find((s) => s.id === id)?.name).filter((n): n is string => Boolean(n)),
  )
  const accountables = $derived(
    c.accountableHumans && c.accountableHumans.length > 0
      ? c.accountableHumans
      : c.accountableHuman
        ? [c.accountableHuman]
        : [],
  )
  const feedback = $derived(
    feedbackFor(form, 'update', c.id) ??
      feedbackFor(form, 'enable', c.id) ??
      feedbackFor(form, 'disable', c.id) ??
      feedbackFor(form, 'remove', c.id),
  )

  function startEdit() {
    card = draftFromCoworker(c)
    editing = true
  }

  const closeWhenSaved: SubmitFunction = () => async ({ result, update }) => {
    await update({ reset: false })
    if (result.type === 'success' && result.data?.ok === true) editing = false
  }
</script>

<li id="coworker-{c.id}" class="rounded-lg border border-border bg-card p-4" data-testid="coworker-card" data-id={c.id} data-enabled={c.enabled}>
  <div class="flex flex-wrap items-start gap-3">
    <UserAvatar name={c.name} image={c.image ?? null} size="md" />
    <div class="min-w-0 flex-1 space-y-0.5">
      <h3 class="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <a
          href={resolve('/(nucleus)/settings/org/[id]', { id: c.id })}
          class="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="coworker-profile-link">{c.name}</a
        >
        <AiMark {family} />
        <span class="text-xs font-normal text-muted-foreground" data-testid="coworker-status"
          >{c.enabled ? m.coworkers_on() : m.coworkers_off()}</span
        >
      </h3>
      <p class="text-sm text-muted-foreground">{c.title ?? ''}</p>
      <p class="text-xs text-muted-foreground">
        {modelName(c.modelId)} · {m.coworkers_daily_cap_value({ amount: c.dailyCapUsd.toFixed(2) })} ·
        {#if managerNames.length > 0}
          {m.coworkers_reports_to_name({ name: managerNames.join(', ') })}
        {:else}
          {m.coworkers_reports_to_owner()}
        {/if}
        {#if accountables.length > 0}· {m.coworkers_answers_to({ name: accountables.map((h) => h.name).join(', ') })}{/if}
      </p>
      <MentionHandle handle={c.slug} />
      {#if usage}
        <CoworkerUsage {...usage} href={(p) => `?usage=${p}`} />
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={editing}
        aria-controls="coworker-edit-{c.id}"
        data-testid="coworker-edit"
        onclick={() => (editing ? (editing = false) : startEdit())}>{m.coworkers_edit()}<span class="sr-only">: {c.name}</span></Button
      >
      <form method="post" action={c.enabled ? '?/disable' : '?/enable'} use:enhance>
        <input type="hidden" name="user_id" value={c.id} />
        <Button type="submit" variant="outline" size="sm" data-testid="coworker-toggle"
          >{c.enabled ? m.coworkers_switch_off() : m.coworkers_switch_on()}<span class="sr-only">: {c.name}</span></Button
        >
      </form>
      {#if confirmingRemove}
        <form method="post" action="?/remove" use:enhance class="flex items-center gap-2">
          <input type="hidden" name="user_id" value={c.id} />
          <Button type="submit" variant="destructive" size="sm" data-testid="coworker-remove-confirm"
            >{m.coworkers_remove_confirm({ name: c.name })}</Button
          >
          <Button type="button" variant="ghost" size="sm" onclick={() => (confirmingRemove = false)}>{m.coworkers_cancel()}</Button>
        </form>
      {:else}
        <Button type="button" variant="ghost" size="sm" data-testid="coworker-remove" onclick={() => (confirmingRemove = true)}
          >{m.coworkers_remove()}<span class="sr-only">: {c.name}</span></Button
        >
      {/if}
    </div>
  </div>

  {#if confirmingRemove}
    <p class="mt-2 text-sm text-muted-foreground" data-testid="coworker-remove-hint">{m.coworkers_remove_hint()}</p>
  {/if}

  {#if editing}
    <form
      id="coworker-edit-{c.id}"
      method="post"
      action="?/update"
      use:enhance={closeWhenSaved}
      class="mt-4 space-y-4 border-t border-border pt-4"
      data-testid="coworker-edit-form"
    >
      <input type="hidden" name="user_id" value={c.id} />
      <CoworkerFields idPrefix="coworker-{c.id}" bind:card {models} {seats} selfId={c.id} currentImage={c.image ?? null} />
      <div class="flex flex-wrap gap-2">
        <Button type="submit" size="sm" data-testid="coworker-save">{m.coworkers_save()}</Button>
        <Button type="button" variant="ghost" size="sm" onclick={() => (editing = false)}>{m.coworkers_cancel()}</Button>
      </div>
    </form>
  {/if}
  {#if feedback}
    <div class="mt-2"><ActionFeedback {feedback} testid="coworker-feedback" /></div>
  {/if}
  <CoworkerRhythms coworkerId={c.id} coworkerName={c.name} rhythms={rhythms.rhythms} targets={rhythms.targets} {timeZone} {form} />
</li>
