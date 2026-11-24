<script lang="ts">
  import { onDestroy } from 'svelte'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'
  import { Button } from '$lib/components/ui/button'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { initialCrop, sourceRect } from '$lib/profile/crop'
  import { AVATAR_SIZE, avatarUrl } from '$lib/profile/profile'
  import {
    COWORKER_AVATAR_PRESETS,
    avatarShaFromUrl,
    coworkerAvatarPresetUrl,
    type CoworkerAvatarPresetId,
  } from './avatar-presets'

  /**
   * Avatar picker for AI co-workers (contribution 8cdc80d8): choose from the 8
   * abstract eigenEnterprise CI emblems or upload a custom photo (cropped to a
   * centered 256×256 WebP and uploaded to POST /api/people/avatar/upload).
   * Writes hidden inputs avatar_sent / avatar_preset / avatar_sha256 for the form.
   */
  let {
    idPrefix,
    name = '',
    avatarPreset = $bindable<CoworkerAvatarPresetId | null>(null),
    avatarSha256 = $bindable<string | null>(null),
    currentImage = null,
  }: {
    idPrefix: string
    name?: string
    avatarPreset?: CoworkerAvatarPresetId | null
    avatarSha256?: string | null
    currentImage?: string | null
  } = $props()

  let fileInput = $state<HTMLInputElement | null>(null)
  let uploading = $state(false)
  let error = $state<string | null>(null)
  let uploadedPreview = $state<{ sha256: string; objectUrl: string } | null>(null)

  function clearUploadedPreview() {
    if (uploadedPreview) {
      URL.revokeObjectURL(uploadedPreview.objectUrl)
      uploadedPreview = null
    }
  }

  onDestroy(() => {
    clearUploadedPreview()
  })

  const previewImage = $derived.by(() => {
    if (avatarPreset) return coworkerAvatarPresetUrl(avatarPreset)
    if (avatarSha256) {
      if (uploadedPreview?.sha256 === avatarSha256) return uploadedPreview.objectUrl
      if (currentImage && avatarShaFromUrl(currentImage) === avatarSha256) return currentImage
      return avatarUrl(avatarSha256)
    }
    return null
  })

  const hasSelection = $derived(avatarPreset !== null || avatarSha256 !== null)

  function selectPreset(id: CoworkerAvatarPresetId) {
    error = null
    clearUploadedPreview()
    avatarPreset = id
    avatarSha256 = null
  }

  function clearSelection() {
    error = null
    clearUploadedPreview()
    avatarPreset = null
    avatarSha256 = null
  }

  function encodeSquareWebp(file: File): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const sourceUrl = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(sourceUrl)
        try {
          const crop = initialCrop(img.naturalWidth, img.naturalHeight)
          const { sx, sy, side } = sourceRect(img.naturalWidth, img.naturalHeight, crop)
          const canvas = document.createElement('canvas')
          canvas.width = AVATAR_SIZE
          canvas.height = AVATAR_SIZE
          const ctx = canvas.getContext('2d')
          if (!ctx) return reject(new Error('This browser cannot draw the image.'))
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
          canvas.toBlob(
            (blob) => {
              if (!blob) return reject(new Error('The avatar image could not be created.'))
              if (blob.type !== 'image/webp') {
                return reject(new Error('This browser cannot encode WebP images.'))
              }
              resolve(blob)
            },
            'image/webp',
            0.9,
          )
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      img.onerror = () => {
        URL.revokeObjectURL(sourceUrl)
        reject(new Error(`This browser cannot open “${file.name}”.`))
      }
      img.src = sourceUrl
    })
  }

  async function onFilePick(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    error = null
    if (!file.type.startsWith('image/')) {
      error = `“${file.name}” is not an image file.`
      return
    }
    uploading = true
    let localUrl: string | null = null
    try {
      const webp = await encodeSquareWebp(file)
      localUrl = URL.createObjectURL(webp)
      const res = await fetch('/api/people/avatar/upload', {
        method: 'POST',
        headers: { 'content-type': 'image/webp' },
        body: webp,
      })
      const body = (await res.json().catch(() => ({}))) as { sha256?: string; error?: string }
      if (!res.ok || !body.sha256) {
        URL.revokeObjectURL(localUrl)
        localUrl = null
        error = body.error ?? `Upload failed (${res.status}).`
        return
      }
      clearUploadedPreview()
      uploadedPreview = { sha256: body.sha256, objectUrl: localUrl }
      localUrl = null
      avatarSha256 = body.sha256
      avatarPreset = null
    } catch (err) {
      if (localUrl) URL.revokeObjectURL(localUrl)
      error = err instanceof Error ? err.message : String(err)
    } finally {
      uploading = false
    }
  }
</script>

<div class="space-y-2.5" data-testid="{idPrefix}-avatar-picker">
  <div class="flex flex-wrap items-center gap-3">
    <UserAvatar name={name || 'AI'} image={previewImage} size="lg" testid="{idPrefix}-avatar-preview" />
    <div class="min-w-0 flex-1 space-y-1">
      <p class="text-sm font-medium">{m.coworkers_field_avatar()}</p>
      <p class="text-xs text-muted-foreground">{m.coworkers_avatar_hint()}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <input
        bind:this={fileInput}
        type="file"
        accept="image/*"
        class="hidden"
        data-testid="{idPrefix}-avatar-file"
        onchange={onFilePick}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        onclick={() => fileInput?.click()}
        data-testid="{idPrefix}-avatar-upload"
      >
        {#if uploading}
          <LoaderCircle class="size-3.5 animate-spin" />
          {m.coworkers_avatar_uploading()}
        {:else}
          <Upload class="size-3.5" />
          {m.coworkers_avatar_upload()}
        {/if}
      </Button>
      {#if hasSelection}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={uploading}
          onclick={clearSelection}
          data-testid="{idPrefix}-avatar-clear"
        >
          <X class="size-3.5" />
          {m.coworkers_avatar_clear()}
        </Button>
      {/if}
    </div>
  </div>

  <div class="flex flex-wrap gap-2" role="group" aria-label={m.coworkers_avatar_presets_label()}>
    {#each COWORKER_AVATAR_PRESETS as preset (preset.id)}
      {@const selected = avatarPreset === preset.id}
      <button
        type="button"
        aria-label={preset.label}
        aria-pressed={selected}
        title={preset.label}
        onclick={() => selectPreset(preset.id)}
        data-testid="{idPrefix}-avatar-preset-{preset.id}"
        class={[
          'size-11 overflow-hidden rounded-lg border bg-card p-0.5 transition focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-foreground/40',
        ]}
      >
        <img src={preset.url} alt="" class="size-full rounded-md object-cover" />
      </button>
    {/each}
  </div>

  {#if error}
    <p class="text-xs text-destructive" role="alert" data-testid="{idPrefix}-avatar-error">{error}</p>
  {/if}

  <input type="hidden" name="avatar_sent" value="1" />
  <input
    type="hidden"
    name="avatar_preset"
    value={avatarPreset ?? ''}
    data-testid="{idPrefix}-avatar-preset-input"
  />
  <input
    type="hidden"
    name="avatar_sha256"
    value={avatarSha256 ?? ''}
    data-testid="{idPrefix}-avatar-sha-input"
  />
</div>
