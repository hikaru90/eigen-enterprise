<script lang="ts">
  import { resolve } from '$app/paths'
  import { authClient } from '$lib/auth-client'
  import { Button } from '$lib/components/ui/button'

  /**
   * "Create your passkey" right after an account is made from a link (invite, claim): the way back
   * in without an email code. Skipping asks once, with the consequence spelled out.
   */
  let {
    email,
    passkeyName,
    doneHref,
    skipWarning,
    testId,
  }: {
    /** The signed-in account, shown so the person knows what the passkey is for. */
    email: string
    /** Name the passkey gets in Settings → Passkeys. */
    passkeyName: string
    /** The route to go to once the passkey exists, or after skipping. */
    doneHref: '/' | '/messages'
    /** Why skipping is risky here, in plain words. */
    skipWarning: string
    /** data-testid prefix (`invite`, `claim`). */
    testId: string
  } = $props()

  let busy = $state(false)
  let error = $state<string | null>(null)
  let confirmSkip = $state(false)

  async function createPasskey() {
    busy = true
    error = null
    try {
      const res = await authClient.passkey.addPasskey({ name: passkeyName })
      if (res?.error) {
        error =
          ('code' in res.error && res.error.code === 'canceled') || /cancel/i.test(res.error.message ?? '')
            ? 'The passkey prompt was cancelled. Try again.'
            : res.error.message || 'The passkey could not be created.'
        return
      }
      window.location.href = resolve(doneHref)
    } catch (err) {
      error = err instanceof Error ? err.message : 'The passkey could not be created.'
    } finally {
      busy = false
    }
  }
</script>

<div class="space-y-4" data-testid="{testId}-passkey-step">
  <p class="text-xs">
    Your device saves the passkey and unlocks it with your fingerprint, face or device PIN. No password, no
    code by email. Signed in as <strong>{email}</strong>.
  </p>
  <Button type="button" class="w-full rounded-[4px]" onclick={createPasskey} disabled={busy} data-testid="{testId}-create-passkey">
    {busy ? 'Waiting for your device…' : 'Create a passkey'}
  </Button>
  {#if error}
    <p class="text-destructive text-xs" role="alert" data-testid="{testId}-passkey-error">{error}</p>
  {/if}
  {#if confirmSkip}
    <div class="space-y-2 rounded-[4px] border border-destructive/40 bg-destructive/5 p-3 text-xs" role="alert" data-testid="{testId}-skip-warning">
      <p>{skipWarning}</p>
      <a href={resolve(doneHref)} class="underline underline-offset-4" data-testid="{testId}-skip-confirm">Continue without a passkey</a>
    </div>
  {:else}
    <p class="text-muted-foreground text-xs">
      <button type="button" class="underline underline-offset-4" onclick={() => (confirmSkip = true)} data-testid="{testId}-skip-passkey">Skip for now</button>
    </p>
  {/if}
</div>
