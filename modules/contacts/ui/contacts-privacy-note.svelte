<script lang="ts">
  import InfoPopover from '$lib/components/ui/info-popover.svelte'

  /**
   * "Who can see your contacts?" — the real rules (modules/contacts/service.ts),
   * behind a "?" next to the Contacts heading (Contribute 09c6fc11): a new
   * contact starts as your default (private unless you or the company chose
   * the whole team), sharing with the whole team / people / groups (Contribute
   * 9d28020a), many at once, and what the agent sees.
   */
</script>

<InfoPopover label="Who can see your contacts?" testid="contacts-privacy">
  <ul class="list-disc space-y-1 pl-5">
    <li>
      A contact you add starts as your default for new contacts — private (only you, the company owner and admins) unless you or the company
      chose the whole team in Contacts settings. Your own choice wins over the company’s.
    </li>
    <li>
      Share contacts with the whole team — everyone in the company, including people who join later — or with people and groups (a group
      share follows who is in the group). They can see and update them.
    </li>
    <li>
      Select several in the list to share them or make them private at once. Only the person who added a contact, the owner and admins
      change who sees it or delete it; others are skipped.
    </li>
    <li>
      When the assistant works for you, it sees what you see and its new contacts follow your default. Working on its own, the company’s
      agent can read every contact, like an admin, and its new contacts follow the company default. Its changes follow the company’s
      approval setting.
    </li>
  </ul>
</InfoPopover>
