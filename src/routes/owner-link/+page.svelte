<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import PublicFrame from '$lib/components/page/public-frame.svelte'
  import PasskeyStep from '$lib/components/passkey-step.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { docTitle } from '$lib/shell/title'

  /** Back in as the owner: the link `ee owner-link` printed → signed in → a passkey. */
  let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head>
  <title>{docTitle(data.step === 'passkey' ? 'Create your passkey' : 'Sign in as the owner')}</title
  >
</svelte:head>

<PublicFrame
  title={data.step === 'passkey' ? 'Create your passkey' : 'Sign in as the owner'}
  subtitle={data.step === 'passkey'
    ? `You're back in. A passkey is how you sign in to ${data.companyName ?? 'your company'} from now on.`
    : null}
>
  <Card.Root class="border border-border shadow-none">
    <Card.Content class="space-y-4">
      {#if data.step === 'passkey'}
        <PasskeyStep
          email={data.email ?? ''}
          passkeyName="Passkey from the owner link"
          doneHref="/"
          testId="owner-link"
          skipWarning="Without a passkey you need a new owner link (`ee owner-link` on the server) every time this session ends, until company email is set up."
        />
      {:else if data.ok}
        <form method="post" use:enhance class="space-y-4" data-testid="owner-link-form">
          <input type="hidden" name="token" value={data.token} />
          <p class="text-xs">
            This link from the server signs in the company's owner, <strong>{data.email}</strong>.
            It works once.
          </p>
          <Button type="submit" class="w-full rounded-[4px]">Sign in as {data.email}</Button>
          {#if form?.message}
            <ErrorNotice
              class="text-xs"
              testid="owner-link-error"
              error={form.message}
              agent={form.agent}
              attempted="Signing in as the owner with the owner link"
            />
          {/if}
        </form>
      {:else}
        <p class="text-xs" data-testid="owner-link-unavailable">{data.message}</p>
        <a
          href={resolve('/login')}
          class="inline-block text-xs font-medium underline underline-offset-4">Sign in</a
        >
      {/if}
    </Card.Content>
  </Card.Root>
</PublicFrame>
