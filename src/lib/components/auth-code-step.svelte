<script lang="ts">
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import type { AgentReport } from '$lib/errors/agent-report'

  /**
   * Passwordless step 2 (shared by /signup and /login): enter the 6-digit code
   * Better Auth emailed. "Send a new code" re-runs step 1 for the same address.
   */
  let {
    email,
    message,
    error,
    agent = null,
    askName = false,
  }: {
    email: string
    message?: string | undefined
    error?: string | undefined
    /** The server's signed-out agent half (no email, no code). */
    agent?: AgentReport | null
    /** Open join on /signup: the person gives their name with the code, like the invite page. */
    askName?: boolean
  } = $props()

  /** A literal `{6}` in markup would be read as a Svelte expression. */
  const CODE_PATTERN = '[0-9]{6}'
</script>

<form
  method="post"
  action="?/verifyCode"
  use:enhance
  class="space-y-4"
  data-testid="auth-code-step"
>
  <input type="hidden" name="email" value={email} />
  {#if message}
    <p class="text-foreground text-xs">{message}</p>
  {/if}
  {#if askName}
    <div class="space-y-1">
      <Label for="name">Your name</Label>
      <input
        id="name"
        name="name"
        autocomplete="name"
        maxlength="80"
        required
        data-testid="auth-code-name"
        class="border-input bg-card text-foreground h-9 w-full border px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      />
    </div>
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
    <ErrorNotice
      class="text-xs"
      testid="auth-code-error"
      {error}
      {agent}
      attempted="Checking the emailed sign-in code"
    />
  {/if}
</form>
<form method="post" action="?/sendCode" use:enhance class="text-center">
  <input type="hidden" name="email" value={email} />
  <input type="hidden" name="acceptTerms" value="on" />
  <button type="submit" class="text-muted-foreground text-xs underline-offset-2 hover:underline">
    Send a new code
  </button>
</form>
