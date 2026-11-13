import type { Component } from 'svelte'
import Box from '@lucide/svelte/icons/box'
import Brain from '@lucide/svelte/icons/brain'
import CalendarDays from '@lucide/svelte/icons/calendar-days'
import Contact from '@lucide/svelte/icons/contact'
import Globe from '@lucide/svelte/icons/globe'
import HardDrive from '@lucide/svelte/icons/hard-drive'
import Mail from '@lucide/svelte/icons/mail'
import MessagesSquare from '@lucide/svelte/icons/messages-square'
import Palette from '@lucide/svelte/icons/palette'
import Settings from '@lucide/svelte/icons/settings'
import Video from '@lucide/svelte/icons/video'

/** Presentation only: an icon per known module id; any other module gets the generic box. */
const ICONS: Record<string, Component> = {
  messages: MessagesSquare,
  settings: Settings,
  website: Globe,
  email: Mail,
  brand: Palette,
  memory: Brain,
  drive: HardDrive,
  calendar: CalendarDays,
  calls: Video,
  contacts: Contact,
}

export function iconFor(id: string): Component {
  return ICONS[id] ?? Box
}
