<script lang="ts">
  import type { ActiveCall } from './active-call.svelte'
  import type { DeviceKind } from './devices'
  import X from '@lucide/svelte/icons/x'

  /**
   * Microphone, speaker and camera for the live call (Contribute round 4).
   * The lists come from the browser (refreshed on devicechange); a choice
   * switches the call at once and is remembered in this browser. Where the
   * browser cannot route sound to a chosen speaker (no setSinkId, e.g. Safari
   * on iPhone), it says so instead of hiding the speaker.
   */
  let { active, onclose }: { active: ActiveCall; onclose: () => void } = $props()

  const ROWS: Array<{ kind: DeviceKind; label: string; none: string }> = [
    { kind: 'audioinput', label: 'Microphone', none: 'No microphone found.' },
    { kind: 'audiooutput', label: 'Speaker', none: 'No speaker found.' },
    { kind: 'videoinput', label: 'Camera', none: 'No camera found.' },
  ]

  async function choose(kind: DeviceKind, e: Event & { currentTarget: HTMLSelectElement }) {
    const select = e.currentTarget
    await active.chooseDevice(kind, select.value)
    // A device that did not switch: show the one still in use again.
    const inUse = active.selected[kind]
    if (inUse !== null && select.value !== inUse) select.value = inUse
  }
</script>

<div class="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 text-sm text-neutral-50 shadow-xl" role="group" aria-label="Call devices" data-testid="call-devices">
  <div class="mb-2 flex items-center justify-between">
    <p class="text-xs font-semibold tracking-wide text-neutral-400 uppercase">Devices</p>
    <button type="button" class="grid size-7 place-items-center rounded-md text-neutral-400 hover:bg-white/10 hover:text-white" aria-label="Close devices" onclick={onclose}
      ><X class="size-4" /></button
    >
  </div>
  <div class="flex flex-col gap-3">
    {#each ROWS as row (row.kind)}
      <div class="flex flex-col gap-1">
        <label for="call-device-{row.kind}" class="text-xs font-medium text-neutral-300">{row.label}</label>
        {#if row.kind === 'audiooutput' && !active.canChooseSpeaker}
          <p class="text-xs text-neutral-400" data-testid="call-speaker-unsupported">
            This browser cannot choose the speaker for calls. Sound plays on your device's current output; change it in your system's sound settings.
          </p>
        {:else if active.devices[row.kind].length === 0}
          <p class="text-xs text-neutral-400" data-testid="call-device-none" data-kind={row.kind}>{row.none}</p>
        {:else}
          <select
            id="call-device-{row.kind}"
            class="h-9 w-full min-w-0 rounded-md border border-white/15 bg-neutral-800 px-2 text-sm text-white focus:border-white/40 focus:outline-none"
            value={active.selected[row.kind]}
            onchange={(e) => choose(row.kind, e)}
            data-testid="call-device-{row.kind}"
          >
            {#each active.devices[row.kind] as d (d.id)}
              <option value={d.id}>{d.label}</option>
            {/each}
          </select>
        {/if}
      </div>
    {/each}
  </div>
  {#if active.deviceProblem}
    <div class="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-xs" role="alert" data-testid="call-device-problem">
      <p class="min-w-0 flex-1">{active.deviceProblem}</p>
      <button type="button" class="text-neutral-400 hover:text-white" aria-label="Dismiss" onclick={() => active.dismissDeviceProblem()}><X class="size-3.5" /></button>
    </div>
  {/if}
</div>
