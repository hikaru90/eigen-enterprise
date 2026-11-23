<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor'
  import Moon from '@lucide/svelte/icons/moon'
  import Sun from '@lucide/svelte/icons/sun'
  import { onMount } from 'svelte'
  import {
    THEME_CHANGE_EVENT,
    THEME_PREFERENCES,
    parseThemePreference,
    readThemePreference,
    setThemePreference,
    type ThemePreference,
  } from './theme'

  /**
   * Light · Dark · System for this device (src/lib/theme/theme.ts). A radio
   * group: the shell applies a choice the moment it is made, and on System it
   * follows the OS. Every switch on screen listens for the change, so the
   * settings menu and Settings → Account never disagree.
   */
  let { testid = 'theme-switch', class: className = '' }: { testid?: string; class?: string } =
    $props()

  const icons = { light: Sun, dark: Moon, system: Monitor } as const

  let current = $state<ThemePreference>('system')

  onMount(() => {
    current = readThemePreference()
    const onChange = (event: Event) => {
      current = parseThemePreference(
        (event as CustomEvent<{ preference?: string }>).detail?.preference ?? null,
      )
    }
    window.addEventListener(THEME_CHANGE_EVENT, onChange)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange)
  })

  function choose(preference: ThemePreference): void {
    current = preference
    setThemePreference(preference)
  }

  function onKeydown(event: KeyboardEvent, index: number): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    const next =
      THEME_PREFERENCES[(index + step + THEME_PREFERENCES.length) % THEME_PREFERENCES.length]
    choose(next.value)
    const group = (event.currentTarget as HTMLElement).parentElement
    group?.querySelector<HTMLButtonElement>(`[data-theme-value="${next.value}"]`)?.focus()
  }
</script>

<div
  role="radiogroup"
  aria-label="Theme"
  class="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5 {className}"
  data-testid={testid}
>
  {#each THEME_PREFERENCES as option, index (option.value)}
    {@const Icon = icons[option.value]}
    {@const chosen = current === option.value}
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      tabindex={chosen ? 0 : -1}
      class="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors {chosen
        ? 'bg-foreground text-background'
        : 'text-foreground hover:bg-accent hover:text-accent-foreground'}"
      onclick={() => choose(option.value)}
      onkeydown={(event) => onKeydown(event, index)}
      data-testid="{testid}-{option.value}"
      data-theme-value={option.value}
    >
      <Icon class="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      {option.label}
    </button>
  {/each}
</div>
