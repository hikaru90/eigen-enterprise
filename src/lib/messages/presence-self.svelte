<script lang="ts">
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { presenceLabel, type PresenceView } from './presence'
  import PresenceDot from './presence-dot.svelte'

  /**
   * My own status at the foot of the Messages sidebar (where Slack and Teams
   * put it): my picture with its dot, the words, and the Do not disturb
   * switch. The switch shows the server's state; flipping it asks the page
   * (ontoggle), which saves it and the feed confirms.
   */
  let {
    name,
    image,
    presence,
    now,
    saving,
    error,
    ontoggle,
  }: {
    name: string
    image: string | null
    presence: PresenceView
    now: Date
    saving: boolean
    /** Status could not be loaded or saved (shown, never hidden). */
    error: string | null
    ontoggle: (on: boolean) => void
  } = $props()

  const label = $derived(presenceLabel(presence, now))
</script>

<div class="shrink-0 border-t border-border px-3 py-2.5" data-testid="presence-self">
  <div class="flex items-center gap-2.5">
    <span class="relative shrink-0">
      <UserAvatar {name} {image} size="md" testid="presence-self-avatar" />
      <PresenceDot {presence} {now} size={12} class="absolute -right-1 -bottom-1" testid="presence-self-dot" />
    </span>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold">{name}</p>
      <p class="truncate text-xs text-muted-foreground" data-testid="presence-self-label">{label}</p>
    </div>
  </div>
  <div class="mt-2 flex items-center gap-2" title="Others see that you’d rather not be disturbed. Notifications still arrive.">
    <Switch
      id="presence-dnd"
      size="sm"
      disabled={saving}
      data-testid="presence-dnd"
      bind:checked={() => presence.doNotDisturb, (on) => ontoggle(on)}
    />
    <Label for="presence-dnd" class="text-xs font-normal text-foreground/80">Do not disturb</Label>
  </div>
  {#if error}<p class="mt-1.5 text-xs text-destructive" role="alert">{error}</p>{/if}
</div>
