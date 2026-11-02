<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'
  import PublicFrame from '$lib/components/page/public-frame.svelte'

  /** Claim this server: the installer's private link → your email → you own the company. */
  let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head>
  <title>{docTitle('Claim your company')}</title>
</svelte:head>

<PublicFrame
  title="Claim your company"
  subtitle={data.ok ? 'Your company is installed. Claim it.' : null}
>
  <Card.Root class="border border-border shadow-none">
    <Card.Content class="space-y-4">
      {#if data.ok}
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
            <p class="text-muted-foreground text-[10px]">
              You become the owner of this server. This link works once.
            </p>
          </div>
          <Button type="submit" class="w-full rounded-[4px]">Claim</Button>
          {#if form?.message}
            <p class="text-destructive text-xs" data-testid="claim-error">{form.message}</p>
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
