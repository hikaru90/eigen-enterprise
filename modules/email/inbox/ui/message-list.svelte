<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- hrefs come from the page, built on resolve('/m/email/inbox') */
  import type { MessageListItem } from '../view'
  import Star from '@lucide/svelte/icons/star'
  import { personLabel, shortWhen } from './display'

  /**
   * One folder's mail, newest first. Opening goes through `onopen` (the page
   * marks the mail read with an explicit POST, then navigates); a modified
   * click (new tab) is left to the browser.
   */
  let {
    messages,
    selectedId,
    label,
    empty,
    href,
    onopen,
    now = new Date(),
  }: {
    messages: MessageListItem[]
    selectedId: string | null
    label: string
    empty: string
    href: (id: string) => string
    onopen: (item: MessageListItem, event: MouseEvent) => void
    now?: Date
  } = $props()

  function click(item: MessageListItem, event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    onopen(item, event)
  }
</script>

{#if messages.length === 0}
  <p class="px-4 py-6 text-sm text-muted-foreground" data-testid="inbox-list-empty">{empty}</p>
{:else}
  <ul class="divide-y divide-border" aria-label={label} data-testid="inbox-list">
    {#each messages as m (m.id)}
      <li>
        <a
          href={href(m.id)}
          onclick={(e) => click(m, e)}
          aria-current={selectedId === m.id ? 'true' : undefined}
          data-testid={`inbox-item-${m.id}`}
          data-unread={m.unread}
          class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-4 py-2.5 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset {selectedId ===
          m.id
            ? 'bg-muted'
            : ''}"
        >
          <span class="flex min-w-0 items-center gap-1.5 text-sm {m.unread ? 'font-semibold' : ''}">
            {#if m.unread}<span class="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span><span class="sr-only">Unread.&nbsp;</span>{/if}
            <span class="truncate">{personLabel(m.from)}</span>
          </span>
          <span class="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            {#if m.starred}<Star class="size-3.5 fill-current text-amber-500" aria-hidden="true" /><span class="sr-only">Starred.&nbsp;</span>{/if}
            <time datetime={m.receivedAt}>{shortWhen(m.receivedAt, now)}</time>
          </span>
          <span class="col-span-2 truncate text-sm {m.unread ? 'font-medium text-foreground' : 'text-foreground/90'}">{m.subject || '(no subject)'}</span>
          <span class="col-span-2 truncate text-xs text-muted-foreground">{m.snippet}</span>
        </a>
      </li>
    {/each}
  </ul>
{/if}
