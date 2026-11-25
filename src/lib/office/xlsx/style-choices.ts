/**
 * The closed sets a cell's look is chosen from (ECMA-376 Part 1 §18.18):
 * shared by the editor, the format toolbar and the drive.sheet_format tool's
 * input schema. No imports, so the registry can load it without the
 * spreadsheet code.
 */

/** Excel's border line styles (ST_BorderStyle, §18.18.3), "none" left out. */
export const BORDER_STYLES = [
  'thin',
  'medium',
  'thick',
  'dashed',
  'dotted',
  'double',
  'hair',
  'mediumDashed',
  'dashDot',
  'mediumDashDot',
  'dashDotDot',
  'mediumDashDotDot',
  'slantDashDot',
] as const
export type BorderStyle = (typeof BORDER_STYLES)[number]

/** Where lines go on a range: every edge, the outline, the inside lines, one side, or none. */
export const BORDER_PRESETS = [
  'all',
  'outer',
  'inner',
  'top',
  'bottom',
  'left',
  'right',
  'none',
] as const
export type BorderPreset = (typeof BORDER_PRESETS)[number]

/** Horizontal alignment (ST_HorizontalAlignment, the ones the editor offers); general is Excel's default. */
export const HORIZONTAL = ['general', 'left', 'center', 'right', 'justify'] as const
export type Horizontal = (typeof HORIZONTAL)[number]

/** Vertical alignment (ST_VerticalAlignment, the ones the editor offers); bottom is Excel's default. */
export const VERTICAL = ['top', 'center', 'bottom'] as const
export type Vertical = (typeof VERTICAL)[number]
