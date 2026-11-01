/**
 * Client half of the cost meter: the composer-dock cost pill and its details
 * dialog. Figures come from the Host half over the authenticated `/api` bridge,
 * so the browser never folds session events itself.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-cost-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useLayoutEffect, useRef, useState } = React

    /** Portal helper; absent in assemblies that do not seed `react-dom`. */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom !== null && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      createPortal = null
    }

    const NS = 'cost-meter'

    /**
     * The active money mark: Heroicons `banknotes` (MIT), outline 24px grid at
     * a 1.5 stroke. Alternative marks from Lucide, Tabler, Phosphor, Remix,
     * Material Symbols, and Heroicons are compared in `design/icon-options.svg`;
     * swapping one means replacing this geometry and `icon.svg`.
     */
    const ICON_VIEW_BOX = '0 0 24 24'
    const ICON_STROKE_WIDTH = 1.5
    const ICON_SHAPES = [
      ['path', {
        d: 'M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z',
      }],
    ]

    /** Chinese copy; see `locale/zh.json` for the package metadata. */
    const zh = {
      'pill': '{turn} · {total}',
      'aria.pill': '本轮 {turn}，会话 {total}',
      'dialog.title': '成本',
      'head.turn': '本轮成本',
      'head.session': '会话成本',
      'col.turn': '本轮',
      'col.session': '会话',
      'col.total': '总计',
      'row.dialogTurns': '对话轮数',
      'row.todaySpend': '今日支出',
      'row.totalSpend': '总计支出',
      'row.input': '输入支出',
      'row.cache': '缓存支出',
      'row.output': '输出支出',
      'row.cacheHit': '本会话缓存命中率',
      'row.cacheSaving': '本会话缓存节省',
      'value.percent': '{percent}%',
      'value.turns': '{count} 轮',
      'footer.input': '输入 {price}',
      'footer.cache': '缓存 {price}',
      'footer.output': '输出 {price}',
      'price.idle': '空闲价',
      'price.peak': '高峰价',
      'price.stale': '价格待更新',
    }

    /** English copy. */
    const en = {
      'pill': '{turn} · {total}',
      'aria.pill': 'This turn {turn}, session {total}',
      'dialog.title': 'Cost',
      'head.turn': 'This turn',
      'head.session': 'Session',
      'col.turn': 'Turn',
      'col.session': 'Session',
      'col.total': 'Total',
      'row.dialogTurns': 'Conversation turns',
      'row.todaySpend': 'Today spend',
      'row.totalSpend': 'Total spent',
      'row.input': 'Input',
      'row.cache': 'Cache',
      'row.output': 'Output',
      'row.cacheHit': 'Session cache hit',
      'row.cacheSaving': 'Session cache savings',
      'value.percent': '{percent}%',
      'value.turns': '{count}',
      'footer.input': 'Input {price}',
      'footer.cache': 'Cache {price}',
      'footer.output': 'Output {price}',
      'price.idle': 'idle',
      'price.peak': 'peak',
      'price.stale': 'price pending',
    }

    /**
     * Pill and dialog chrome copied from the host statistics pill/dialog,
     * renamed under this plugin's prefix, and reduced to theme tokens with
     * fallbacks.
     *
     * Both columns share one 20px row rhythm so every row title lines up
     * exactly across the two-column body, independent of the 11px column
     * headers and the 12px row labels.
     */
    const CSS = [
      '.DCM_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.DCM_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm,4px);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.DCM_pill svg{flex:none;width:14px;height:14px}',
      '.DCM_pill:hover,.DCM_pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary)}',
      '.DCM_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.DCM_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#fff));width:max-content;min-width:min(380px,100vw - 24px);max-width:min(520px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(12px));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:14px 16px;font-size:12px;line-height:18px;position:fixed}',
      '.DCM_header{align-items:center;gap:6px;min-height:24px;display:flex}',
      '.DCM_headIcon{flex:none;color:var(--dsw-alias-label-primary);align-items:center;display:inline-flex}',
      '.DCM_headIcon svg{width:16px;height:16px}',
      '.DCM_headGroup{align-items:baseline;gap:6px;min-width:0;display:inline-flex}',
      '.DCM_headEnd{margin-left:auto}',
      /* CJK ideographs ink about 0.06em below the alphabetic baseline while digits sit on it, so a CJK label is nudged by that amount to keep its ink bottom flush with the number's bottom. */
      '.DCM_headLabel{color:var(--dsw-alias-label-primary);font-size:12px;white-space:nowrap}',
      '.DCM_headLabelCjk{position:relative;top:-0.06em}',
      '.DCM_headValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.DCM_rule{border-top:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));margin:10px 0}',
      '.DCM_body{grid-template-columns:minmax(0,1fr) minmax(0,1fr);display:grid}',
      '.DCM_table{grid-template-columns:minmax(0,1fr) 52px 52px;grid-auto-rows:20px;row-gap:6px;column-gap:5px;align-items:center;min-width:0;display:grid}',
      '.DCM_tableLeft{padding-right:12px}',
      '.DCM_tableRight{border-left:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));padding-left:12px}',
      '.DCM_cellHead{color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:right;white-space:nowrap}',
      '.DCM_cellLabel{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.DCM_cellValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',
      '.DCM_notes{align-items:baseline;justify-content:space-between;gap:16px;margin-top:0;display:flex}',
      '.DCM_note{align-items:baseline;gap:6px;min-width:0;display:inline-flex}',
      '.DCM_noteLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.DCM_noteValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.DCM_footer{align-items:center;justify-content:space-between;gap:6px;display:flex;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:10px;font-variant-numeric:tabular-nums}',
      '.DCM_footerPart{white-space:nowrap;min-width:0;text-overflow:ellipsis;overflow:hidden;align-items:center;gap:6px;display:inline-flex}',
      '.DCM_footerTag{font-size:10px;line-height:14px;font-weight:500;flex:none}',
      '.DCM_footerTagIdle{color:var(--dsw-alias-state-success-primary,#0e7a46)}',
      '.DCM_footerTagPeak{color:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.DCM_footerTagStale{color:var(--dsw-alias-state-error-primary,#c62828)}',
      '.DCM_footerDot{color:var(--dsw-alias-separator-primary,var(--dsw-alias-label-tertiary));flex:none}',
    ].join('')

    /** Hidden-but-laid-out first paint so the clamp measures real dimensions. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }

    /** Viewport margin kept by the placement clamp. */
    const PANEL_MARGIN = 12

    /** Distance between the trigger and the panel. */
    const PANEL_GAP = 8

    /**
     * Fixed-precision amount so every cell stays column-aligned: the header uses
     * four decimals, the detail rows and the composer pill use three.
     * @param value - amount in the configured currency.
     * @param digits - decimal places to keep.
     * @returns display text without the currency sign.
     */
    function formatAmount(value, digits) {
      const safe = typeof value === 'number' && Number.isFinite(value) ? value : 0
      return safe.toFixed(digits)
    }

    /**
     * "Total" column amount: four significant digits at or above 1, three
     * decimals below 1, so the figure always reads as four digits across the
     * column while small values keep their precision.
     * @param value - amount in the configured currency.
     * @returns display text without the currency sign.
     */
    function formatTotalAmount(value) {
      const safe = typeof value === 'number' && Number.isFinite(value) ? value : 0
      const magnitude = Math.abs(safe)
      if (magnitude < 1) return safe.toFixed(3)
      const exponent = Math.floor(Math.log10(magnitude))
      const decimals = Math.max(0, Math.min(8, 3 - exponent))
      return safe.toFixed(decimals)
    }

    /**
     * Two-decimal price used by the footer table.
     * @param value - per-million-token price.
     * @returns display text.
     */
    function formatPrice(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0.00'
      return value.toFixed(2)
    }

    /**
     * Cache-hit share of prompt-side billing.
     * @param tokens - prompt/completion buckets.
     * @returns percent text, or null when nothing was billed.
     */
    function cacheHitPercent(tokens) {
      if (tokens === undefined || tokens === null) return null
      const billed = tokens.input + tokens.cacheRead + tokens.cacheWrite
      if (billed <= 0) return null
      const ratio = tokens.cacheRead / billed * 100
      if (ratio >= 99.95) return '100'
      return String(Math.round(ratio * 10) / 10)
    }

    /**
     * Apply a localized template to placeholder values.
     * @param t - locale seat for the plugin namespace.
     * @param key - dictionary key.
     * @param values - placeholder values.
     * @returns localized text.
     */
    const text = (t, key, values) => t(key, values)

    /** The active money mark, drawn from the licensed icon path data above. */
    function MeterIcon(props) {
      const size = props?.size ?? 14
      return h('svg', {
        viewBox: ICON_VIEW_BOX,
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: ICON_STROKE_WIDTH,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, ICON_SHAPES.map(([tag, shape], index) => h(tag, { key: index, ...shape })))
    }

    /**
     * Poll the Host snapshot for one Session.
     * @param sessionId - current Session id.
     * @returns latest payload and the transient failure flag.
     */
    function useCostSnapshot(sessionId) {
      const [state, setState] = useState({ data: null, failed: false })
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          setState({ data: null, failed: false })
          return undefined
        }
        let disposed = false
        let timer = null
        let controller = null
        const clearTimer = () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
        }
        const schedule = (delay) => {
          clearTimer()
          timer = setTimeout(() => {
            void load()
          }, delay)
        }
        const load = async () => {
          clearTimer()
          if (controller !== null) controller.abort()
          const next = new AbortController()
          controller = next
          try {
            const url = new URL('/api/cost-meter/snapshot', window.location.origin)
            url.searchParams.set('session', sessionId)
            const response = await fetch(url.href, {
              signal: next.signal,
              credentials: 'same-origin',
              cache: 'no-store',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            if (disposed || next.signal.aborted) return
            if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
              throw new Error(typeof payload?.error === 'string' ? payload.error : 'cost meter unavailable')
            }
            setState({ data: payload, failed: false })
            const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
            schedule(hidden ? 15000 : payload.complete === false ? 1200 : 2500)
          } catch (error) {
            if (disposed || next.signal.aborted) return
            setState((previous) => ({ data: previous.data, failed: true }))
            schedule(8000)
          }
        }
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
            clearTimer()
            void load()
          }
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        void load()
        return () => {
          disposed = true
          if (controller !== null) controller.abort()
          clearTimer()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId])
      return state
    }

    /**
     * Viewport-clamped placement above the trigger, below it when it does not fit.
     * @param open - dialog visibility.
     * @param anchorRef - trigger element.
     * @param panelRef - portaled panel element.
     * @param revision - value that changes when the panel's measured content changes.
     * @returns fixed-position coordinates, or null until measured.
     */
    function useAnchorPosition(open, anchorRef, panelRef, revision) {
      const [position, setPosition] = useState(null)
      useLayoutEffect(() => {
        if (open === false) {
          setPosition(null)
          return undefined
        }
        const measure = () => {
          const anchor = anchorRef.current
          const panel = panelRef.current
          if (anchor === null || panel === null) return
          const trigger = anchor.getBoundingClientRect()
          const rect = panel.getBoundingClientRect()
          const width = rect.width
          const height = rect.height
          const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN)
          let left = trigger.left + trigger.width / 2 - width / 2
          left = Math.min(Math.max(PANEL_MARGIN, left), maxLeft)
          let top = trigger.top - height - PANEL_GAP
          if (top < PANEL_MARGIN) top = Math.min(trigger.bottom + PANEL_GAP, window.innerHeight - height - PANEL_MARGIN)
          setPosition({ left, top })
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [open, anchorRef, panelRef, revision])
      return position
    }

    /**
     * Close the dialog on Escape or on a pointer outside it.
     * @param open - dialog visibility.
     * @param setOpen - visibility setter.
     * @param rootRef - trigger element.
     * @param panelRef - portaled panel element.
     */
    function useDismiss(open, setOpen, rootRef, panelRef) {
      useEffect(() => {
        if (open === false) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointerDown = (event) => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (rootRef.current !== null && rootRef.current.contains(target)) return
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open, setOpen, rootRef, panelRef])
    }

    /**
     * Detail dialog content for one snapshot.
     *
     * Header: the current turn and whole-session totals. Body: two identical
     * tables on one 20px row grid. The left table splits spend by billing line
     * (this turn vs session); the right table compares the session with every
     * session in this harness (turns, today's spend, total spend), and its
     * harness-wide column keeps four significant digits. Footer: the model plus
     * its current per-million-token rates, spaced across the full width.
     *
     * @param props - snapshot, locale seat, refs, and placement.
     * @returns React element.
     */
    function CostDialog(props) {
      const { data, t, panelRef, position, className } = props
      const currency = typeof data.currency === 'string' ? data.currency : ''
      const session = data.session
      const price = data.price ?? {}
      const rate = {
        input: typeof price.input === 'number' ? price.input : 0,
        cacheRead: typeof price.cacheRead === 'number' ? price.cacheRead : 0,
        cacheWrite: typeof price.cacheWrite === 'number' ? price.cacheWrite : 0,
        output: typeof price.output === 'number' ? price.output : 0,
      }
      const turnTokens = session.turn.tokens
      const totalTokens = session.total.tokens
      // The Host prices each settled sample at the rate in force then, so its
      // money split is authoritative; the local price-only estimate is the
      // fallback for a Host generation that predates the breakdown.
      const fallbackBreakdown = (tokens) => ({
        input: tokens.input * rate.input / 1e6,
        cache: (tokens.cacheRead * rate.cacheRead + tokens.cacheWrite * rate.cacheWrite) / 1e6,
        output: tokens.output * rate.output / 1e6,
      })
      const turnBreakdown = session.turn.breakdown ?? fallbackBreakdown(turnTokens)
      const totalBreakdown = session.total.breakdown ?? fallbackBreakdown(totalTokens)
      const model = session.model ?? price.model ?? '—'
      // Header keeps four decimals; every detail row and the pill use three.
      const money = (value) => `${currency}${formatAmount(value, 3)}`
      const moneyExact = (value) => `${currency}${formatAmount(value, 4)}`
      const percent = cacheHitPercent(totalTokens)

      const headerLabels = {
        turn: text(t, 'head.turn'),
        session: text(t, 'head.session'),
      }
      const cjkLabel = /[\u3400-\u9fff]/.test(headerLabels.turn)
      const labelClass = cjkLabel
        ? `${className.headLabel} ${className.headLabelCjk}`
        : className.headLabel
      const header = h('div', { key: 'header', className: className.header }, [
        h('span', { key: 'icon', className: className.headIcon }, h(MeterIcon, { key: 'mark', size: 16 })),
        h('span', { key: 'turn', className: className.headGroup }, [
          h('span', { key: 'label', className: labelClass }, headerLabels.turn),
          h('span', { key: 'value', className: className.headValue }, moneyExact(session.turn.cost)),
        ]),
        h('span', { key: 'session', className: `${className.headGroup} ${className.headEnd}` }, [
          h('span', { key: 'label', className: labelClass }, headerLabels.session),
          h('span', { key: 'value', className: className.headValue }, moneyExact(session.total.cost)),
        ]),
      ])

      // Both halves are the same table: one label column plus two value
      // columns on the shared 20px row grid, so one builder keeps their layout
      // identical. The left table splits spend by billing line (this turn vs
      // session); the right table compares the session against every session in
      // this harness (conversation count, today's spend, total spend).
      const renderTable = (key, modifier, columns, rows) => {
        const cells = [h('span', { key: 'head-label', className: className.cellHead }, '')]
        columns.forEach((label, index) => {
          cells.push(h('span', { key: `head-${index}`, className: className.cellHead }, label))
        })
        rows.forEach((row, rowIndex) => {
          cells.push(h('span', { key: `row-${rowIndex}-label`, className: className.cellLabel }, row.label))
          row.values.forEach((value, cellIndex) => {
            cells.push(h('span', { key: `row-${rowIndex}-${cellIndex}`, className: className.cellValue }, value))
          })
        })
        return h('div', { key, className: `${className.table} ${modifier}` }, cells)
      }
      const spendTable = renderTable('spend', className.tableLeft, [text(t, 'col.turn'), text(t, 'col.session')], [
        { label: text(t, 'row.input'), values: [money(turnBreakdown.input), money(totalBreakdown.input)] },
        { label: text(t, 'row.cache'), values: [money(turnBreakdown.cache), money(totalBreakdown.cache)] },
        { label: text(t, 'row.output'), values: [money(turnBreakdown.output), money(totalBreakdown.output)] },
      ])
      const harnessTotals = data.totals ?? null
      const turns = (count) => text(t, 'value.turns', { count })
      // The harness-wide column keeps four significant digits so a large total
      // stays meaningful instead of padding out a fixed decimal tail.
      const harnessMoney = (value) => `${currency}${formatTotalAmount(value)}`
      const totalsTable = renderTable('totals', className.tableRight, [text(t, 'col.session'), text(t, 'col.total')], [
        {
          label: text(t, 'row.dialogTurns'),
          values: [turns(session.total.turns), harnessTotals === null ? '—' : turns(harnessTotals.turns)],
        },
        {
          label: text(t, 'row.todaySpend'),
          values: [money(session.today.cost), harnessMoney(data.today?.cost ?? 0)],
        },
        {
          label: text(t, 'row.totalSpend'),
          values: [money(session.total.cost), harnessTotals === null ? '—' : harnessMoney(harnessTotals.cost)],
        },
      ])

      const notes = h('div', { key: 'notes', className: className.notes }, [
        h('span', { key: 'hit', className: className.note }, [
          h('span', { key: 'label', className: className.noteLabel }, text(t, 'row.cacheHit')),
          h('span', { key: 'value', className: className.noteValue }, percent === null ? '—' : text(t, 'value.percent', { percent })),
        ]),
        h('span', { key: 'saving', className: className.note }, [
          h('span', { key: 'label', className: className.noteLabel }, text(t, 'row.cacheSaving')),
          h('span', { key: 'value', className: className.noteValue }, money(session.total.cacheSaving)),
        ]),
      ])

      const stale = data.version !== 2
      const tagKey = stale ? 'price.stale' : price.peak === true ? 'price.peak' : 'price.idle'
      const tagClass = stale
        ? `${className.footerTag} ${className.footerTagStale}`
        : price.peak === true
          ? `${className.footerTag} ${className.footerTagPeak}`
          : `${className.footerTag} ${className.footerTagIdle}`
      const modelCell = h('span', { key: 'part-0', className: className.footerPart }, [
        h('span', { key: 'model' }, model),
        h('span', { key: 'tag', className: tagClass }, text(t, tagKey)),
      ])
      const footerParts = [
        modelCell,
        text(t, 'footer.input', { price: formatPrice(rate.input) }),
        text(t, 'footer.cache', { price: formatPrice(rate.cacheRead) }),
        text(t, 'footer.output', { price: formatPrice(rate.output) }),
      ]
      const footerChildren = []
      footerParts.forEach((part, index) => {
        if (index > 0) footerChildren.push(h('span', { key: `dot-${index}`, className: className.footerDot, 'aria-hidden': true }, '·'))
        footerChildren.push(index === 0
          ? part
          : h('span', { key: `part-${index}`, className: className.footerPart }, part))
      })
      const footer = h('div', { key: 'footer', className: className.footer }, footerChildren)

      const panel = h('div', {
        ref: panelRef,
        className: className.panel,
        role: 'dialog',
        'aria-label': text(t, 'dialog.title'),
        'data-cost-meter': 'dialog',
        style: position === null ? MEASURE_STYLE : { left: position.left, top: position.top },
      }, [
        header,
        h('div', { key: 'rule-1', className: className.rule, 'aria-hidden': true }),
        h('div', { key: 'body', className: className.body }, [spendTable, totalsTable]),
        h('div', { key: 'rule-2', className: className.rule, 'aria-hidden': true }),
        notes,
        footer,
      ])
      return createPortal === null ? panel : createPortal(panel, document.body)
    }

    /**
     * Composer-dock cost pill.
     * @param props - slot standard props plus the locale seat.
     * @returns the pill, or null while no usage exists yet.
     */
    function CostPill(props) {
      const { sessionId, t } = props
      const { data } = useCostSnapshot(sessionId)
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const position = useAnchorPosition(open, rootRef, panelRef, data?.generatedAt ?? 0)
      useDismiss(open, setOpen, rootRef, panelRef)

      if (data === null || data.session === null || data.session === undefined) return null
      const totals = data.session.total.tokens
      if (totals.input + totals.cacheRead + totals.cacheWrite + totals.output === 0) return null

      const currency = typeof data.currency === 'string' ? data.currency : ''
      const turnText = `${currency}${formatAmount(data.session.turn.cost, 3)}`
      const totalText = `${currency}${formatAmount(data.session.total.cost, 3)}`
      const label = text(t, 'pill', { turn: turnText, total: totalText })
      const ariaLabel = text(t, 'aria.pill', { turn: turnText, total: totalText })
      const className = {
        anchor: 'DCM_anchor',
        pill: 'DCM_pill',
        label: 'DCM_label',
        panel: 'DCM_panel',
        header: 'DCM_header',
        headIcon: 'DCM_headIcon',
        headGroup: 'DCM_headGroup',
        headEnd: 'DCM_headEnd',
        headLabel: 'DCM_headLabel',
        headLabelCjk: 'DCM_headLabelCjk',
        headValue: 'DCM_headValue',
        rule: 'DCM_rule',
        body: 'DCM_body',
        table: 'DCM_table',
        tableLeft: 'DCM_tableLeft',
        tableRight: 'DCM_tableRight',
        cellHead: 'DCM_cellHead',
        cellLabel: 'DCM_cellLabel',
        cellValue: 'DCM_cellValue',
        notes: 'DCM_notes',
        note: 'DCM_note',
        noteLabel: 'DCM_noteLabel',
        noteValue: 'DCM_noteValue',
        footer: 'DCM_footer',
        footerPart: 'DCM_footerPart',
        footerDot: 'DCM_footerDot',
        footerTag: 'DCM_footerTag',
        footerTagIdle: 'DCM_footerTagIdle',
        footerTagPeak: 'DCM_footerTagPeak',
        footerTagStale: 'DCM_footerTagStale',
      }
      const children = [
        h('style', { key: 'styles' }, CSS),
        h('button', {
          key: 'trigger',
          type: 'button',
          className: className.pill,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': ariaLabel,
          onClick: () => setOpen((value) => !value),
        }, [h(MeterIcon, { key: 'icon' }), h('span', { key: 'label', className: className.label }, label)]),
      ]
      if (open) {
        children.push(h(CostDialog, {
          key: 'dialog',
          data,
          t,
          panelRef,
          position,
          className,
        }))
      }
      return h('span', { ref: rootRef, className: className.anchor, 'data-cost-meter': 'pill' }, children)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cost-meter: dictionaries')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'cost',
          order: 2,
          locale: NS,
        }, CostPill))
      },
    }
  },
})
