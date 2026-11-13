<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'
  import { relativeDays, visibilityText } from '../../../../../../../modules/contacts/types'
  import ChannelLinks from '../../../../../../../modules/contacts/ui/channel-links.svelte'
  import ContactForm from '../../../../../../../modules/contacts/ui/contact-form.svelte'
  import LogContactForm from '../../../../../../../modules/contacts/ui/log-contact-form.svelte'

  /** /m/email/people/[id]: one person — who can see them, log a contact, edit, share, delete. */
  let { data, form }: PageProps = $props()
  const c = $derived(data.contact)
  const errorFor = (action: string) => (form && 'error' in form && form.action === action ? form.error : null)
  const saved = $derived(form && !('error' in form) && form.action === 'save')
  const days = (day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${data.today}T00:00:00Z`)) / 86_400_000)
</script>

<svelte:head><title>{docTitle(c.name, 'Contacts')}</title></svelte:head>

<a class="text-sm text-muted-foreground hover:text-foreground" href={resolve('/m/email/people')}>← All contacts</a>
<div class="mt-3">
  <SectionHeader title={c.name} description={[c.title, c.organisation].filter(Boolean).join(' · ') || null} />
</div>

<div class="mt-5 grid max-w-2xl gap-4">
  <aside
    role="note"
    aria-label="Who can see this contact"
    class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm"
    data-testid="contact-visibility"
  >
    <p>
      {visibilityText(c)}
      {#if !c.own}<span class="block text-xs text-muted-foreground">Added by {c.createdByName}.</span>{/if}
    </p>
    {#if c.canManage}
      <form method="POST" action="?/share" use:enhance>
        <input type="hidden" name="shared" value={c.shared ? 'false' : 'true'} />
        <Button type="submit" variant="outline" size="sm" data-testid="contact-share-toggle"
          >{c.shared ? 'Make private' : 'Share with the company'}</Button
        >
      </form>
    {/if}
    {#if errorFor('share')}<p class="w-full text-sm text-destructive" role="alert">{errorFor('share')}</p>{/if}
  </aside>

  <ChannelLinks channels={c.channels} />

  <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]" data-testid="contact-summary">
    {#if c.tags.length > 0}
      <dt class="text-muted-foreground">Tags</dt>
      <dd class="flex flex-wrap gap-1.5">
        {#each c.tags as tag (tag)}<span class="rounded-full border border-border px-2 py-0.5 text-[11px]">{tag}</span>{/each}
      </dd>
    {/if}
    {#if c.whyRelevant}
      <dt class="text-muted-foreground">Why they matter</dt>
      <dd class="whitespace-pre-line">{c.whyRelevant}</dd>
    {/if}
    {#if c.metHow}
      <dt class="text-muted-foreground">Where you met</dt>
      <dd class="whitespace-pre-line">{c.metHow}</dd>
    {/if}
    <dt class="text-muted-foreground">Last in touch</dt>
    <dd>{c.lastContactedOn ? `${c.lastContactedOn} (${relativeDays(days(c.lastContactedOn))})` : 'Not logged yet'}</dd>
    <dt class="text-muted-foreground">Next follow-up</dt>
    <dd data-testid="contact-next">
      {#if c.nextFollowUpOn}
        {c.nextFollowUpOn} ({relativeDays(days(c.nextFollowUpOn))}){#if c.nextStep}: {c.nextStep}{/if}
      {:else}
        None set
      {/if}
    </dd>
  </dl>
</div>

<SectionHeader title="Log a contact" description="You were in touch: say when, and what comes next (or nothing)." />
<div class="mt-3 max-w-2xl">
  {#key c.updatedAt}
    <LogContactForm contactId={c.id} name={c.name} today={data.today} error={errorFor('log')} />
  {/key}
</div>

<SectionHeader title="Details" testid="contact-edit-section" />
<div class="mt-3">
  <!-- Re-rendered from what is stored after every change (a failed save keeps what you typed). -->
  {#key c.updatedAt}
    <ContactForm contact={c} suggestedTags={data.tags} action="?/save" submitLabel="Save" error={errorFor('save')} />
  {/key}
  {#if saved}<p class="mt-2 text-sm text-muted-foreground" role="status">Saved.</p>{/if}
</div>

{#if c.canManage}
  <SectionHeader title="Delete" description="Removes this contact for everyone who can see it. This can’t be undone." />
  <form
    method="POST"
    action="?/delete"
    class="mt-3"
    use:enhance={({ cancel }) => {
      if (!confirm(`Delete ${c.name} from Contacts? This can’t be undone.`)) cancel()
    }}
  >
    <Button type="submit" variant="destructive" data-testid="contact-delete">Delete contact</Button>
    {#if errorFor('delete')}<p class="mt-2 text-sm text-destructive" role="alert">{errorFor('delete')}</p>{/if}
  </form>
{/if}
