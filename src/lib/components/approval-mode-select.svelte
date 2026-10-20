<script lang="ts">
  import { APPROVAL_MODE_OPTIONS, type ApprovalMode } from '$lib/chat/approvals-client'

  type Props = {
    /** The stored mode, or null when it could not be loaded. */
    mode: ApprovalMode | null
    /** Persists the mode (PUT /api/approvals/mode); rejects on failure. */
    save: (mode: ApprovalMode) => Promise<ApprovalMode>
  }

  let { mode, save }: Props = $props()

  // Seeded once from the prop; changes only after a confirmed save.
  // svelte-ignore state_referenced_locally
  let current = $state<ApprovalMode | null>(mode)
  let saving = $state(false)
  let error = $state<string | null>(null)

  async function handleChange(e: Event & { currentTarget: HTMLSelectElement }) {
    const select = e.currentTarget
    const next = select.value as ApprovalMode
    saving = true
    error = null
    try {
      current = await save(next)
      select.value = current
    } catch (err) {
      console.error('[nucleus] approval mode update failed', err)
      // No silent change: the selection stays on the stored mode.
      if (current) select.value = current
      error = 'Could not change the approval mode. Please try again.'
    } finally {
      saving = false
    }
  }
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
  {#if current}
    <label for="approval-mode" class="shrink-0">Approvals</label>
    <select
      id="approval-mode"
      class="min-w-0 border border-black/30 bg-white px-1.5 py-0.5 text-xs text-black"
      value={current}
      disabled={saving}
      onchange={handleChange}
    >
      {#each APPROVAL_MODE_OPTIONS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  {:else}
    <p class="text-destructive">Approval mode could not be loaded.</p>
  {/if}
  {#if error}
    <p class="text-destructive" role="alert">{error}</p>
  {/if}
</div>
