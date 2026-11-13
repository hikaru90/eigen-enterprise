<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { authClient } from '$lib/auth-client'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'
  import PublicFrame from '$lib/components/page/public-frame.svelte'

  /**
   * Accept an invite (owner decision W-4): the link is the proof. Step 1 —
   * your name, Join (the account is created with the invited role, signed in).
   * Step 2 — create a passkey for this device: the way back in, no email.
   */
  let { data, form }: { data: PageData; form: ActionData } = $props()

  const company = $derived(data.companyName ?? 'your company')

  let passkeyBusy = $state(false)
  let passkeyError = $state<string | null>(null)
  /** Skipping the passkey asks once, with the consequence spelled out. */
  let confirmSkip = $state(false)

  async function createPasskey() {
    passkeyBusy = true
    passkeyError = null
    try {
      const res = await authClient.passkey.addPasskey({ name: 'Passkey from the invite' })
      if (res?.error) {
        passkeyError =
          ('code' in res.error && res.error.code === 'canceled') || /cancel/i.test(res.error.message ?? '')
            ? 'The passkey prompt was cancelled. Try again.'
            : res.error.message || 'The passkey could not be created.'
        return
      }
      window.location.href = resolve('/messages')
    } catch (err) {
      passkeyError = err instanceof Error ? err.message : 'The passkey could not be created.'
    } finally {
      passkeyBusy = false
    }
  }
</script>

<svelte:head>
  <title>{docTitle(data.step === 'passkey' ? 'Create your passkey' : data.ok ? `Join ${company}` : 'Join your company')}</title>
</svelte:head>

<PublicFrame
  title={data.step === 'passkey'
    ? 'Create your passkey'
    : data.ok
      ? `Join ${company}`
      : 'Join your company'}
  subtitle={data.step === 'passkey'
    ? `You're in. A passkey is how you sign in to ${company} from now on.`
    : data.ok
      ? `You're invited to join as ${data.role === 'admin' ? 'an admin' : 'a member'}.`
      : null}
>
  <Card.Root class="border border-border shadow-none">
    <Card.Content class="space-y-4">
      {#if data.step === 'passkey'}
        <div class="space-y-4" data-testid="invite-passkey-step">
          <p class="text-xs">
            Your device saves the passkey and unlocks it with your fingerprint, face or device PIN.
            No password, no code by email. Signed in as <strong>{data.email}</strong>.
          </p>
          <Button
            type="button"
            class="w-full rounded-[4px]"
            onclick={createPasskey}
            disabled={passkeyBusy}
            data-testid="invite-create-passkey"
          >
            {passkeyBusy ? 'Waiting for your device…' : 'Create a passkey'}
          </Button>
          {#if passkeyError}
            <p class="text-destructive text-xs" role="alert" data-testid="invite-passkey-error">
              {passkeyError}
            </p>
          {/if}
          {#if confirmSkip}
            <div class="space-y-2 rounded-[4px] border border-destructive/40 bg-destructive/5 p-3 text-xs" role="alert" data-testid="invite-skip-warning">
              <p>
                <strong>Without a passkey you can’t sign in again</strong> once this session ends (or on
                another device) — this company has no sign-in by email. Add one in Settings → Passkeys
                before you sign out.
              </p>
              <a href={resolve('/messages')} class="underline underline-offset-4" data-testid="invite-skip-confirm">Continue without a passkey</a>
            </div>
          {:else}
            <p class="text-muted-foreground text-xs">
              <button type="button" class="underline underline-offset-4" onclick={() => (confirmSkip = true)} data-testid="invite-skip-passkey">Skip for now</button>
            </p>
          {/if}
        </div>
      {:else if !data.ok}
        <p class="text-xs" data-testid="invite-unavailable">{data.message}</p>
        <a
          href={resolve('/login')}
          class="inline-block text-xs font-medium underline underline-offset-4"
          data-testid="invite-sign-in">Sign in</a
        >
      {:else}
        <form method="post" action="?/join" use:enhance class="space-y-4" data-testid="invite-start">
          <input type="hidden" name="token" value={data.token} />
          <p class="text-xs">Your account: <strong>{data.email}</strong></p>
          <div class="space-y-1">
            <Label for="invite-name">Your name</Label>
            <input
              id="invite-name"
              name="name"
              autocomplete="name"
              required
              maxlength="80"
              value={form?.name ?? ''}
              class="border-input bg-card text-foreground h-9 w-full border px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            />
          </div>
          <Button type="submit" class="w-full rounded-[4px]" data-testid="invite-join">Join</Button>
          {#if form?.message}
            <p class="text-destructive text-xs" data-testid="invite-error">{form.message}</p>
          {/if}
        </form>
      {/if}
    </Card.Content>
  </Card.Root>
</PublicFrame>
