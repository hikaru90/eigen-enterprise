<script lang="ts">
  import type { ChannelType, ContactDto, ContactDraft } from '../types'
  import { untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { readDescription, type ReadDescription } from '../client'
  import { CONTACT_FIELDS, newChannels, newTags, planFields, type Change, type ContactFieldKey } from '../prefill'
  import { CHANNEL_LABELS, CHANNEL_TYPES, CONTACT_LIMITS, DEFAULT_TAGS } from '../types'
  import DescribeThem from './describe-them.svelte'

  /**
   * Add or edit a contact: who they are, how to reach them (any number of
   * channels), where you met, why they matter (the default tags plus your
   * own), and the next follow-up. Posts every field; blank clears it.
   *
   * "Tell me about them" (above the fields): say or type who they are and the
   * AI prefills the form. Empty fields are filled in; a field that already
   * holds something else is listed as a change to accept or keep; channels and
   * tags are only added. Nothing is saved until the person presses Save.
   */
  let {
    contact = null,
    suggestedTags = [],
    action,
    submitLabel,
    error = null,
    offerShare = false,
    describeOpen = false,
    read = readDescription,
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
    /** Start with "Tell me about them" unfolded (the create form). */
    describeOpen?: boolean
    /** The AI's reading of a description (tests pass a double). */
    read?: ReadDescription
  } = $props()

  type Row = { key: number; type: ChannelType; value: string }
  let nextKey = 0
  const row = (type: ChannelType, value: string): Row => ({ key: nextKey++, type, value })
  const start = untrack(() => contact)
  const initial = start?.channels ?? []
  let rows = $state<Row[]>(initial.length > 0 ? initial.map((c) => row(c.type, c.value)) : [row('email', '')])

  let fields = $state<Record<ContactFieldKey, string>>({
    name: start?.name ?? '',
    organisation: start?.organisation ?? '',
    title: start?.title ?? '',
    metHow: start?.metHow ?? '',
    whyRelevant: start?.whyRelevant ?? '',
    lastContactedOn: start?.lastContactedOn ?? '',
    nextFollowUpOn: start?.nextFollowUpOn ?? '',
    nextStep: start?.nextStep ?? '',
  })
  let checked = $state<string[]>([...(start?.tags ?? [])])

  const tagChoices = $derived([...new Set([...DEFAULT_TAGS, ...suggestedTags, ...(contact?.tags ?? []), ...checked])])

  /** What the last reading did, and the changes still to decide on. */
  let prefilled = $state<string | null>(null)
  let changes = $state<Change<ContactFieldKey>[]>([])

  function addRow() {
    rows.push(row('phone', ''))
  }
  function removeRow(key: number) {
    rows = rows.filter((r) => r.key !== key)
    if (rows.length === 0) rows.push(row('email', ''))
  }

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  function applyDraft(draft: ContactDraft): void {
    const plan = planFields(CONTACT_FIELDS, fields, draft)
    for (const f of plan.filled) fields[f.key] = f.value
    const channels = newChannels(rows, draft.channels)
    if (channels.length > 0) rows = [...rows.filter((r) => r.value.trim() !== ''), ...channels.map((c) => row(c.type, c.value))]
    const tags = newTags(checked, draft.tags)
    checked = [...checked, ...tags]
    changes = plan.changes

    const done = [
      ...plan.filled.map((f) => f.label),
      ...(channels.length > 0 ? [plural(channels.length, 'way to reach them', 'ways to reach them')] : []),
      ...(tags.length > 0 ? [`${tags.length === 1 ? 'tag' : 'tags'} ${tags.join(', ')}`] : []),
    ]
    const parts = [
      done.length > 0 ? `Filled in: ${done.join(', ')}.` : changes.length > 0 ? '' : 'Nothing new to fill in from that.',
      changes.length > 0 ? `${plural(changes.length, 'field already holds', 'fields already hold')} something else — see below.` : '',
      `Check the form; nothing is saved until you press ${submitLabel}.`,
    ]
    prefilled = parts.filter(Boolean).join(' ')
  }

  async function onread(text: string): Promise<void> {
    applyDraft(await read('contact', text))
  }

  function accept(c: Change<ContactFieldKey>): void {
    fields[c.key] = c.to
    changes = changes.filter((x) => x.key !== c.key)
  }
  function keep(c: Change<ContactFieldKey>): void {
    changes = changes.filter((x) => x.key !== c.key)
  }
  function acceptAll(): void {
    for (const c of changes) fields[c.key] = c.to
    changes = []
  }
</script>

<div class="grid max-w-2xl gap-5">
  <DescribeThem
    summary="Tell me about them"
    hint="Say or type it freely: who they are, what they do, why they’re interesting for us, how you met, how to reach them, what comes next. The AI fills in the form below — you check it and save."
    placeholder="e.g. Mara Voss, partner at Northwind Capital, we met at the founders breakfast in Berlin. She leads seed rounds — I’ll send her the deck next week. mara@northwind.example"
    open={describeOpen}
    testid="contact-describe"
    {onread}
  />

  {#if prefilled}
    <p class="text-sm text-muted-foreground" role="status" data-testid="contact-prefilled">{prefilled}</p>
  {/if}
  {#if changes.length > 0}
    <section
      class="grid gap-2 rounded-lg border border-border p-3"
      aria-label="Changes from what you said"
      data-testid="contact-changes"
    >
      <p class="text-sm font-medium">These fields already hold something else. Use what you said?</p>
      <ul class="grid gap-2">
        {#each changes as c (c.key)}
          <li class="grid gap-1 text-sm sm:grid-cols-[10rem_1fr_auto] sm:items-center" data-testid="contact-change">
            <span class="text-muted-foreground">{c.label}</span>
            <span class="min-w-0 [overflow-wrap:anywhere]">
              <del class="text-muted-foreground">{c.from}</del>
              <span aria-hidden="true"> → </span><span class="sr-only"> would become </span>
              <ins class="no-underline">{c.to}</ins>
            </span>
            <span class="flex gap-1">
              <Button type="button" size="sm" variant="outline" aria-label={`Use the new ${c.label.toLowerCase()}`} onclick={() => accept(c)}
                >Use new</Button
              >
              <Button type="button" size="sm" variant="ghost" aria-label={`Keep the current ${c.label.toLowerCase()}`} onclick={() => keep(c)}
                >Keep</Button
              >
            </span>
          </li>
        {/each}
      </ul>
      {#if changes.length > 1}
        <div><Button type="button" size="sm" variant="outline" onclick={acceptAll}>Use all new values</Button></div>
      {/if}
    </section>
  {/if}

  <form
    method="POST"
    {action}
    class="grid gap-5"
    data-testid="contact-form"
    use:enhance={() =>
      async ({ update }) =>
        update({ reset: false })}
  >
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="grid gap-1.5 sm:col-span-2">
        <Label for="contact-name">Name</Label>
        <Input id="contact-name" name="name" required maxlength={CONTACT_LIMITS.name} bind:value={fields.name} />
      </div>
      <div class="grid gap-1.5">
        <Label for="contact-organisation">Organisation</Label>
        <Input
          id="contact-organisation"
          name="organisation"
          maxlength={CONTACT_LIMITS.organisation}
          bind:value={fields.organisation}
        />
      </div>
      <div class="grid gap-1.5">
        <Label for="contact-title">Role or title</Label>
        <Input id="contact-title" name="title" maxlength={CONTACT_LIMITS.title} bind:value={fields.title} />
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
        bind:value={fields.metHow}
      />
    </div>

    <fieldset class="grid gap-2" data-testid="contact-tags">
      <legend class="mb-1 text-sm font-medium">Why they matter</legend>
      <div class="flex flex-wrap gap-2">
        {#each tagChoices as tag (tag)}
          <label
            class="flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs has-[:checked]:border-foreground has-[:checked]:bg-muted"
          >
            <input type="checkbox" name="tag" value={tag} bind:group={checked} class="size-3.5" />
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
        bind:value={fields.whyRelevant}
      />
    </fieldset>

    <div class="grid gap-4 sm:grid-cols-3">
      <div class="grid gap-1.5">
        <Label for="contact-last">Last in touch</Label>
        <Input id="contact-last" name="lastContactedOn" type="date" bind:value={fields.lastContactedOn} />
      </div>
      <div class="grid gap-1.5">
        <Label for="contact-next">Next follow-up</Label>
        <Input id="contact-next" name="nextFollowUpOn" type="date" bind:value={fields.nextFollowUpOn} />
      </div>
      <div class="grid gap-1.5">
        <Label for="contact-step">Next step</Label>
        <Input
          id="contact-step"
          name="nextStep"
          maxlength={CONTACT_LIMITS.nextStep}
          placeholder="e.g. Send the deck"
          bind:value={fields.nextStep}
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
</div>
