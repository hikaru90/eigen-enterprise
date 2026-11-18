<script lang="ts">
  import type { ContactVisibility } from '../types'
  import { untrack } from 'svelte'
  import { resolve } from '$app/paths'
  import { CONTACT_VISIBILITIES, VISIBILITY_LABELS } from '../types'

  /**
   * Who sees a new contact (or an import): Private or Whole team, starting at
   * the person's default for new contacts (Contacts settings). Posts
   * `visibility` = private | team.
   */
  let {
    initial,
    plural = false,
    testid = 'contact-visibility',
  }: {
    /** The person's default (theirs, else the company's, else private). */
    initial: ContactVisibility
    /** An import: "them" instead of "it". */
    plural?: boolean
    testid?: string
  } = $props()

  // Starts at the default (the prop's first value); the person may change it here.
  let chosen = $state<ContactVisibility>(untrack(() => initial))

  const hint = $derived(
    chosen === 'team'
      ? `Everyone in the company, including people who join later, will see and update ${plural ? 'them' : 'it'}.`
      : `Only you, the company owner and admins will see ${plural ? 'them' : 'it'}.`,
  )
</script>

<fieldset class="grid gap-1.5" data-testid={testid}>
  <legend class="text-sm font-medium">Who sees {plural ? 'them' : 'it'}</legend>
  <div class="flex flex-wrap gap-4">
    {#each CONTACT_VISIBILITIES as v (v)}
      <label class="flex items-center gap-2 text-sm">
        <input type="radio" name="visibility" value={v} bind:group={chosen} data-testid={`${testid}-${v}`} />
        {VISIBILITY_LABELS[v]}
        {#if v === initial}<span class="text-xs text-muted-foreground">(your default)</span>{/if}
      </label>
    {/each}
  </div>
  <p class="text-xs text-muted-foreground">
    {hint}
    <a class="underline hover:text-foreground" href={resolve('/m/email/people/settings')}>Change your default</a>
  </p>
</fieldset>
