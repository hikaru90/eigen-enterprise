<script lang="ts">
  import { invalidateAll } from '$app/navigation'

  /**
   * Pre-activation notice (phase-2d follow-up, owner directive): the branding
   * module is inactive — tell the owner BEFORE anything starts, then drive the
   * approval-gated `kernel.module_activate` (first call → pending approval in
   * the orchestrator chat, retry after the conversational yes → activated).
   */
  let activating = $state(false)
  let pendingApproval = $state(false)
  let activationError = $state('')

  async function activate() {
    activating = true
    activationError = ''
    try {
      const res = await fetch('/api/brand/activate', { method: 'POST' })
      const body = (await res.json()) as { activated?: boolean; pendingApproval?: boolean }
      if (body.pendingApproval) {
        pendingApproval = true
      } else if (body.activated) {
        await invalidateAll()
      } else {
        activationError = 'Activation failed.'
      }
    } catch {
      activationError = 'Activation failed.'
    } finally {
      activating = false
    }
  }
</script>

<section
  class="mx-auto mt-16 max-w-xl rounded-lg border border-amber-300 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-950"
>
  <h1 class="text-lg font-semibold">The branding module is inactive</h1>
  <p class="mt-2 text-sm text-muted-foreground">
    Activating it enables the visual brand tools — style extraction, the selection wizard and the
    editor. Activation is approval-gated: after you confirm here, approve
    <code class="rounded bg-muted px-1">kernel.module_activate</code> in the orchestrator chat.
  </p>
  <button
    class="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
    onclick={activate}
    disabled={activating}
  >
    {activating ? 'Requesting activation…' : 'Activate branding module'}
  </button>
  {#if pendingApproval}
    <p class="mt-3 text-sm text-amber-700 dark:text-amber-300">
      Approval requested — approve it in the orchestrator chat, then press the button again to
      finish activation.
    </p>
  {/if}
  {#if activationError}
    <p class="mt-3 text-sm text-red-700">{activationError}</p>
  {/if}
</section>
