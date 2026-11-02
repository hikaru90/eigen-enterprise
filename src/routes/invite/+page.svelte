<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  /** Accept an invite: one click emails a code to the invited address; the code signs you in as a member. */
  let { data, form }: { data: PageData; form: ActionData } = $props()

  const CODE_PATTERN = '[0-9]{6}'
  const codeStep = $derived(form?.step === 'code')
  const company = $derived(data.companyName ?? 'the company')
</script>

<svelte:head>
  <title>{docTitle(`Join ${company}`)}</title>
</svelte:head>

<div class="mx-auto max-w-md px-5 pt-16">
  <header class="text-center">
    <span class="text-lg font-medium tracking-tight">{company}</span>
    {#if data.ok}
      <p class="text-muted-foreground mt-2 text-xs">
        You're invited to join as {data.role === 'admin' ? 'an admin' : 'a member'}.
      </p>
    {/if}
  </header>

  <Card.Root class="ring-0 shadow-[4px_4px_0_0_rgb(17_17_17_/_0.08)] mt-8 border border-black/10 bg-card">
    <Card.Content class="space-y-4 pt-6">
      {#if !data.ok}
        <p class="text-xs" data-testid="invite-unavailable">{data.message}</p>
        <a
          href={resolve('/login')}
          class="inline-block text-xs font-medium underline underline-offset-4"
          data-testid="invite-sign-in">Sign in</a
        >
      {:else if codeStep}
        <form method="post" action="?/verifyCode" use:enhance class="space-y-4" data-testid="invite-code-step">
          <input type="hidden" name="token" value={data.token} />
          <input type="hidden" name="email" value={data.email} />
          {#if form && 'notice' in form && form.notice}
            <p class="text-xs">{form.notice}</p>
          {/if}
          <div class="space-y-1">
            <Label for="code">Code</Label>
            <input
              id="code"
              name="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              pattern={CODE_PATTERN}
              required
              class="border-input bg-card text-foreground h-11 w-full border px-2.5 text-center font-mono text-lg tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            />
          </div>
          <Button type="submit" class="w-full rounded-[4px]">Join</Button>
          {#if form && 'message' in form && form.message}
            <p class="text-destructive text-xs" data-testid="invite-error">{form.message}</p>
          {/if}
        </form>
      {:else}
        <form method="post" action="?/sendCode" use:enhance class="space-y-4" data-testid="invite-start">
          <input type="hidden" name="token" value={data.token} />
          <p class="text-xs">We'll send a sign-in code to <strong>{data.email}</strong>.</p>
          <Button type="submit" class="w-full rounded-[4px]">Send code</Button>
          {#if form && 'message' in form && form.message}
            <p class="text-destructive text-xs" data-testid="invite-error">{form.message}</p>
          {/if}
        </form>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
