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

  /**
   * Accept an invite (owner decision W-4): the link is the proof. Step 1 —
   * your name, Join (the account is created with the invited role, signed in).
   * Step 2 — create a passkey for this device: the way back in, no email.
   */
  let { data, form }: { data: PageData; form: ActionData } = $props()

  const company = $derived(data.companyName ?? 'your company')

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
        <PasskeyStep
          email={data.email ?? ''}
          passkeyName="Passkey from the invite"
          doneHref={resolve('/messages')}
          testId="invite"
          skipWarning="Without a passkey you can’t sign in again once this session ends (or on another device) — this company has no sign-in by email. Add one in Settings → Passkeys before you sign out."
        />
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
