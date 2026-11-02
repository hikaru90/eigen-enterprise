<script lang="ts">
  import type { PageProps } from './$types'
  import { putApprovalMode } from '$lib/chat/approvals-client'
  import ApprovalModeSelect from '$lib/components/approval-mode-select.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: PageProps = $props()
</script>

<svelte:head>
  <title>{docTitle('Approval mode', 'Settings')}</title>
</svelte:head>

<h1 class="text-xl font-medium tracking-tight">Approval mode</h1>
<p class="mt-1 text-sm text-foreground/60">
  How much the agent may do on its own before it asks you. The same choice sits under the chat box.
</p>

<div class="mt-8 rounded-lg border border-border p-4" data-testid="settings-approvals">
  <ApprovalModeSelect
    mode={data.approvalMode.status === 'ok' ? data.approvalMode.mode : null}
    save={(mode) => putApprovalMode(fetch, mode)}
  />
</div>
