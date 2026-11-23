<script lang="ts">
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import type { MemberAiUsageView } from '$lib/kernel/member-ai-cap-tools'

  /**
   * Settings → AI provider, "Daily AI cap per member" (DC3). Owner and admins set the cap
   * (?/setMemberAiCap → settings.member_ai_cap_set); everyone sees their own usage today
   * (settings.my_ai_usage). Over the cap, a member's model calls wait until midnight UTC.
   */
  let {
    usage,
    canManage,
    message,
  }: { usage: MemberAiUsageView; canManage: boolean; message?: string } = $props()

  const dollars = (value: number) => `$${value.toFixed(2)}`
</script>

<section class="space-y-3" data-testid="member-ai-cap">
  <div>
    <h3 class="text-sm font-semibold">Daily AI cap per member</h3>
    <p class="mt-1 text-sm text-muted-foreground">
      The most a member's AI use may cost per day (UTC). Owners and admins have no cap. Leave it
      empty for no cap.
    </p>
  </div>

  <div class="space-y-3 rounded-lg border border-border p-4">
    {#if canManage}
      <form method="post" action="?/setMemberAiCap" use:enhance class="flex items-end gap-3">
        <div class="space-y-1.5">
          <Label for="member-ai-cap">Dollars per member per day</Label>
          <Input
            dictation={false}
            id="member-ai-cap"
            name="capUsd"
            type="number"
            min="0.01"
            step="0.01"
            inputmode="decimal"
            value={usage.capUsd === null ? '' : usage.capUsd.toFixed(2)}
            placeholder="No cap"
            class="w-40 font-mono"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">Save cap</Button>
      </form>
    {:else}
      <p class="text-sm" data-testid="member-ai-cap-value">
        {usage.capUsd === null ? 'No cap is set.' : `${dollars(usage.capUsd)} per member per day.`}
      </p>
    {/if}

    <p class="text-sm text-muted-foreground" data-testid="member-ai-usage">
      You today: {dollars(usage.spentUsd)}
      {#if usage.capApplies && usage.capUsd !== null && usage.remainingUsd !== null}
        of {dollars(usage.capUsd)} ({dollars(usage.remainingUsd)} left; resets at midnight UTC).
      {:else if usage.capUsd !== null}
        (the cap does not apply to you).
      {/if}
    </p>

    {#if message}
      <p class="text-sm text-muted-foreground" role="status">{message}</p>
    {/if}
  </div>
</section>
