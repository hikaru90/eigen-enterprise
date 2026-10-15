<script lang="ts">
  import type { PageProps } from './$types'
  import Cpu from '@lucide/svelte/icons/cpu'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import LogOut from '@lucide/svelte/icons/log-out'
  import Puzzle from '@lucide/svelte/icons/puzzle'
  import UserRound from '@lucide/svelte/icons/user-round'
  import { enhance } from '$app/forms'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { resetPostHog } from '$lib/analytics/posthog-client'
  import { Button } from '$lib/components/ui/button'

  /**
   * Minimal Eigen Enterprise settings: Account (email + password + sign out),
   * AI provider status, API keys, Extensions (the roadmap). Nothing else — the
   * eigen feature surfaces (appearance, speech, push, memory tools, graph
   * utilities) are gone; their server APIs live on untouched.
   */

  let { data, form }: PageProps = $props()

  let signingOut = $state(false)
  let signOutError = $state<string | null>(null)

  async function signOut() {
    if (signingOut) return
    signingOut = true
    signOutError = null
    try {
      const res = await fetch('/api/session/sign-out', {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        throw new Error(`Sign out failed (HTTP ${res.status}).`)
      }
      resetPostHog()
      await goto(resolve('/login'), { invalidateAll: true })
    } catch (err) {
      signOutError = err instanceof Error ? err.message : String(err)
    } finally {
      signingOut = false
    }
  }
</script>

<svelte:head>
  <title>Settings · Eigen Enterprise</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl px-4 py-10">
  <header class="mb-8">
    <p class="text-muted-foreground text-[11px] font-medium tracking-[0.25em] uppercase">
      Eigen Enterprise
    </p>
    <h1 class="mt-1 text-xl font-medium tracking-tight">Settings</h1>
  </header>

  <main class="space-y-8">
    <!-- Account -->
    <section class="space-y-3" data-testid="settings-account">
      <div class="flex items-center gap-2">
        <UserRound class="size-4 shrink-0 opacity-80" strokeWidth={1.75} aria-hidden="true" />
        <h2 class="text-sm font-semibold">Account</h2>
      </div>
      <p class="text-muted-foreground text-xs">Email and password for this account.</p>

      <form
        method="post"
        action="?/changeEmail"
        use:enhance
        class="border-black/15 space-y-2 border p-4"
      >
        <label class="block">
          <span class="text-sm font-medium">Change email</span>
          <input
            type="email"
            name="newEmail"
            placeholder="you@example.com"
            autocomplete="email"
            class="border-black/15 focus:border-black mt-1 h-10 w-full border bg-white px-3 text-sm outline-none"
          />
        </label>
        <Button type="submit" variant="outline" size="sm" class="rounded-none"
          >Update email</Button
        >
        {#if form?.emailMessage}
          <p class="text-muted-foreground text-xs">{form.emailMessage}</p>
        {/if}
      </form>

      <form
        method="post"
        action="?/changePassword"
        use:enhance
        class="border-black/15 space-y-2 border p-4"
      >
        <label class="block">
          <span class="text-sm font-medium">Change password</span>
          <input
            type="password"
            name="currentPassword"
            placeholder="Current password"
            autocomplete="current-password"
            class="border-black/15 focus:border-black mt-1 h-10 w-full border bg-white px-3 text-sm outline-none"
          />
        </label>
        <input
          type="password"
          name="newPassword"
          placeholder="New password (min. 8 characters)"
          autocomplete="new-password"
          class="border-black/15 focus:border-black h-10 w-full border bg-white px-3 text-sm outline-none"
        />
        <div>
          <Button type="submit" variant="outline" size="sm" class="rounded-none"
            >Update password</Button
          >
        </div>
        {#if form?.passwordMessage}
          <p class="text-muted-foreground text-xs">{form.passwordMessage}</p>
        {/if}
      </form>

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          class="rounded-none"
          disabled={signingOut}
          onclick={() => void signOut()}
        >
          {#if signingOut}
            <LoaderCircle class="size-4 shrink-0 animate-spin" strokeWidth={1.75} />
          {:else}
            <LogOut class="size-4 shrink-0" strokeWidth={1.75} />
          {/if}
          Sign out
        </Button>
        {#if signOutError}
          <p class="text-destructive mt-2 text-xs" role="alert">{signOutError}</p>
        {/if}
      </div>
    </section>

    <!-- AI provider -->
    <section class="space-y-3" data-testid="settings-provider">
      <div class="flex items-center gap-2">
        <Cpu class="size-4 shrink-0 opacity-80" strokeWidth={1.75} aria-hidden="true" />
        <h2 class="text-sm font-semibold">AI provider</h2>
      </div>
      <div class="border-black/15 flex items-center justify-between gap-4 border p-4">
        <div>
          <p class="text-sm">
            {data.providerReady ? 'Connected.' : 'Not set up yet.'}
          </p>
          <p class="text-muted-foreground mt-0.5 text-xs">
            The engine that thinks for your company. Without it, nothing works.
          </p>
        </div>
        <a
          href={resolve('/settings/llm')}
          class="shrink-0 bg-black px-3 py-2 text-xs font-medium text-white hover:bg-black/90"
        >
          {data.providerReady ? 'Manage' : 'Set up'} provider →
        </a>
      </div>
    </section>

    <!-- API keys -->
    <section class="space-y-3" data-testid="settings-api-keys">
      <div class="flex items-center gap-2">
        <KeyRound class="size-4 shrink-0 opacity-80" strokeWidth={1.75} aria-hidden="true" />
        <h2 class="text-sm font-semibold">API keys</h2>
      </div>
      <div class="border-black/15 flex items-center justify-between gap-4 border p-4">
        <p class="text-muted-foreground text-xs">
          Connect other tools to your company's data.
        </p>
        <a
          href={resolve('/api-keys')}
          class="border-black/15 hover:border-black shrink-0 border px-3 py-2 text-xs font-medium"
        >
          Manage API keys →
        </a>
      </div>
    </section>

    <!-- Extensions -->
    <section class="space-y-3" data-testid="settings-extensions">
      <div class="flex items-center gap-2">
        <Puzzle class="size-4 shrink-0 opacity-80" strokeWidth={1.75} aria-hidden="true" />
        <h2 class="text-sm font-semibold">Extensions</h2>
      </div>
      <div class="border-black/15 flex items-center justify-between gap-4 border p-4">
        <p class="text-muted-foreground text-xs">
          What the system shipped, what it is working on, what comes next.
        </p>
        <a
          href={resolve('/settings/extensions')}
          class="border-black/15 hover:border-black shrink-0 border px-3 py-2 text-xs font-medium"
        >
          Extension Roadmap →
        </a>
      </div>
    </section>
  </main>
</div>
