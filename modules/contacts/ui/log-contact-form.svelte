<script lang="ts">
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { CONTACT_LIMITS } from '../types'

  /**
   * "Log a contact": you were in touch (today unless you say otherwise). The
   * follow-up this answered is done — set the next one here, or leave it
   * empty for none.
   */
  let {
    contactId,
    name,
    today,
    action = '?/log',
    error = null,
    oncancel,
    ondone,
  }: {
    contactId: string
    name: string
    today: string
    action?: string
    error?: string | null
    oncancel?: () => void
    /** After a successful log (the page data is already refreshed). */
    ondone?: () => void
  } = $props()
</script>

<form
  method="POST"
  {action}
  class="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-[auto_auto_1fr] sm:items-end"
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
    <Input id={`log-on-${contactId}`} name="on" type="date" required value={today} max={today} />
  </div>
  <div class="grid gap-1.5">
    <Label for={`log-next-${contactId}`}>Next follow-up</Label>
    <Input id={`log-next-${contactId}`} name="nextFollowUpOn" type="date" />
  </div>
  <div class="grid gap-1.5">
    <Label for={`log-step-${contactId}`}>Next step</Label>
    <Input
      id={`log-step-${contactId}`}
      name="nextStep"
      maxlength={CONTACT_LIMITS.nextStep}
      placeholder="Leave both empty if there is nothing next"
    />
  </div>
  {#if error}<p class="text-sm text-destructive sm:col-span-3" role="alert">{error}</p>{/if}
  <div class="flex gap-2 sm:col-span-3">
    <Button type="submit" size="sm" data-testid="log-contact-submit">Log it</Button>
    {#if oncancel}<Button type="button" size="sm" variant="ghost" onclick={oncancel}>Cancel</Button>{/if}
  </div>
</form>
