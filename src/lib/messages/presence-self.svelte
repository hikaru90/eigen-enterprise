<script lang="ts">
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import type { ShownError } from '$lib/errors/agent-report'
  import { presenceLabel, type PresenceView } from './presence'
  import PresenceDot from './presence-dot.svelte'

  /**
   * My own status at the foot of the Messages sidebar (where Slack and Teams
   * put it): my picture with its dot, the words, and the Do not disturb
   * switch. The switch shows the server's state; flipping it asks the page
   * (ontoggle), which saves it and the feed confirms. Under it, Share where I
   * am (plan/phase-multiplayer-presence.md) — once the server has said how
   * it is set (`share`), saved the same way (onshare).
   */
  let {
    name,
    image,
    presence,
    now,
    saving,
    error,
    ontoggle,
    switchId = 'presence-dnd',
    share = null,
    onshare,
  }: {
    name: string
    image: string | null
    presence: PresenceView
    now: Date
    saving: boolean
    /** Status could not be loaded or saved (shown, never hidden). */
    error: ShownError | null
    ontoggle: (on: boolean) => void
    /** The switch's element id (the nav's copy needs its own, Messages shows both). */
    switchId?: string
    /** Share where I am as the server has it; null until it has said (no switch is shown yet). */
    share?: boolean | null
    onshare?: (on: boolean) => void
  } = $props()
  // svelte-ignore state_referenced_locally
  const shareId = `${switchId}-share-where`

  const label = $derived(presenceLabel(presence, now))
</script>

<div class="shrink-0 border-t border-border px-3 py-2.5" data-testid="presence-self">
  <div class="flex items-center gap-2.5">
    <span class="relative shrink-0">
      <UserAvatar {name} {image} size="md" testid="presence-self-avatar" />
      <PresenceDot
        {presence}
        {now}
        size={12}
        class="absolute -right-1 -bottom-1"
        testid="presence-self-dot"
      />
    </span>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold">{name}</p>
      <p class="truncate text-xs text-muted-foreground" data-testid="presence-self-label">
        {label}
      </p>
    </div>
  </div>
  <div
    class="mt-2 flex items-center gap-2"
    title="Others see that you’d rather not be disturbed. Notifications still arrive."
  >
    <Switch
      id={switchId}
      size="sm"
      disabled={saving}
      data-testid="presence-dnd"
      bind:checked={() => presence.doNotDisturb, (on) => ontoggle(on)}
    />
    <Label for={switchId} class="text-xs font-normal text-foreground/80">Do not disturb</Label>
  </div>
  {#if share !== null && share !== undefined && onshare}
    <div class="mt-2 flex items-center gap-2">
      <Switch
        id={shareId}
        size="sm"
        disabled={saving}
        data-testid="presence-share-where"
        aria-describedby="{shareId}-hint"
        bind:checked={() => share, (on) => onshare(on)}
      />
      <Label for={shareId} class="text-xs font-normal text-foreground/80">Share where I am</Label>
    </div>
    <p id="{shareId}-hint" class="mt-1 text-xs text-muted-foreground" data-testid="presence-share-where-hint">
      Others see which page you’re on; files and chats only if they can open them.
    </p>
  {/if}
  {#if error}
    <ErrorNotice
      class="mt-1.5 text-xs"
      error={error.error}
      agent={error.agent}
      attempted="Keeping my status (presence) up to date"
    />
  {/if}
</div>
