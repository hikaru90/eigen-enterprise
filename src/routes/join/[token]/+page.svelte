<script lang="ts">
  import type { PageData } from './$types'
  import { browserActiveCall } from '$lib/calls/active-call.svelte'
  import { guestCallsClient } from '$lib/calls/client'
  import GuestJoin from '$lib/calls/guest-join.svelte'
  import { docTitle } from '$lib/shell/title'

  /** A guest's call link (proposal 844bab56): the page is GuestJoin over the guest routes. */
  let { data }: { data: PageData } = $props()

  const makeActive = (name: () => string) => browserActiveCall(guestCallsClient(data.token, name))
  const getMedia = (c: MediaStreamConstraints) => {
    if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('this browser offers no camera or microphone here'))
    return navigator.mediaDevices.getUserMedia(c)
  }
</script>

<svelte:head>
  <title>{docTitle(data.view?.status === 'ok' ? data.view.title : 'Video call')}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<GuestJoin view={data.view} call={data.call} {makeActive} {getMedia} />
