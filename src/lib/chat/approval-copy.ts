/** Plain-language copy for every tool the kernel gates (modules/index APPROVAL_REQUIRED_TOOLS). */
const APPROVAL_ACTION_COPY: Record<string, string> = {
  'email.send_mail': 'Send an email',
  'email.domain_add': 'Add a sender domain',
  'email.domain_recheck': "Re-check a sender domain's DNS",
  'email.sender_add': 'Add a sender address',
  'email.send_template': 'Send a template email',
  'email.suppression_add': 'Stop mail to an address',
  'email.suppression_remove': 'Allow mail to an address again',
  'brand.set_activate': 'Make a brand guideline set the active one',
  'brand.visual_set_activate': 'Make a visual brand set live across the company',
  'website.publish_page': 'Publish a page of your website',
  'repo.merge': 'Merge agent work into the company repository',
  'kernel.module_deactivate': 'Switch off a module',
  'website.github_connect_repo': 'Connect a GitHub repository',
  'website.github_disconnect_repo': 'Disconnect a GitHub repository',
}

/** The gated action in plain words; a tool without copy still names itself. */
export function approvalActionLabel(tool: string): string {
  return APPROVAL_ACTION_COPY[tool] ?? `Run ${tool}`
}
