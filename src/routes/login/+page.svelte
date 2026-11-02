<script lang="ts">
  import { docTitle } from '$lib/shell/title'
  import PublicFrame from '$lib/components/page/public-frame.svelte'
  import type { ActionData } from './$types'
  import type { PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { authClient } from '$lib/auth-client'
  import AuthCodeStep from '$lib/components/auth-code-step.svelte'
  import AuthSocialButtons from '$lib/components/auth-social-buttons.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { emailCodeRequestSchema } from '$lib/validation/auth'

  /** Passwordless sign-in: email → 6-digit code (Better Auth emailOTP). */

  let { data, form }: { data: PageData; form: ActionData } = $props()

  let email = $state('')
  let emailError = $state<string | undefined>(undefined)

  const codeStep = $derived(form?.step === 'code' && typeof form.email === 'string')

  /** Passkey: the machine's credential, registered from Settings → Passkeys. */
  let passkeyBusy = $state(false)
  let passkeyError = $state<string | null>(null)

  async function signInWithPasskey() {
    passkeyBusy = true
    passkeyError = null
    try {
      const res = await authClient.signIn.passkey()
      if (res?.error) {
        passkeyError =
          'No passkey on this device for this app — sign in with a code once, then add one in Settings → Passkeys.'
        return
      }
      window.location.href = resolve('/')
    } catch {
      passkeyError = 'The passkey prompt was cancelled.'
    } finally {
      passkeyBusy = false
    }
  }

  function validate() {
    const result = emailCodeRequestSchema.safeParse({ email })
    emailError = result.success ? undefined : result.error.flatten().fieldErrors.email?.[0]
    return result.success
  }
</script>

<svelte:head><title>{docTitle('Sign in')}</title></svelte:head>

<PublicFrame title="Sign in" back>
  <Card.Root class="border border-border shadow-none">
    <Card.Content class="space-y-4">
      {#if data.unclaimed}
        <p class="text-xs" data-testid="auth-unclaimed">{data.unclaimed}</p>
      {:else if codeStep && form?.email}
        <AuthCodeStep
          email={form.email}
          message={'notice' in form ? form.notice : undefined}
          error={'message' in form ? form.message : undefined}
        />
      {:else}
        {#if data.socialProviders.length > 0}
          <AuthSocialButtons providers={data.socialProviders} />
          {#if data.oauthError}
            <p class="text-destructive text-xs">{data.oauthError}</p>
          {/if}
          <div class="relative py-1">
            <div class="border-t border-black/10" aria-hidden="true"></div>
            <p
              class="text-muted-foreground absolute inset-x-0 top-1/2 -translate-y-1/2 bg-card px-2 text-center text-[10px] mx-auto w-fit"
            >
              or
            </p>
          </div>
        {/if}
        <form
          method="post"
          action="?/sendCode"
          use:enhance
          class="space-y-4"
          onsubmit={(e) => {
            if (!validate()) e.preventDefault()
          }}
        >
          <div class="space-y-1">
            <Label for="email">Email</Label>
            <input
              id="email"
              type="email"
              name="email"
              autocomplete="email"
              bind:value={email}
              class="border-input bg-card text-foreground h-9 w-full border px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              aria-describedby={emailError ? 'email-error' : undefined}
            />
            {#if emailError}
              <p id="email-error" class="text-destructive text-xs">{emailError}</p>
            {/if}
          </div>
          <Button type="submit" class="w-full rounded-[4px]">Send code</Button>
          {#if form && 'message' in form && form.message}
            <p class="text-destructive text-xs">{form.message}</p>
          {/if}
        </form>

        <Button
          type="button"
          variant="outline"
          class="w-full rounded-[4px]"
          onclick={signInWithPasskey}
          disabled={passkeyBusy}
        >
          {passkeyBusy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </Button>
        {#if passkeyError}
          <p class="text-destructive text-xs">{passkeyError}</p>
        {/if}

        {#if data.signupOpen}
          <p class="text-muted-foreground text-center text-xs" data-testid="auth-signup-link">
            Don't have an account?
            <a href={resolve('/signup')} class="text-foreground underline-offset-2 hover:underline"
              >Sign up</a
            >
          </p>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>
</PublicFrame>
