<script lang="ts">
  import InfoIcon from '@lucide/svelte/icons/info'
  import XIcon from '@lucide/svelte/icons/x'
  import { resolve } from '$app/paths'

  /**
   * "Who can see your Memory" — stated where people decide whether to write
   * down a worry. Every sentence is what the code does; the facts are pinned
   * by src/lib/server/memory/memory-access.integration.spec.ts and the delete
   * specs next to it:
   * - RLS (src/lib/server/db/enable_rls.sql) scopes every Memory table to the
   *   signed-in person's user id, whatever their company role; no app route
   *   reads another person's Memory. Exception: the Roadmap system project lives
   *   in the owner's Memory — members read it, admins and the agent's roadmap.*
   *   tools change it (modules/orchestrator/roadmap).
   * - The company assistant's memory.* kernel tools run as its own principal
   *   id (modules/memory/tools.ts), never as the person.
   * - API keys authenticate only /api/mcp and /api/mail/send; MCP needs the
   *   key's "MCP access"; its delete_thought archives, delete_project dismisses.
   * - Capture, enrichment and search go through the gateway to the server's AI
   *   provider; speech-to-text always goes to OpenRouter (llm-client.ts). Memory's
   *   calls say `contentOrigin: 'memory'` (memory-content-origin.spec.ts): the
   *   gateway logs and keeps their model, size, cost and timing — in server logs,
   *   the AI usage log (activity_call_log) and, when POSTHOG_API_KEY is set,
   *   PostHog's $ai_generation (`analyticsSeesAi`) — never their text. Memory's
   *   own log lines carry ids and sizes; its pages send PostHog nothing read off
   *   the page (enterPrivateAnalyticsSurface).
   * - Delete (deleteThoughtForUser) removes the row and everything derived;
   *   backups (ee, owner-configured retention) and log lines / AI usage previews
   *   written before this change keep their copies.
   * Dismissed per visit (it sits in the Memory layout, so tab changes keep it closed).
   */
  let { analyticsSeesAi }: { analyticsSeesAi: boolean } = $props()
  let open = $state(true)
</script>

{#if open}
  <aside
    role="note"
    aria-labelledby="memory-privacy-title"
    class="flex gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm"
    data-testid="memory-privacy-note"
  >
    <InfoIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div class="min-w-0 flex-1 space-y-1.5">
      <p id="memory-privacy-title" class="font-medium">Who can see your Memory</p>
      <ul class="list-disc space-y-1 pl-4 text-muted-foreground">
        <li>
          Only you. Other members, admins and the owner can’t open or search your thoughts, tasks,
          projects or notes. The one exception is the company’s Roadmap project: everyone sees it,
          and admins and the assistant change it.
        </li>
        <li>
          The company’s assistant doesn’t read it either. An app or agent you give an API key with
          MCP access (Settings → API keys) can read and add to it as you, until you revoke the key —
          it can archive thoughts, but never delete them.
        </li>
        <li>
          To understand and search it, what you capture and search for is sent to this server’s AI
          provider; voice notes are transcribed by OpenRouter. The server’s logs and your AI usage
          log note that Memory used AI — size, cost, time — never what you wrote.{#if analyticsSeesAi}
            The same goes for this server’s product analytics (PostHog): how AI requests went, never
            your Memory text.{/if}
        </li>
        <li>
          It is stored in the company’s database, so anyone with direct access to the server can
          read it.
        </li>
        <li>
          Delete removes a thought for good — its text, search, dates and graph links. It doesn’t
          reach backups if the owner set them up, or log lines and AI usage previews written before
          Memory stopped keeping your text there.
          <a
            href={resolve('/m/memory/settings#your-data')}
            class="font-medium text-foreground underline underline-offset-2"
          >
            Delete everything
          </a>
        </li>
      </ul>
    </div>
    <button
      type="button"
      class="size-6 shrink-0 rounded text-muted-foreground hover:text-foreground"
      aria-label="Dismiss"
      onclick={() => (open = false)}
    >
      <XIcon class="mx-auto size-4" aria-hidden="true" />
    </button>
  </aside>
{/if}
