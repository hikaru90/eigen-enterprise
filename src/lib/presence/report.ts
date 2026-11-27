import { currentNavId, type ShellNavItem } from '$lib/shell/nav'
import { DASHBOARD_AREA, type WhereItem, type WhereReport } from './where'

/**
 * Where this tab is (plan/phase-multiplayer-presence.md): the sidebar entry
 * the page belongs to (`dashboard` on `/`), its pathname, and the one item
 * the page declared open (PresenceFocus). Structure only — nothing is read
 * from the page's text.
 */
export function whereOf(items: readonly ShellNavItem[], pathname: string, item: WhereItem | null): WhereReport {
  return {
    area: pathname === '/' ? DASHBOARD_AREA : currentNavId(items, pathname),
    path: pathname,
    item,
  }
}
