<script lang="ts">
  import { docTitle } from '$lib/shell/title'
  import PublicFrame from '$lib/components/page/public-frame.svelte'
  import type { ActionData } from './$types'
  import type { PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { signupPlanSubtitle } from '$lib/auth/signup-plan'
  import AuthSocialButtons from '$lib/components/auth-social-buttons.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { websiteLegalUrl } from '$lib/legal/website-legal-urls'
  import AuthCodeStep from '$lib/components/auth-code-step.svelte'
  import { signUpCodeRequestSchema } from '$lib/validation/auth'

  const websiteOrigin = (import.meta.env.PUBLIC_WEBSITE_ORIGIN ?? '').replace(/\/$/, '')
  const termsHref = websiteLegalUrl('terms', websiteOrigin)
  const privacyHref = websiteLegalUrl('privacy', websiteOrigin)
  const imprintHref = websiteLegalUrl('imprint', websiteOrigin)

  let { data, form }: { data: PageData; form: ActionData } = $props()

  let email = $state('')
  let acceptTerms = $state(false)
  let fieldErrors = $state<{ email?: string; acceptTerms?: string }>({})

  const codeStep = $derived(form?.step === 'code' && typeof form.email === 'string')

  function validate() {
    const result = signUpCodeRequestSchema.safeParse({
      email,
      acceptTerms: acceptTerms ? 'on' : undefined,
    })
    if (result.success) {
      fieldErrors = {}
      return true
    }
    const flat = result.error.flatten().fieldErrors
    fieldErrors = { email: flat.email?.[0], acceptTerms: flat.acceptTerms?.[0] }
    return false
  }
</script>

<svelte:head><title>{docTitle('Sign up')}</title></svelte:head>

<PublicFrame
  title="Create an account"
  subtitle={data.plan ? signupPlanSubtitle(data.plan) : null}
  back
>
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
            <label class="flex items-start gap-2 text-xs leading-snug" for="accept-terms">
              <input
                id="accept-terms"
                type="checkbox"
                name="acceptTerms"
                value="on"
                bind:checked={acceptTerms}
                class="mt-0.5 size-3.5 shrink-0"
                aria-describedby={fieldErrors.acceptTerms ? 'accept-terms-error' : undefined}
              />
              <span>
                I accept the
                <a
                  href={termsHref}
                  class="text-foreground underline underline-offset-2"
                  target="_blank"
                  rel="noopener noreferrer external"
                >
                  Terms of Service (AGB)
                </a>
                and
                <a
                  href={privacyHref}
                  class="text-foreground underline underline-offset-2"
                  target="_blank"
                  rel="noopener noreferrer external"
                >
                  Privacy Policy
                </a>
                , including receiving emails related to my account and the Service.
                <span class="text-muted-foreground">
                  (
                  <a
                    href={imprintHref}
                    class="underline underline-offset-2"
                    target="_blank"
                    rel="noopener noreferrer external"
                  >
                    Imprint
                  </a>
                  )
                </span>
              </span>
            </label>
            {#if fieldErrors.acceptTerms}
              <p id="accept-terms-error" class="text-destructive text-xs">
                {fieldErrors.acceptTerms}
              </p>
            {/if}
          </div>

          {#if data.socialProviders.length > 0}
            <AuthSocialButtons providers={data.socialProviders} disabled={!acceptTerms} />
            {#if !acceptTerms}
              <p class="text-muted-foreground text-[10px]">
                Accept the Terms of Service (AGB) above before continuing with a social provider.
              </p>
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

          <div class="space-y-1">
            <Label for="email">Email</Label>
            <input
              id="email"
              type="email"
              name="email"
              autocomplete="email"
              bind:value={email}
              class="border-input bg-card text-foreground h-9 w-full border px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              aria-describedby={fieldErrors.email ? 'email-error' : undefined}
            />
            {#if fieldErrors.email}
              <p id="email-error" class="text-destructive text-xs">{fieldErrors.email}</p>
            {/if}
          </div>
          <p class="text-muted-foreground text-[10px]">No password: we email you a 6-digit code.</p>
          <Button type="submit" class="w-full rounded-[4px]">Create account</Button>
          {#if form && 'message' in form && form.message}
            <p class="text-destructive text-xs">{form.message}</p>
          {/if}
        </form>

        <p class="text-muted-foreground text-center text-xs">
          Already have an account?
          <a href={resolve('/login')} class="text-foreground underline-offset-2 hover:underline"
            >Sign in</a
          >
        </p>
      {/if}
    </Card.Content>
  </Card.Root>
</PublicFrame>
