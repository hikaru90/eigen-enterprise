<script lang="ts">
  import { onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import type { AiUsagePeriod } from '$lib/ai-usage/view'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { CoworkerProfilePayload } from './profile'
  import AiMark from './ai-mark.svelte'
  import CoworkerUsage from './coworker-usage.svelte'
  import MentionHandle from './mention-handle.svelte'

  /**
   * An AI co-worker's profile inside Messages (wish 7c6db153): click its name
   * or avatar on a message and read who it is — title, accountabilities, lens,
   * daily budget, whom it answers to, its @handle — without leaving the chat.
   * For the owner and admins also its AI usage (wish acdb941e) and the edit
   * path (Settings → Co-workers, the coworkers.update client). A view of
   * GET /api/coworkers/[id]/profile (coworkers.get + settings.ai_usage_overview).
   */
  let {
    coworkerId,
    onclose,
    load = async (id: string, period: AiUsagePeriod) => {
      const res = await fetch(`/api/coworkers/${encodeURIComponent(id)}/profile?usage=${period}`)
      if (!res.ok) throw new Error(`The profile could not be loaded (HTTP ${res.status}).`)
      return (await res.json()) as CoworkerProfilePayload
    },
  }: {
    coworkerId: string
    onclose: () => void
    load?: (id: string, period: AiUsagePeriod) => Promise<CoworkerProfilePayload>
  } = $props()

  let profile = $state<CoworkerProfilePayload | null>(null)
  let failed = $state<string | null>(null)

  async function read(p: AiUsagePeriod) {
    failed = null
    try {
      profile = await load(coworkerId, p)
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e)
    }
  }

  onMount(() => {
    void read('30')
  })

  const c = $derived(profile?.coworker ?? null)
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  <Dialog.Content class="max-w-md" data-testid="coworker-profile-panel">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        {#if c}
          <UserAvatar name={c.name} image={c.image} size="md" />
          <span data-testid="coworker-profile-name">{c.name}</span>
          <AiMark />
          <span class="text-xs font-normal text-muted-foreground">{c.enabled ? m.coworkers_on() : m.coworkers_off()}</span>
        {:else}
          {m.coworkers_profile()}
        {/if}
      </Dialog.Title>
    </Dialog.Header>

    {#if failed}
      <ErrorNotice error={failed} attempted="Opening an AI co-worker's profile in Messages (GET /api/coworkers/[id]/profile)" />
    {:else if !c}
      <p class="text-sm text-muted-foreground" role="status">Loading…</p>
    {:else}
      <div class="space-y-3 text-sm">
        {#if c.title}<p class="font-medium" data-testid="coworker-profile-title">{c.title}</p>{/if}
        <MentionHandle handle={c.slug} />
        {#if c.accountabilities.length > 0}
          <div>
            <h3 class="text-xs font-semibold text-muted-foreground">Accountabilities</h3>
            <ul class="list-disc pl-5" data-testid="coworker-profile-accountabilities">
              {#each c.accountabilities as a (a)}<li>{a}</li>{/each}
            </ul>
          </div>
        {/if}
        <div>
          <h3 class="text-xs font-semibold text-muted-foreground">Lens</h3>
          <p class="whitespace-pre-line" data-testid="coworker-profile-lens">{c.lens}</p>
        </div>
        <p class="text-xs text-muted-foreground">
          {m.coworkers_daily_cap_value({ amount: c.dailyCapUsd.toFixed(2) })}
          {#if c.accountableHumans.length > 0}· {m.coworkers_answers_to({ name: c.accountableHumans.map((h) => h.name).join(', ') })}{/if}
        </p>
        {#if profile?.usage}
          <CoworkerUsage {...profile.usage} onperiod={(p) => void read(p)} testid="coworker-profile-usage" />
        {/if}
      </div>
      <Dialog.Footer class="gap-2">
        <a
          href={resolve('/(nucleus)/settings/org/[id]', { id: c.id })}
          class="text-sm underline-offset-4 hover:underline"
          data-testid="coworker-profile-open">Open full profile</a
        >
        {#if profile?.canManage}
          <a
            href="{resolve('/settings/coworkers')}#coworker-{c.id}"
            class="text-sm font-medium underline-offset-4 hover:underline"
            data-testid="coworker-profile-edit">Change in Settings → Co-workers</a
          >
        {/if}
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
