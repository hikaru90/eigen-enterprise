<script lang="ts">
  import type { PageProps } from './$types'
  import { markHandoffPending } from '$lib/components/assistant/handoff'
  import HomeSettingsMenu from '$lib/components/home-settings-menu.svelte'
  import WelcomeWizard from '$lib/components/welcome-wizard.svelte'
  import { docTitle } from '$lib/shell/title'
  import Dashboard from './dashboard.svelte'

  /**
   * `/`: the full-screen first run (welcome boot sequence, provider gate) until
   * it is done, then the company's dashboard (polish P-2). The chat moved into
   * the shell's assistant panel (P-1).
   */
  let { data }: PageProps = $props()

  /**
   * Assisted onboarding: when the scripted first run ends, the orchestrator
   * AGENT takes over — its first turn is generated server-side from the
   * onboarding context (POST /api/chat, onboardingHandoff), not scripted here.
   * The wizard reloads page data right after this, the shell (and its
   * assistant panel) mounts, takes the mark and streams the greeting into the
   * opened panel. Explicit event from the wizard; no prop-watching.
   */
  function handleOnboardingComplete(): void {
    // Website already under way (e.g. opened earlier): the assistant simply continues it.
    if (!data.handoffAvailable) return
    // Assistant switched off (round 5): no panel takes the greeting, so none is marked.
    if (data.shell?.assistant !== true) return
    markHandoffPending()
  }
</script>

<svelte:head><title>{docTitle(data.dashboard ? 'Dashboard' : 'Welcome')}</title></svelte:head>

{#if data.showWelcome}
  <!-- The welcome wizard (its provider step is the hard gate) runs without the
       app shell: it keeps its own header with the settings cog. -->
  <div class="flex min-h-dvh w-full flex-col px-4 sm:px-6 lg:px-10">
    <header class="relative flex shrink-0 justify-center pt-6 pb-2">
      <p class="text-sm font-semibold tracking-tight text-muted-foreground">eigenEnterprise</p>
      <div class="absolute top-5 right-0 flex items-center gap-3">
        <HomeSettingsMenu />
      </div>
    </header>

    <!-- First open: the boot sequence leads; the provider step inside it stays a hard gate. -->
    <WelcomeWizard
      providerReady={!data.needsOnboarding}
      needsMail={data.needsMail}
      byokUiEnabled={data.byokUiEnabled}
      displayName={data.displayName}
      returnedFromProvider={data.returnedFromProvider}
      oncomplete={handleOnboardingComplete}
    />
  </div>
{:else if data.dashboard && data.shell}
  <Dashboard
    dashboard={data.dashboard}
    greetingName={data.greetingName}
    companyName={data.shell.companyName}
    navItems={data.shell.nav.items}
    capabilities={data.shell.capabilities}
    providerMissing={data.providerMissing}
  />
{/if}
