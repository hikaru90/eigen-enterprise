<script lang="ts">
  import type { PushEnvironment } from './push-prompt'
  import { onMount } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { ShownError } from '$lib/errors/agent-report'
  import type { NotificationDevice } from '$lib/kernel/notification-tools'
  import { getExistingPushSubscription, postTestPush, shownPushFailure } from '$lib/push/client'
  import { endpointHash } from '$lib/push/endpoint-hash'
  import NotificationsBanner from './notifications-banner.svelte'

  /**
   * Settings → Account → Notifications (bug 87f5b9f8): the devices on which
   * this person has notifications on, which one is this device, a test
   * notification per device (POST /api/push/test — the registry tool
   * notifications.test), and "Turn on notifications on this device" when this
   * one is not on. On iPhone/iPad the home-screen app and Safari are separate
   * devices here: each has its own subscription.
   */
  type Props = {
    devices: NotificationDevice[]
    currentEndpointHash?: () => Promise<string | null>
    sendTest?: (deviceId: string) => Promise<{ sent: number }>
    /** Passed to the turn-on prompt (tests inject fakes). */
    readEnv?: () => Promise<PushEnvironment>
    enable?: () => Promise<void>
    /** After notifications were turned on here: reload the list. */
    onchanged?: () => void
  }

  let {
    devices,
    currentEndpointHash = async () => {
      const sub = await getExistingPushSubscription()
      return sub ? endpointHash(sub.endpoint) : null
    },
    sendTest = postTestPush,
    readEnv,
    enable,
    onchanged,
  }: Props = $props()

  let current = $state<string | null>(null)
  let testing = $state<string | null>(null)
  let results = $state<Record<string, { ok: true; text: string } | ({ ok: false } & ShownError)>>(
    {},
  )

  onMount(() => {
    currentEndpointHash()
      .then((h) => (current = h))
      .catch((err) => console.error('[push] could not read this device’s subscription', err))
  })

  /** The platform part of the user agent — "(iPhone; CPU iPhone OS 18_1 …)" — as written by the browser. */
  function platformOf(ua: string | null): string {
    if (!ua) return 'Unknown device'
    const open = ua.indexOf('(')
    const close = ua.indexOf(')', open + 1)
    return open >= 0 && close > open ? ua.slice(open + 1, close) : ua
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

  async function test(id: string) {
    testing = id
    try {
      const r = await sendTest(id)
      results = {
        ...results,
        [id]: { ok: true, text: r.sent > 0 ? 'Sent — check that device.' : 'Not delivered.' },
      }
    } catch (err) {
      results = { ...results, [id]: { ok: false, ...shownPushFailure(err) } }
    } finally {
      testing = null
    }
  }
</script>

<section class="space-y-3 rounded-lg border border-border p-4" data-testid="settings-notifications">
  <div>
    <h3 class="text-sm font-medium">Notifications</h3>
    <p class="text-xs text-foreground/60">
      The devices that get your notifications. On iPhone and iPad, the app on your home screen is
      its own device: turn notifications on in it.
    </p>
  </div>

  {#if devices.length === 0}
    <p class="text-xs text-foreground/60" data-testid="push-devices-empty">
      No device has notifications on yet.
    </p>
  {:else}
    <ul class="divide-y divide-border rounded-md border border-border">
      {#each devices as d (d.id)}
        <li
          class="flex flex-wrap items-center justify-between gap-2 p-3"
          data-testid={`push-device-${d.id}`}
        >
          <div class="min-w-0">
            <p class="truncate text-sm">
              {platformOf(d.userAgent)}
              {#if current === d.endpointHash}
                <span class="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
                  >This device</span
                >
              {/if}
            </p>
            <p class="text-xs text-foreground/60">
              On since {day(d.since)} · last seen {day(d.lastSeen)} · {d.service}
            </p>
            {#if results[d.id]}
              {@const result = results[d.id]}
              {#if result.ok}
                <p class="mt-1 text-xs text-foreground/70" role="status">{result.text}</p>
              {:else}
                <ErrorNotice
                  class="mt-1 text-xs"
                  error={result.error}
                  agent={result.agent}
                  attempted="Sending a test notification to one device (Settings → Account → Notifications)"
                />
              {/if}
            {/if}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={testing !== null}
            onclick={() => void test(d.id)}
            data-testid={`push-device-test-${d.id}`}
          >
            {testing === d.id ? 'Sending…' : 'Send test'}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}

  <NotificationsBanner variant="inline" {readEnv} {enable} onenabled={onchanged} />
</section>
