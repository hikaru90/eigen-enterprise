<script lang="ts">
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { rhythmLine, WEEKDAY_LABELS } from '$lib/memory/reminder-format'
  import { m } from '$lib/paraglide/messages.js'
  import ActionFeedback from './action-feedback.svelte'
  import { feedbackFor } from './action-result'

  /**
   * An AI co-worker's rhythms in Settings → Co-workers (plan/phase-ai-coworkers.md
   * C6): its scheduled check-ins — days, time and zone, where it posts and what —
   * with add, edit, pause/resume, run now and delete (a second click names it).
   * Every button posts a form action that runs its coworkers.rhythm_* tool.
   */
  type Weekday = keyof typeof WEEKDAY_LABELS
  export type RhythmItem = {
    id: string
    weekdays: Weekday[]
    time: string
    timeZone: string
    instruction: string
    targetConversationId: string | null
    targetTitle: string | null
    hidden: boolean
    enabled: boolean
    nextAt: string | null
  }
  export type RhythmTargetItem = { id: string; title: string; kind: 'channel' | 'dm' }

  let {
    coworkerId,
    coworkerName,
    rhythms,
    targets,
    timeZone,
    form = null,
  }: {
    coworkerId: string
    coworkerName: string
    rhythms: RhythmItem[]
    targets: RhythmTargetItem[]
    /** The time zone a new rhythm starts in (the admin's own). */
    timeZone: string
    form?: unknown
  } = $props()

  const days = Object.entries(WEEKDAY_LABELS) as Array<[Weekday, string]>
  const WORKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR']
  let adding = $state(false)
  let editing = $state<string | null>(null)
  let confirmingDelete = $state<string | null>(null)

  const feedback = $derived(
    feedbackFor(form, 'rhythmCreate', coworkerId) ??
      feedbackFor(form, 'rhythmUpdate', coworkerId) ??
      feedbackFor(form, 'rhythmDelete', coworkerId) ??
      feedbackFor(form, 'rhythmRunNow', coworkerId),
  )
  const ranNow = $derived(feedbackFor(form, 'rhythmRunNow', coworkerId)?.kind === 'done')

  const nextFormat = (zone: string) =>
    new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone })
</script>

{#snippet fields(prefix: string, r: RhythmItem | null)}
  <input type="hidden" name="weekdays_sent" value="1" />
  <fieldset class="space-y-1">
    <legend class="text-sm font-medium">{m.coworkers_rhythm_field_days()}</legend>
    <div class="flex flex-wrap gap-1.5">
      {#each days as [code, label] (code)}
        <label class="cursor-pointer">
          <input
            type="checkbox"
            name="weekdays"
            value={code}
            checked={(r?.weekdays ?? WORKDAYS).includes(code)}
            class="peer sr-only"
            data-testid="{prefix}-day-{code}"
          />
          <span
            class="inline-flex h-8 min-w-11 items-center justify-center rounded-full bg-muted px-2.5 text-sm text-muted-foreground peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
            >{label}</span
          >
        </label>
      {/each}
    </div>
  </fieldset>
  <div class="grid gap-3 sm:grid-cols-2">
    <div class="space-y-1">
      <label class="text-sm font-medium" for="{prefix}-time">{m.coworkers_rhythm_field_time()}</label>
      <Input id="{prefix}-time" name="time" type="time" required value={r?.time ?? '09:00'} data-testid="{prefix}-time" />
    </div>
    <div class="space-y-1">
      <label class="text-sm font-medium" for="{prefix}-zone">{m.coworkers_rhythm_field_zone()}</label>
      <Input id="{prefix}-zone" name="time_zone" required value={r?.timeZone ?? timeZone} dictation={false} data-testid="{prefix}-zone" />
    </div>
  </div>
  {#if !r || !r.hidden}
    <div class="space-y-1">
      <label class="text-sm font-medium" for="{prefix}-where">{m.coworkers_rhythm_field_where()}</label>
      <select
        id="{prefix}-where"
        name="conversation_id"
        required
        class="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
        data-testid="{prefix}-where"
      >
        {#if !r}<option value="" disabled selected>{m.coworkers_rhythm_pick_where()}</option>{/if}
        {#each targets as t (t.id)}
          <option value={t.id} selected={r?.targetConversationId === t.id}>{t.title}</option>
        {/each}
      </select>
    </div>
  {/if}
  <div class="space-y-1">
    <label class="text-sm font-medium" for="{prefix}-instruction">{m.coworkers_rhythm_field_instruction()}</label>
    <Textarea
      id="{prefix}-instruction"
      name="instruction"
      required
      rows={3}
      maxlength={2000}
      value={r?.instruction ?? ''}
      aria-describedby="{prefix}-instruction-hint"
      data-testid="{prefix}-instruction"
    />
    <p id="{prefix}-instruction-hint" class="text-xs text-muted-foreground">{m.coworkers_rhythm_instruction_hint()}</p>
  </div>
{/snippet}

<section class="mt-4 space-y-3 border-t border-border pt-4" aria-labelledby="rhythms-{coworkerId}" data-testid="coworker-rhythms">
  <div>
    <h4 id="rhythms-{coworkerId}" class="text-sm font-semibold">{m.coworkers_rhythms_heading()}</h4>
    <p class="text-xs text-muted-foreground">{m.coworkers_rhythms_intro()}</p>
  </div>

  {#if rhythms.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="rhythms-empty">{m.coworkers_rhythms_empty()}</p>
  {:else}
    <ul class="space-y-2">
      {#each rhythms as r (r.id)}
        <li class="rounded-md bg-muted/40 p-3" data-testid="rhythm" data-id={r.id} data-enabled={r.enabled}>
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0 space-y-0.5 text-sm">
              <p class="font-medium" data-testid="rhythm-schedule">{rhythmLine(r)}</p>
              <p class="text-muted-foreground" data-testid="rhythm-where">
                {r.hidden ? m.coworkers_rhythm_hidden() : m.coworkers_rhythm_in({ where: r.targetTitle ?? '' })} ·
                {r.enabled && r.nextAt ? nextFormat(r.timeZone).format(new Date(r.nextAt)) : m.coworkers_rhythm_paused()}
              </p>
              <p class="whitespace-pre-line" data-testid="rhythm-instruction">{r.instruction}</p>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <form method="post" action="?/rhythmRunNow" use:enhance>
                <input type="hidden" name="user_id" value={coworkerId} />
                <input type="hidden" name="rhythm_id" value={r.id} />
                <Button type="submit" variant="outline" size="sm" data-testid="rhythm-run-now">{m.coworkers_rhythm_run_now()}</Button>
              </form>
              <form method="post" action="?/rhythmUpdate" use:enhance>
                <input type="hidden" name="user_id" value={coworkerId} />
                <input type="hidden" name="rhythm_id" value={r.id} />
                <input type="hidden" name="enabled" value={r.enabled ? 'false' : 'true'} />
                <Button type="submit" variant="outline" size="sm" data-testid="rhythm-toggle"
                  >{r.enabled ? m.coworkers_rhythm_pause() : m.coworkers_rhythm_resume()}</Button
                >
              </form>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={editing === r.id}
                data-testid="rhythm-edit"
                onclick={() => (editing = editing === r.id ? null : r.id)}>{m.coworkers_edit()}</Button
              >
              {#if confirmingDelete === r.id}
                <form method="post" action="?/rhythmDelete" use:enhance class="flex items-center gap-1.5">
                  <input type="hidden" name="user_id" value={coworkerId} />
                  <input type="hidden" name="rhythm_id" value={r.id} />
                  <Button type="submit" variant="destructive" size="sm" data-testid="rhythm-delete-confirm">{m.coworkers_rhythm_delete_confirm()}</Button>
                  <Button type="button" variant="ghost" size="sm" onclick={() => (confirmingDelete = null)}>{m.coworkers_cancel()}</Button>
                </form>
              {:else}
                <Button type="button" variant="ghost" size="sm" data-testid="rhythm-delete" onclick={() => (confirmingDelete = r.id)}
                  >{m.coworkers_rhythm_delete()}</Button
                >
              {/if}
            </div>
          </div>
          {#if editing === r.id}
            <form
              method="post"
              action="?/rhythmUpdate"
              use:enhance={() =>
                async ({ result, update }) => {
                  await update({ reset: false })
                  if (result.type === 'success') editing = null
                }}
              class="mt-3 space-y-3"
              data-testid="rhythm-edit-form"
            >
              <input type="hidden" name="user_id" value={coworkerId} />
              <input type="hidden" name="rhythm_id" value={r.id} />
              {@render fields(`rhythm-${r.id}`, r)}
              <div class="flex gap-2">
                <Button type="submit" size="sm" data-testid="rhythm-save">{m.coworkers_rhythm_save()}</Button>
                <Button type="button" variant="ghost" size="sm" onclick={() => (editing = null)}>{m.coworkers_cancel()}</Button>
              </div>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if adding}
    {#if targets.length === 0}
      <p class="text-sm text-muted-foreground" data-testid="rhythm-no-targets">{m.coworkers_rhythm_no_targets()}</p>
    {:else}
      <form
        method="post"
        action="?/rhythmCreate"
        use:enhance={() =>
          async ({ result, update }) => {
            await update({ reset: false })
            if (result.type === 'success') adding = false
          }}
        class="space-y-3"
        data-testid="rhythm-new"
      >
        <input type="hidden" name="user_id" value={coworkerId} />
        {@render fields(`rhythm-new-${coworkerId}`, null)}
        <div class="flex gap-2">
          <Button type="submit" size="sm" data-testid="rhythm-create">{m.coworkers_rhythm_save()}</Button>
          <Button type="button" variant="ghost" size="sm" onclick={() => (adding = false)}>{m.coworkers_cancel()}</Button>
        </div>
      </form>
    {/if}
  {:else}
    <Button type="button" variant="outline" size="sm" data-testid="rhythm-add" onclick={() => (adding = true)}
      >{m.coworkers_rhythm_add()}<span class="sr-only">: {coworkerName}</span></Button
    >
  {/if}

  {#if ranNow}
    <p class="text-sm text-muted-foreground" role="status" data-testid="rhythm-queued">{m.coworkers_rhythm_queued()}</p>
  {:else if feedback}
    <ActionFeedback {feedback} testid="rhythm-feedback" />
  {/if}
</section>
