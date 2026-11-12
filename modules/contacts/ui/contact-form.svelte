<script lang="ts">
  import type { ChannelType, ContactDto } from '../types'
  import { untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { CHANNEL_LABELS, CHANNEL_TYPES, CONTACT_LIMITS, DEFAULT_TAGS } from '../types'

  /**
   * Add or edit a contact: who they are, how to reach them (any number of
   * channels), where you met, why they matter (the default tags plus your
   * own), and the next follow-up. Posts every field; blank clears it.
   */
  let {
    contact = null,
    suggestedTags = [],
    action,
    submitLabel,
    error = null,
    offerShare = false,
  }: {
    contact?: ContactDto | null
    /** Tags in use elsewhere, offered as choices beside the default ones. */
    suggestedTags?: readonly string[]
    /** The form action (`?/save`); omitted = the page's default action. */
    action?: string
    submitLabel: string
    error?: string | null
    /** The create form: offer "share with the company" right away. */
    offerShare?: boolean
  } = $props()

  type Row = { key: number; type: ChannelType; value: string }
  let nextKey = 0
  const row = (type: ChannelType, value: string): Row => ({ key: nextKey++, type, value })
  const initial = untrack(() => contact?.channels ?? [])
  let rows = $state<Row[]>(initial.length > 0 ? initial.map((c) => row(c.type, c.value)) : [row('email', '')])

  const tagChoices = $derived([...new Set([...DEFAULT_TAGS, ...suggestedTags, ...(contact?.tags ?? [])])])
  const has = (tag: string) => contact?.tags.includes(tag) ?? false

  function addRow() {
    rows.push(row('phone', ''))
  }
  function removeRow(key: number) {
    rows = rows.filter((r) => r.key !== key)
    if (rows.length === 0) rows.push(row('email', ''))
  }
</script>

<form
  method="POST"
  {action}
  class="grid max-w-2xl gap-5"
  data-testid="contact-form"
  use:enhance={() =>
    async ({ update }) =>
      update({ reset: false })}
>
  <div class="grid gap-4 sm:grid-cols-2">
    <div class="grid gap-1.5 sm:col-span-2">
      <Label for="contact-name">Name</Label>
      <Input id="contact-name" name="name" required maxlength={CONTACT_LIMITS.name} value={contact?.name ?? ''} />
    </div>
    <div class="grid gap-1.5">
      <Label for="contact-organisation">Organisation</Label>
      <Input
        id="contact-organisation"
        name="organisation"
        maxlength={CONTACT_LIMITS.organisation}
        value={contact?.organisation ?? ''}
      />
    </div>
    <div class="grid gap-1.5">
      <Label for="contact-title">Role or title</Label>
      <Input id="contact-title" name="title" maxlength={CONTACT_LIMITS.title} value={contact?.title ?? ''} />
    </div>
  </div>

  <fieldset class="grid gap-2" data-testid="contact-channels">
    <legend class="mb-1 text-sm font-medium">How to reach them</legend>
    {#each rows as r, i (r.key)}
      <div class="flex flex-wrap items-center gap-2" data-testid="channel-row">
        <select
          name="channelType"
          aria-label={`Channel ${i + 1} type`}
          class="border-input bg-card h-8 rounded-md border px-2 text-xs"
          bind:value={r.type}
        >
          {#each CHANNEL_TYPES as type (type)}
            <option value={type}>{CHANNEL_LABELS[type]}</option>
          {/each}
        </select>
        <Input
          class="min-w-48 flex-1"
          name="channelValue"
          aria-label={`Channel ${i + 1}`}
          maxlength={CONTACT_LIMITS.channelValue}
          placeholder={r.type === 'email'
            ? 'name@example.com'
            : r.type === 'phone'
              ? '+49 30 1234567'
              : r.type === 'linkedin'
                ? 'https://www.linkedin.com/in/…'
                : r.type === 'website'
                  ? 'https://…'
                  : 'Signal, a postal address, …'}
          bind:value={r.value}
        />
        <Button type="button" variant="ghost" size="sm" onclick={() => removeRow(r.key)} aria-label={`Remove channel ${i + 1}`}>
          Remove
        </Button>
      </div>
    {/each}
    {#if rows.length < CONTACT_LIMITS.channels}
      <div>
        <Button type="button" variant="outline" size="sm" onclick={addRow}>Add a channel</Button>
      </div>
    {/if}
  </fieldset>

  <div class="grid gap-1.5">
    <Label for="contact-met">Where or how you met</Label>
    <Textarea
      id="contact-met"
      name="metHow"
      rows={2}
      maxlength={CONTACT_LIMITS.metHow}
      placeholder="e.g. Founders breakfast in Berlin, introduced by Ana"
      value={contact?.metHow ?? ''}
    />
  </div>

  <fieldset class="grid gap-2" data-testid="contact-tags">
    <legend class="mb-1 text-sm font-medium">Why they matter</legend>
    <div class="flex flex-wrap gap-2">
      {#each tagChoices as tag (tag)}
        <label
          class="flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs has-[:checked]:border-foreground has-[:checked]:bg-muted"
        >
          <input type="checkbox" name="tag" value={tag} checked={has(tag)} class="size-3.5" />
          {tag}
        </label>
      {/each}
    </div>
    <div class="grid gap-1.5">
      <Label for="contact-custom-tags" class="text-xs font-normal text-muted-foreground"
        >Your own tags, separated by commas</Label
      >
      <Input id="contact-custom-tags" name="customTags" placeholder="e.g. press, mentor" />
    </div>
    <Textarea
      name="whyRelevant"
      aria-label="Why they matter, in your words"
      rows={3}
      maxlength={CONTACT_LIMITS.whyRelevant}
      placeholder="Why this person is relevant to you"
      value={contact?.whyRelevant ?? ''}
    />
  </fieldset>

  <div class="grid gap-4 sm:grid-cols-3">
    <div class="grid gap-1.5">
      <Label for="contact-last">Last in touch</Label>
      <Input id="contact-last" name="lastContactedOn" type="date" value={contact?.lastContactedOn ?? ''} />
    </div>
    <div class="grid gap-1.5">
      <Label for="contact-next">Next follow-up</Label>
      <Input id="contact-next" name="nextFollowUpOn" type="date" value={contact?.nextFollowUpOn ?? ''} />
    </div>
    <div class="grid gap-1.5">
      <Label for="contact-step">Next step</Label>
      <Input
        id="contact-step"
        name="nextStep"
        maxlength={CONTACT_LIMITS.nextStep}
        placeholder="e.g. Send the deck"
        value={contact?.nextStep ?? ''}
      />
    </div>
  </div>

  {#if offerShare}
    <label class="flex items-start gap-2 text-sm">
      <input type="checkbox" name="shared" class="mt-0.5" data-testid="contact-share-now" />
      <span>
        Share with the company
        <span class="block text-xs text-muted-foreground"
          >Unchecked, only you, the company owner and admins can see this contact.</span
        >
      </span>
    </label>
  {/if}

  {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
  <div>
    <Button type="submit" data-testid="contact-submit">{submitLabel}</Button>
  </div>
</form>
