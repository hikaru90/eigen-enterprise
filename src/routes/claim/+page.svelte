<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'
  import PublicFrame from '$lib/components/page/public-frame.svelte'
  import PasskeyStep from '$lib/components/passkey-step.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'

  /** Claim this server: the installer's private link → your email → you own the company → a passkey. */
  let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head>
  <title>{docTitle(data.step === 'passkey' ? 'Create your passkey' : 'Claim your company')}</title>
</svelte:head>

<PublicFrame
  title={data.step === 'passkey' ? 'Create your passkey' : 'Claim your company'}
  subtitle={data.step === 'passkey'
    ? `It's yours. A passkey is how you sign in to ${data.companyName ?? 'your company'} from now on.`
    : data.ok
      ? 'Your company is installed. Claim it.'
      : null}
>
  <Card.Root class="border border-border shadow-none">
    <Card.Content class="space-y-4">
      {#if data.step === 'passkey'}
        <PasskeyStep
          email={data.email ?? ''}
          passkeyName="Passkey from the claim"
          doneHref="/"
          testId="claim"
          skipWarning="Without a passkey you can’t sign in again once this session ends (or on another device) until email is set up — sign-in codes go out by email, and the onboarding’s email step comes next. Add one in Settings → Passkeys before you sign out."
        />
      {:else if data.ok}
        <form method="post" use:enhance class="space-y-4" data-testid="claim-form">
          <input type="hidden" name="token" value={data.token} />
          <div class="space-y-1">
            <Label for="email">Your email</Label>
            <input
              id="email"
              type="email"
              name="email"
              required
              autocomplete="email"
              value={form?.email ?? ''}
              class="border-input bg-card text-foreground h-9 w-full border px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            />
            <p class="text-muted-foreground text-xs">
              You become the owner of this server. This link works once.
            </p>
          </div>
          <Button type="submit" class="w-full rounded-[4px]">Claim</Button>
          {#if form?.message}
            <ErrorNotice
              class="text-xs"
              testid="claim-error"
              error={form.message}
              agent={form.agent}
              attempted="Claiming the company"
            />
          {/if}
        </form>
      {:else}
        <p class="text-xs" data-testid="claim-unavailable">{data.message}</p>
        <a
          href={resolve('/login')}
          class="inline-block text-xs font-medium underline underline-offset-4"
          data-testid="claim-sign-in">Sign in</a
        >
      {/if}
    </Card.Content>
  </Card.Root>
</PublicFrame>
