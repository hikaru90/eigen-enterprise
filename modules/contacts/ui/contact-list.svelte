<script lang="ts">
  import type { ContactDto } from '../types'
  import { resolve } from '$app/paths'
  import { relativeDays } from '../types'
  import ChannelLinks from './channel-links.svelte'

  /**
   * The people, by name: organisation and role, tags, how to reach them, when
   * you were last in touch, and who can see each one (private or shared).
   */
  let { contacts, today, empty }: { contacts: readonly ContactDto[]; today: string; empty: string } = $props()

  const daysSince = (day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)

  function seenBy(c: ContactDto): string {
    if (c.shared) return 'Shared with the company'
    return c.own ? 'Private' : `Private to ${c.createdByName}`
  }
</script>

{#if contacts.length === 0}
  <p class="text-sm text-muted-foreground" data-testid="contacts-empty">{empty}</p>
{:else}
  <ul class="divide-y divide-border rounded-lg border border-border" data-testid="contacts">
    {#each contacts as c (c.id)}
      <li class="grid gap-1.5 px-4 py-3 sm:px-5" data-testid="contact-row">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <a class="truncate text-sm font-medium hover:underline" href={resolve(`/m/email/people/${c.id}`)}>{c.name}</a>
            {#if c.organisation || c.title}
              <span class="text-xs text-muted-foreground">{[c.title, c.organisation].filter(Boolean).join(' · ')}</span>
            {/if}
          </div>
          <span class="text-xs text-muted-foreground" data-testid="contact-visibility">{seenBy(c)}</span>
        </div>
        {#if c.tags.length > 0}
          <ul class="flex flex-wrap gap-1.5" aria-label="Tags">
            {#each c.tags as tag (tag)}
              <li class="rounded-full border border-border px-2 py-0.5 text-[11px]">{tag}</li>
            {/each}
          </ul>
        {/if}
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <ChannelLinks channels={c.channels} limit={3} />
          {#if c.lastContactedOn}
            <span class="text-xs text-muted-foreground">Last in touch {relativeDays(daysSince(c.lastContactedOn))}</span>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
