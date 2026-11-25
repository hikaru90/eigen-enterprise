import type { MaterialTextSuggestions } from '../../../../../modules/brand/material/texts'
import { brandRequestError } from '../brand-errors'

/**
 * The Material tab's calls onto /api/brand/material (the clients of
 * brand.material_export and brand.material_text_suggest). Every failure is a
 * BrandRequestError carrying the server's plain sentence and its agent report.
 */

export type MaterialExportBody = {
  formatId: string
  mode: 'light' | 'dark'
  headline: string
  body?: string
  cta?: string
  logo: boolean
}

export type MaterialApi = {
  exportFile(body: MaterialExportBody): Promise<{ blob: Blob; filename: string }>
  suggestTexts(body: { formatId: string; brief?: string }): Promise<MaterialTextSuggestions>
}

const post = (f: typeof fetch, url: string, body: unknown) =>
  f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** The file name the server put in `content-disposition` (RFC 5987 `filename*`). */
export function dispositionFilename(header: string | null): string {
  const match = header?.match(/filename\*=UTF-8''([^;]+)/)
  if (!match) throw new Error('The export answered without a file name.')
  return decodeURIComponent(match[1])
}

export function materialApi(f: typeof fetch = fetch): MaterialApi {
  return {
    exportFile: async (body) => {
      const res = await post(f, '/api/brand/material/export', body)
      if (!res.ok) throw brandRequestError(res.status, await res.text(), 'The export')
      return { blob: await res.blob(), filename: dispositionFilename(res.headers.get('content-disposition')) }
    },
    suggestTexts: async (body) => {
      const res = await post(f, '/api/brand/material/texts', body)
      if (!res.ok) throw brandRequestError(res.status, await res.text(), 'Writing the texts')
      return (await res.json()) as MaterialTextSuggestions
    },
  }
}
