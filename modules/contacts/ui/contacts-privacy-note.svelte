<script lang="ts">
  /**
   * "Who can see your contacts?" — the real rules (modules/contacts/service.ts),
   * stated where people keep their contacts: private to whoever adds one plus
   * the owner and admins (as in Drive), shared = everyone in the company, and
   * what the agent sees.
   */
</script>

<aside
  role="note"
  aria-labelledby="contacts-privacy-title"
  class="max-w-2xl rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm"
  data-testid="contacts-privacy-note"
>
  <p id="contacts-privacy-title" class="font-medium">Who can see your contacts</p>
  <ul class="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
    <li>A contact you add is private: only you, the company owner and admins can see it.</li>
    <li>
      Share one with the company and everyone in it can see and update it; only you, the owner and admins can make it
      private again or delete it.
    </li>
    <li>
      When the assistant works for you, it sees what you see. Working on its own, the company’s agent can read every
      contact, like an admin. Its changes follow the company’s approval setting.
    </li>
  </ul>
</aside>
