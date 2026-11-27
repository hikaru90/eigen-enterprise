<script lang="ts">
  import { Tooltip } from 'bits-ui'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { presenceLabel } from '$lib/messages/presence'
  import PresenceDot from '$lib/messages/presence-dot.svelte'
  import type { PresencePerson } from './company-presence.svelte'

  /**
   * Who is here (plan/phase-multiplayer-presence.md): up to three small round
   * avatars on a neutral ring, +n for the rest, a status dot only where the
   * status is worth telling (online is everyone here). Hover or keyboard
   * focus lists every name with what they have open; a tap opens it too. The
   * button's name says the same for screen readers.
   */
  let {
    people,
    title,
    max = 3,
    side = 'right',
    class: className = '',
    testid = 'presence-stack',
  }: {
    people: PresencePerson[]
    /** What the list is ("In Drive", "Here with you"): the list's heading and the start of the name. */
    title: string
    max?: number
    side?: 'top' | 'right' | 'bottom' | 'left'
    class?: string
    testid?: string
  } = $props()

  let open = $state(false)
  const now = $derived(new Date())
  const shown = $derived(people.slice(0, max))
  const more = $derived(people.length - shown.length)
  const told = (p: PresencePerson) => p.presence.status !== 'online'
  const name = $derived(
    `${title}: ${people.map((p) => (told(p) ? `${p.label} (${presenceLabel(p.presence, now)})` : p.label)).join(', ')}`,
  )
</script>

<Tooltip.Provider delayDuration={150}>
  <Tooltip.Root bind:open disableCloseOnTriggerClick>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          aria-label={name}
          data-testid={testid}
          onclick={() => (open = true)}
          class={[
            'flex shrink-0 cursor-default items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          ]}
        >
          {#each shown as p, i (p.userId)}
            <span
              class={['relative shrink-0 rounded-full ring-2 ring-sidebar', i > 0 && '-ml-1.5']}
              data-testid="{testid}-avatar"
            >
              <UserAvatar name={p.name} image={p.image} size="xs" round testid="{testid}-picture" />
              {#if told(p)}
                <PresenceDot
                  presence={p.presence}
                  {now}
                  size={9}
                  class="absolute -right-0.5 -bottom-0.5"
                  testid="{testid}-dot"
                />
              {/if}
            </span>
          {/each}
          {#if more > 0}
            <span
              class="-ml-1.5 inline-grid h-5 min-w-5 place-items-center rounded-full bg-muted px-1 font-mono text-xs text-foreground ring-2 ring-sidebar"
              data-testid="{testid}-more">+{more}</span
            >
          {/if}
        </button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content
        {side}
        sideOffset={6}
        collisionPadding={12}
        class="z-50 w-max max-w-72 rounded-xl bg-popover px-3 py-2 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      >
        <div data-testid="{testid}-list">
          <p class="text-xs font-medium text-muted-foreground">{title}</p>
          <ul class="mt-1.5 flex flex-col gap-1.5">
            {#each people as p (p.userId)}
              <li class="flex min-w-0 items-center gap-2 text-sm">
                <UserAvatar name={p.name} image={p.image} size="xs" round testid="{testid}-list-picture" />
                <span class="min-w-0">
                  <span class="block truncate font-medium">{p.name}</span>
                  {#if p.place || told(p)}
                    <span class="block truncate text-xs text-muted-foreground"
                      >{[p.place, told(p) ? presenceLabel(p.presence, now) : null].filter(Boolean).join(' · ')}</span
                    >
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
</Tooltip.Provider>
