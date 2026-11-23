<script lang="ts">
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import type { AgentReport } from '$lib/errors/agent-report'
  import type { ShareStatusView } from '../../../../modules/contribute/share/service'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { NEVER_SHARED, SHARED_FIELDS } from '$lib/contribute/share-fields'

  /**
   * Settings → Company, owner only (plan/contribute-phone-home.md §5): share
   * wishes from the Make a wish board (module `contribute`) with the eigenEnterprise makers. On by
   * default; the exact field list; where sending stands (waiting, last error,
   * not configured, refused, no AI provider). Turning it off can also delete
   * everything already sent from the central board.
   */
  type Props = {
    status: ShareStatusView
    /** The setSharing action's answer, if this was the last action. */
    result: { error?: string; agent?: AgentReport; ok?: boolean } | null
  }
  let { status, result }: Props = $props()

  let withdraw = $state(false)
  let busy = $state(false)
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => dateFmt.format(new Date(iso))
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
</script>

<section class="space-y-4 rounded-lg border border-border p-4" data-testid="share-settings">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-sm font-medium">Share wishes with the eigenEnterprise makers</h3>
      <p class="mt-0.5 text-xs text-foreground/60">
        Each new wish on the Make a wish board is also sent, without names, to the central board
        the makers read, so they see what every company asks for. Your own board stays as it is.
      </p>
    </div>
    <span
      class="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-medium {status.enabled
        ? 'bg-primary/10 text-primary'
        : 'bg-foreground/[0.06] text-foreground/60'}"
      data-testid="share-enabled">{status.enabled ? 'On' : 'Off'}</span
    >
  </div>

  <div class="grid gap-3 text-xs sm:grid-cols-2">
    <div>
      <p class="font-medium">What is sent</p>
      <ul class="mt-1 list-disc space-y-0.5 pl-4 text-foreground/70" data-testid="share-fields">
        {#each Object.values(SHARED_FIELDS) as line (line)}<li>{line}</li>{/each}
      </ul>
    </div>
    <div>
      <p class="font-medium">Never sent</p>
      <ul class="mt-1 list-disc space-y-0.5 pl-4 text-foreground/70">
        {#each NEVER_SHARED as line (line)}<li>{line}</li>{/each}
      </ul>
      <p class="mt-2 text-foreground/60">
        On the <a class="underline" href={resolve('/contribute')}>Make a wish board</a> you see each wish's
        sharing, what was sent, and can stop one from being shared.
      </p>
    </div>
  </div>

  <div class="space-y-1 text-xs" role="status" data-testid="share-status">
    {#if status.notConfigured}
      <p class="text-destructive" data-testid="share-not-configured">
        The central board is not configured on this server, so nothing is sent.
      </p>
    {/if}
    {#if status.revoked}
      <p class="text-destructive" data-testid="share-revoked">
        The central board refused this install on {when(status.revoked.at)}. Nothing more is sent.
      </p>
    {/if}
    {#if status.enabled && !status.providerReady}
      <p class="text-destructive" data-testid="share-no-provider">
        No AI provider is connected, so wishes can't be prepared without names. Connect one under
        <a class="underline" href={resolve('/settings/llm')}>Settings → AI provider</a>; waiting
        wishes are shared then.
      </p>
    {/if}
    <p class="text-foreground/70" data-testid="share-counts">
      {plural(status.waiting, 'wish', 'wishes')} waiting · {status.sent} shared{#if status.failed > 0}
        · {status.failed} failed{/if}{#if status.withdrawing > 0}
        · {status.withdrawing} being withdrawn{/if}
    </p>
    {#if status.lastError}
      <p class="text-foreground/70 [overflow-wrap:anywhere]" data-testid="share-last-error">
        Last problem ({when(status.lastError.at)}): {status.lastError.message}
      </p>
    {/if}
  </div>

  <form
    method="post"
    action="?/setSharing"
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
        <input
          type="checkbox"
          name="withdraw"
          bind:checked={withdraw}
          data-testid="share-withdraw"
        />
        Also delete everything already sent from the central board
      </label>
    {/if}
    <Button
      type="submit"
      size="sm"
      variant={status.enabled ? 'outline' : 'default'}
      disabled={busy}
      data-testid="share-toggle"
    >
      {status.enabled
        ? withdraw
          ? 'Turn off and delete what was sent'
          : 'Turn sharing off'
        : 'Turn sharing on'}
    </Button>
    {#if result?.error}
      <ErrorNotice
        class="text-xs"
        error={result.error}
        agent={result.agent ?? null}
        attempted="Turning sharing of Make a wish wishes with the makers on or off"
      />
    {:else if result?.ok}
      <p class="text-xs text-foreground/60" role="status">Saved.</p>
    {/if}
  </form>
</section>
