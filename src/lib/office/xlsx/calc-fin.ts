import { err, isMatrix, toNumber, truthy, type Matrix } from './calc-values'
import { isErrorValue, type CellValue, type ErrorValue } from './workbook'

/**
 * Deterministic financial functions of Excel (ECMA-376 Part 1 §18.17.7)
 * missing from @formulajs/formulajs: bond/coupon schedules and pricing
 * (ACCRINTM, COUP*, DURATION, MDURATION, INTRATE, RECEIVED, PRICEMAT,
 * YIELDDISC, YIELDMAT, PRICE, YIELD, ODDF*, ODDL*) and depreciation
 * (VDB, AMORLINC, AMORDEGRC).
 */

type FArg = CellValue | Matrix
export type FinFn = (...args: FArg[]) => CellValue

const num = (v: FArg | undefined, def?: number): number | ErrorValue => {
  if (v === undefined || v === null) return def !== undefined ? def : err('#VALUE!')
  if (isMatrix(v)) return err('#VALUE!')
  if (isErrorValue(v)) return v
  const n = toNumber(v)
  return isErrorValue(n) ? n : n
}

const bool = (v: FArg | undefined, def: boolean): boolean | ErrorValue => {
  if (v === undefined || v === null) return def
  if (isMatrix(v)) return err('#VALUE!')
  if (isErrorValue(v)) return v
  return truthy(v)
}

const serial = (v: FArg | undefined): number | ErrorValue => {
  const n = num(v)
  if (isErrorValue(n)) return n
  const s = Math.trunc(n)
  return s < 0 ? err('#NUM!') : s
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y: number, m: number) =>
  [0, 31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m]!

type Ymd = { y: number; m: number; d: number }

/** Excel 1900 serial date → Gregorian { y, m, d } (accounting for the 1900-02-29 leap-day bug at serial 60). */
function serialToYmd(s: number): Ymd {
  if (s === 60) return { y: 1900, m: 2, d: 29 }
  const adj = s < 60 ? s - 25568 : s - 25569
  const dt = new Date(adj * 86_400_000)
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function ymdToSerial(y: number, m: number, d: number): number {
  const utc = Date.UTC(y, m - 1, d) / 86_400_000
  const s = utc + 25569
  return s <= 60 ? utc + 25568 : s
}

function addMonths(d: Ymd, months: number, eom: boolean): Ymd {
  const total = d.y * 12 + (d.m - 1) + months
  const y = Math.floor(total / 12)
  const m = ((total % 12) + 12) % 12 + 1
  const maxD = daysInMonth(y, m)
  return { y, m, d: eom ? maxD : Math.min(d.d, maxD) }
}

function days360(a: Ymd, b: Ymd, euro: boolean): number {
  let d1 = a.d
  let d2 = b.d
  if (euro) {
    d1 = Math.min(d1, 30)
    d2 = Math.min(d2, 30)
  } else {
    if (a.m === 2 && d1 === daysInMonth(a.y, 2)) {
      if (b.m === 2 && d2 === daysInMonth(b.y, 2)) d2 = 30
      d1 = 30
    }
    if (d1 === 31) d1 = 30
    if (d2 === 31 && d1 >= 30) d2 = 30
  }
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1)
}

function basisDays(s1: number, s2: number, basis: number): { days: number; yearDays: number } {
  const a = serialToYmd(s1)
  const b = serialToYmd(s2)
  if (basis === 0) return { days: days360(a, b, false), yearDays: 360 }
  if (basis === 4) return { days: days360(a, b, true), yearDays: 360 }
  const actual = s2 - s1
  if (basis === 2) return { days: actual, yearDays: 360 }
  if (basis === 3) return { days: actual, yearDays: 365 }
  // Basis 1: Actual/Actual (year length per ECMA-376 YEARFRAC).
  const oneYearOrLess =
    a.y === b.y ||
    (b.y === a.y + 1 && (a.m > b.m || (a.m === b.m && a.d >= b.d)))
  let yearDays = 365
  if (oneYearOrLess) {
    const leap =
      (a.y === b.y && isLeap(a.y)) ||
      (b.y > a.y &&
        ((isLeap(a.y) && (a.m < 2 || (a.m === 2 && a.d <= 29))) ||
          (isLeap(b.y) && (b.m > 2 || (b.m === 2 && b.d === 29)))))
    if (leap) yearDays = 366
  } else {
    let total = 0
    for (let y = a.y; y <= b.y; y++) total += isLeap(y) ? 366 : 365
    yearDays = total / (b.y - a.y + 1)
  }
  return { days: actual, yearDays }
}

function checkFreq(v: FArg | undefined): number | ErrorValue {
  const n = num(v)
  if (isErrorValue(n)) return n
  const f = Math.trunc(n)
  return f === 1 || f === 2 || f === 4 ? f : err('#NUM!')
}

function checkBasis(v: FArg | undefined): number | ErrorValue {
  const n = num(v, 0)
  if (isErrorValue(n)) return n
  const b = Math.trunc(n)
  return b >= 0 && b <= 4 ? b : err('#NUM!')
}

type CoupInfo = { pcd: number; ncd: number; count: number; e: number; a: number; dsc: number }

function couponSchedule(
  settle: number,
  mat: number,
  freq: number,
  basis: number,
): CoupInfo | ErrorValue {
  if (settle >= mat) return err('#NUM!')
  const step = 12 / freq
  const mYmd = serialToYmd(mat)
  const eom = mYmd.d === daysInMonth(mYmd.y, mYmd.m)
  let k = 0
  let ncd = mat
  let pcd: number
  while (true) {
    k++
    const prev = ymdToSerial(
      addMonths(mYmd, -k * step, eom).y,
      addMonths(mYmd, -k * step, eom).m,
      addMonths(mYmd, -k * step, eom).d,
    )
    if (prev <= settle) {
      pcd = prev
      break
    }
    ncd = prev
  }
  const e = basis === 1 ? ncd - pcd : basis === 3 ? 365 / freq : 360 / freq
  const a = basisDays(pcd, settle, basis).days
  const dsc = basis === 1 ? ncd - settle : basis === 2 || basis === 3 ? ncd - settle : e - a
  return { pcd, ncd, count: k, e, a, dsc }
}

function accrintm(args: FArg[]): CellValue {
  const iss = serial(args[0])
  const set = serial(args[1])
  const rate = num(args[2])
  const par = num(args[3], 1000)
  const basis = checkBasis(args[4])
  for (const x of [iss, set, rate, par, basis]) if (isErrorValue(x)) return x
  if ((iss as number) >= (set as number) || (rate as number) <= 0 || (par as number) <= 0)
    return err('#NUM!')
  const { days, yearDays } = basisDays(iss as number, set as number, basis as number)
  return (par as number) * (rate as number) * (days / yearDays)
}

function coup(
  args: FArg[],
  pick: (c: CoupInfo) => number,
): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const freq = checkFreq(args[2])
  const basis = checkBasis(args[3])
  for (const x of [set, mat, freq, basis]) if (isErrorValue(x)) return x
  const info = couponSchedule(set as number, mat as number, freq as number, basis as number)
  return isErrorValue(info) ? info : pick(info)
}

function intrate(args: FArg[]): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const inv = num(args[2])
  const red = num(args[3])
  const basis = checkBasis(args[4])
  for (const x of [set, mat, inv, red, basis]) if (isErrorValue(x)) return x
  if ((set as number) >= (mat as number) || (inv as number) <= 0 || (red as number) <= 0)
    return err('#NUM!')
  const { days, yearDays } = basisDays(set as number, mat as number, basis as number)
  return (((red as number) - (inv as number)) / (inv as number)) * (yearDays / days)
}

function received(args: FArg[]): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const inv = num(args[2])
  const disc = num(args[3])
  const basis = checkBasis(args[4])
  for (const x of [set, mat, inv, disc, basis]) if (isErrorValue(x)) return x
  if ((set as number) >= (mat as number) || (inv as number) <= 0 || (disc as number) <= 0)
    return err('#NUM!')
  const { days, yearDays } = basisDays(set as number, mat as number, basis as number)
  const denom = 1 - (disc as number) * (days / yearDays)
  return denom <= 0 ? err('#NUM!') : (inv as number) / denom
}

function priceMat(args: FArg[]): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const iss = serial(args[2])
  const rate = num(args[3])
  const yld = num(args[4])
  const basis = checkBasis(args[5])
  for (const x of [set, mat, iss, rate, yld, basis]) if (isErrorValue(x)) return x
  if (
    (set as number) >= (mat as number) ||
    (iss as number) > (set as number) ||
    (rate as number) < 0 ||
    (yld as number) < 0
  )
    return err('#NUM!')
  const dsm = basisDays(set as number, mat as number, basis as number)
  const dim = basisDays(iss as number, mat as number, basis as number)
  const a = basisDays(iss as number, set as number, basis as number)
  const r = rate as number
  const y = yld as number
  return (
    (100 + (dim.days / dim.yearDays) * r * 100) / (1 + (dsm.days / dsm.yearDays) * y) -
    (a.days / a.yearDays) * r * 100
  )
}

function yieldDisc(args: FArg[]): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const pr = num(args[2])
  const red = num(args[3])
  const basis = checkBasis(args[4])
  for (const x of [set, mat, pr, red, basis]) if (isErrorValue(x)) return x
  if ((set as number) >= (mat as number) || (pr as number) <= 0 || (red as number) <= 0)
    return err('#NUM!')
  const { days, yearDays } = basisDays(set as number, mat as number, basis as number)
  return (((red as number) - (pr as number)) / (pr as number)) * (yearDays / days)
}

function yieldMat(args: FArg[]): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const iss = serial(args[2])
  const rate = num(args[3])
  const pr = num(args[4])
  const basis = checkBasis(args[5])
  for (const x of [set, mat, iss, rate, pr, basis]) if (isErrorValue(x)) return x
  if (
    (set as number) >= (mat as number) ||
    (iss as number) > (set as number) ||
    (rate as number) < 0 ||
    (pr as number) <= 0
  )
    return err('#NUM!')
  const dsm = basisDays(set as number, mat as number, basis as number)
  const dim = basisDays(iss as number, mat as number, basis as number)
  const a = basisDays(iss as number, set as number, basis as number)
  const r = rate as number
  const p = pr as number
  const numPart = (dim.days / dim.yearDays) * r + 1 - (p / 100 + (a.days / a.yearDays) * r)
  const denPart = (p / 100 + (a.days / a.yearDays) * r) * (dsm.days / dsm.yearDays)
  return denPart === 0 ? err('#NUM!') : numPart / denPart
}

function bondPrice(
  c: CoupInfo,
  rate: number,
  yld: number,
  red: number,
  freq: number,
): number {
  const coupPay = 100 * (rate / freq)
  if (c.count === 1) {
    const t = c.dsc / c.e
    return (red + coupPay) / (1 + t * (yld / freq)) - (c.a / c.e) * coupPay
  }
  const base = 1 + yld / freq
  const d = c.dsc / c.e
  let pv = red / Math.pow(base, c.count - 1 + d)
  for (let k = 1; k <= c.count; k++) pv += coupPay / Math.pow(base, k - 1 + d)
  return pv - (c.a / c.e) * coupPay
}

function price(args: FArg[]): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const rate = num(args[2])
  const yld = num(args[3])
  const red = num(args[4])
  const freq = checkFreq(args[5])
  const basis = checkBasis(args[6])
  for (const x of [set, mat, rate, yld, red, freq, basis]) if (isErrorValue(x)) return x
  if ((rate as number) < 0 || (yld as number) < 0 || (red as number) <= 0) return err('#NUM!')
  const c = couponSchedule(set as number, mat as number, freq as number, basis as number)
  if (isErrorValue(c)) return c
  return bondPrice(c, rate as number, yld as number, red as number, freq as number)
}

function solveYield(target: number, f: (y: number) => number): number | ErrorValue {
  let y = 0.05
  for (let i = 0; i < 100; i++) {
    const v = f(y) - target
    if (Math.abs(v) < 1e-8) return y
    const eps = 1e-6
    const d = (f(y + eps) - f(y - eps)) / (2 * eps)
    if (!Number.isFinite(d) || Math.abs(d) < 1e-14) return err('#NUM!')
    const next = y - v / d
    if (!Number.isFinite(next) || next <= -0.999) return err('#NUM!')
    y = next
  }
  return err('#NUM!')
}

function yieldFn(args: FArg[]): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const rate = num(args[2])
  const pr = num(args[3])
  const red = num(args[4])
  const freq = checkFreq(args[5])
  const basis = checkBasis(args[6])
  for (const x of [set, mat, rate, pr, red, freq, basis]) if (isErrorValue(x)) return x
  if ((rate as number) < 0 || (pr as number) <= 0 || (red as number) <= 0) return err('#NUM!')
  const c = couponSchedule(set as number, mat as number, freq as number, basis as number)
  if (isErrorValue(c)) return c
  if (c.count === 1) {
    const coupPay = 100 * ((rate as number) / (freq as number))
    const a = (c.a / c.e) * coupPay
    const numPart = (red as number) + coupPay - ((pr as number) + a)
    const denPart = (pr as number) + a
    return (numPart / denPart) * ((freq as number) * c.e / c.dsc)
  }
  return solveYield(pr as number, (y) =>
    bondPrice(c, rate as number, y, red as number, freq as number),
  )
}

function duration(args: FArg[], modified: boolean): CellValue {
  const set = serial(args[0])
  const mat = serial(args[1])
  const coupon = num(args[2])
  const yld = num(args[3])
  const freq = checkFreq(args[4])
  const basis = checkBasis(args[5])
  for (const x of [set, mat, coupon, yld, freq, basis]) if (isErrorValue(x)) return x
  if ((coupon as number) < 0 || (yld as number) < 0) return err('#NUM!')
  const c = couponSchedule(set as number, mat as number, freq as number, basis as number)
  if (isErrorValue(c)) return c
  const f = freq as number
  const y = yld as number
  const coupPay = 100 * ((coupon as number) / f)
  const base = 1 + y / f
  const d = c.dsc / c.e
  let numSum = 0
  let denSum = 0
  for (let k = 1; k <= c.count; k++) {
    const t = (k - 1 + d) / f
    const cf = k === c.count ? coupPay + 100 : coupPay
    const pv = cf / Math.pow(base, k - 1 + d)
    numSum += t * pv
    denSum += pv
  }
  const mac = numSum / denSum
  return modified ? mac / (1 + y / f) : mac
}

function vdb(args: FArg[]): CellValue {
  const cost = num(args[0])
  const salvage = num(args[1])
  const life = num(args[2])
  const start = num(args[3])
  const end = num(args[4])
  const factor = num(args[5], 2)
  const noSwitch = bool(args[6], false)
  for (const x of [cost, salvage, life, start, end, factor, noSwitch])
    if (isErrorValue(x)) return x
  const c = cost as number
  const sal = salvage as number
  const l = life as number
  const s = start as number
  const e = end as number
  const fac = factor as number
  if (c < 0 || sal < 0 || l <= 0 || s < 0 || e < s || e > l || fac <= 0) return err('#NUM!')
  if (c <= sal || s === e) return 0
  const maxPeriod = Math.ceil(e)
  const rate = Math.min(1, fac / l)
  let book = c
  const deps: number[] = []
  let slnMode = false
  for (let p = 0; p < maxPeriod; p++) {
    let dep: number
    if (slnMode) {
      dep = (book - sal) / (l - p)
    } else {
      const db = book * rate
      const sl = !(noSwitch as boolean) && l - p > 0 ? (book - sal) / (l - p) : 0
      if (!(noSwitch as boolean) && sl > db) {
        slnMode = true
        dep = sl
      } else {
        dep = db
      }
    }
    dep = Math.max(0, Math.min(dep, book - sal))
    deps.push(dep)
    book -= dep
  }
  let total = 0
  for (let p = Math.floor(s); p < maxPeriod; p++) {
    const lo = Math.max(s, p)
    const hi = Math.min(e, p + 1)
    if (hi > lo) total += deps[p]! * (hi - lo)
  }
  return total
}

function amor(args: FArg[], degressive: boolean): CellValue {
  const cost = num(args[0])
  const purchased = serial(args[1])
  const firstPeriod = serial(args[2])
  const salvage = num(args[3])
  const period = num(args[4])
  const rate = num(args[5])
  const basis = checkBasis(args[6])
  for (const x of [cost, purchased, firstPeriod, salvage, period, rate, basis])
    if (isErrorValue(x)) return x
  const c = cost as number
  const sal = salvage as number
  const p = Math.trunc(period as number)
  const r = rate as number
  const d1 = purchased as number
  const d2 = firstPeriod as number
  if (c < 0 || sal < 0 || sal > c || p < 0 || r <= 0 || d1 > d2 || (basis as number) === 2)
    return err('#NUM!')
  const life = 1 / r
  const coeff = degressive ? (life < 3 ? 1 : life < 5 ? 1.5 : life <= 6 ? 2 : 2.5) : 1
  const effRate = r * coeff
  const { days, yearDays } = basisDays(d1, d2, basis as number)
  const frac0 = days / yearDays
  if (!degressive) {
    const annual = c * r
    const maxDep = c - sal
    let rem = maxDep
    let out = 0
    for (let k = 0; k <= p; k++) {
      const d = k === 0 ? Math.min(rem, annual * frac0) : Math.min(rem, annual)
      rem -= d
      if (k === p) out = d
    }
    return out
  }
  let book = c
  const firstDep = Math.round(c * effRate * frac0)
  if (p === 0) return Math.min(firstDep, Math.max(0, c - sal))
  book -= firstDep
  const totalPeriods = Math.floor(life) + 1
  for (let k = 1; k <= p; k++) {
    const remaining = totalPeriods - k
    let dep =
      remaining <= 2 ? Math.round((book - sal) / Math.max(1, remaining)) : Math.round(book * effRate)
    dep = Math.max(0, Math.min(dep, book - sal))
    if (k === p) return dep
    book -= dep
  }
  return 0
}

function oddFirstPrice(
  settle: number,
  mat: number,
  issue: number,
  firstCoup: number,
  rate: number,
  yld: number,
  red: number,
  freq: number,
  basis: number,
): number | ErrorValue {
  if (issue > settle || settle >= firstCoup || firstCoup >= mat) return err('#NUM!')
  if (rate < 0 || yld < 0 || red <= 0) return err('#NUM!')
  const c = couponSchedule(firstCoup, mat, freq, basis)
  if (isErrorValue(c)) return c
  const e = c.e
  const dfc = basisDays(issue, firstCoup, basis).days
  const dsc = basisDays(settle, firstCoup, basis).days
  const a = basisDays(issue, settle, basis).days
  const n = c.count + 1
  const coupPay = 100 * (rate / freq)
  const base = 1 + yld / freq
  if (dfc <= e) {
    let pv = red / Math.pow(base, n - 1 + dsc / e)
    pv += ((dfc / e) * coupPay) / Math.pow(base, dsc / e)
    for (let k = 2; k <= n; k++) pv += coupPay / Math.pow(base, k - 1 + dsc / e)
    return pv - (a / e) * coupPay
  }
  // Long first coupon: split into quasi-coupon periods from firstCoup backwards.
  const step = 12 / freq
  const fYmd = serialToYmd(firstCoup)
  const eom = fYmd.d === daysInMonth(fYmd.y, fYmd.m)
  let prev = firstCoup
  let q = 0
  let dc = 0
  while (prev > issue) {
    q++
    const nextPrevYmd = addMonths(fYmd, -q * step, eom)
    const nextPrev = ymdToSerial(nextPrevYmd.y, nextPrevYmd.m, nextPrevYmd.d)
    const periodLen = basis === 1 ? prev - nextPrev : e
    if (nextPrev <= issue) dc += basisDays(issue, prev, basis).days / periodLen
    else dc += 1
    prev = nextPrev
  }
  // Days from settlement to firstCoup in quasi-periods + accrued from issue to settlement.
  const nq = basisDays(settle, firstCoup, basis).days / e
  const aq = basisDays(issue, settle, basis).days / e
  let pv = red / Math.pow(base, n - 1 + nq)
  pv += (dc * coupPay) / Math.pow(base, nq)
  for (let k = 2; k <= n; k++) pv += coupPay / Math.pow(base, k - 1 + nq)
  return pv - aq * coupPay
}

function oddLastPrice(
  settle: number,
  mat: number,
  lastCoup: number,
  rate: number,
  yld: number,
  red: number,
  freq: number,
  basis: number,
): number | ErrorValue {
  if (lastCoup >= settle || settle >= mat) return err('#NUM!')
  if (rate < 0 || yld < 0 || red <= 0) return err('#NUM!')
  const step = 12 / freq
  const lYmd = serialToYmd(lastCoup)
  const eom = lYmd.d === daysInMonth(lYmd.y, lYmd.m)
  let prev = lastCoup
  let ncy = 0
  let dsl = 0
  let a = 0
  let dsc = 0
  while (prev < mat) {
    const nextYmd = addMonths(lYmd, (ncy + 1) * step, eom)
    const next = ymdToSerial(nextYmd.y, nextYmd.m, nextYmd.d)
    const periodLen = basis === 1 ? next - prev : basis === 3 ? 365 / freq : 360 / freq
    if (next >= mat) {
      dsl += basisDays(prev, mat, basis).days / periodLen
      if (settle >= prev) a += basisDays(prev, settle, basis).days / periodLen
      if (settle < mat) dsc += basisDays(Math.max(settle, prev), mat, basis).days / periodLen
    } else {
      dsl += 1
      if (settle >= next) a += 1
      else if (settle > prev) {
        a += basisDays(prev, settle, basis).days / periodLen
        dsc += basisDays(settle, next, basis).days / periodLen
      } else {
        dsc += 1
      }
    }
    prev = next
    ncy++
  }
  const coupPay = 100 * (rate / freq)
  return (red + dsl * coupPay) / (1 + dsc * (yld / freq)) - a * coupPay
}

function oddfArgs(args: FArg[], isPrice: boolean) {
  const set = serial(args[0])
  const mat = serial(args[1])
  const iss = serial(args[2])
  const fc = serial(args[3])
  const rate = num(args[4])
  const val = num(args[5])
  const red = num(args[6])
  const freq = checkFreq(args[7])
  const basis = checkBasis(args[8])
  for (const x of [set, mat, iss, fc, rate, val, red, freq, basis]) if (isErrorValue(x)) return x
  if (isPrice)
    return oddFirstPrice(
      set as number,
      mat as number,
      iss as number,
      fc as number,
      rate as number,
      val as number,
      red as number,
      freq as number,
      basis as number,
    )
  if ((val as number) <= 0) return err('#NUM!')
  return solveYield(val as number, (y) => {
    const r = oddFirstPrice(
      set as number,
      mat as number,
      iss as number,
      fc as number,
      rate as number,
      y,
      red as number,
      freq as number,
      basis as number,
    )
    return isErrorValue(r) ? NaN : r
  })
}

function oddlArgs(args: FArg[], isPrice: boolean) {
  const set = serial(args[0])
  const mat = serial(args[1])
  const lc = serial(args[2])
  const rate = num(args[3])
  const val = num(args[4])
  const red = num(args[5])
  const freq = checkFreq(args[6])
  const basis = checkBasis(args[7])
  for (const x of [set, mat, lc, rate, val, red, freq, basis]) if (isErrorValue(x)) return x
  if (isPrice)
    return oddLastPrice(
      set as number,
      mat as number,
      lc as number,
      rate as number,
      val as number,
      red as number,
      freq as number,
      basis as number,
    )
  if ((val as number) <= 0) return err('#NUM!')
  return solveYield(val as number, (y) => {
    const r = oddLastPrice(
      set as number,
      mat as number,
      lc as number,
      rate as number,
      y,
      red as number,
      freq as number,
      basis as number,
    )
    return isErrorValue(r) ? NaN : r
  })
}

export const FIN_FUNCTIONS: Record<string, FinFn> = {
  ACCRINTM: (...a) => accrintm(a),
  COUPPCD: (...a) => coup(a, (c) => c.pcd),
  COUPNCD: (...a) => coup(a, (c) => c.ncd),
  COUPNUM: (...a) => coup(a, (c) => c.count),
  COUPDAYBS: (...a) => coup(a, (c) => c.a),
  COUPDAYSNC: (...a) => coup(a, (c) => c.dsc),
  DURATION: (...a) => duration(a, false),
  MDURATION: (...a) => duration(a, true),
  INTRATE: (...a) => intrate(a),
  RECEIVED: (...a) => received(a),
  PRICEMAT: (...a) => priceMat(a),
  YIELDDISC: (...a) => yieldDisc(a),
  YIELDMAT: (...a) => yieldMat(a),
  PRICE: (...a) => price(a),
  YIELD: (...a) => yieldFn(a),
  VDB: (...a) => vdb(a),
  AMORLINC: (...a) => amor(a, false),
  AMORDEGRC: (...a) => amor(a, true),
  ODDFPRICE: (...a) => oddfArgs(a, true),
  ODDFYIELD: (...a) => oddfArgs(a, false),
  ODDLPRICE: (...a) => oddlArgs(a, true),
  ODDLYIELD: (...a) => oddlArgs(a, false),
}
