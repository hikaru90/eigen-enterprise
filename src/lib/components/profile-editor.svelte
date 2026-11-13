<script lang="ts" module>
  export type EditableProfile = {
    firstName: string
    lastName: string
    name: string
    email: string
    image: string | null
    complete: boolean
  }
</script>

<script lang="ts">
  import Camera from '@lucide/svelte/icons/camera'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { tick } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { initialCrop, MAX_ZOOM, panBy, sourceRect, zoomTo, type Crop } from '$lib/profile/crop'
  import { AVATAR_SIZE, MAX_NAME_LENGTH } from '$lib/profile/profile'

  /**
   * The one profile editor (P-5): first name, last name and a picture the
   * person crops square here (drag to move, slider to zoom); it is resized
   * to 256 px and saved as WebP in the browser, then uploaded. Used by the
   * required profile step (/welcome/profile) and Settings › Account.
   *
   * The picture uploads as soon as it is chosen ("Use this picture"); the
   * names save with the submit button.
   */
  let {
    profile,
    submitLabel = 'Save',
    requireComplete = false,
    onsaved,
    onpicture,
  }: {
    profile: EditableProfile
    submitLabel?: string
    /** The profile step: the submit button stays disabled until names and picture are there. */
    requireComplete?: boolean
    onsaved?: (profile: EditableProfile) => void | Promise<void>
    /** After a new picture is stored (Settings refreshes the shell's avatar). */
    onpicture?: (profile: EditableProfile) => void | Promise<void>
  } = $props()

  // svelte-ignore state_referenced_locally
  let firstName = $state(profile.firstName)
  // svelte-ignore state_referenced_locally
  let lastName = $state(profile.lastName)
  // svelte-ignore state_referenced_locally
  let image = $state<string | null>(profile.image)
  let saving = $state(false)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)

  // ── cropping ──────────────────────────────────────────────────────────
  /** The crop preview's on-screen size (CSS px); pointer deltas are in these units. */
  const VIEW = 176
  let fileInput = $state<HTMLInputElement | null>(null)
  let canvasEl = $state<HTMLCanvasElement | null>(null)
  let source = $state<HTMLImageElement | null>(null)
  let sourceUrl: string | null = null
  let crop = $state<Crop | null>(null)
  let uploading = $state(false)
  let drag: { x: number; y: number; id: number } | null = null

  const displayName = $derived(`${firstName.trim()} ${lastName.trim()}`.trim() || profile.email)
  const namesReady = $derived(firstName.trim().length > 0 && lastName.trim().length > 0)
  const canSubmit = $derived(!saving && !uploading && !source && namesReady && (!requireComplete || Boolean(image)))

  function draw() {
    const ctx = canvasEl?.getContext('2d')
    if (!ctx || !source || !crop) return
    const { sx, sy, side } = sourceRect(source.naturalWidth, source.naturalHeight, crop)
    const px = VIEW * 2 // drawn at 2× for sharp previews on high-density screens
    ctx.clearRect(0, 0, px, px)
    ctx.drawImage(source, sx, sy, side, side, 0, 0, px, px)
  }

  function discardSource() {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl)
    sourceUrl = null
    source = null
    crop = null
  }

  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    error = null
    notice = null
    if (!file.type.startsWith('image/')) {
      error = `“${file.name}” isn’t a picture. Choose a JPEG, PNG, WebP or GIF.`
      return
    }
    discardSource()
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = async () => {
      sourceUrl = url
      source = img
      crop = initialCrop(img.naturalWidth, img.naturalHeight)
      await tick()
      draw()
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      error = `This browser can’t open “${file.name}”. Choose a JPEG, PNG, WebP or GIF.`
    }
    img.src = url
  }

  function onPointerDown(e: PointerEvent) {
    if (!canvasEl) return
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId }
    canvasEl.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId || !source || !crop) return
    crop = panBy(source.naturalWidth, source.naturalHeight, crop, e.clientX - drag.x, e.clientY - drag.y, VIEW)
    drag = { ...drag, x: e.clientX, y: e.clientY }
    draw()
  }

  function onPointerUp(e: PointerEvent) {
    if (drag?.id === e.pointerId) drag = null
  }

  function onZoom(e: Event) {
    if (!source || !crop) return
    crop = zoomTo(source.naturalWidth, source.naturalHeight, crop, Number((e.currentTarget as HTMLInputElement).value))
    draw()
  }

  function onCropKey(e: KeyboardEvent) {
    if (!source || !crop) return
    const step = 8
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    const m = moves[e.key]
    if (!m) return
    e.preventDefault()
    crop = panBy(source.naturalWidth, source.naturalHeight, crop, m[0], m[1], VIEW)
    draw()
  }

  /** The cropped square, resized to 256 px, as WebP (fails loud when the browser can't encode WebP). */
  function renderWebp(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!source || !crop) return reject(new Error('Choose a picture first.'))
      const out = document.createElement('canvas')
      out.width = AVATAR_SIZE
      out.height = AVATAR_SIZE
      const ctx = out.getContext('2d')
      if (!ctx) return reject(new Error('This browser can’t draw the picture.'))
      const { sx, sy, side } = sourceRect(source.naturalWidth, source.naturalHeight, crop)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(source, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
      out.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('The picture could not be made.'))
          if (blob.type !== 'image/webp') {
            return reject(new Error('This browser can’t save WebP pictures. Try a current Chrome, Edge, Firefox or Safari.'))
          }
          resolve(blob)
        },
        'image/webp',
        0.9,
      )
    })
  }

  async function usePicture() {
    error = null
    notice = null
    uploading = true
    try {
      const blob = await renderWebp()
      const res = await fetch('/api/profile/avatar', { method: 'POST', headers: { 'content-type': 'image/webp' }, body: blob })
      const body = (await res.json().catch(() => ({}))) as { profile?: EditableProfile; error?: string }
      if (!res.ok || !body.profile) throw new Error(body.error ?? `Upload failed (${res.status}).`)
      image = body.profile.image
      discardSource()
      notice = 'Picture saved.'
      await onpicture?.(body.profile)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      uploading = false
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!canSubmit) return
    saving = true
    error = null
    notice = null
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName, lastName }),
      })
      const body = (await res.json().catch(() => ({}))) as { profile?: EditableProfile; error?: string }
      if (!res.ok || !body.profile) throw new Error(body.error ?? `Saving failed (${res.status}).`)
      firstName = body.profile.firstName
      lastName = body.profile.lastName
      image = body.profile.image
      notice = 'Profile saved.'
      await onsaved?.(body.profile)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }
</script>

<form class="space-y-6" onsubmit={submit} data-testid="profile-editor" novalidate>
  <div class="flex items-center gap-4">
    {#if source}
      <div class="flex flex-col items-start gap-2" data-testid="profile-crop">
        <canvas
          bind:this={canvasEl}
          width={VIEW * 2}
          height={VIEW * 2}
          class="cursor-grab touch-none rounded-xl border border-border bg-foreground/[0.04] outline-none focus-visible:ring-2 -ring active:cursor-grabbing"
          style="width: {VIEW}px; height: {VIEW}px;"
          tabindex="0"
          aria-label="Crop preview — drag or use the arrow keys to move the picture"
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
          onkeydown={onCropKey}
        ></canvas>
        <label class="flex w-full items-center gap-2 text-xs text-muted-foreground">
          Zoom
          <input
            type="range"
            min="1"
            max={MAX_ZOOM}
            step="0.01"
            value={crop?.zoom ?? 1}
            oninput={onZoom}
            class="flex-1 accent-primary"
            aria-label="Zoom"
            data-testid="profile-crop-zoom"
          />
        </label>
      </div>
    {:else}
      <UserAvatar name={displayName} {image} size="xl" testid="profile-avatar" />
    {/if}
    <div class="min-w-0 space-y-2">
      <p class="text-sm font-medium">Profile picture</p>
      <p class="text-xs text-muted-foreground">
        {#if source}Drag to frame your face, then use it.{:else}A photo people recognise you by — square, it’s cropped here.{/if}
      </p>
      <input
        bind:this={fileInput}
        type="file"
        accept="image/*"
        class="hidden"
        data-testid="profile-picture-input"
        onchange={onPick}
      />
      <div class="flex flex-wrap gap-2">
        {#if source}
          <Button type="button" size="sm" onclick={usePicture} disabled={uploading} data-testid="profile-crop-apply">
            {#if uploading}<LoaderCircle class="size-4 animate-spin" />{/if}
            Use this picture
          </Button>
          <Button type="button" size="sm" variant="outline" onclick={discardSource} disabled={uploading}>Cancel</Button>
        {:else}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onclick={() => fileInput?.click()}
            data-testid="profile-picture-choose"
          >
            <Camera class="size-4" />
            {image ? 'Change picture' : 'Choose a picture'}
          </Button>
        {/if}
      </div>
    </div>
  </div>

  <div class="grid gap-4 sm:grid-cols-2">
    <div class="space-y-1.5">
      <Label for="profile-first-name">First name</Label>
      <Input
        id="profile-first-name"
        bind:value={firstName}
        autocomplete="given-name"
        maxlength={MAX_NAME_LENGTH}
        required
        data-testid="profile-first-name"
      />
    </div>
    <div class="space-y-1.5">
      <Label for="profile-last-name">Last name</Label>
      <Input
        id="profile-last-name"
        bind:value={lastName}
        autocomplete="family-name"
        maxlength={MAX_NAME_LENGTH}
        required
        data-testid="profile-last-name"
      />
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive" role="alert" data-testid="profile-error">{error}</p>
  {:else if notice}
    <p class="text-sm text-muted-foreground" role="status" data-testid="profile-notice">{notice}</p>
  {/if}

  <div class="flex items-center gap-3">
    <Button type="submit" disabled={!canSubmit} data-testid="profile-save">
      {#if saving}<LoaderCircle class="size-4 animate-spin" />{/if}
      {submitLabel}
    </Button>
    {#if requireComplete && !image}
      <span class="text-xs text-muted-foreground">Add a picture to continue.</span>
    {/if}
  </div>
</form>
