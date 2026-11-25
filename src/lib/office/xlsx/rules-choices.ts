/**
 * Pure closed-set constants for conditional formatting, data validation and
 * protection (shared by core modules, UI dialogs and the drive.sheet_* tool
 * schemas without pulling XML/formula dependencies into registry startup).
 */

export const CF_TYPES = [
  'cellIs',
  'expression',
  'colorScale',
  'dataBar',
  'iconSet',
  'top10',
  'aboveAverage',
  'duplicateValues',
  'uniqueValues',
  'containsText',
  'notContainsText',
  'beginsWith',
  'endsWith',
  'containsBlanks',
  'notContainsBlanks',
  'containsErrors',
  'notContainsErrors',
  'timePeriod',
] as const
export type CfType = (typeof CF_TYPES)[number]

export const CF_OPERATORS = [
  'between',
  'notBetween',
  'equal',
  'notEqual',
  'greaterThan',
  'lessThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
] as const
export type CfOperator = (typeof CF_OPERATORS)[number]

export const TIME_PERIODS = [
  'today',
  'yesterday',
  'tomorrow',
  'last7Days',
  'thisWeek',
  'lastWeek',
  'nextWeek',
  'thisMonth',
  'lastMonth',
  'nextMonth',
] as const
export type TimePeriod = (typeof TIME_PERIODS)[number]

/** Icon sets (ST_IconSetType, plus the three Excel 2010 added) and how many icons each has. */
export const ICON_SETS = {
  '3Arrows': 3,
  '3ArrowsGray': 3,
  '3Flags': 3,
  '3TrafficLights1': 3,
  '3TrafficLights2': 3,
  '3Signs': 3,
  '3Symbols': 3,
  '3Symbols2': 3,
  '3Stars': 3,
  '3Triangles': 3,
  '4Arrows': 4,
  '4ArrowsGray': 4,
  '4RedToBlack': 4,
  '4Rating': 4,
  '4TrafficLights': 4,
  '5Arrows': 5,
  '5ArrowsGray': 5,
  '5Rating': 5,
  '5Quarters': 5,
  '5Boxes': 5,
} as const
export type IconSetName = keyof typeof ICON_SETS

export const ICON_SET_NAMES = [
  '3Arrows',
  '3ArrowsGray',
  '3Flags',
  '3TrafficLights1',
  '3TrafficLights2',
  '3Signs',
  '3Symbols',
  '3Symbols2',
  '3Stars',
  '3Triangles',
  '4Arrows',
  '4ArrowsGray',
  '4RedToBlack',
  '4Rating',
  '4TrafficLights',
  '5Arrows',
  '5ArrowsGray',
  '5Rating',
  '5Quarters',
  '5Boxes',
] as const satisfies readonly IconSetName[]

export const CFVO_KINDS = [
  'min',
  'max',
  'num',
  'percent',
  'percentile',
  'formula',
  'autoMin',
  'autoMax',
] as const
export type CfvoKind = (typeof CFVO_KINDS)[number]

export const VALIDATION_TYPES = [
  'any',
  'whole',
  'decimal',
  'list',
  'date',
  'time',
  'textLength',
  'custom',
] as const
export type ValidationType = (typeof VALIDATION_TYPES)[number]

export const VALIDATION_OPERATORS = [
  'between',
  'notBetween',
  'equal',
  'notEqual',
  'greaterThan',
  'lessThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
] as const
export type ValidationOperator = (typeof VALIDATION_OPERATORS)[number]

export const ERROR_STYLES = ['stop', 'warning', 'information'] as const
export type ErrorStyle = (typeof ERROR_STYLES)[number]

/** What a protected sheet still allows (Excel's "Allow all users of this worksheet to" list). */
export const SHEET_ALLOW = [
  'selectLockedCells',
  'selectUnlockedCells',
  'formatCells',
  'formatColumns',
  'formatRows',
  'insertColumns',
  'insertRows',
  'insertHyperlinks',
  'deleteColumns',
  'deleteRows',
  'sort',
  'autoFilter',
  'pivotTables',
  'objects',
  'scenarios',
] as const
export type SheetAllow = (typeof SHEET_ALLOW)[number]
