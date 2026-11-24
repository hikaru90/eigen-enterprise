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
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { emailCodeRequestSchema } from '$lib/validation/auth'

  /** Passwordless sign-in: email → 6-digit code (Better Auth emailOTP). */

  let { data, form }: { data: PageData; form: ActionData } = $props()

  let email = $state('')
  let emailError = $state<string | undefined>(undefined)

  const codeStep = $derived(form?.step === 'code' && typeof form.email === 'string')
  const demo = $derived(data.demoGuest ?? null)
  const teamFormHasError = $derived(Boolean(form && 'message' in form && form.message))
  const teamSignInOpen = $derived(Boolean(data.teamSignIn || teamFormHasError || data.oauthError))
  const pageTitle = $derived(demo && !data.unclaimed ? `Explore ${demo.companyName}` : 'Sign in')
  const pageSubtitle = $derived(
    demo && !data.unclaimed ? 'One-click demo — no email or password needed.' : null,
  )

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

<svelte:head><title>{docTitle(pageTitle)}</title></svelte:head>

<PublicFrame title={pageTitle} subtitle={pageSubtitle} back>
  <Card.Root class="border border-border shadow-none">
    <Card.Content class="space-y-4">
      {#if data.unclaimed}
        <p class="text-xs" data-testid="auth-unclaimed">{data.unclaimed}</p>
      {:else if codeStep && form?.email}
        <AuthCodeStep
          email={form.email}
          message={'notice' in form ? form.notice : undefined}
          error={'message' in form ? form.message : undefined}
          agent={'agent' in form ? form.agent : null}
        />
      {:else}
        {#if demo}
          <div class="space-y-3" data-testid="demo-welcome-card">
            <p class="text-foreground text-xs leading-relaxed">
              Step inside <span class="font-medium">{demo.companyName}</span> as
              <span class="font-medium">{demo.guestName}</span> to explore projects, messages,
              contacts, calendar, Drive, and the company website.
            </p>
            <p class="text-muted-foreground text-xs leading-relaxed">
              {#if demo.aiCallsPerIp > 0}
                Includes up to {demo.aiCallsPerIp} AI {demo.aiCallsPerIp === 1 ? 'call' : 'calls'} per
                day from your network.
              {:else}
                Browse and edit freely — AI calls are turned off in this demo.
              {/if}
            </p>
            <form method="post" action="?/enterDemo" use:enhance class="space-y-2">
              <Button type="submit" class="w-full rounded-[4px]" data-testid="demo-enter">
                Explore {demo.companyName}
              </Button>
              {#if form && 'demoError' in form && form.demoError}
                <ErrorNotice
                  class="text-xs"
                  error={form.demoError}
                  agent={'agent' in form ? form.agent : null}
                  attempted="Opening the login-free demo company"
                />
              {/if}
            </form>
          </div>
        {/if}

        {#snippet teamSignInContent()}
          {#if data.socialProviders.length > 0}
            <AuthSocialButtons providers={data.socialProviders} />
            {#if data.oauthError}
              <ErrorNotice
                class="text-xs"
                error={data.oauthError}
                attempted="Signing in with Google or GitHub (the provider sent the visitor back with an error)"
              />
            {/if}
            <div class="relative py-1">
              <div class="border-t border-black/10" aria-hidden="true"></div>
              <p
                class="text-muted-foreground absolute inset-x-0 top-1/2 -translate-y-1/2 bg-card px-2 text-center text-xs mx-auto w-fit"
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
              <ErrorNotice
                class="text-xs"
                error={form.message}
                agent={'agent' in form ? form.agent : null}
                attempted="Sending a sign-in code by email"
              />
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
            <ErrorNotice
              class="text-xs"
              error={passkeyError}
              attempted="Signing in with a passkey (browser WebAuthn prompt)"
            />
          {/if}

          {#if data.openJoin}
            <p class="text-muted-foreground text-center text-xs" data-testid="auth-join-link">
              Not a member yet?
              <a href={resolve('/signup')} class="text-foreground underline-offset-2 hover:underline"
                >Join</a
              >
            </p>
          {:else if data.signupOpen && !demo}
            <p class="text-muted-foreground text-center text-xs" data-testid="auth-signup-link">
              Don't have an account?
              <a href={resolve('/signup')} class="text-foreground underline-offset-2 hover:underline"
                >Sign up</a
              >
            </p>
          {/if}
        {/snippet}

        {#if demo}
          <details open={teamSignInOpen} class="border-t border-border pt-3">
            <summary
              class="text-muted-foreground hover:text-foreground cursor-pointer text-center text-xs select-none"
              data-testid="team-sign-in-toggle"
            >
              Team sign in
            </summary>
            <div class="mt-4 space-y-4">
              {@render teamSignInContent()}
            </div>
          </details>
        {:else}
          {@render teamSignInContent()}
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>
</PublicFrame>
