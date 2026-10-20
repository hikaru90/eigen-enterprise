/** GitHub source-provider tool names (namespace `github`), owned by the website module. */
export const GITHUB_TOOL_NAMES = [
  'github.status',
  'github.repos_list',
  'github.app_create',
  'github.app_deploy',
  'github.auto_deploy',
] as const

/** Connect-a-repo tool names (namespace `website`, plan/github-connect.md). */
export const GITHUB_CONNECT_TOOL_NAMES = [
  'website.github_list_repos',
  'website.github_available_repos',
  'website.github_inspect_repo',
  'website.github_connect_repo',
  'website.github_disconnect_repo',
] as const
