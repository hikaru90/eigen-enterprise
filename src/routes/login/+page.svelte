<script lang="ts">
  import type { ActionData } from './$types'
  import type { PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import AuthCodeStep from '$lib/components/auth-code-step.svelte'
  import AuthSocialButtons from '$lib/components/auth-social-buttons.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { emailCodeRequestSchema } from '$lib/validation/auth'

  /** Passwordless sign-in: email → 6-digit code (Better Auth emailOTP). */

  const websiteOrigin = (import.meta.env.PUBLIC_WEBSITE_ORIGIN ?? '').replace(/\/$/, '')

  let { data, form }: { data: PageData; form: ActionData } = $props()

  let email = $state('')
  let emailError = $state<string | undefined>(undefined)

  const codeStep = $derived(form?.step === 'code' && typeof form.email === 'string')

  function validate() {
    const result = emailCodeRequestSchema.safeParse({ email })
    emailError = result.success ? undefined : result.error.flatten().fieldErrors.email?.[0]
    return result.success
  }
</script>

<div class="mx-auto max-w-md px-5 pt-10">
  <header class="text-center">
    {#if websiteOrigin}
      <a href={websiteOrigin} rel="external" class="inline-block">
        <span class="text-lg font-medium tracking-tight">Eigen Enterprise</span>
      </a>
    {:else}
      <a href={resolve('/')} class="inline-block">
        <span class="text-lg font-medium tracking-tight">Eigen Enterprise</span>
      </a>
    {/if}
    <p class="text-muted-foreground mt-2 text-xs">Sign in</p>
  </header>

  <Card.Root
    class="ring-0 shadow-[4px_4px_0_0_rgb(17_17_17_/_0.08)] mt-8 border border-black/10 bg-card"
  >
    <Card.Content class="space-y-4 pt-6">
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

        {#if data.signupOpen}
          <p class="text-muted-foreground text-center text-xs" data-testid="auth-signup-link">
            Don't have an account?
            <a href={resolve('/signup')} class="text-foreground underline-offset-2 hover:underline">Sign up</a>
          </p>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>
</div>
