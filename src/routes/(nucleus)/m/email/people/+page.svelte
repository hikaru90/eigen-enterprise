<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- the tag filter links add a query string to resolve() */
  import type { PageProps } from './$types'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { shownErrorOf } from '$lib/errors/agent-report'
  import { docTitle } from '$lib/shell/title'
  import { changeSharing } from '../../../../../../modules/contacts/client'
  import ContactList from '../../../../../../modules/contacts/ui/contact-list.svelte'
  import ContactsPrivacyNote from '../../../../../../modules/contacts/ui/contacts-privacy-note.svelte'
  import NextUpStrip from '../../../../../../modules/contacts/ui/next-up-strip.svelte'

  /** /m/email/people: the assistant's "Next up", then everyone you know (by tag, by search). */
  let { data, form }: PageProps = $props()

  const base = resolve('/m/email/people')
  const filtered = $derived(data.filter.tag !== '' || data.filter.q.trim() !== '')
  const logError = $derived(
    form && 'error' in form && typeof form.error === 'string' && form.action === 'log' && form.id
      ? { id: form.id, message: form.error, agent: shownErrorOf(form)?.agent ?? null }
      : null,
  )

  /** The list filtered by this tag (null = every tag), keeping the search. */
  function tagHref(tag: string | null): string {
    const q = data.filter.q.trim()
    const query = [
      tag ? `tag=${encodeURIComponent(tag)}` : null,
      q ? `q=${encodeURIComponent(q)}` : null,
    ].filter(Boolean)
    return query.length > 0 ? `${base}?${query.join('&')}` : base
  }
</script>

<svelte:head><title>{docTitle('Contacts', 'Email')}</title></svelte:head>

<SectionHeader title="Contacts" testid="contacts-header">
  {#snippet info()}<ContactsPrivacyNote />{/snippet}
  {#snippet actions()}
    <Button variant="ghost" href="/m/email/people/settings" data-testid="contact-settings"
      >Settings</Button
    >
    <Button variant="outline" href="/m/email/people/pipeline" data-testid="contact-pipeline"
      >Pipeline</Button
    >
    <Button variant="outline" href="/m/email/people/import" data-testid="contact-import"
      >Import</Button
    >
    <Button href="/m/email/people/new" data-testid="contact-add">Add a contact</Button>
  {/snippet}
</SectionHeader>

<div class="mt-4"><NextUpStrip today={data.today} {logError} /></div>

<SectionHeader
  title="Everyone"
  description="Your contacts and the ones shared with the whole team or with you, by name. Select some to share them or make them private."
  testid="contacts-section"
/>
<div class="mt-3 grid gap-3">
  <form
    method="GET"
    action={base}
    class="flex max-w-2xl flex-wrap items-center gap-2"
    role="search"
    data-testid="contacts-search"
  >
    {#if data.filter.tag}<input type="hidden" name="tag" value={data.filter.tag} />{/if}
    <Input
      class="min-w-56 flex-1"
      type="search"
      name="q"
      aria-label="Search names and organisations"
      placeholder="Search names and organisations"
      value={data.filter.q}
    />
    <Button type="submit" variant="outline">Search</Button>
  </form>
  <nav class="flex flex-wrap gap-1.5" aria-label="Filter by tag" data-testid="contacts-tags">
    <a
      href={tagHref(null)}
      aria-current={data.filter.tag === '' ? 'page' : undefined}
      class="rounded-full border px-3 py-1 text-xs {data.filter.tag === ''
        ? 'border-foreground bg-muted font-medium'
        : 'border-border text-muted-foreground hover:text-foreground'}">All</a
    >
    {#each data.tags as tag (tag)}
      <a
        href={tagHref(tag)}
        aria-current={data.filter.tag === tag ? 'page' : undefined}
        class="rounded-full border px-3 py-1 text-xs {data.filter.tag === tag
          ? 'border-foreground bg-muted font-medium'
          : 'border-border text-muted-foreground hover:text-foreground'}">{tag}</a
      >
    {/each}
  </nav>
  <ContactList
    contacts={data.contacts}
    today={data.today}
    sharing={{ choices: data.choices, change: changeSharing, onchanged: () => invalidateAll() }}
    empty={filtered
      ? 'Nobody matches. Try another tag or search.'
      : 'No contacts yet. Add the people you know — where you met, why they matter, when to follow up.'}
  />
</div>
