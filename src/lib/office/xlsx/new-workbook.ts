import { strToU8, zipSync } from 'fflate'

/**
 * A new, empty Excel workbook (Drive → New → Spreadsheet, drive.create_document
 * kind "xlsx"): the smallest package Excel opens without repairing it
 * (ECMA-376 Part 1 §18; Part 2 for the package): content types, the package
 * relationship to the workbook, the workbook with one sheet, a stylesheet
 * with the default cell format (Excel requires cellXfs to hold the xf 0 that
 * every unstyled cell uses), and the empty sheet. Core and app properties are
 * optional parts and left out; Excel adds them on its first save.
 */

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** The sheet a new workbook starts with (Excel's own English default). */
export const NEW_SHEET_NAME = 'Sheet1'

const CONTENT_TYPES = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`

const ROOT_RELS = `${HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`

const WORKBOOK = `${HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${NEW_SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`

const WORKBOOK_RELS = `${HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS_R}/styles" Target="styles.xml"/></Relationships>`

const STYLES = `${HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

const SHEET = `${HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><dimension ref="A1"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`

export function newWorkbookBytes(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(SHEET),
  })
}
