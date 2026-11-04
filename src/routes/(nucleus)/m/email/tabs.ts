import type { AreaTab } from '$lib/shell/area-nav'

/**
 * The Email area's sections (plan/phase-polish-1.md P-6). Kept beside the
 * routes: the shell's area-nav lists only the shell-owned areas.
 */
export const EMAIL_TABS: readonly AreaTab[] = [
  { id: 'overview', label: 'Overview', href: '/m/email' },
  { id: 'domains', label: 'Domains', href: '/m/email/domains' },
  { id: 'senders', label: 'Senders', href: '/m/email/senders' },
  { id: 'templates', label: 'Templates', href: '/m/email/templates' },
  { id: 'layouts', label: 'Layouts', href: '/m/email/layouts' },
  { id: 'logs', label: 'Logs', href: '/m/email/logs' },
  { id: 'suppression', label: 'Suppression', href: '/m/email/suppression' },
  { id: 'api', label: 'API', href: '/m/email/api' },
]
