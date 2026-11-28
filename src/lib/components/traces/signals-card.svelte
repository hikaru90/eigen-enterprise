<script lang="ts">
  import type { TracesSettingsView } from '../../../../modules/traces/service'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { AgentReport } from '$lib/errors/agent-report'

  /**
   * Settings → Company (plan/traces-phone-home.md §4): the box tells the eigenEnterprise makers
   * how the product behaved — usage statistics only, never content. On by default; the exact
   * field list; the last send and problem; the owner's switch (off can also delete everything
   * sent). Admins see it read-only. "What was sent" lists every batch and its exact JSON.
   */
  type Props = {
    status: TracesSettingsView
    canSwitch: boolean
    result: { error?: string; agent?: AgentReport; ok?: boolean } | null
  }
  let { status, canSwitch, result }: Props = $props()

  let withdraw = $state(false)
  let busy = $state(false)
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => dateFmt.format(new Date(iso))
</script>

<section class="space-y-4 rounded-lg border border-border p-4" data-testid="signals-settings">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-sm font-medium">Share product signals with the eigenEnterprise makers</h3>
      <p class="mt-0.5 text-xs text-foreground/60">
        How the product behaved — which tool or model ran, how long it took, whether it failed, on
        which version — so the makers can make it better. Never what your company did: no text,
        names, emails, prompts or files.
      </p>
    </div>
    <span
      class="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-medium {status.enabled
        ? 'bg-primary/10 text-primary'
        : 'bg-foreground/[0.06] text-foreground/60'}"
      data-testid="signals-enabled">{status.enabled ? 'On' : 'Off'}</span
    >
  </div>

  <div class="text-xs">
    <p class="font-medium">The only fields a signal has</p>
    <p class="mt-1 text-foreground/70 [overflow-wrap:anywhere]" data-testid="signals-fields">{status.fields.join(' · ')}</p>
    <p class="mt-2 text-foreground/60">
      A name this box can't vouch for (a module of your own, a custom model) is checked here first:
      if it could say anything about your company it is sent as “other”, and if it can't be checked
      it is not sent.
      <a class="underline" href={resolve('/settings/company/signals')} data-testid="signals-sent-link">What was sent</a>
    </p>
  </div>

  <div class="space-y-1 text-xs" role="status">
    {#if !status.hubConfigured}
      <p class="text-destructive" data-testid="signals-not-configured">{status.hubMessage}</p>
    {/if}
    {#if status.lastSentAt}
      <p class="text-foreground/70" data-testid="signals-last-sent">Last sent {when(status.lastSentAt)}.</p>
    {/if}
    {#if status.lastError}
      <p class="text-foreground/70 [overflow-wrap:anywhere]" data-testid="signals-last-error">Last problem: {status.lastError}</p>
    {/if}
  </div>

  {#if canSwitch}
    <form
      method="post"
      action="?/setSignals"
      class="space-y-2"
      use:enhance={() => {
        busy = true
        return async ({ update }) => {
          await update({ reset: false })
          busy = false
          withdraw = false
        }
      }}
    >
      <input type="hidden" name="enabled" value={status.enabled ? 'off' : 'on'} />
      {#if status.enabled}
        <label class="flex items-center gap-2 text-xs">
          <input type="checkbox" name="withdraw" bind:checked={withdraw} data-testid="signals-withdraw" />
          Also delete everything already sent from the makers’ hub
        </label>
      {/if}
      <Button type="submit" size="sm" variant={status.enabled ? 'outline' : 'default'} disabled={busy} data-testid="signals-toggle">
        {status.enabled ? (withdraw ? 'Turn off and delete what was sent' : 'Turn product signals off') : 'Turn product signals on'}
      </Button>
      {#if result?.error}
        <ErrorNotice class="text-xs" error={result.error} agent={result.agent ?? null} attempted="Turning product signals on or off" />
      {:else if result?.ok}
        <p class="text-xs text-foreground/60" role="status">Saved.</p>
      {/if}
    </form>
  {/if}
</section>
