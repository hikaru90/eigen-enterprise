<script lang="ts">
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'

  /**
   * Passwordless step 2 (shared by /signup and /login): enter the 6-digit code
   * Better Auth emailed. "Send a new code" re-runs step 1 for the same address.
   */
  let {
    email,
    message,
    error,
  }: { email: string; message?: string | undefined; error?: string | undefined } = $props()

  /** A literal `{6}` in markup would be read as a Svelte expression. */
  const CODE_PATTERN = '[0-9]{6}'
</script>

<form method="post" action="?/verifyCode" use:enhance class="space-y-4" data-testid="auth-code-step">
  <input type="hidden" name="email" value={email} />
  {#if message}
    <p class="text-foreground text-xs">{message}</p>
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
  <Button type="submit" class="w-full rounded-[4px]">Continue</Button>
  {#if error}
    <p class="text-destructive text-xs" data-testid="auth-code-error">{error}</p>
  {/if}
</form>
<form method="post" action="?/sendCode" use:enhance class="text-center">
  <input type="hidden" name="email" value={email} />
  <input type="hidden" name="acceptTerms" value="on" />
  <button type="submit" class="text-muted-foreground text-xs underline-offset-2 hover:underline">
    Send a new code
  </button>
</form>
