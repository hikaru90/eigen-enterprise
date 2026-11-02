<script lang="ts">
  import { onMount } from 'svelte'
  import { browser } from '$app/environment'
  import { afterNavigate } from '$app/navigation'
  import { base } from '$app/paths'
  import { page } from '$app/state'
  import './layout.css'
  import {
    isPostHogEnabled,
    identify,
    resetPostHog,
    capturePageview,
  } from '$lib/analytics/posthog-client'
  import favicon from '$lib/assets/favicon.png'
  import { startCaptureQueueRunner } from '$lib/capture/queue'
  import { activeVisualSetStyleTag } from '../../modules/brand/style-format/emitter'

  // E2E hydration marker: SvelteKit hydration replaces the SSR DOM, wiping values
  // typed into pre-hydration inputs. Tests wait for this flag before interacting.
  onMount(() => {
    document.body.dataset.eigenHydrated = 'true'
  })
  import type { AuthorLayerMeta } from '$lib/graph/graph-author-layers'
  import { getLocale, setLocale } from '$lib/paraglide/runtime'
  import { startPushNavigationFromServiceWorker } from '$lib/push/navigation-from-sw'
  import { initCurrentUserViewStore } from '$lib/stores/current-user-view.svelte'
  import { startThoughtSync } from '$lib/stores/thought-sync'

  let { children } = $props()

  const authPaths = new Set(['/login', '/signup'])

  function normalizePathname(pathname: string): string {
    let p = pathname
    if (base && p.startsWith(base)) {
      p = p.slice(base.length) || '/'
    }
    if (p.length > 1 && p.endsWith('/')) {
      p = p.slice(0, -1)
    }
    return p || '/'
  }

  // No chrome here: signed-in pages live in the (nucleus) shell, which carries
  // the navigation and the settings menu; signed-out and public pages stay bare.

  let themePreference = 'system'
  let lastIdentifiedUserId: string | null | undefined = undefined

  function syncPostHogIdentity() {
    if (!browser) return
    const user = (page.data as { user?: { id: string; email?: string; name?: string } | null }).user
    const isAdmin = (page.data as { isAdmin?: boolean }).isAdmin ?? false
    if (user?.id) {
      if (lastIdentifiedUserId === user.id) return
      identify(user.id, { email: user.email, name: user.name, is_admin: isAdmin })
      lastIdentifiedUserId = user.id
    } else if (lastIdentifiedUserId !== null) {
      resetPostHog()
      lastIdentifiedUserId = null
    }
  }

  onMount(() => {
    syncPostHogIdentity()
    const layoutUser = (page.data as { user?: { id: string } | null }).user
    if (layoutUser) {
      const layers = (page.data as { authorLayers?: AuthorLayerMeta[] }).authorLayers ?? []
      initCurrentUserViewStore(layers)
    }

    const posthogReady = isPostHogEnabled()
    if (posthogReady) {
      const initialPath = normalizePathname(page.url.pathname)
      if (!authPaths.has(initialPath)) {
        capturePageview(initialPath)
      }
    }
    afterNavigate((nav) => {
      syncPostHogIdentity()
      const path = normalizePathname(nav.to?.url.pathname ?? page.url.pathname)
      if (!authPaths.has(path)) {
        capturePageview(path)
      }
    })

    const stopPushNavigation = startPushNavigationFromServiceWorker()

    if ((page.data as { user?: { id: string } | null }).user) {
      startCaptureQueueRunner()
      startThoughtSync()
    }

    const preferredUiLocale = (page.data as { preferredUiLocale?: string | null }).preferredUiLocale
    if (preferredUiLocale && getLocale() !== preferredUiLocale) {
      setLocale(preferredUiLocale as 'en' | 'de')
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncThemeColorMeta = () => {
      const meta = document.getElementById('theme-color-meta')
      if (!meta) return
      const themeColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--theme-color')
        .trim()
      if (themeColor) meta.setAttribute('content', themeColor)
    }

    const applyTheme = (isDark: boolean) => {
      document.documentElement.classList.toggle('dark', isDark)
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
      syncThemeColorMeta()
    }
    const applyThemePreference = (preference: string) => {
      themePreference = preference
      const useDark = preference === 'dark' || (preference === 'system' && media.matches)
      applyTheme(useDark)
    }
    const savedPreference = localStorage.getItem('theme-preference') ?? 'system'
    applyThemePreference(savedPreference)

    const handleChange = (event: MediaQueryListEvent) => {
      if (themePreference === 'system') {
        applyTheme(event.matches)
      }
    }
    const handlePreferenceChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ preference?: string }>
      applyThemePreference(customEvent.detail?.preference ?? 'system')
    }
    media.addEventListener('change', handleChange)
    window.addEventListener('theme-preference-change', handlePreferenceChange)
    return () => {
      stopPushNavigation()
      media.removeEventListener('change', handleChange)
      window.removeEventListener('theme-preference-change', handlePreferenceChange)
    }
  })
</script>

<svelte:head>
  <title>eigenEnterprise</title>
  <link rel="icon" href={favicon} />
  {#if page.data.activeVisualSet}
    <!-- Phase-2d M5 (V9): the active visual set's tokens apply globally to
         every surface (app shell + public). Cascade guarantee: this <style>
         is UNLAYERED, so it beats the app's @layer base :root declarations at
         equal specificity regardless of order; the app's unlayered `.dark`
         block loses on document order — SvelteKit renders the manifest's
         bundled CSS before the root layout's head content, so this override
         follows it. Exactly one style element, emitter-generated (owner-approved
         tokens, never user input). -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- emitter output over owner-approved active visual set tokens -->
    {@html activeVisualSetStyleTag(
      page.data.activeVisualSet.cssVars,
      page.data.activeVisualSet.darkCssVars,
    )}
  {/if}
</svelte:head>

<div class="bg-background min-h-dvh">
  {@render children()}
</div>

