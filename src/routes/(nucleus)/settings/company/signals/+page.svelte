<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- opening a batch is resolve() + a query string */
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'

  /** What was sent (plan/traces-phone-home.md §4): every batch, its exact JSON, and the owner's withdraw. */
  let { data, form }: PageProps = $props()
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—')
  const STATE_WORDS = { pending: 'Waiting', sent: 'Sent', failed: 'Refused by the hub', withdrawn: 'Deleted from the hub' } as const
</script>

<div class="space-y-4">
  <div>
    <a class="text-xs underline" href={resolve('/settings/company')}>← Company</a>
    <h2 class="mt-1 text-base font-semibold tracking-tight">What was sent</h2>
    <p class="text-xs text-foreground/60">
      Every batch of product signals this box sent the eigenEnterprise makers, exactly as sent.
    </p>
  </div>

  {#if data.canWithdraw && data.batches.some((b) => b.state === 'sent')}
    <form method="post" action="?/withdraw" use:enhance>
      <Button type="submit" size="sm" variant="outline" data-testid="signals-withdraw-all">Delete everything sent from the hub</Button>
    </form>
  {/if}
  {#if form?.error}
    <ErrorNotice class="text-xs" error={form.error} agent={form.agent ?? null} attempted="Deleting product signals from the makers’ hub" />
  {/if}

  {#if data.batches.length === 0}
    <p class="text-sm text-foreground/60" data-testid="signals-none">Nothing sent yet.</p>
  {:else}
    <table class="w-full text-left text-xs" data-testid="signals-batches">
      <thead class="text-foreground/60">
        <tr><th class="py-1">Made</th><th>State</th><th>Signals</th><th>Withheld</th><th></th></tr>
      </thead>
      <tbody>
        {#each data.batches as b (b.id)}
          <tr class="border-t border-border">
            <td class="py-1">{when(b.createdAt)}</td>
            <td>{STATE_WORDS[b.state]}{#if b.lastError}<span class="block text-foreground/60 [overflow-wrap:anywhere]">{b.lastError}</span>{/if}</td>
            <td>{b.spanCount}</td>
            <td>{b.withheldCount}</td>
            <td class="space-x-2 text-right">
              <a
                href={`${resolve('/(nucleus)/settings/company/signals')}?batch=${encodeURIComponent(b.id)}`}
                class="underline">Open</a
              >
              {#if data.canWithdraw && b.state === 'sent'}
                <form method="post" action="?/withdraw" class="inline" use:enhance>
                  <input type="hidden" name="batch" value={b.id} />
                  <button type="submit" class="underline">Delete from hub</button>
                </form>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if data.open}
    <section class="space-y-2 rounded-lg border border-border p-3" data-testid="signals-open">
      <h3 class="text-sm font-medium">Batch {data.open.id}</h3>
      {#if data.open.withheld.length > 0}
        <p class="text-xs text-foreground/70">
          Not sent (could not be checked): {data.open.withheld.map((w) => `${w.field} “${w.value}”`).join(', ')}
        </p>
      {/if}
      <pre class="max-h-[28rem] overflow-auto rounded bg-foreground/[0.04] p-2 text-[11px]">{JSON.stringify(data.open.body, null, 2)}</pre>
    </section>
  {/if}
</div>
