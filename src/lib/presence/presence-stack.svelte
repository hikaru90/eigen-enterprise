<script lang="ts" module>
  /** How wide a stack of `n` people is (px) at most `max` avatars: room a row leaves for it. */
  export const stackWidth = (n: number, max = 3) => 20 + (Math.min(n, max) - 1) * 14 + (n > max ? 14 : 0)

  /** "Anna", "Anna and Ben", "Anna, Ben and Cara". */
  const joined = (names: string[]) =>
    names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
</script>

<script lang="ts">
  import { Tooltip } from 'bits-ui'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { presenceLabel } from '$lib/messages/presence'
  import PresenceDot from '$lib/messages/presence-dot.svelte'
  import type { PresencePerson } from './company-presence.svelte'

  /**
   * Who is here (plan/phase-multiplayer-presence.md): up to three small round
   * avatars, no border, a light shadow to lift each off the one beneath, +n for the rest, a status dot only where the
   * status is worth telling (online is everyone here). Hover or keyboard
   * focus lists every name with what they have open; a tap opens it too. The
   * button's name says the same for screen readers.
   *
   * `onItem`: the stack sits on the one thing they all have open (a
   * conversation row, a Drive row) — the name says "Anna Müller has this
   * open" and the list leaves the item out instead of repeating it per name.
   */
  let {
    people,
    title,
    max = 3,
    onItem = false,
    side = 'right',
    class: className = '',
    testid = 'presence-stack',
  }: {
    people: PresencePerson[]
    /** What the list is ("In Drive", "Here with you"): the list's heading and the start of the name. */
    title: string
    max?: number
    /** Everyone shown has the item the stack sits on open. */
    onItem?: boolean
    side?: 'top' | 'right' | 'bottom' | 'left'
    class?: string
    testid?: string
  } = $props()

  let open = $state(false)
  const now = $derived(new Date())
  const shown = $derived(people.slice(0, max))
  const more = $derived(people.length - shown.length)
  const told = (p: PresencePerson) => p.presence.status !== 'online'
  const named = (p: PresencePerson, label: string) => (told(p) ? `${label} (${presenceLabel(p.presence, now)})` : label)
  const name = $derived(
    onItem
      ? `${joined(people.map((p) => named(p, p.name)))} ${people.length === 1 ? 'has' : 'have'} this open`
      : `${title}: ${people.map((p) => named(p, p.label)).join(', ')}`,
  )
  const placeOf = (p: PresencePerson) => (onItem ? null : p.place)
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
            'flex shrink-0 cursor-default items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          ]}
        >
          {#each shown as p, i (p.userId)}
            <span
              class={['relative flex shrink-0 items-center justify-center rounded-full shadow-sm', i > 0 && '-ml-1.5']}
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
              class="-ml-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 font-mono text-xs text-foreground shadow-sm"
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
                  {#if placeOf(p) || told(p)}
                    <span class="block truncate text-xs text-muted-foreground"
                      >{[placeOf(p), told(p) ? presenceLabel(p.presence, now) : null].filter(Boolean).join(' · ')}</span
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
