<script lang="ts">
  import type { CardDraft } from './card-draft'
  import type { ChatModelOption } from './model-family'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { m } from '$lib/paraglide/messages.js'
  import AvatarPicker from './avatar-picker.svelte'
  import ModelSelect from './model-select.svelte'

  /**
   * The role card fields of a co-worker (create and edit share them): avatar,
   * name, title, accountabilities (one per line), lens, model, multi-manager
   * reports-to checkboxes and the daily cap. Names match the coworkers.* tool
   * inputs (the page server maps them through).
   */
  let {
    idPrefix,
    card = $bindable(),
    models,
    seats,
    selfId = null,
    currentImage = null,
  }: {
    idPrefix: string
    card: CardDraft
    models: ChatModelOption[]
    seats: { id: string; name: string; kind: 'human' | 'coworker' }[]
    /** The co-worker being edited: it cannot report to itself. */
    selfId?: string | null
    currentImage?: string | null
  } = $props()

  const managers = $derived(seats.filter((s) => s.id !== selfId))

  function toggleManager(id: string) {
    if (card.reportsTo.includes(id)) {
      card.reportsTo = card.reportsTo.filter((mId) => mId !== id)
    } else {
      card.reportsTo = [...card.reportsTo, id]
    }
  }
</script>

<div class="grid gap-4 sm:grid-cols-2">
  <div class="sm:col-span-2">
    <AvatarPicker
      {idPrefix}
      name={card.name}
      bind:avatarPreset={card.avatarPreset}
      bind:avatarSha256={card.avatarSha256}
      {currentImage}
    />
  </div>
  <div class="space-y-1">
    <label class="text-sm font-medium" for="{idPrefix}-name">{m.coworkers_field_name()}</label>
    <Input id="{idPrefix}-name" name="name" bind:value={card.name} maxlength={80} dictation={false} data-testid="{idPrefix}-name" />
  </div>
  <div class="space-y-1">
    <label class="text-sm font-medium" for="{idPrefix}-title">{m.org_field_title()}</label>
    <Input id="{idPrefix}-title" name="title" bind:value={card.title} required maxlength={120} data-testid="{idPrefix}-title" />
  </div>
  <div class="space-y-1 sm:col-span-2">
    <label class="text-sm font-medium" for="{idPrefix}-acc">{m.org_field_accountabilities()}</label>
    <Textarea
      id="{idPrefix}-acc"
      name="accountabilities"
      bind:value={card.accountabilities}
      required
      rows={4}
      aria-describedby="{idPrefix}-acc-hint"
      data-testid="{idPrefix}-accountabilities"
    />
    <p id="{idPrefix}-acc-hint" class="text-xs text-muted-foreground">{m.coworkers_accountabilities_hint()}</p>
  </div>
  <div class="space-y-1 sm:col-span-2">
    <label class="text-sm font-medium" for="{idPrefix}-lens">{m.coworkers_field_lens()}</label>
    <Textarea
      id="{idPrefix}-lens"
      name="lens"
      bind:value={card.lens}
      required
      rows={5}
      maxlength={4000}
      aria-describedby="{idPrefix}-lens-hint"
      data-testid="{idPrefix}-lens"
    />
    <p id="{idPrefix}-lens-hint" class="text-xs text-muted-foreground">{m.coworkers_lens_hint()}</p>
  </div>
  <div class="space-y-1">
    <label class="text-sm font-medium" for="{idPrefix}-model">{m.coworkers_field_model()}</label>
    <ModelSelect id="{idPrefix}-model" {models} bind:value={card.modelId} testid="{idPrefix}-model" />
  </div>
  <div class="space-y-1">
    <label class="text-sm font-medium" for="{idPrefix}-cap">{m.coworkers_field_daily_cap()}</label>
    <Input
      id="{idPrefix}-cap"
      name="daily_cap_usd"
      type="number"
      inputmode="decimal"
      min="0.01"
      max="1000"
      step="0.01"
      required
      bind:value={card.dailyCapUsd}
      dictation={false}
      aria-describedby="{idPrefix}-cap-hint"
      data-testid="{idPrefix}-cap"
    />
    <p id="{idPrefix}-cap-hint" class="text-xs text-muted-foreground">{m.coworkers_daily_cap_hint()}</p>
  </div>
  <fieldset class="space-y-2 sm:col-span-2" data-testid="{idPrefix}-manager">
    <legend class="text-sm font-medium">{m.org_field_reports_to()}</legend>
    <input type="hidden" name="reports_to_sent" value="1" />
    <!-- In the order chosen: the first is the primary manager (the chart's parent). -->
    {#each card.reportsTo as id (id)}<input type="hidden" name="reports_to_user_ids" value={id} />{/each}
    <div class="flex flex-wrap gap-2">
      {#each managers as s (s.id)}
        <label class="flex cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-2.5 py-1.5 text-sm">
          <input
            type="checkbox"
            value={s.id}
            checked={card.reportsTo.includes(s.id)}
            onchange={() => toggleManager(s.id)}
            data-testid="{idPrefix}-manager-option"
          />
          <span>{s.kind === 'coworker' ? m.org_option_coworker({ name: s.name }) : s.name}</span>
        </label>
      {/each}
    </div>
    <p class="text-xs text-muted-foreground">{m.coworkers_reports_to_multi_hint()}</p>
  </fieldset>
</div>
