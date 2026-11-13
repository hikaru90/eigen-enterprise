<script lang="ts">
  import type { FollowUpStep, HistoryItem } from '../types'
  import { HISTORY_MAIL_LIMIT, relativeDays } from '../types'

  /**
   * "Kontaktverlauf": everything with this person, newest first — logged
   * contacts (how it went, the follow-up it answered, the one it set), mail
   * with their addresses from the mailboxes you read (and, for the owner and
   * admins, what the company sent them), and when they were added.
   */
  let { items, today, hasEmail }: { items: readonly HistoryItem[]; today: string; hasEmail: boolean } = $props()

  const days = (day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  const stepText = (s: FollowUpStep) => [s.on, s.step].filter(Boolean).join(': ')

  function mailLabel(i: Extract<HistoryItem, { kind: 'mail' }>): string {
    if (i.via.kind === 'company') return `The company sent them mail (${i.via.status.replaceAll('_', ' ')})`
    return i.direction === 'sent' ? `Mail to them from ${i.via.address}` : `Mail from them to ${i.via.address}`
  }
</script>

<div class="grid gap-2" data-testid="contact-history">
  <p class="text-xs text-muted-foreground">
    {#if hasEmail}
      Mail shows from the mailboxes you read (your own and shared ones you’re in); the owner and admins also see what the company sent. Up
      to the newest {HISTORY_MAIL_LIMIT} of each.
    {:else}
      Add an email address to see mail with them here.
    {/if}
  </p>
  <ol class="divide-y divide-border rounded-lg border border-border" aria-label="History">
    {#each items as item (`${item.kind}:${item.id}`)}
      <li class="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[8.5rem_1fr] sm:gap-4" data-testid="history-item" data-kind={item.kind}>
        <time class="text-xs text-muted-foreground" datetime={item.day}>
          {item.day}<span class="block">{relativeDays(days(item.day))}</span>
        </time>
        <div class="grid min-w-0 gap-1">
          {#if item.kind === 'logged'}
            <p class="font-medium">In touch <span class="font-normal text-muted-foreground">· logged by {item.by}</span></p>
            {#if item.note}<p class="whitespace-pre-line">{item.note}</p>{/if}
            {#if item.answered}<p class="text-xs text-muted-foreground">Answered the follow-up {stepText(item.answered)}</p>{/if}
            <p class="text-xs text-muted-foreground">{item.next ? `Next: ${stepText(item.next)}` : 'Nothing next'}</p>
          {:else if item.kind === 'mail'}
            <p class="text-xs text-muted-foreground">{mailLabel(item)}</p>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Email’s own links (Inbox reader, Logs), built on the server -->
            <a class="truncate font-medium hover:underline" href={item.href}>{item.subject || '(no subject)'}</a>
            {#if item.snippet}<p class="line-clamp-2 text-muted-foreground">{item.snippet}</p>{/if}
          {:else}
            <p class="text-muted-foreground">Added to Contacts by {item.by}</p>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
</div>
