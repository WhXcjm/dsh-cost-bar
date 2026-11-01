/**
 * Host half of the cost meter: prices durable provider usage into money.
 *
 * The harness records tokens, never money, so this meter folds every settled
 * attempt's usage exactly like the `tokenUsage` session projection and applies
 * DeepSeek's official per-million-token price table. That table is real billing
 * data with two rates per line: idle-time prices and double-priced peak hours
 * (Beijing time, Monday-Friday excluding statutory holidays, 9:00-12:00 and
 * 14:00-18:00). Each settled sample is therefore priced by the local rate in
 * force at the moment it was reported, which keeps a turn that crosses a peak
 * boundary accurate.
 *
 * Live sessions are read from the in-memory session store; sessions from
 * earlier runs are backfilled from durable session storage so "today, all
 * sessions" includes them.
 *
 * @module dsh-cost-meter
 */

import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Price table asset shipped beside this module; edited without a reload. */
const PRICE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'prices.json')

/** Orders of magnitude for one price unit, used when the asset omits it. */
const ONE_MILLION = 1e6

/** Fallback billing used only while `prices.json` is missing or malformed. */
const FALLBACK_BILLING = {
  currency: '¥',
  unit: ONE_MILLION,
  peakMultiplier: 2,
  peakWindows: [[9, 12], [14, 18]],
  peakOffsetMinutes: 480,
  holidays: new Set(),
  models: { default: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 } },
  source: undefined,
  retrievedAt: undefined,
}

/** Fallback settings; every field is overridable from the bundle patch. */
const DEFAULT_SETTINGS = Object.freeze({
  currency: undefined,
  dailyBudget: 0,
  coldScanBudgetMs: 2000,
  coldScanIntervalMs: 60000,
})

/** Durable-log events that may carry provider usage for one attempt. */
const USAGE_EVENTS = new Set(['assistant/message', 'assistant/attempt'])

/** Empty prompt/completion bucket set. */
const emptyTokens = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/** Empty money split by billing line. */
const emptyBreakdown = () => ({ input: 0, cache: 0, output: 0 })

/**
 * Read one positive number, falling back to a default.
 * @param value - candidate override.
 * @param fallback - value to use when the candidate is not a finite number.
 * @returns the resolved number.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Normalize the raw bundle configuration into a complete settings object.
 * Prices are not configurable here: they live in `prices.json` so the table can
 * be corrected without reloading the Host.
 * @param config - patch-supplied configuration, possibly absent or partial.
 * @returns settings with every default resolved.
 */
export function normalizeSettings(config) {
  const source = typeof config === 'object' && config !== null ? config : {}
  return {
    currency: typeof source.currency === 'string' && source.currency.length > 0 ? source.currency : undefined,
    dailyBudget: Math.max(0, numberOr(source.dailyBudget, DEFAULT_SETTINGS.dailyBudget)),
    coldScanBudgetMs: Math.max(200, numberOr(source.coldScanBudgetMs, DEFAULT_SETTINGS.coldScanBudgetMs)),
    coldScanIntervalMs: Math.max(1000, numberOr(source.coldScanIntervalMs, DEFAULT_SETTINGS.coldScanIntervalMs)),
  }
}

/**
 * Normalize one billing table document.
 * @param raw - parsed `prices.json`.
 * @returns a complete billing table.
 */
export function normalizeBilling(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const rawModels = typeof source.models === 'object' && source.models !== null ? source.models : {}
  const models = {}
  for (const [model, row] of Object.entries(rawModels)) {
    if (typeof row !== 'object' || row === null) continue
    const input = numberOr(row.input, FALLBACK_BILLING.models.default.input)
    models[model] = {
      input,
      cacheRead: numberOr(row.cacheRead, FALLBACK_BILLING.models.default.cacheRead),
      cacheWrite: numberOr(row.cacheWrite, input),
      output: numberOr(row.output, FALLBACK_BILLING.models.default.output),
    }
  }
  if (models.default === undefined) models.default = { ...FALLBACK_BILLING.models.default }
  const windows = Array.isArray(source.peakWindows)
    ? source.peakWindows
      .filter((window) => Array.isArray(window) && window.length === 2 && window.every((hour) => Number.isFinite(Number(hour))))
      .map(([start, end]) => [Number(start), Number(end)])
    : FALLBACK_BILLING.peakWindows
  return {
    currency: typeof source.currency === 'string' && source.currency.length > 0 ? source.currency : FALLBACK_BILLING.currency,
    unit: Math.max(1, numberOr(source.unit, FALLBACK_BILLING.unit)),
    peakMultiplier: Math.max(1, numberOr(source.peakMultiplier, FALLBACK_BILLING.peakMultiplier)),
    peakWindows: windows.length > 0 ? windows : FALLBACK_BILLING.peakWindows,
    peakOffsetMinutes: numberOr(source.peakOffsetMinutes, FALLBACK_BILLING.peakOffsetMinutes),
    holidays: new Set(Array.isArray(source.holidays) ? source.holidays.filter((day) => typeof day === 'string') : []),
    models,
    source: typeof source.source === 'string' ? source.source : undefined,
    retrievedAt: typeof source.retrievedAt === 'string' ? source.retrievedAt : undefined,
  }
}

/** Last successfully parsed price table, keyed by file stamp. */
let priceCache = null

/**
 * Current price table, re-read whenever `prices.json` changes on disk.
 * A malformed edit keeps the previous good table instead of breaking billing.
 * @returns billing table with its file stamp.
 */
export function currentBilling() {
  try {
    const stat = fs.statSync(PRICE_FILE)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (priceCache !== null && priceCache.stamp === stamp) return priceCache
    const billing = normalizeBilling(JSON.parse(fs.readFileSync(PRICE_FILE, 'utf8')))
    priceCache = { stamp, ...billing }
    return priceCache
  } catch {
    if (priceCache !== null) return priceCache
    priceCache = { stamp: 'fallback', ...FALLBACK_BILLING }
    return priceCache
  }
}

/** Two-digit zero padding. */
const pad2 = (value) => String(value).padStart(2, '0')

/**
 * Decide whether one instant falls in a peak billing window.
 * Peak hours are Beijing time, Monday-Friday, excluding statutory holidays.
 * @param time - epoch milliseconds of the billed sample.
 * @param billing - current billing table.
 * @returns true when the peak multiplier applies.
 */
export function isPeak(time, billing) {
  const shifted = new Date(numberOr(time, Date.now()) + billing.peakOffsetMinutes * 60000)
  const weekday = shifted.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const day = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
  if (billing.holidays.has(day)) return false
  const hour = shifted.getUTCHours()
  return billing.peakWindows.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Resolve the billing row for one model at one instant.
 * @param billing - current billing table.
 * @param model - model id recorded by the provider route.
 * @param time - epoch milliseconds.
 * @returns unit prices plus whether the peak multiplier applied.
 */
export function rateAt(billing, model, time) {
  const row = typeof model === 'string' && Object.hasOwn(billing.models, model)
    ? billing.models[model]
    : billing.models.default
  const peak = isPeak(time, billing)
  const factor = peak ? billing.peakMultiplier : 1
  return {
    input: row.input * factor,
    cacheRead: row.cacheRead * factor,
    cacheWrite: row.cacheWrite * factor,
    output: row.output * factor,
    peak,
  }
}

/**
 * Local-calendar day key for one event timestamp.
 * @param time - epoch milliseconds.
 * @returns `YYYY-MM-DD` in the host's local zone.
 */
export function dayKey(time) {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * Convert provider usage onto the harness's disjoint billing buckets.
 * @param usage - provider-reported usage; `inputTokens` already excludes cache reads.
 * @returns billing buckets.
 */
function tokensFromUsage(usage) {
  return {
    input: numberOr(usage.inputTokens, 0),
    cacheRead: numberOr(usage.cacheReadTokens, 0),
    cacheWrite: numberOr(usage.cacheWriteTokens, 0),
    output: numberOr(usage.outputTokens, 0),
  }
}

/**
 * Sum two token bucket sets in place.
 * @param target - bucket set to mutate.
 * @param delta - signed bucket set to add.
 * @returns the mutated target.
 */
function addTokens(target, delta) {
  target.input += delta.input
  target.cacheRead += delta.cacheRead
  target.cacheWrite += delta.cacheWrite
  target.output += delta.output
  return target
}

/**
 * Signed difference between two bucket sets.
 * @param next - newer sample.
 * @param previous - replaced sample.
 * @returns the delta that turns `previous` into `next`.
 */
function subtractTokens(next, previous) {
  return {
    input: next.input - previous.input,
    cacheRead: next.cacheRead - previous.cacheRead,
    cacheWrite: next.cacheWrite - previous.cacheWrite,
    output: next.output - previous.output,
  }
}

/**
 * Whether a bucket delta carries no billable movement.
 * @param tokens - candidate delta.
 * @returns true when every counter is zero.
 */
function isZero(tokens) {
  return tokens.input === 0 && tokens.cacheRead === 0 && tokens.cacheWrite === 0 && tokens.output === 0
}

/**
 * Last usage sample embedded in one attempt's stream.
 * @param stream - assistant stream records.
 * @returns the newest usage sample, or undefined.
 */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * Usage one event reports for its attempt.
 * @param event - durable session event.
 * @returns the sample, or undefined when the event bills nothing.
 */
function usageOf(event) {
  if (USAGE_EVENTS.has(event.type) === false) return undefined
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  return lastStreamUsage(event.data?.stream)
}

/**
 * Fresh fold state for one session log.
 * @returns mutable fold state.
 */
export function createFold() {
  return {
    totals: emptyTokens(),
    totalCost: 0,
    breakdown: emptyBreakdown(),
    cacheSaving: 0,
    last: null,
    turns: new Map(),
    days: new Map(),
    steps: 0,
    maxTurn: 0,
    model: undefined,
    provider: undefined,
    maxSeq: -1,
  }
}

/**
 * Apply one durable event to a session fold.
 *
 * Mirrors the `tokenUsage` projection's replacement discipline: a sample for the
 * same turn and step replaces the previous one instead of adding to it, and an
 * `llm/retry-started` event ends that replacement scope so the retried attempt
 * bills separately. Every net movement is priced by the rate in force at the
 * sample's own timestamp.
 *
 * @param state - fold state to mutate.
 * @param event - durable session event.
 * @param billing - current billing table.
 * @returns the same fold state.
 */
export function applySessionEvent(state, event, billing) {
  if (typeof event?.seq === 'number' && event.seq > state.maxSeq) state.maxSeq = event.seq
  const data = event?.data ?? {}
  if (typeof data.turn === 'number' && data.turn > state.maxTurn) state.maxTurn = data.turn

  switch (event?.type) {
    case 'step/end': {
      state.steps += 1
      const row = state.turns.get(data.turn)
      if (row !== undefined) row.steps += 1
      return state
    }
    case 'llm/retry-started': {
      if (state.last !== null && state.last.turn === data.turn && state.last.step === data.step) state.last = null
      return state
    }
    case 'assistant/message': {
      const source = data.message?.source
      if (typeof source?.model === 'string') state.model = source.model
      if (typeof source?.provider === 'string') state.provider = source.provider
      break
    }
    case 'request/header': {
      const config = data.header?.config
      if (typeof config?.model === 'string') state.model = config.model
      if (typeof config?.provider === 'string') state.provider = config.provider
      break
    }
    default: break
  }

  if (USAGE_EVENTS.has(event.type) === false) return state
  const sample = usageOf(event)
  if (sample === undefined) return state

  const turn = numberOr(data.turn, 0)
  const step = numberOr(data.step, 0)
  const tokens = tokensFromUsage(sample)
  const previous = state.last !== null && state.last.turn === turn && state.last.step === step
    ? state.last.tokens
    : undefined
  const delta = previous === undefined ? tokens : subtractTokens(tokens, previous)
  state.last = { turn, step, tokens }
  if (isZero(delta)) return state

  const time = numberOr(event.time, Date.now())
  const rate = rateAt(billing, state.model, time)
  const unit = billing.unit
  const breakdown = {
    input: delta.input * rate.input / unit,
    cache: (delta.cacheRead * rate.cacheRead + delta.cacheWrite * rate.cacheWrite) / unit,
    output: delta.output * rate.output / unit,
  }
  const cost = breakdown.input + breakdown.cache + breakdown.output
  const saving = delta.cacheRead * Math.max(0, rate.input - rate.cacheRead) / unit

  addTokens(state.totals, delta)
  state.totalCost += cost
  state.breakdown.input += breakdown.input
  state.breakdown.cache += breakdown.cache
  state.breakdown.output += breakdown.output
  state.cacheSaving += saving

  const turnRow = state.turns.get(turn) ?? { tokens: emptyTokens(), cost: 0, breakdown: emptyBreakdown(), saving: 0, steps: 0 }
  addTokens(turnRow.tokens, delta)
  turnRow.cost += cost
  turnRow.breakdown.input += breakdown.input
  turnRow.breakdown.cache += breakdown.cache
  turnRow.breakdown.output += breakdown.output
  turnRow.saving += saving
  state.turns.set(turn, turnRow)

  const day = dayKey(time)
  const dayRow = state.days.get(day) ?? { tokens: emptyTokens(), cost: 0 }
  addTokens(dayRow.tokens, delta)
  dayRow.cost += cost
  state.days.set(day, dayRow)

  return state
}

/**
 * Host half of the cost meter bundle.
 * @param ctx - plugin context.
 * @param config - raw bundle configuration.
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const live = new Map()
  const cold = new Map()
  let coldComplete = false
  let coldScannedAt = 0
  let scanning = null
  let disposed = false
  let billingStamp = null

  ctx.effect(() => () => {
    disposed = true
  }, 'cost-meter: lifetime')

  /** @returns the durable session storage service, when composed. */
  const persistence = () => ctx.get('sessionPersistence')

  /** @returns the current billing table, resetting folded history when the price asset changed. */
  function billing() {
    const table = currentBilling()
    if (table.stamp !== billingStamp) {
      billingStamp = table.stamp
      live.clear()
      cold.clear()
      coldComplete = false
      coldScannedAt = 0
    }
    return table
  }

  /**
   * Fold every newly committed event of every live session into its meter.
   * @param table - billing table in force.
   */
  function refreshLive(table) {
    const store = ctx.get('sessions')
    if (store === undefined) return
    const liveIds = new Set()
    for (const session of store.list()) {
      const id = session.id
      liveIds.add(id)
      const inherited = Number(session.inheritedEventCount ?? 0)
      let entry = live.get(id)
      if (entry === undefined) {
        entry = { fold: createFold(), nextSeq: inherited, origin: session.header?.origin }
        live.set(id, entry)
        cold.delete(id)
      }
      const end = Number(session.seq ?? 0)
      if (end > entry.nextSeq) {
        for (const event of session.snapshotEvents(entry.nextSeq, end)) {
          if (Number(event.seq) >= entry.nextSeq) applySessionEvent(entry.fold, event, table)
        }
        entry.nextSeq = end
      }
      entry.origin = session.header?.origin
    }
    for (const [id, entry] of [...live]) {
      if (liveIds.has(id)) continue
      live.delete(id)
      cold.set(id, { revision: null, fold: entry.fold, origin: entry.origin })
    }
  }

  /**
   * Fold one stored session from the durable log.
   * @param snapshot - durable session snapshot.
   * @param cached - previously folded entry, if any.
   * @param table - billing table in force.
   * @returns the refreshed cache entry.
   */
  async function refreshStored(snapshot, cached, table) {
    const service = persistence()
    if (service === undefined) throw new Error('session storage is unavailable')
    const handle = await service.open(snapshot.header.id, 'read')
    try {
      const fold = cached?.fold ?? createFold()
      const inherited = Number(handle.inheritedEventCount ?? 0)
      const from = fold.maxSeq < 0 ? inherited : fold.maxSeq + 1
      const result = await handle.read(from)
      for (const event of result.events) applySessionEvent(fold, event, table)
      return { revision: snapshot.revision, fold, origin: snapshot.header.origin }
    } finally {
      try {
        await handle.close()
      } catch {
        /* closing a read handle cannot change the folded figures */
      }
    }
  }

  /**
   * Backfill stored sessions not currently live, newest first, within a time slice.
   * @param budgetMs - time slice for this pass.
   * @param table - billing table in force.
   * @returns whether every stored session is now folded.
   */
  async function scanStored(budgetMs, table) {
    if (disposed) return true
    if (scanning !== null) return scanning
    const service = persistence()
    if (service === undefined) {
      coldComplete = true
      return true
    }
    scanning = (async () => {
      const deadline = Date.now() + Math.max(200, budgetMs)
      let snapshots
      try {
        snapshots = [...await service.list()]
      } catch {
        coldComplete = true
        coldScannedAt = Date.now()
        return true
      }
      snapshots.sort((left, right) => numberOr(right.header?.createdAt, 0) - numberOr(left.header?.createdAt, 0))
      let complete = true
      for (const snapshot of snapshots) {
        if (disposed) return false
        if (Date.now() > deadline) {
          complete = false
          break
        }
        const id = snapshot.header.id
        if (live.has(id)) {
          cold.delete(id)
          continue
        }
        const cached = cold.get(id)
        if (cached !== undefined && cached.revision === snapshot.revision) continue
        try {
          cold.set(id, await refreshStored(snapshot, cached, table))
        } catch {
          cold.set(id, { revision: snapshot.revision, fold: cached?.fold ?? createFold(), origin: snapshot.header.origin })
        }
      }
      coldComplete = complete
      coldScannedAt = Date.now()
      return complete
    })().finally(() => {
      scanning = null
    })
    return scanning
  }

  /**
   * Today's spend across every session this meter can see.
   * @param day - local day key.
   * @returns total, main-session, subagent, and active-session figures.
   */
  function aggregateDay(day) {
    let cost = 0
    let main = 0
    let subagent = 0
    let sessions = 0
    const visit = (entry) => {
      const row = entry.fold.days.get(day)
      if (row === undefined || row.cost === 0) return
      cost += row.cost
      if (entry.origin === 'subagent') subagent += row.cost
      else main += row.cost
      sessions += 1
    }
    for (const entry of live.values()) visit(entry)
    for (const [id, entry] of cold) if (!live.has(id)) visit(entry)
    return { cost, main, subagent, sessions }
  }

  /**
   * Whole-harness spend and conversation counts across every session this meter
   * can see, for the "total" column beside each session-scoped figure.
   * @returns all-session spend, turns, and contributing sessions.
   */
  function aggregateAll() {
    let cost = 0
    let turns = 0
    let sessions = 0
    const visit = (entry) => {
      cost += entry.fold.totalCost
      turns += entry.fold.maxTurn
      if (entry.fold.totalCost !== 0) sessions += 1
    }
    for (const entry of live.values()) visit(entry)
    for (const [id, entry] of cold) if (!live.has(id)) visit(entry)
    return { cost, turns, sessions }
  }

  /**
   * Resolve one session's meter, live first and durable second.
   * @param sessionId - the Session requested by the page.
   * @param table - billing table in force.
   * @returns the cache entry, or undefined for an unknown session.
   */
  async function resolveSession(sessionId, table) {
    const current = live.get(sessionId)
    if (current !== undefined) return current
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const service = persistence()
    if (service === undefined) return cold.get(sessionId)
    try {
      const snapshot = await service.stat(sessionId)
      if (snapshot === undefined) return undefined
      const cached = cold.get(sessionId)
      if (cached === undefined || cached.revision !== snapshot.revision) {
        const refreshed = await refreshStored(snapshot, cached, table)
        cold.set(sessionId, refreshed)
        return refreshed
      }
      return cached
    } catch {
      return cold.get(sessionId)
    }
  }

  /**
   * Build the payload the page polls.
   * @param sessionId - current Session id.
   * @returns serializable snapshot.
   */
  async function snapshot(sessionId) {
    const table = billing()
    refreshLive(table)
    const now = Date.now()
    const day = dayKey(now)
    const entry = await resolveSession(sessionId, table)
    const shouldScan = !coldComplete || now - coldScannedAt > settings.coldScanIntervalMs
    if (shouldScan && scanning === null && persistence() !== undefined) void scanStored(settings.coldScanBudgetMs, table).catch(() => {})

    const dayTotals = aggregateDay(day)
    const allTotals = aggregateAll()
    const fold = entry?.fold
    const turnRow = fold?.turns.get(fold.maxTurn)
    const sessionDay = fold?.days.get(day)
    const model = fold?.model ?? null
    const currentRate = rateAt(table, model, now)
    const currency = settings.currency ?? table.currency
    return {
      ok: true,
      version: 2,
      currency,
      generatedAt: now,
      complete: coldComplete,
      session: fold === undefined ? null : {
        id: String(sessionId),
        model,
        provider: fold.provider ?? null,
        turn: {
          index: fold.maxTurn,
          cost: turnRow?.cost ?? 0,
          steps: turnRow?.steps ?? 0,
          tokens: turnRow?.tokens ?? emptyTokens(),
          breakdown: turnRow?.breakdown ?? emptyBreakdown(),
          saving: turnRow?.saving ?? 0,
        },
        total: {
          cost: fold.totalCost,
          steps: fold.steps,
          turns: fold.maxTurn,
          cacheSaving: fold.cacheSaving,
          tokens: fold.totals,
          breakdown: fold.breakdown,
        },
        today: {
          cost: sessionDay?.cost ?? 0,
          tokens: sessionDay?.tokens ?? emptyTokens(),
        },
      },
      today: dayTotals,
      totals: allTotals,
      budget: settings.dailyBudget > 0
        ? { limit: settings.dailyBudget, spent: dayTotals.cost, ratio: dayTotals.cost / settings.dailyBudget }
        : null,
      price: {
        model,
        input: currentRate.input,
        cacheRead: currentRate.cacheRead,
        cacheWrite: currentRate.cacheWrite,
        output: currentRate.output,
        peak: currentRate.peak,
        multiplier: table.peakMultiplier,
        source: table.source,
        retrievedAt: table.retrievedAt,
      },
    }
  }

  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection
    if (connection?.fetch === undefined) return
    scope.effect(() => connection.fetch.register({
      path: '/api/cost-meter/snapshot',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('session') ?? ''
        try {
          const payload = await snapshot(sessionId)
          return new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
      },
    }), 'cost-meter: snapshot route')
  })
}

export const name = 'cost-meter'
export const inject = ['sessions']
