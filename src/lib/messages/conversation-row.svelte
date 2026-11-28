<script lang="ts">
  import Hash from '@lucide/svelte/icons/hash'
  import Lock from '@lucide/svelte/icons/lock'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import AiMark from '$lib/coworkers/ai-mark.svelte'
  import type { CompanyPresence } from '$lib/presence/company-presence.svelte'
  import PresenceStack, { stackWidth } from '$lib/presence/presence-stack.svelte'
  import type { RowPerson } from './message-row.svelte'
  import type { PresenceView } from './presence'
  import PresenceDot from './presence-dot.svelte'
  import type { ConversationView } from './view'

  /**
   * One channel or DM in the Messages list: its mark (#, lock, the DM
   * partner's avatar with their status, or the group's size), the title and
   * the unread count. Who has the conversation open right now
   * (plan/phase-multiplayer-presence.md, in the view) sits at the row's end,
   * beside the button, not in it (no button in a button) — at most two
   * avatars on this narrow row, and the button keeps room for them so the
   * unread count stays visible. Without the presence feed (`company` null)
   * the row is exactly as it was.
   */
  let {
    conversation: c,
    current,
    dmWith,
    presenceOf,
    now,
    company,
    onopen,
  }: {
    conversation: ConversationView
    current: boolean
    /** A DM's other participants; empty for a channel. */
    dmWith: RowPerson[]
    /** Someone's status (a one-to-one DM's partner gets a dot). */
    presenceOf: (userId: string) => PresenceView
    now: Date
    company: CompanyPresence | null
    onopen: () => void
  } = $props()

  const MAX = 2
  const here = $derived(company ? company.peopleOnItem('conversation', c.id) : [])
</script>

<li class="relative">
  <button
    type="button"
    class={[
      'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[15px] outline-none focus-visible:ring-2 -ring',
      current ? 'bg-primary text-primary-foreground' : 'text-foreground/75 hover:bg-foreground/[0.06]',
      c.unread > 0 && !current ? 'font-bold text-foreground' : '',
    ]}
    style={here.length > 0 ? `padding-right: ${8 + stackWidth(here.length, MAX) + 6}px;` : undefined}
    aria-current={current ? 'true' : undefined}
    data-testid="messages-conversation"
    data-title={c.title}
    data-unread={c.unread}
    onclick={onopen}
  >
    {#if c.kind === 'channel'}
      <span class="grid w-5 shrink-0 place-items-center">
        {#if c.private}
          <Lock class="size-3.5 opacity-70" aria-label="Private channel" />
        {:else}
          <Hash class="size-4 opacity-70" aria-hidden="true" />
        {/if}
      </span>
    {:else if dmWith.length === 1}
      <span class="relative shrink-0">
        <UserAvatar name={dmWith[0].name} image={dmWith[0].image} size="xs" testid="messages-dm-avatar" />
        <PresenceDot presence={presenceOf(dmWith[0].id)} {now} class="absolute -right-1 -bottom-1" testid="messages-dm-presence" />
      </span>
    {:else}
      <span
        class={[
          'grid size-5 shrink-0 place-items-center rounded-md text-xs font-semibold',
          current ? 'bg-primary-foreground/20' : 'bg-foreground/10',
        ]}
        aria-hidden="true">{dmWith.length || 1}</span
      >
    {/if}
    <span class="min-w-0 flex-1 truncate">{c.title}</span>
    {#if dmWith.length === 1 && dmWith[0].kind === 'coworker'}<AiMark testid="messages-dm-ai" />{/if}
    {#if c.unread > 0}
      <span
        class={[
          'min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs leading-5 font-bold tabular-nums',
          current ? 'bg-primary-foreground text-primary' : 'bg-primary text-primary-foreground',
        ]}
        data-testid="messages-unread"
        aria-label="{c.unread} unread">{c.unread > 99 ? '99+' : c.unread}</span
      >
    {/if}
  </button>
  {#if here.length > 0}
    <PresenceStack
      people={here}
      title="Open now"
      onItem
      max={MAX}
      class="absolute top-1/2 right-2 -translate-y-1/2"
      testid="messages-conversation-presence"
    />
  {/if}
</li>
