import { z } from 'zod'

/**
 * Canonical style-format seed block (phase-2d V3). One seed block fully
 * determines a design system via expandSeeds — deterministic, no taste left
 * in the expansion. The zod schema is the contract; SEED_SHAPE_DESCRIPTION is
 * the plain-JSON rendering embedded in LLM prompts so models emit exactly
 * this shape.
 */

export const oklchComponentsSchema = z.object({
  l: z.number().min(0, 'lightness must be within 0..1').max(1),
  c: z.number().min(0, 'chroma must be within 0..0.4').max(0.4),
  h: z.number().min(0, 'hue must be within 0..360').max(360),
})

export const chromaCurveSchema = z.enum(['tailwind', 'flat', 'muted'])
export const darkModeStrategySchema = z.enum(['invert-tone', 'm3-scheme'])
export const trackingCurveSchema = z.enum(['negative-on-display', 'neutral', 'positive-on-display'])
export const shapeCharacterSchema = z.enum(['sharp', 'soft', 'pill', 'squircle'])
export const elevationSchema = z.enum(['flat', 'subtle', 'layered'])
export const motionPersonalitySchema = z.enum(['productive', 'expressive'])

const pxPair = z
  .object({ min: z.number().positive(), max: z.number().positive() })
  .refine((v) => v.max >= v.min, { message: 'max must be >= min' })

const cssLength = z
  .string()
  .regex(/^\d*\.?\d+(px|rem|em|%)$/, 'must be a CSS length (px|rem|em|%)')

export const brandSeedsSchema = z.object({
  seedColor: oklchComponentsSchema,
  neutralTintHue: z.number().min(0).max(360),
  accentHueShift: z.number().nullable(),
  chromaCurve: chromaCurveSchema,
  darkModeStrategy: darkModeStrategySchema,
  fonts: z.object({
    fontPrimary: z.string().min(1, 'OFL family name required'),
    fontSecondary: z.string().min(1, 'OFL family name required'),
    fontMono: z.string().min(1, 'OFL family name required'),
  }),
  fluidScale: z.object({
    baseSize: pxPair,
    scaleRatio: z
      .object({ min: z.number().gt(1), max: z.number().gt(1) })
      .refine((v) => v.max >= v.min, { message: 'max must be >= min' }),
    viewport: pxPair.refine((v) => v.max > v.min, { message: 'viewport max must be > min' }),
    scaleSteps: z.number().int().min(4, '4..8 steps').max(8, '4..8 steps'),
    trackingCurve: trackingCurveSchema,
  }),
  spaceRhythm: z.array(z.number().positive()).min(4, '4..8 multipliers').max(8, '4..8 multipliers'),
  shapeCharacter: shapeCharacterSchema,
  radiusBase: cssLength,
  elevation: elevationSchema,
  motionPersonality: motionPersonalitySchema,
  grain: z.number().min(0).max(1),
  imageryDirection: z.object({ style: z.string().min(1) }).optional(),
})

export type BrandSeeds = z.infer<typeof brandSeedsSchema>

/** Plain-JSON JSON-schema-ish shape of the seed block, embedded verbatim in extraction prompts. */
export const SEED_SHAPE_DESCRIPTION = {
  type: 'object',
  required: [
    'seedColor',
    'neutralTintHue',
    'accentHueShift',
    'chromaCurve',
    'darkModeStrategy',
    'fonts',
    'fluidScale',
    'spaceRhythm',
    'shapeCharacter',
    'radiusBase',
    'elevation',
    'motionPersonality',
    'grain',
  ],
  properties: {
    seedColor: {
      type: 'object',
      description: 'Brand color as OKLCH components',
      properties: { l: '0..1', c: '0..0.4', h: '0..360' },
      required: ['l', 'c', 'h'],
    },
    neutralTintHue: { type: 'number', range: '0..360', description: 'hue tinting the neutral gray ramp' },
    accentHueShift: {
      type: 'number|null',
      description: 'degrees between derived chart hues; null means the fixed 24-degree default',
    },
    chromaCurve: { type: 'enum', values: ['tailwind', 'flat', 'muted'] },
    darkModeStrategy: { type: 'enum', values: ['invert-tone', 'm3-scheme'] },
    fonts: {
      type: 'object',
      description: 'SIL Open Font License family names only',
      properties: { fontPrimary: 'string', fontSecondary: 'string', fontMono: 'string' },
      required: ['fontPrimary', 'fontSecondary', 'fontMono'],
    },
    fluidScale: {
      type: 'object',
      properties: {
        baseSize: { type: 'object', properties: { min: 'px', max: 'px' } },
        scaleRatio: { type: 'object', description: 'modular scale ratio, values > 1', properties: { min: 'number', max: 'number' } },
        viewport: { type: 'object', description: 'fluid clamp viewport range in px', properties: { min: 'px', max: 'px' } },
        scaleSteps: { type: 'integer', range: '4..8' },
        trackingCurve: { type: 'enum', values: ['negative-on-display', 'neutral', 'positive-on-display'] },
      },
      required: ['baseSize', 'scaleRatio', 'viewport', 'scaleSteps', 'trackingCurve'],
    },
    spaceRhythm: { type: 'array', items: 'positive numbers', length: '4..8' },
    shapeCharacter: { type: 'enum', values: ['sharp', 'soft', 'pill', 'squircle'] },
    radiusBase: { type: 'string', description: 'CSS length, e.g. "0.5rem"' },
    elevation: { type: 'enum', values: ['flat', 'subtle', 'layered'] },
    motionPersonality: { type: 'enum', values: ['productive', 'expressive'] },
    grain: { type: 'number', range: '0..1', description: '0 means no grain overlay token' },
    imageryDirection: { type: 'object|null', properties: { style: 'string' } },
  },
} as const
