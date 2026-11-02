<script lang="ts">
  import type { PageData } from './$types'
  import * as Alert from '$lib/components/ui/alert'
  import { Badge } from '$lib/components/ui/badge'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import * as Dialog from '$lib/components/ui/dialog'
  import { dialogSurfaceClass } from '$lib/components/ui/dialog/dialog-content.svelte'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import * as Table from '$lib/components/ui/table'
  import * as Tabs from '$lib/components/ui/tabs'
  import { Textarea } from '$lib/components/ui/textarea'
  import { cn } from '$lib/utils.js'
  import {
    BUTTON_SIZES,
    BUTTON_VARIANTS,
    COLOR_ROLES,
    RADIUS_SAMPLES,
    SHADOW_SAMPLES,
    SYSTEM_SCOPE_ATTR,
    TYPE_SCALE,
    googleFontLinks,
    systemScopeCss,
  } from '../../../../../modules/brand/system/component-set'

  let { data }: { data: PageData } = $props()

  /** Page-scoped light/dark: independent of the app theme. */
  let mode = $state<'light' | 'dark'>('light')

  const style = $derived(data.style)
  const fontLinks = $derived(style ? googleFontLinks(style.cssVars) : [])
  const scopeCss = $derived(style ? systemScopeCss(style.cssVars, style.darkCssVars) : '')

  const fontClass = { display: 'font-display', sans: 'font-sans', mono: 'font-mono' } as const
  const radiusClass = {
    sm: 'rounded-sm',
    md: 'rounded-md',
    lg: 'rounded-lg',
    xl: 'rounded-xl',
  } as const

  const rows = [
    { name: 'Website', owner: 'Ada', status: 'Live' },
    { name: 'Billing', owner: 'Grace', status: 'Draft' },
    { name: 'Support inbox', owner: 'Linus', status: 'Live' },
  ]

  const section = 'flex flex-col gap-4 border-t border-border py-8'
  const sectionTitle = 'text-xs font-medium tracking-wide text-muted-foreground uppercase'
</script>

<svelte:head>
  <title>Design system · Eigen Enterprise</title>
  {#each fontLinks as link (link.family)}
    <link rel="stylesheet" href={link.href} data-brand-font={link.family} />
  {/each}
  {#if style}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- emitter output over the owner-approved active visual set tokens -->
    {@html `<style>\n${scopeCss}</style>`}
  {/if}
</svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-wrap items-end justify-between gap-4">
    <div class="flex min-w-0 flex-col gap-1">
      <h1 class="text-xl font-semibold tracking-tight">Design system</h1>
      <p class="text-sm text-foreground/55">
        {#if style}
          Every component in <span class="text-foreground">{style.name}</span>, the active style.
        {:else}
          The components your brand drives, once a style is chosen.
        {/if}
      </p>
    </div>
    {#if style}
      <div
        class="inline-flex rounded-md border border-border p-0.5"
        role="group"
        aria-label="Preview theme"
      >
        {#each ['light', 'dark'] as const as m (m)}
          <Button
            size="sm"
            variant={mode === m ? 'default' : 'ghost'}
            aria-pressed={mode === m}
            data-testid="system-mode-{m}"
            onclick={() => (mode = m)}
          >
            {m === 'light' ? 'Light' : 'Dark'}
          </Button>
        {/each}
      </div>
    {/if}
  </header>

  {#if !style}
    <div
      class="mt-10 flex flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-16 text-center"
      data-testid="system-empty"
    >
      <div class="grid grid-cols-3 gap-1.5" aria-hidden="true">
        {#each [0, 1, 2, 3, 4, 5] as i (i)}
          <span class="size-6 rounded-sm bg-muted" class:bg-foreground={i === 4}></span>
        {/each}
      </div>
      <h2 class="text-lg font-semibold">Choose a style first</h2>
      <p class="max-w-sm text-sm text-foreground/55">
        The design system shows buttons, forms, cards, tables and type in your company's style. Pick
        a style and it appears here — light and dark.
      </p>
      <Button href="/brand">Choose a style</Button>
    </div>
  {:else}
    <div
      {...{ [SYSTEM_SCOPE_ATTR]: mode }}
      class={cn(
        'mt-6 rounded-lg border border-border bg-background px-4 font-sans text-foreground sm:px-8',
        mode === 'dark' && 'dark',
      )}
      data-testid="system-scope"
    >
      <!-- Nav bar -->
      <section class="flex flex-col gap-4 py-8" data-component="nav">
        <h2 class={sectionTitle}>Nav bar</h2>
        <nav
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-card-foreground"
          aria-label="Sample navigation"
        >
          <div class="flex items-center gap-1">
            <span class="mr-3 font-display text-lg">{style.name}</span>
            <Button size="sm" variant="secondary" aria-current="page">Overview</Button>
            <Button size="sm" variant="ghost">Projects</Button>
            <Button size="sm" variant="ghost">Team</Button>
          </div>
          <Breadcrumb.Root>
            <Breadcrumb.List>
              <Breadcrumb.Item
                ><Breadcrumb.Link href="#nav">Company</Breadcrumb.Link></Breadcrumb.Item
              >
              <Breadcrumb.Separator />
              <Breadcrumb.Item><Breadcrumb.Page>Brand</Breadcrumb.Page></Breadcrumb.Item>
            </Breadcrumb.List>
          </Breadcrumb.Root>
        </nav>
      </section>

      <!-- Typography -->
      <section class={section} data-component="typography">
        <h2 class={sectionTitle}>Typography</h2>
        <div class="flex flex-col gap-3">
          {#each TYPE_SCALE as step (step.id)}
            <div class="grid grid-cols-[5.5rem_1fr] items-baseline gap-4">
              <span class="font-mono text-[11px] text-muted-foreground">{step.label}</span>
              <svelte:element
                this={step.tag}
                class={cn(fontClass[step.font], step.className, 'min-w-0')}
                data-type-step={step.id}
              >
                {step.id === 'mono' ? 'const brand = tokens.active()' : 'The quick brown fox jumps'}
              </svelte:element>
            </div>
          {/each}
        </div>
      </section>

      <!-- Buttons -->
      <section class={section} data-component="button">
        <h2 class={sectionTitle}>Buttons</h2>
        <div class="flex flex-wrap items-center gap-2">
          {#each BUTTON_VARIANTS as variant (variant)}
            <Button {variant} data-variant={variant}>
              {variant === 'default' ? 'Primary' : variant[0].toUpperCase() + variant.slice(1)}
            </Button>
          {/each}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          {#each BUTTON_SIZES as size (size)}
            <Button {size} variant="outline">Size {size}</Button>
          {/each}
          <Button disabled data-variant="disabled">Disabled</Button>
          <Button variant="outline" disabled>Disabled outline</Button>
        </div>
      </section>

      <!-- Forms -->
      <section class={section} data-component="forms">
        <h2 class={sectionTitle}>Forms</h2>
        <div class="grid gap-6 sm:grid-cols-2">
          <div class="flex flex-col gap-2">
            <Label for="sys-name">Company name</Label>
            <Input id="sys-name" placeholder="Kindred Digital Labs" />
            <Label for="sys-disabled">Disabled</Label>
            <Input id="sys-disabled" value="Read only" disabled />
          </div>
          <div class="flex flex-col gap-2">
            <Label for="sys-note">Note</Label>
            <Textarea id="sys-note" placeholder="What should the team know?" rows={3} />
          </div>
          <div class="flex flex-col gap-2">
            <Label>Plan</Label>
            <Select.Root type="single" value="team">
              <Select.Trigger class="w-full">Team</Select.Trigger>
              <Select.Content>
                <Select.Item value="solo">Solo</Select.Item>
                <Select.Item value="team">Team</Select.Item>
                <Select.Item value="company">Company</Select.Item>
              </Select.Content>
            </Select.Root>
          </div>
          <div class="flex flex-col justify-end gap-3">
            <div class="flex items-center gap-2">
              <Checkbox id="sys-check" checked />
              <Label for="sys-check">Send the weekly summary</Label>
            </div>
            <div class="flex items-center gap-2">
              <Checkbox id="sys-check-off" />
              <Label for="sys-check-off">Share with guests</Label>
            </div>
            <div class="flex items-center gap-2">
              <Switch id="sys-switch" checked />
              <Label for="sys-switch">Notifications</Label>
            </div>
          </div>
        </div>
      </section>

      <!-- Surfaces -->
      <section class={section} data-component="surfaces">
        <h2 class={sectionTitle}>Card, badges, alerts</h2>
        <div class="grid gap-6 sm:grid-cols-2">
          <Card.Root>
            <Card.Header>
              <Card.Title>Quarterly review</Card.Title>
              <Card.Description>Three projects need a decision this week.</Card.Description>
            </Card.Header>
            <Card.Content class="flex flex-wrap gap-2">
              <Badge>Primary</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="destructive">Destructive</Badge>
            </Card.Content>
            <Card.Footer class="gap-2">
              <Button size="sm">Open</Button>
              <Button size="sm" variant="ghost">Later</Button>
            </Card.Footer>
          </Card.Root>
          <div class="flex flex-col gap-3">
            <Alert.Root>
              <Alert.Title>Style applied</Alert.Title>
              <Alert.Description>Every surface now uses the brand's tokens.</Alert.Description>
            </Alert.Root>
            <Alert.Root variant="destructive">
              <Alert.Title>Payment failed</Alert.Title>
              <Alert.Description
                >Update the card on file to keep the workspace running.</Alert.Description
              >
            </Alert.Root>
          </div>
        </div>
      </section>

      <!-- Tabs + dialog -->
      <section class={section} data-component="tabs-dialog">
        <h2 class={sectionTitle}>Tabs and dialog</h2>
        <div class="grid gap-6 sm:grid-cols-2">
          <Tabs.Root value="overview">
            <Tabs.List>
              <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
              <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
              <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="overview" class="pt-3 text-sm text-muted-foreground">
              Overview content sits on the page background.
            </Tabs.Content>
            <Tabs.Content value="activity" class="pt-3 text-sm text-muted-foreground">
              Recent activity.
            </Tabs.Content>
            <Tabs.Content value="settings" class="pt-3 text-sm text-muted-foreground">
              Settings.
            </Tabs.Content>
          </Tabs.Root>
          <!-- Static open preview: the dialog's own surface + parts, in flow (no portal/overlay). -->
          <Dialog.Root open>
            <div
              class={cn(dialogSurfaceClass, 'max-w-none')}
              role="presentation"
              data-testid="system-dialog"
            >
              <Dialog.Header>
                <Dialog.Title>Invite a teammate</Dialog.Title>
                <Dialog.Description>They get access to every active module.</Dialog.Description>
              </Dialog.Header>
              <Input placeholder="name@company.com" aria-label="Email" />
              <Dialog.Footer>
                <Button variant="outline">Cancel</Button>
                <Button>Send invite</Button>
              </Dialog.Footer>
            </div>
          </Dialog.Root>
        </div>
      </section>

      <!-- Table -->
      <section class={section} data-component="table">
        <h2 class={sectionTitle}>Table</h2>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Project</Table.Head>
              <Table.Head>Owner</Table.Head>
              <Table.Head class="text-right">Status</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each rows as row (row.name)}
              <Table.Row>
                <Table.Cell class="font-medium">{row.name}</Table.Cell>
                <Table.Cell>{row.owner}</Table.Cell>
                <Table.Cell class="text-right">
                  <Badge variant={row.status === 'Live' ? 'default' : 'outline'}>{row.status}</Badge
                  >
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </section>

      <!-- Colour roles -->
      <section class={section} data-component="colors">
        <h2 class={sectionTitle}>Colour roles</h2>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {#each COLOR_ROLES as { role, on } (role)}
            <div class="flex flex-col gap-1.5" data-role={role}>
              <div
                class="flex h-16 items-end rounded-md border border-border p-2 text-xs"
                style:background={`var(--${role})`}
                style:color={on ? `var(--${on})` : undefined}
              >
                {on ? 'Aa' : ''}
              </div>
              <span class="font-mono text-[11px]">--{role}</span>
            </div>
          {/each}
        </div>
      </section>

      <!-- Radius + shadow -->
      <section class={section} data-component="shape">
        <h2 class={sectionTitle}>Radius and shadow</h2>
        <div class="flex flex-wrap gap-6">
          {#each RADIUS_SAMPLES as r (r)}
            <div class="flex flex-col items-center gap-1.5" data-radius={r}>
              <div class={cn('size-16 border border-border bg-muted', radiusClass[r])}></div>
              <span class="font-mono text-[11px]">radius-{r}</span>
            </div>
          {/each}
          {#each SHADOW_SAMPLES as s (s)}
            <div class="flex flex-col items-center gap-1.5" data-shadow={s}>
              <div class="size-16 rounded-md bg-card" style:box-shadow={`var(${s}, none)`}></div>
              <span class="font-mono text-[11px]">{s.slice(2)}</span>
            </div>
          {/each}
        </div>
      </section>
    </div>
  {/if}
</div>
