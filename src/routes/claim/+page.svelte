<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'

  /** Claim this server: the installer's private link → your email → you own the company. */
  let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head>
  <title>Claim your company · Eigen Enterprise</title>
</svelte:head>

<div class="mx-auto max-w-md px-5 pt-16">
  <header class="text-center">
    <span class="text-lg font-medium tracking-tight">Eigen Enterprise</span>
    {#if data.ok}
      <p class="text-muted-foreground mt-2 text-xs">Your company is installed. Claim it.</p>
    {/if}
  </header>

  <Card.Root class="ring-0 shadow-[4px_4px_0_0_rgb(17_17_17_/_0.08)] mt-8 border border-black/10 bg-card">
    <Card.Content class="space-y-4 pt-6">
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
      {/if}
    </Card.Content>
  </Card.Root>
</div>
