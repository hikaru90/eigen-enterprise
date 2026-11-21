<script lang="ts">
  import type { SocialApi } from './social-api'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import type { ShownError } from '$lib/errors/agent-report'
  import {
    SOCIAL_IMAGE_TYPES,
    SOCIAL_MAX_IMAGES,
    SOCIAL_NETWORK_LABELS,
    SOCIAL_NETWORKS,
    SOCIAL_STATUS_LABELS,
    SOCIAL_STATUSES,
    SOCIAL_VIDEO_TYPES,
    type SocialNetwork,
    type SocialPost,
    type SocialPostStatus,
  } from '../../../../../modules/brand/social/types'
  import { brandShownError } from '../brand-errors'

  /**
   * Upload a post that's already made: images (one, or a carousel) or one
   * video, with its title, networks, status, planned day and a caption that
   * starts out the same for every network (each can be edited afterwards).
   */
  let {
    open = $bindable(false),
    api,
    onUploaded,
  }: { open?: boolean; api: SocialApi; onUploaded: (post: SocialPost) => void } = $props()

  let files = $state<File[]>([])
  let title = $state('')
  let networks = $state<SocialNetwork[]>(['instagram'])
  let status = $state<SocialPostStatus>('ready')
  let plannedFor = $state('')
  let caption = $state('')
  let busy = $state(false)
  let error = $state<ShownError | null>(null)

  const accept = [...SOCIAL_IMAGE_TYPES, ...SOCIAL_VIDEO_TYPES].join(',')

  function pick(e: Event & { currentTarget: HTMLInputElement }) {
    files = [...(e.currentTarget.files ?? [])]
    if (!title.trim() && files[0]) title = files[0].name.replace(/\.[^.]+$/, '')
  }

  function toggle(n: SocialNetwork) {
    networks = networks.includes(n)
      ? networks.filter((x) => x !== n)
      : SOCIAL_NETWORKS.filter((x) => x === n || networks.includes(x))
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    busy = true
    error = null
    try {
      const form = new FormData()
      form.set('title', title)
      form.set('status', status)
      if (plannedFor) form.set('plannedFor', plannedFor)
      for (const n of networks) {
        form.append('networks', n)
        if (caption.trim()) form.set(`caption_${n}`, caption.trim())
      }
      for (const f of files) form.append('files', f)
      const post = await api.upload(form)
      onUploaded(post)
      open = false
      files = []
      title = ''
      caption = ''
      plannedFor = ''
    } catch (err) {
      error = brandShownError(err)
    } finally {
      busy = false
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-lg">
    <form class="flex flex-col gap-4" onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>Upload a post</Dialog.Title>
        <Dialog.Description>
          Images for a single post or a carousel (up to {SOCIAL_MAX_IMAGES}), or one video.
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-1.5">
        <Label for="upload-files">Files</Label>
        <input id="upload-files" type="file" multiple {accept} class="text-sm" onchange={pick} />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="upload-title">Title</Label>
        <Input id="upload-title" bind:value={title} required maxlength={120} />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium" id="upload-networks-label">Networks</span>
        <div class="flex flex-wrap gap-2" role="group" aria-labelledby="upload-networks-label">
          {#each SOCIAL_NETWORKS as n (n)}
            <Button
              type="button"
              size="sm"
              variant={networks.includes(n) ? 'secondary' : 'ghost'}
              aria-pressed={networks.includes(n)}
              onclick={() => toggle(n)}
            >
              {SOCIAL_NETWORK_LABELS[n]}
            </Button>
          {/each}
        </div>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="upload-caption"
          >Caption <span class="font-normal text-foreground/55"
            >(for every network; edit each later)</span
          ></Label
        >
        <Textarea id="upload-caption" rows={3} bind:value={caption} />
      </div>
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium" id="upload-status-label">Status</span>
          <div
            class="inline-flex w-fit rounded-md border border-border p-0.5"
            role="group"
            aria-labelledby="upload-status-label"
          >
            {#each SOCIAL_STATUSES as s (s)}
              <Button
                type="button"
                size="sm"
                variant={status === s ? 'default' : 'ghost'}
                aria-pressed={status === s}
                onclick={() => (status = s)}
              >
                {SOCIAL_STATUS_LABELS[s]}
              </Button>
            {/each}
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="upload-planned">Planned for</Label>
          <Input id="upload-planned" type="date" class="w-44" bind:value={plannedFor} />
        </div>
      </div>
      {#if error}
        <ErrorNotice
          error={error.error}
          agent={error.agent}
          attempted="Uploading a file as a social post (Brand › Social)"
        />
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        <Button
          type="submit"
          disabled={busy || files.length === 0 || networks.length === 0 || !title.trim()}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
