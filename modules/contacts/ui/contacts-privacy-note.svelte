<script lang="ts">
  import InfoPopover from '$lib/components/ui/info-popover.svelte'

  /**
   * "Who can see your contacts?" — the real rules (modules/contacts/service.ts),
   * behind a "?" next to the Contacts heading (Contribute 09c6fc11; it was an
   * always-visible box): private to whoever adds one plus the owner and admins
   * (as in Drive), shared = everyone in the company, and what the agent sees.
   */
</script>

<InfoPopover label="Who can see your contacts?" testid="contacts-privacy">
  <ul class="list-disc space-y-1 pl-5">
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
</InfoPopover>
