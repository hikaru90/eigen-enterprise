<script lang="ts">
  import type { PageData } from './$types'
  import { browserActiveCall, type ActiveCall } from '$lib/calls/active-call.svelte'
  import { CallChat } from '$lib/calls/call-chat.svelte'
  import { browserCallTranscription } from '$lib/calls/call-transcription.svelte'
  import { guestCallsClient, guestChatClient, type LiveCallClient } from '$lib/calls/client'
  import GuestJoin from '$lib/calls/guest-join.svelte'
  import { docTitle } from '$lib/shell/title'
  import { TRANSCRIPT_CHUNK_MS } from '../../../../modules/calls/transcript'

  /** A guest's call link (proposal 844bab56): the page is GuestJoin over the guest routes. */
  let { data }: { data: PageData } = $props()

  /** One guest client per join: the call and the transcription of the guest's microphone share it. */
  let client: LiveCallClient | null = null
  const makeActive = (name: () => string) => browserActiveCall((client = guestCallsClient(data.token, name)))
  const makeTranscription = (active: ActiveCall, me: string) => {
    if (!client) throw new Error('calls: the guest call has no client yet')
    return browserCallTranscription(active, me, client, TRANSCRIPT_CHUNK_MS)
  }
  /** The call's chat as this guest (their link is the proof). */
  const makeChat = (me: string, callId: string) => new CallChat({ callId, me, client: guestChatClient(data.token) })
  const getMedia = (c: MediaStreamConstraints) => {
    if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('this browser offers no camera or microphone here'))
    return navigator.mediaDevices.getUserMedia(c)
  }
</script>

<svelte:head>
  <title>{docTitle(data.view?.status === 'ok' ? data.view.title : 'Video call')}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<GuestJoin view={data.view} call={data.call} {makeActive} {makeTranscription} {getMedia} {makeChat} />
