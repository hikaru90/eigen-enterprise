/** Website → Apps tool names (namespace `website`, plan/phase-platform.md step 3). */
export const APP_TOOL_NAMES = [
  'website.app_list',
  'website.app_get',
  'website.app_logs',
  'website.app_deploy_status',
  'website.app_diagnose',
  'website.app_suggest_contract',
  'website.app_deploy',
  'website.app_env_set',
  'website.app_remove',
  'website.app_auto_deploy',
  // Per-app domains (plan/phase-website-apps-ux.md D-W2): human-only, never agent-gated.
  'website.app_domain_set',
  'website.app_domain_remove',
] as const
