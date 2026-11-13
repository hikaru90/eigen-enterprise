<script lang="ts">
  import { untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { readDescription, type ReadDescription } from '../client'
  import { LOG_FIELDS, planFields, type Change, type LogFieldKey } from '../prefill'
  import { CONTACT_LIMITS } from '../types'
  import DescribeThem from './describe-them.svelte'

  /**
   * "Log a contact": you were in touch (today unless you say otherwise) and
   * how it went (kept in the contact's history). The
   * follow-up this answered is done — set the next one here, or leave it
   * empty for none. "Tell me how it went" (say or type it) prefills the
   * fields; a field you already changed is offered as a change, never
   * overwritten. Nothing is logged until you press "Log it".
   */
  let {
    contactId,
    name,
    today,
    action = '?/log',
    error = null,
    oncancel,
    ondone,
    read = readDescription,
  }: {
    contactId: string
    name: string
    today: string
    action?: string
    error?: string | null
    oncancel?: () => void
    /** After a successful log (the page data is already refreshed). */
    ondone?: () => void
    /** The AI's reading of a description (tests pass a double). */
    read?: ReadDescription
  } = $props()

  const startDay = untrack(() => today)
  let fields = $state<Record<LogFieldKey, string>>({ on: startDay, note: '', nextFollowUpOn: '', nextStep: '' })
  let prefilled = $state<string | null>(null)
  let changes = $state<Change<LogFieldKey>[]>([])

  async function onread(text: string): Promise<void> {
    const draft = await read('log', text)
    // "In touch on" starts at today: still today, it is not something you typed.
    const plan = planFields(LOG_FIELDS, fields, draft, { on: startDay })
    for (const f of plan.filled) fields[f.key] = f.value
    changes = plan.changes
    prefilled = [
      plan.filled.length > 0 ? `Filled in: ${plan.filled.map((f) => f.label).join(', ')}.` : changes.length > 0 ? '' : 'Nothing new to fill in from that.',
      'Nothing is logged until you press “Log it”.',
    ]
      .filter(Boolean)
      .join(' ')
  }

  function accept(c: Change<LogFieldKey>): void {
    fields[c.key] = c.to
    changes = changes.filter((x) => x.key !== c.key)
  }
  function keep(c: Change<LogFieldKey>): void {
    changes = changes.filter((x) => x.key !== c.key)
  }
</script>

<div class="grid gap-3 rounded-lg border border-border bg-muted/30 p-3">
  <DescribeThem
    summary="Tell me how it went"
    hint="Say or type it: when you were in touch, how it went and what comes next. The AI fills in the fields below — you check them and log it."
    placeholder="e.g. Spoke yesterday, she wants the deck — I’ll send it by next Thursday."
    testid={`log-describe-${contactId}`}
    {onread}
  />
  {#if prefilled}<p class="text-xs text-muted-foreground" role="status" data-testid="log-prefilled">{prefilled}</p>{/if}
  {#if changes.length > 0}
    <ul class="grid gap-1.5 text-sm" aria-label="Changes from what you said" data-testid="log-changes">
      {#each changes as c (c.key)}
        <li class="flex flex-wrap items-center gap-2" data-testid="log-change">
          <span class="text-muted-foreground">{c.label}</span>
          <span><del class="text-muted-foreground">{c.from}</del><span aria-hidden="true"> → </span><span class="sr-only"> would become </span><ins class="no-underline">{c.to}</ins></span>
          <Button type="button" size="sm" variant="outline" aria-label={`Use the new ${c.label.toLowerCase()}`} onclick={() => accept(c)}>Use new</Button>
          <Button type="button" size="sm" variant="ghost" aria-label={`Keep the current ${c.label.toLowerCase()}`} onclick={() => keep(c)}>Keep</Button>
        </li>
      {/each}
    </ul>
  {/if}
  <form
    method="POST"
    {action}
    class="grid gap-3 sm:grid-cols-[auto_auto_1fr] sm:items-end"
    aria-label={`Log a contact with ${name}`}
    data-testid="log-contact-form"
    use:enhance={() =>
      async ({ result, update }) => {
        await update({ reset: false })
        if (result.type === 'success') ondone?.()
      }}
  >
    <input type="hidden" name="id" value={contactId} />
    <div class="grid gap-1.5">
      <Label for={`log-on-${contactId}`}>In touch on</Label>
      <Input id={`log-on-${contactId}`} name="on" type="date" required bind:value={fields.on} max={today} />
    </div>
    <div class="grid gap-1.5 sm:col-span-3">
      <Label for={`log-note-${contactId}`}>How it went</Label>
      <Textarea
        id={`log-note-${contactId}`}
        name="note"
        rows={2}
        maxlength={CONTACT_LIMITS.logNote}
        placeholder="Optional: what you talked about, how it went"
        bind:value={fields.note}
      />
    </div>
    <div class="grid gap-1.5">
      <Label for={`log-next-${contactId}`}>Next follow-up</Label>
      <Input id={`log-next-${contactId}`} name="nextFollowUpOn" type="date" bind:value={fields.nextFollowUpOn} />
    </div>
    <div class="grid gap-1.5">
      <Label for={`log-step-${contactId}`}>Next step</Label>
      <Input
        id={`log-step-${contactId}`}
        name="nextStep"
        maxlength={CONTACT_LIMITS.nextStep}
        placeholder="Leave both empty if there is nothing next"
        bind:value={fields.nextStep}
      />
    </div>
    {#if error}<p class="text-sm text-destructive sm:col-span-3" role="alert">{error}</p>{/if}
    <div class="flex gap-2 sm:col-span-3">
      <Button type="submit" size="sm" data-testid="log-contact-submit">Log it</Button>
      {#if oncancel}<Button type="button" size="sm" variant="ghost" onclick={oncancel}>Cancel</Button>{/if}
    </div>
  </form>
</div>
