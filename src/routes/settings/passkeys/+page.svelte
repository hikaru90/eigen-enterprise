<script lang="ts">
  import type { PageProps } from './$types'
  import { authClient } from '$lib/auth-client'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'

  /** Settings → Passkeys: this machine's authenticator as the way back in. */
  let { data }: PageProps = $props()

  const passkeys = authClient.useListPasskeys()
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
    } catch (err) {
      error = err instanceof Error ? err.message : 'The passkey could not be registered.'
    } finally {
      adding = false
    }
  }
</script>

<svelte:head>
  <title>Passkeys · Eigen Enterprise</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl px-4 py-10">
  <header class="mb-8">
    <p class="text-muted-foreground text-[11px] font-medium tracking-[0.25em] uppercase">
      Settings
    </p>
    <h1 class="mt-1 text-xl font-medium tracking-tight">Passkeys</h1>
    <p class="text-muted-foreground mt-2 text-sm">
      A passkey is this machine's credential: after signing in with a code once, a passkey lets you
      back in with a fingerprint, face, or device PIN — no code, no email. Passkeys are bound to
      <span class="font-mono text-xs">{data.origin}</span>; register one per machine.
    </p>
  </header>

  <section class="space-y-3" data-testid="passkeys">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold">Your passkeys</h2>
      <Button type="button" onclick={addPasskey} disabled={adding}>
        {adding ? 'Waiting for your device…' : 'Add a passkey for this machine'}
      </Button>
    </div>

    {#if error}
      <p class="text-destructive text-xs">{error}</p>
    {/if}

    {#if $passkeys.isPending}
      <p class="text-muted-foreground text-sm">Loading…</p>
    {:else if $passkeys.data?.length}
      <ul class="border-black/15 divide-y divide-black/10 border">
        {#each $passkeys.data as pk (pk.id)}
          <li class="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="passkey-row">
            <div class="min-w-0">
              <p class="text-sm">{pk.name ?? 'Passkey'}</p>
              <p class="text-muted-foreground text-[11px]">
                {pk.deviceType === 'singleDevice' ? 'This device only' : 'Synced across devices'} ·
                added {new Date(pk.createdAt).toLocaleDateString()}
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
      <p class="text-muted-foreground text-sm">None yet.</p>
    {/if}

    <p class="text-muted-foreground border-black/10 border-t pt-3 text-xs">
      The sign-in page offers "Sign in with a passkey" — the browser shows the matching passkey for
      this address automatically. Signing in with a code keeps working everywhere.
    </p>
  </section>
</div>
