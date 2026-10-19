/**
 * The GitHub App manifest (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
 * Least privilege: read contents + metadata, push events only.
 */
export function githubAppManifest(origin: string, suffix: string) {
  const host = new URL(origin).hostname.split('.')[0]?.replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'company'
  return {
    name: `eigen-${host}-${suffix}`.slice(0, 34),
    url: origin,
    hook_attributes: { url: `${origin}/api/github/webhook`, active: true },
    redirect_url: `${origin}/settings/hosting/github/callback`,
    setup_url: `${origin}/settings/hosting/github/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: 'read', metadata: 'read' },
    default_events: ['push'],
  }
}

export const GITHUB_STATE_COOKIE = 'ee_github_state'
