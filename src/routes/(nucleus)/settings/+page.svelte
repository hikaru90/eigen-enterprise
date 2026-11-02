<script lang="ts">
  import type { PageProps } from './$types'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import LogOut from '@lucide/svelte/icons/log-out'
  import { enhance } from '$app/forms'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { resetPostHog } from '$lib/analytics/posthog-client'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings → Account: this person's email and sign-out. Sign-in is
   * passwordless, so there is no password form. The company-wide sections
   * are in the settings sub-navigation above.
   */
  let { data, form }: PageProps = $props()

  let signingOut = $state(false)
  let signOutError = $state<string | null>(null)

  async function signOut() {
    if (signingOut) return
    signingOut = true
    signOutError = null
    try {
      const res = await fetch('/api/session/sign-out', {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        throw new Error(`Sign out failed (HTTP ${res.status}).`)
      }
      resetPostHog()
      await goto(resolve('/login'), { invalidateAll: true })
    } catch (err) {
      signOutError = err instanceof Error ? err.message : String(err)
    } finally {
      signingOut = false
    }
  }
</script>

<svelte:head>
  <title>{docTitle('Account', 'Settings')}</title>
</svelte:head>

<h1 class="text-xl font-medium tracking-tight">Account</h1>
<p class="mt-1 text-sm text-foreground/60">
  Signed in as <span class="font-medium text-foreground">{data.user.email}</span>. You sign in with a
  code sent to this email or with a passkey — there is no password.
</p>

<div class="mt-8 space-y-6" data-testid="settings-account">
  <form
    method="post"
    action="?/changeEmail"
    use:enhance
    class="space-y-3 rounded-lg border border-border p-4"
  >
    <label class="block space-y-1.5">
      <span class="text-sm font-medium">Change email</span>
      <Input type="email" name="newEmail" placeholder="you@example.com" autocomplete="email" />
    </label>
    <Button type="submit" variant="outline" size="sm">Update email</Button>
    {#if form?.emailMessage}
      <p class="text-xs text-foreground/60" role="status">{form.emailMessage}</p>
    {/if}
  </form>

  <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
    <div>
      <p class="text-sm font-medium">Sign out</p>
      <p class="text-xs text-foreground/60">Ends the session in this browser.</p>
    </div>
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={signingOut}
      onclick={() => void signOut()}
      data-testid="settings-sign-out"
    >
      {#if signingOut}
        <LoaderCircle class="size-4 shrink-0 animate-spin" strokeWidth={1.75} />
      {:else}
        <LogOut class="size-4 shrink-0" strokeWidth={1.75} />
      {/if}
      Sign out
    </Button>
    {#if signOutError}
      <p class="w-full text-xs text-destructive" role="alert">{signOutError}</p>
    {/if}
  </div>
</div>
