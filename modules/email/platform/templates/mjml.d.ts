declare module 'mjml' {
  export type MjmlOptions = {
    validationLevel?: 'strict' | 'soft' | 'skip'
    minify?: boolean
    keepComments?: boolean
    fonts?: Record<string, string>
    lang?: string
  }

  export type MjmlError = {
    line?: number
    message: string
    tagName?: string
    formattedMessage?: string
  }

  export type MjmlResult = {
    html: string
    json: unknown
    errors: MjmlError[]
  }

  /** MJML 5: the default export is async. */
  export default function mjml2html(input: string, options?: MjmlOptions): Promise<MjmlResult>
}
