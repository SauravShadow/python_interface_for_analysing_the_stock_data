'use client'
// app/live/page.tsx — Live market quotes with WebSocket streaming + live intraday candles
import { useState, useEffect, useRef } from 'react'
import { stocksApi, liveApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { createLogger } from '@/lib/logger'
import Link from 'next/link'

const log = createLogger('LivePage')
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from 'recharts'

interface Quote {
  tsym: string
  exchange: string
  token: string
  lp?: number
  pc?: number
  v?: number
  h?: number
  l?: number
  o?: number
  c?: number
  bp1?: number
  sp1?: number
  updated_at?: string
}

interface WatchlistItem {
  tsym: string; token: string; exchange: string; cname?: string
}

interface Candle {
  datetime: string    // "HH:MM" display label (IST)
  minuteKey: string   // "YYYY-MM-DDTHH:MM" UTC — used for live candle merging, not rendered
  open: number
  high: number
  low: number
  close: number
  volume: number
  isUp: boolean
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getMinuteKey(isoUtc: string): string {
  // "2026-05-12T05:30:01.123456" → "2026-05-12T05:30"
  return isoUtc.slice(0, 16)
}

function minuteKeyToLabel(minuteKey: string): string {
  // Convert UTC minute key to IST HH:MM display string
  const utcDate = new Date(`${minuteKey}:00Z`)
  return utcDate.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  })
}

function transformCandles(raw: any[]): Candle[] {
  return raw.map(c => {
    const d = new Date(typeof c.datetime === 'number' ? c.datetime * 1000 : c.datetime)
    const label = d.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    })
    const minuteKey = d.toISOString().slice(0, 16) // UTC minute key
    return {
      datetime: label,
      minuteKey,
      open:   Number(c.open   ?? c.into ?? 0),
      high:   Number(c.high   ?? c.inth ?? 0),
      low:    Number(c.low    ?? c.intl ?? 0),
      close:  Number(c.close  ?? c.intc ?? 0),
      volume: Number(c.volume ?? c.intv ?? 0),
      isUp:   Number(c.close ?? 0) >= Number(c.open ?? 0),
    }
  })
}

function applyTickToCandles(
  candles: Candle[],
  tick: { ltp: number; volume: number; timestamp: string }
): { candles: Candle[]; changed: boolean } {
  if (!tick.ltp || !tick.timestamp) return { candles, changed: false }

  const minuteKey = getMinuteKey(tick.timestamp)
  const label     = minuteKeyToLabel(minuteKey)
  const ltp       = tick.ltp
  const last      = candles.length > 0 ? candles[candles.length - 1] : null

  if (last && last.minuteKey === minuteKey) {
    // Update the live (last) candle in-place
    const updated: Candle = {
      ...last,
      high:   Math.max(last.high, ltp),
      low:    Math.min(last.low, ltp),
      close:  ltp,
      volume: tick.volume,
      isUp:   ltp >= last.open,
    }
    return { candles: [...candles.slice(0, -1), updated], changed: true }
  } else {
    // New minute — open a fresh candle
    const newCandle: Candle = {
      datetime: label,
      minuteKey,
      open: ltp, high: ltp, low: ltp, close: ltp,
      volume: tick.volume,
      isUp: true,
    }
    return { candles: [...candles, newCandle], changed: true }
  }
}

// ── Intraday chart ─────────────────────────────────────────────────────────────

function IntradayChart({ candles, symbol, version }: {
  candles: Candle[] | null
  symbol: string
  version: number   // bumped on every live update; forces re-render without re-mounting
}) {
  const lastMinuteKey = candles && candles.length > 0 ? candles[candles.length - 1].minuteKey : null
  const isLive = lastMinuteKey === new Date().toISOString().slice(0, 16)

  if (candles === null) return (
    <div style={{ padding: '20px 16px', color: 'var(--red)', fontSize: '0.8125rem' }}>
      Failed to load chart — check backend logs for details.
    </div>
  )

  if (!candles.length) return (
    <div style={{ padding: '20px 16px', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
      No intraday data yet — FlatTrade may not have 1-min data for this symbol, or market hasn&apos;t opened today.
    </div>
  )

  const CustomCandlestick = (props: any) => {
    const { x, y, width, height, payload } = props
    if (!payload) return null
    const { open, close } = payload
    const isUp = close >= open
    const color = isUp ? '#22c55e' : '#ef4444'
    return (
      <g>
        <line x1={x + width / 2} y1={y} x2={x + width / 2} y2={y + height} stroke={color} strokeWidth={1} opacity={0.6} />
        <rect x={x + width * 0.15} y={Math.min(open, close)} width={width * 0.7} height={Math.abs(close - open) || 1} fill={color} rx={1} />
      </g>
    )
  }

  return (
    <div style={{ padding: '12px 16px 8px' }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{symbol} &mdash; Today&apos;s intraday ({candles.length} candles)</span>
        {isLive && (
          <span style={{ color: 'var(--green)', fontWeight: 600, fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', animation: 'pulse 2s infinite' }} />
            LIVE
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <ComposedChart data={candles} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="datetime" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval="preserveStartEnd" />
          <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} width={55} tickFormatter={v => v.toFixed(1)} />
          <Tooltip
            contentStyle={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.75rem' }}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null
              const d: Candle = payload[0].payload
              return (
                <div style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', fontSize: '0.78rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary)' }}>{d.datetime}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>O</span><span style={{ fontFamily: 'monospace' }}>{d.open.toFixed(2)}</span>
                    <span style={{ color: 'var(--green)' }}>H</span><span style={{ fontFamily: 'monospace' }}>{d.high.toFixed(2)}</span>
                    <span style={{ color: 'var(--red)' }}>L</span><span style={{ fontFamily: 'monospace' }}>{d.low.toFixed(2)}</span>
                    <span style={{ color: 'var(--accent-bright)' }}>C</span><span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{d.close.toFixed(2)}</span>
                  </div>
                </div>
              )
            }}
          />
          <Bar dataKey="close" shape={<CustomCandlestick />} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Market hours helper ────────────────────────────────────────────────────────

/** Returns true if current IST time is Mon–Fri 09:00–16:00 */
function isMarketOpen(): boolean {
  const now = new Date()
  // toLocaleString in IST gives us a date string we can re-parse cleanly
  const istStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
  const ist = new Date(istStr)
  const day = ist.getDay()          // 0=Sun 1=Mon … 5=Fri 6=Sat
  const mins = ist.getHours() * 60 + ist.getMinutes()
  const isWeekday = day >= 1 && day <= 5
  const isDuringSession = mins >= 9 * 60 && mins < 16 * 60   // 09:00–16:00 IST
  return isWeekday && isDuringSession
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function LivePage() {
  const { auth } = useAppStore()
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set())
  const [wsStatus, setWsStatus] = useState<'connecting'|'open'|'closed'|'error'>('closed')
  const [flashMap, setFlashMap] = useState<Record<string, 'up'|'down'>>({})
  const [expandedSymbols, setExpandedSymbols] = useState<Set<string>>(new Set())
  const [loadingCandles, setLoadingCandles] = useState<Set<string>>(new Set())
  const [reconnectCount, setReconnectCount] = useState(0)

  // Candle data stored in a ref (mutated on every tick without causing renders)
  const candleCacheRef = useRef<Record<string, Candle[]>>({})
  // Version counters per symbol — incrementing triggers a chart re-render
  const [candleVersions, setCandleVersions] = useState<Record<string, number>>({})
  // Stale-closure-safe mirror of expandedSymbols for use inside ws.onmessage
  const expandedSymbolsRef = useRef<Set<string>>(new Set())
  // Debounce timers for chart re-renders (max 2 redraws/second per symbol)
  const chartRenderTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const wsRef = useRef<WebSocket | null>(null)
  const prevPrices = useRef<Record<string, number>>({})
  const reconnectAttempt = useRef(0)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep expandedSymbolsRef in sync with state (fixes stale closure in onmessage)
  useEffect(() => {
    expandedSymbolsRef.current = expandedSymbols
  }, [expandedSymbols])

  useEffect(() => {
    if (!auth.logged_in) return
    log.info('User logged in — loading watchlist')
    stocksApi.getWatchlist().then(async r => {
      const items: WatchlistItem[] = r.data
      log.info(`Watchlist loaded: ${items.length} item(s)`)
      setWatchlist(items)
      if (!items.length) return

      // Pre-populate quotes from REST so values show even outside market hours
      log.info(`Fetching initial quotes via REST for ${items.length} symbol(s)...`)
      const byExchange: Record<string, WatchlistItem[]> = {}
      items.forEach(item => {
        if (!byExchange[item.exchange]) byExchange[item.exchange] = []
        byExchange[item.exchange].push(item)
      })
      const initialQuotes: Record<string, Quote> = {}
      await Promise.all(
        Object.entries(byExchange).map(async ([exchange, exchangeItems]) => {
          try {
            const tokens = exchangeItems.map(i => i.token)
            log.debug(`REST quote batch: exchange=${exchange} tokens=${tokens.join(',')}`)
            const res = await liveApi.getMultipleQuotes(tokens, exchange)
            const rows: any[] = Array.isArray(res.data) ? res.data : []
            rows.forEach((q: any) => {
              const key = q.symbol || q.token
              if (!key) return
              initialQuotes[key] = {
                tsym: q.symbol ?? key,
                exchange,
                token: q.token,
                lp: q.ltp,
                pc: q.change_pct,
                v: q.volume,
                h: q.high,
                l: q.low,
                o: q.open,
                c: q.close,
              }
            })
            log.info(`REST quotes received: ${rows.length}/${exchangeItems.length} symbols for ${exchange}`)
          } catch (e) {
            log.error(`REST quote fetch failed for exchange=${exchange}`, e)
          }
        })
      )
      if (Object.keys(initialQuotes).length > 0) {
        log.info(`Initial quotes populated: ${Object.keys(initialQuotes).length} symbol(s)`)
        setQuotes(initialQuotes)
      }
    }).catch((e) => log.error('Watchlist load failed', e))
  }, [auth.logged_in])

  useEffect(() => {
    if (!auth.logged_in || watchlist.length === 0) return
    log.info(`Watchlist ready (${watchlist.length} items) — connecting WebSocket`)
    connectWS()
    return () => {
      log.info('Component unmounting — closing WebSocket')
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close(1000, 'unmount')
    }
  }, [auth.logged_in, watchlist])

  const connectWS = () => {
    if (wsRef.current) wsRef.current.close()
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host  = window.location.host
    const url   = `${proto}//${host}/api/live/ws/multiplex`
    log.info(`WebSocket connecting → ${url}`)
    const ws    = new WebSocket(url)
    wsRef.current = ws
    setWsStatus('connecting')

    ws.onopen = () => {
      log.info(`WebSocket open — subscribing ${watchlist.length} symbol(s)`)
      setWsStatus('open')
      reconnectAttempt.current = 0
      setReconnectCount(0)
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
      watchlist.forEach(item => {
        log.debug(`Subscribe: ${item.exchange}:${item.token}`)
        ws.send(JSON.stringify({ action: 'subscribe', exchange: item.exchange, token: item.token }))
      })
      setSubscribed(new Set(watchlist.map(w => w.tsym)))
    }

    ws.onmessage = (e) => {
      try {
        const tick = JSON.parse(e.data)
        const key = tick.symbol || tick.token
        if (!key) return

        const mapped = {
          tsym: tick.symbol || key,
          token: tick.token,
          lp: tick.ltp ?? tick.lp,
          pc: tick.change_pct ?? tick.pc,
          v: tick.volume ?? tick.v,
          h: tick.high ?? tick.h,
          l: tick.low ?? tick.l,
          o: tick.open ?? tick.o,
          c: tick.close ?? tick.c,
          bp1: tick.bp1,
          sp1: tick.sp1,
        }

        // Flash animation on price change
        if (mapped.lp != null && prevPrices.current[key] != null) {
          const dir = mapped.lp > prevPrices.current[key] ? 'up' : mapped.lp < prevPrices.current[key] ? 'down' : null
          if (dir) {
            setFlashMap(p => ({ ...p, [key]: dir! }))
            setTimeout(() => setFlashMap(p => { const n = { ...p }; delete n[key]; return n }), 800)
          }
        }
        if (mapped.lp != null) prevPrices.current[key] = mapped.lp
        setQuotes(prev => ({ ...prev, [key]: { ...prev[key], ...mapped } }))

        // ── Live candle aggregation ────────────────────────────────────────────
        const tsym = mapped.tsym
        if (
          tsym &&
          expandedSymbolsRef.current.has(tsym) &&
          candleCacheRef.current[tsym] &&
          mapped.lp != null &&
          tick.timestamp
        ) {
          const { candles: updated, changed } = applyTickToCandles(
            candleCacheRef.current[tsym],
            { ltp: mapped.lp, volume: mapped.v ?? 0, timestamp: tick.timestamp }
          )
          if (changed) {
            candleCacheRef.current[tsym] = updated
            // Throttle: at most one chart re-render per 500ms per symbol
            if (chartRenderTimers.current[tsym]) clearTimeout(chartRenderTimers.current[tsym])
            chartRenderTimers.current[tsym] = setTimeout(() => {
              setCandleVersions(prev => ({ ...prev, [tsym]: (prev[tsym] ?? 0) + 1 }))
            }, 500)
          }
        }
      } catch {}
    }

    ws.onerror = (e) => {
      log.error('WebSocket error', e)
      setWsStatus('error')
    }
    ws.onclose = (event) => {
      setWsStatus('closed')
      if (event.code === 1000) {
        log.info('WebSocket closed cleanly (code 1000)')
        return
      }
      const attempt = reconnectAttempt.current
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 200
      log.warn(`WebSocket closed (code=${event.code}) — reconnect #${attempt + 1} in ${(delay / 1000).toFixed(1)}s`)
      reconnectAttempt.current = attempt + 1
      setReconnectCount(attempt + 1)
      reconnectTimer.current = setTimeout(() => {
        if (watchlist.length > 0) connectWS()
      }, delay)
    }
  }

  const fetchChartData = async (item: WatchlistItem) => {
    log.debug(`Fetching intraday candles: ${item.tsym} (${item.exchange}:${item.token})`)
    setLoadingCandles(prev => new Set(prev).add(item.tsym))
    try {
      const r = await liveApi.getIntraday(item.exchange, item.token)
      const candles = transformCandles(r.data.candles || [])
      log.info(`Intraday candles loaded: ${item.tsym} — ${candles.length} candles`)
      candleCacheRef.current[item.tsym] = candles
      setCandleVersions(prev => ({ ...prev, [item.tsym]: (prev[item.tsym] ?? 0) + 1 }))
    } catch (e: any) {
      const status = e?.response?.status
      log.error(`Intraday fetch failed for ${item.tsym}: HTTP ${status ?? 'unknown'}`, e)
      // Mark with special sentinel so chart shows correct error message
      candleCacheRef.current[item.tsym] = status === 401 ? null as any : []
      setCandleVersions(prev => ({ ...prev, [item.tsym]: (prev[item.tsym] ?? 0) + 1 }))
    } finally {
      setLoadingCandles(prev => { const n = new Set(prev); n.delete(item.tsym); return n })
    }
  }

  const toggleChart = async (item: WatchlistItem) => {
    const isOpen = expandedSymbols.has(item.tsym)
    setExpandedSymbols(prev => {
      const next = new Set(prev)
      if (isOpen) { next.delete(item.tsym); return next }
      next.add(item.tsym)
      return next
    })
    // Always fetch fresh data when expanding (not just first time)
    if (!isOpen) fetchChartData(item)
  }

  // Auto-refresh open charts every 60 seconds (always — charts need fresh candle data)
  useEffect(() => {
    if (watchlist.length === 0) return
    const interval = setInterval(() => {
      expandedSymbolsRef.current.forEach(tsym => {
        const item = watchlist.find(w => w.tsym === tsym)
        if (item) fetchChartData(item)
      })
    }, 60000)
    return () => clearInterval(interval)
  }, [watchlist])

  // Market-hours quote refresh — polls REST every 30s Mon–Fri 09:00–16:00 IST
  // (WebSocket ticks are the primary source; this is a fallback/supplement)
  useEffect(() => {
    if (watchlist.length === 0) return
    const interval = setInterval(async () => {
      if (!isMarketOpen()) {
        log.debug('Market closed — skipping quote refresh')
        return
      }
      log.info(`Market hours quote refresh — fetching ${watchlist.length} symbol(s)...`)
      const byExchange: Record<string, WatchlistItem[]> = {}
      watchlist.forEach(item => {
        if (!byExchange[item.exchange]) byExchange[item.exchange] = []
        byExchange[item.exchange].push(item)
      })
      await Promise.all(
        Object.entries(byExchange).map(async ([exchange, exchangeItems]) => {
          try {
            const tokens = exchangeItems.map(i => i.token)
            const res = await liveApi.getMultipleQuotes(tokens, exchange)
            const rows: any[] = Array.isArray(res.data) ? res.data : []
            rows.forEach((q: any) => {
              const key = q.symbol || q.token
              if (!key) return
              setQuotes(prev => ({
                ...prev,
                [key]: {
                  ...prev[key],
                  tsym: q.symbol ?? key, exchange, token: q.token,
                  lp: q.ltp, pc: q.change_pct,
                  v: q.volume, h: q.high, l: q.low, o: q.open, c: q.close,
                },
              }))
            })
            log.debug(`Quote refresh done: ${rows.length}/${exchangeItems.length} symbols for ${exchange}`)
          } catch (e) {
            log.error(`Quote refresh failed for ${exchange}`, e)
          }
        })
      )
    }, 30000)
    return () => clearInterval(interval)
  }, [watchlist])

  const StatusDot = () => {
    const colors: Record<string, string> = { open: 'var(--green)', connecting: 'var(--yellow)', closed: 'var(--text-muted)', error: 'var(--red)' }
    const labels: Record<string, string> = { open: 'Live', connecting: 'Connecting...', closed: 'Disconnected', error: 'Error' }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem' }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: colors[wsStatus], boxShadow: wsStatus === 'open' ? `0 0 6px ${colors[wsStatus]}` : 'none', animation: wsStatus === 'open' ? 'pulse 2s infinite' : 'none' }} />
        <span style={{ color: colors[wsStatus] }}>{labels[wsStatus]}</span>
      </div>
    )
  }

  const fmtPrice = (v: number | undefined) => v != null ? v.toFixed(2) : '—'
  const fmtVol = (v: number | undefined) => {
    if (v == null) return '—'
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
    return v.toString()
  }
  const fmtChange = (q: Quote) => {
    if (q.pc == null) return null
    const sign = q.pc >= 0 ? '+' : ''
    return `${sign}${q.pc.toFixed(2)}%`
  }

  if (!auth.logged_in) {
    return (
      <>
        <div className="topbar"><span className="topbar-title">📡 Live Quotes</span></div>
        <div className="page-body">
          <div className="card" style={{ textAlign: 'center', padding: '60px 32px', color: 'var(--text-secondary)' }}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>🔑</div>
            <h2 style={{ color: 'var(--text-primary)', marginBottom: 8 }}>Login Required</h2>
            <p>Connect to FlatTrade to stream live market data</p>
            <Link href="/login" className="btn btn-primary" style={{ marginTop: 16, display: 'inline-flex' }}>Login to FlatTrade</Link>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="topbar">
        <span className="topbar-title">📡 Live Quotes</span>
        <div className="topbar-actions">
          <StatusDot />
          {wsStatus !== 'open' && reconnectCount > 0 && (
            <span style={{ fontSize: '0.75rem', color: 'var(--yellow)' }}>Retry #{reconnectCount}</span>
          )}
          {wsStatus !== 'open' && reconnectCount === 0 && (
            <button className="btn btn-secondary btn-sm" onClick={connectWS}>↻ Reconnect</button>
          )}
          <Link href="/live/alerts" className="btn btn-secondary btn-sm">🔔 Alerts</Link>
        </div>
      </div>

      <div className="page-body">
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          Stocks in your FlatTrade watchlist stream live prices via WebSocket. Click 📈 on any row to expand today&apos;s intraday chart — updates live with each tick.{' '}
          <Link href="/stocks" style={{ color: 'var(--accent-bright)' }}>Add stocks via Stock Search →</Link>
        </div>

        {watchlist.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: '40px 32px', color: 'var(--text-secondary)' }}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>⭐</div>
            <p>Your watchlist is empty. Add stocks to stream live prices.</p>
            <Link href="/stocks" className="btn btn-primary" style={{ marginTop: 14, display: 'inline-flex' }}>🔍 Stock Search</Link>
          </div>
        )}

        {watchlist.length > 0 && (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrapper" style={{ border: 'none', borderRadius: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th style={{ textAlign: 'right' }}>LTP</th>
                    <th style={{ textAlign: 'right' }}>Change %</th>
                    <th style={{ textAlign: 'right' }}>Open</th>
                    <th style={{ textAlign: 'right' }}>High</th>
                    <th style={{ textAlign: 'right' }}>Low</th>
                    <th style={{ textAlign: 'right' }}>Volume</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {watchlist.map(item => {
                    const q: Quote = quotes[item.tsym] || (item.token ? quotes[item.token] : {}) || {}
                    const flash = flashMap[item.tsym] || (item.token ? flashMap[item.token] : undefined)
                    const chg = fmtChange(q)
                    const isUp = q.pc != null && q.pc >= 0
                    const hasLive = q.lp != null
                    const isExpanded = expandedSymbols.has(item.tsym)
                    const isLoadingChart = loadingCandles.has(item.tsym)

                    return (
                      <>
                        <tr key={item.tsym} style={{
                          background: flash === 'up' ? 'rgba(34,197,94,0.08)' : flash === 'down' ? 'rgba(239,68,68,0.08)' : 'transparent',
                          transition: 'background 0.3s'
                        }}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                                background: subscribed.has(item.tsym) && wsStatus === 'open' ? 'var(--green)' : 'var(--yellow)' }} />
                              <div>
                                <div style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.9375rem' }}>{item.tsym}</div>
                                {item.cname && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{item.cname}</div>}
                              </div>
                              <span className="badge badge-blue" style={{ fontSize: '0.65rem' }}>{item.exchange}</span>
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', fontSize: '1rem',
                            color: flash === 'up' ? 'var(--green)' : flash === 'down' ? 'var(--red)'
                              : !hasLive ? 'var(--text-muted)'
                              : (q.pc ?? 0) > 0 ? 'var(--green)' : (q.pc ?? 0) < 0 ? 'var(--red)' : 'var(--text-primary)' }}>
                            {fmtPrice(q.lp)}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {chg ? (
                              <span style={{ color: isUp ? 'var(--green)' : 'var(--red)', fontWeight: 600, fontFamily: 'monospace' }}>
                                {isUp ? '▲' : '▼'} {chg}
                              </span>
                            ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{fmtPrice(q.o)}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--green)', fontSize: '0.875rem' }}>{fmtPrice(q.h)}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--red)', fontSize: '0.875rem' }}>{fmtPrice(q.l)}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                            {fmtVol(q.v)}
                          </td>
                          <td>
                            <button
                              className={`btn btn-sm ${isExpanded ? 'btn-primary' : 'btn-ghost'}`}
                              style={{ padding: '2px 8px' }}
                              onClick={() => toggleChart(item)}
                              title={isExpanded ? 'Hide chart' : 'Show intraday chart'}
                            >
                              {isLoadingChart ? <div className="spinner" style={{ width: 12, height: 12 }} /> : '📈'}
                            </button>
                          </td>
                        </tr>

                        {/* Inline chart expansion row */}
                        {isExpanded && (
                          <tr key={`${item.tsym}-chart`}>
                            <td colSpan={8} style={{ padding: 0, background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)' }}>
                              {isLoadingChart
                                ? <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>Loading chart...</div>
                                : <IntradayChart
                                    candles={candleCacheRef.current[item.tsym] ?? []}
                                    symbol={item.tsym}
                                    version={candleVersions[item.tsym] ?? 0}
                                  />
                              }
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Market summary */}
        {Object.keys(quotes).length > 0 && (
          <div className="stat-grid" style={{ marginTop: 20 }}>
            <div className="stat-card green">
              <div className="stat-label">Gainers</div>
              <div className="stat-value">{Object.values(quotes).filter(q => (q.pc ?? 0) > 0).length}</div>
              <div className="stat-sub">of {watchlist.length} stocks</div>
            </div>
            <div className="stat-card red" style={{ '--accent': 'var(--red)' } as any}>
              <div className="stat-label">Losers</div>
              <div className="stat-value">{Object.values(quotes).filter(q => (q.pc ?? 0) < 0).length}</div>
              <div className="stat-sub">of {watchlist.length} stocks</div>
            </div>
            <div className="stat-card yellow">
              <div className="stat-label">Best Gainer</div>
              {(() => {
                const best = Object.values(quotes).filter(q => (q.pc ?? 0) > 0).sort((a,b)=>(b.pc??0)-(a.pc??0))[0]
                return best ? (
                  <>
                    <div className="stat-value" style={{ fontSize: '1.25rem' }}>{best.tsym}</div>
                    <div className="stat-sub" style={{ color: 'var(--green)' }}>+{best.pc!.toFixed(2)}%</div>
                  </>
                ) : (
                  <>
                    <div className="stat-value" style={{ fontSize: '1.25rem' }}>—</div>
                    <div className="stat-sub">No gainers yet</div>
                  </>
                )
              })()}
            </div>
            <div className="stat-card red">
              <div className="stat-label">Worst Loser</div>
              {(() => {
                const worst = Object.values(quotes).filter(q => (q.pc ?? 0) < 0).sort((a,b)=>(a.pc??0)-(b.pc??0))[0]
                return worst ? (
                  <>
                    <div className="stat-value" style={{ fontSize: '1.25rem' }}>{worst.tsym}</div>
                    <div className="stat-sub" style={{ color: 'var(--red)' }}>{worst.pc!.toFixed(2)}%</div>
                  </>
                ) : (
                  <>
                    <div className="stat-value" style={{ fontSize: '1.25rem' }}>—</div>
                    <div className="stat-sub">No losers yet</div>
                  </>
                )
              })()}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
