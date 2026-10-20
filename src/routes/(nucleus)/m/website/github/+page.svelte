<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { resolve } from '$app/paths'
  import GitHubConnect, { type GitHubConnectForm } from '$lib/components/github-connect.svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>GitHub · Website · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <a href={resolve('/m/website')} class="text-xs text-foreground/55 hover:text-foreground"
      >Website</a
    >
    <h1 class="text-xl font-semibold tracking-tight">GitHub</h1>
    <p class="text-sm text-foreground/60">
      Connect your GitHub repositories so they can be deployed here.
    </p>
  </header>

  <GitHubConnect
    github={data.github}
    repos={data.repos}
    available={data.available}
    availableError={data.availableError}
    manifest={data.manifest}
    form={(form ?? null) as GitHubConnectForm}
  />
</div>
