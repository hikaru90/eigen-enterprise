/** Plain-language copy for every tool the kernel gates (modules/index APPROVAL_REQUIRED_TOOLS). */
const APPROVAL_ACTION_COPY: Record<string, string> = {
  'email.send_mail': 'Send an email',
  'owlery.send_mail': 'Send an email from the company address',
  'brand.set_activate': 'Make a brand guideline set the active one',
  'brand.visual_set_activate': 'Make a visual brand set live across the company',
  'website.publish_page': 'Publish a page of your website',
  'repo.merge': 'Merge agent work into the company repository',
  'kernel.module_deactivate': 'Switch off a module',
}

/** The gated action in plain words; a tool without copy still names itself. */
export function approvalActionLabel(tool: string): string {
  return APPROVAL_ACTION_COPY[tool] ?? `Run ${tool}`
}
