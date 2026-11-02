<script lang="ts">
  import type { PageProps } from './$types'
  import { invalidateAll } from '$app/navigation'
  import { authClient } from '$lib/auth-client'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'

  /** Settings → Passkeys & sessions: ways back in, and where you are signed in. */
  let { data }: PageProps = $props()

  let adding = $state(false)
  let error = $state<string | null>(null)

  function passkeyErrorMessage(err: { message?: string; code?: string }): string {
    if (err.code === 'canceled' || /cancel/i.test(err.message ?? '')) {
      return 'The passkey prompt was cancelled.'
    }
    return err.message || 'The passkey could not be registered.'
  }

  async function addPasskey() {
    adding = true
    error = null
    try {
      const res = await authClient.passkey.addPasskey()
      if (res?.error) error = passkeyErrorMessage(res.error)
      else await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : 'The passkey could not be registered.'
    } finally {
      adding = false
    }
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString()
</script>

<svelte:head>
  <title>{docTitle('Passkeys & sessions', 'Settings')}</title>
</svelte:head>

<h1 class="text-xl font-medium tracking-tight">Passkeys &amp; sessions</h1>
<p class="mt-1 text-sm text-foreground/60">
  A passkey lets you back in with a fingerprint, face, or device PIN — no code, no email. Passkeys
  are bound to <span class="font-mono text-xs">{data.origin}</span>; register one per machine.
</p>

<section class="mt-8 space-y-3" data-testid="passkeys">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 class="text-sm font-semibold">Your passkeys</h2>
    <Button type="button" size="sm" onclick={addPasskey} disabled={adding}>
      {adding ? 'Waiting for your device…' : 'Add a passkey for this machine'}
    </Button>
  </div>

  {#if error}
    <p class="text-xs text-destructive" role="alert">{error}</p>
  {/if}

  {#if data.passkeys.length}
    <ul class="divide-y divide-border rounded-lg border border-border">
      {#each data.passkeys as pk (pk.id)}
        <li class="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="passkey-row">
          <div class="min-w-0">
            <p class="text-sm">{pk.name}</p>
            <p class="text-[11px] text-foreground/50">
              {pk.syncs ? 'Synced across devices' : 'This device only'} · added {day(pk.createdAt)}
            </p>
          </div>
          {#if pk.backedUp}
            <Badge variant="outline">backed up</Badge>
          {:else}
            <Badge>this device</Badge>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-sm text-foreground/60" data-testid="passkeys-empty">
      None yet. Signing in with a code keeps working everywhere.
    </p>
  {/if}
</section>

<section class="mt-10 space-y-3" data-testid="sessions">
  <h2 class="text-sm font-semibold">Where you are signed in</h2>
  <ul class="divide-y divide-border rounded-lg border border-border">
    {#each data.sessions as s (s.id)}
      <li class="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="session-row">
        <div class="min-w-0">
          <p class="truncate text-sm">{s.device}</p>
          <p class="text-[11px] text-foreground/50">
            {s.ipAddress ?? 'Unknown address'} · last active {day(s.lastActive)}
          </p>
        </div>
        {#if s.current}<Badge variant="outline">this browser</Badge>{/if}
      </li>
    {/each}
  </ul>
</section>
