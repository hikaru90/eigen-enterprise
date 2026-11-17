<script lang="ts">
  /**
   * "Who can see this?" — the Drive's real visibility rules, stated where people
   * first land (My drive). Mirrors modules/drive/service.ts + access-port.ts:
   * new items are visible to their creator plus the company owner and admins;
   * sharing adds people, groups or the whole company at view/edit/manage, and a
   * folder's grants cover what is inside it; the agent acts with admin rights.
   * There is no item hidden from the owner and admins. Shown on demand in the
   * Drive's "?" popover next to its title (Contribute 19fc700d, b732961f).
   */
</script>

<section aria-labelledby="drive-privacy-title" class="space-y-1.5" data-testid="drive-privacy-note">
  <h2 id="drive-privacy-title" class="font-medium text-foreground">Who can see your Drive</h2>
  <ul class="list-disc space-y-1 pl-4">
    <li>
      A folder or file you create is private until you share it: only you, the company owner and admins can see
      it.
    </li>
    <li>
      Share it with specific people, a group or the whole company, and choose whether they can view, edit or manage
      it. Sharing a folder shares everything inside it.
    </li>
    <li>The company’s agent can read and list Drive files with admin rights.</li>
    <li>There is no way to make a folder hidden from the owner and admins.</li>
  </ul>
</section>
