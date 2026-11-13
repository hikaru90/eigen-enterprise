<script lang="ts">
  import type { SelfPresence } from './self-presence.svelte'
  import * as Popover from '$lib/components/ui/popover'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { presenceLabel } from './presence'
  import PresenceDot from './presence-dot.svelte'
  import PresenceSelf from './presence-self.svelte'

  /**
   * Me at the foot of the main nav (Contribute e4ef6be1): my picture with its
   * status dot, my name and my status in words — on every page, where people
   * look for it, so Do not disturb is not forgotten. Clicking opens my status
   * card (the same one as in Messages) with the Do not disturb switch.
   */
  let {
    self,
    name,
    email,
    image,
  }: {
    self: SelfPresence
    name: string
    email: string | null
    image: string | null
  } = $props()

  const view = $derived(self.view)
  const label = $derived(
    view ? presenceLabel(view, new Date()) : self.error ? 'Status unavailable' : 'Checking status…',
  )
</script>

<Popover.Root>
  <Popover.Trigger
    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    aria-label="Your status: {label}. Change status"
    data-testid="shell-presence-trigger"
  >
    <span class="relative shrink-0">
      <UserAvatar {name} {image} size="sm" round testid="shell-presence-avatar" />
      {#if view}
        <PresenceDot presence={view} now={new Date()} size={10} class="absolute -right-0.5 -bottom-0.5" testid="shell-presence-dot" />
      {/if}
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-[13px] font-medium" data-testid="shell-user">{name}</span>
      <span
        class="block truncate text-[11px] {self.error && !view ? 'text-destructive' : 'text-foreground/50'}"
        data-testid="shell-presence-label">{label}</span
      >
    </span>
  </Popover.Trigger>
  <Popover.Content align="start" side="top" sideOffset={8} class="w-64 gap-0 overflow-hidden p-0">
    {#if email}
      <p class="truncate px-3 pt-2.5 text-xs text-muted-foreground" data-testid="shell-presence-email">{email}</p>
    {/if}
    {#if view}
      <PresenceSelf
        {name}
        {image}
        presence={view}
        now={new Date()}
        saving={self.saving}
        error={self.error}
        ontoggle={(on) => void self.setDoNotDisturb(on)}
        switchId="shell-presence-dnd"
      />
    {:else}
      <p class="px-3 py-2.5 text-xs {self.error ? 'text-destructive' : 'text-muted-foreground'}" role={self.error ? 'alert' : undefined}>
        {self.error ?? 'Checking status…'}
      </p>
    {/if}
  </Popover.Content>
</Popover.Root>
