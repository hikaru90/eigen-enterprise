<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'
  import { VISIBILITY_LABELS } from '../../../../../../../modules/contacts/types'

  /**
   * Contacts settings: who sees a new contact by default. Your own choice wins
   * over the company's; with neither, new contacts are private.
   */
  let { data, form }: PageProps = $props()

  const d = $derived(data.defaults)
  const companyLabel = $derived(VISIBILITY_LABELS[d.company ?? 'private'])
  const errorFor = (action: string) => (form && 'error' in form && form.action === action ? form.error : null)
  const savedFor = (action: string) => form && 'saved' in form && form.action === action
</script>

<svelte:head><title>{docTitle('Contacts settings', 'Contacts')}</title></svelte:head>

<a class="text-sm text-muted-foreground hover:text-foreground" href={resolve('/m/email/people')}>← All contacts</a>
<div class="mt-3">
  <SectionHeader
    title="Contacts settings"
    description="Who sees a contact when it is added — by hand, by import or by the assistant. You can still change it for each contact, or for many at once in the list."
    testid="contacts-settings-header"
  />
</div>

<div class="mt-6 grid max-w-2xl gap-8">
  <form method="POST" action="?/mine" use:enhance class="grid gap-3" data-testid="contacts-default-mine">
    <fieldset class="grid gap-2">
      <legend class="text-sm font-medium">Your new contacts</legend>
      <label class="flex items-start gap-2 text-sm">
        <input type="radio" name="visibility" value="" class="mt-1" checked={d.person === null} />
        <span>Follow the company default <span class="text-muted-foreground">({companyLabel})</span></span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input type="radio" name="visibility" value="private" class="mt-1" checked={d.person === 'private'} />
        <span>Private <span class="block text-xs text-muted-foreground">Only you, the company owner and admins.</span></span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input type="radio" name="visibility" value="team" class="mt-1" checked={d.person === 'team'} />
        <span
          >Whole team <span class="block text-xs text-muted-foreground">Everyone in the company, including people who join later.</span
          ></span
        >
      </label>
    </fieldset>
    <p class="text-xs text-muted-foreground" data-testid="contacts-default-effective">
      New contacts you add start as: <span class="font-medium text-foreground">{VISIBILITY_LABELS[d.effective]}</span>.
    </p>
    {#if errorFor('mine')}<p class="text-sm text-destructive" role="alert">
        {errorFor('mine')}
      </p>{/if}
    <div class="flex items-center gap-3">
      <Button type="submit" data-testid="contacts-default-mine-save">Save</Button>
      {#if savedFor('mine')}<span class="text-xs text-muted-foreground" role="status">Saved.</span>{/if}
    </div>
  </form>

  {#if data.canSetCompany}
    <form
      method="POST"
      action="?/company"
      use:enhance
      class="grid gap-3 border-t border-border pt-6"
      data-testid="contacts-default-company"
    >
      <fieldset class="grid gap-2">
        <legend class="text-sm font-medium">Company default</legend>
        <p class="text-xs text-muted-foreground">
          For everyone who hasn’t chosen their own, and for contacts the assistant adds on its own. Owner and admins only.
        </p>
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="visibility" value="private" checked={d.company !== 'team'} />
          Private
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="visibility" value="team" checked={d.company === 'team'} />
          Whole team
        </label>
      </fieldset>
      {#if errorFor('company')}<p class="text-sm text-destructive" role="alert">
          {errorFor('company')}
        </p>{/if}
      <div class="flex items-center gap-3">
        <Button type="submit" variant="outline" data-testid="contacts-default-company-save">Save company default</Button>
        {#if savedFor('company')}<span class="text-xs text-muted-foreground" role="status">Saved.</span>{/if}
      </div>
    </form>
  {/if}
</div>
