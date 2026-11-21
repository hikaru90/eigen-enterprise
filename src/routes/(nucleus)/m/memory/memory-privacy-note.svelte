<script lang="ts">
  import { resolve } from '$app/paths'

  /**
   * "Who can see your Memory" — stated where people decide whether to write
   * down a worry. Every sentence is what the code does; the facts are pinned
   * by src/lib/server/memory/memory-access.integration.spec.ts and the delete
   * specs next to it:
   * - RLS (src/lib/server/db/enable_rls.sql) scopes every Memory table to the
   *   signed-in person's user id, whatever their company role. Shared Memory
   *   (drizzle/0164, plan/shared-memory-voice-agent-tools.md §1): projects and
   *   notes are shared with every member by default — a project with its tasks
   *   (task thoughts linked to it), their order, milestones and dates — read-only
   *   for everyone but their owner; one switched to Private is the owner's alone,
   *   no admin or owner override. Thoughts, Capture and tasks outside a shared
   *   project stay the person's own. memory-sharing.integration.spec.ts pins it.
   *   The Roadmap system project lives in the owner's Memory and is always
   *   shared — admins and the agent's roadmap.* tools change it
   *   (modules/orchestrator/roadmap).
   * - The company brain acts as a person (CB3): in a person's own conversation
   *   its memory.* kernel tools run as THAT person (delegated principal, RLS of
   *   that person — modules/memory/tools.ts, src/lib/server/kernel/principal-scope.ts),
   *   so it reads their Memory plus what colleagues share; another person's turn
   *   runs as them and reaches only what this person shares.
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
   * Shown on demand in Memory's "?" popover next to its title (Contribute
   * 19fc700d, b732961f), on every Memory tab.
   */
  let { analyticsSeesAi }: { analyticsSeesAi: boolean } = $props()
</script>

<section aria-labelledby="memory-privacy-title" class="space-y-1.5" data-testid="memory-privacy-note">
  <h2 id="memory-privacy-title" class="font-medium text-foreground">Who can see your Memory</h2>
  <ul class="list-disc space-y-1 pl-4">
    <li>
      Your projects and notes are shared with everyone in the company — a project together with
      its tasks and progress. Colleagues can read them but only you change them. Switch one to
      Private and only you can see it: no admin, not even the owner. Your thoughts, what you
      capture and tasks outside a shared project are yours alone. The company’s Roadmap project
      is always shared, and admins and the assistant change it.
    </li>
    <li>
      The company brain reads it only as you: in your own conversations it sees your Memory and
      what colleagues share — never their private things; a colleague’s question reaches only
      what you share. It can make things private for you, never share them. When you ask, it adds thoughts
      and notes to your Memory — notes marked as the assistant’s — and changes only the notes it
      wrote. An app or agent you give an API key with
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
      <a href={resolve('/m/memory/settings#your-data')}>
        Delete everything
      </a>
    </li>
  </ul>
</section>
