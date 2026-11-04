<script lang="ts">
  import type { PageData } from './$types'
  import PublicFrame from '$lib/components/page/public-frame.svelte'
  import ProfileEditor from '$lib/components/profile-editor.svelte'
  import * as Card from '$lib/components/ui/card'
  import { docTitle } from '$lib/shell/title'

  /**
   * The profile step (P-5): first name, last name and a picture before
   * anything else — the name and face everyone in the company sees next to
   * your messages and files. Then on to where you were going.
   */
  let { data }: { data: PageData } = $props()

  const company = $derived(data.companyName ?? 'your company')

  function continueOn() {
    // A full load: the next page's loads (and the shell) see the finished profile.
    window.location.assign(data.next)
  }
</script>

<svelte:head>
  <title>{docTitle('Your profile')}</title>
</svelte:head>

<PublicFrame title="Set up your profile" subtitle={`This is how people in ${company} see you.`}>
  <Card.Root class="border border-border shadow-none">
    <Card.Content data-testid="profile-step">
      <ProfileEditor profile={data.profile} submitLabel="Continue" requireComplete onsaved={continueOn} />
    </Card.Content>
  </Card.Root>
  <p class="mt-4 text-center text-xs text-muted-foreground">
    Signed in as <span class="font-medium text-foreground">{data.profile.email}</span>. You can change this later in
    Settings › Account.
  </p>
</PublicFrame>
