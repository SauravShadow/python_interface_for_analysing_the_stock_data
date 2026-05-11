'use client'
// app/live/page.tsx — Live market quotes with WebSocket streaming
import { useState, useEffect, useRef } from 'react'
import { stocksApi, liveApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import Link from 'next/link'
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from 'recharts'

interface Quote {
  tsym: string
  exchange: string
  token: string
  lp?: number      // last price
  pc?: number      // percent change
  v?: number       // volume
  h?: number       // high
  l?: number       // low
  o?: number       // open
  c?: number       // close (prev)
  bp1?: number     // best bid
  sp1?: number     // best ask
  updated_at?: string
}

interface WatchlistItem {
  tsym: string; token: string; exchange: string; cname?: string
}

export default function LivePage() {
  const { auth } = useAppStore()
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set())
  const [wsStatus, setWsStatus] = useState<'connecting'|'open'|'closed'|'error'>('closed')
  const [flashMap, setFlashMap] = useState<Record<string, 'up'|'down'>>({})
  const [selectedCandle, setSelectedCandle] = useState<string | null>(null)
  const [intradayData, setIntradayData] = useState<any[]>([])
  const [loadingCandles, setLoadingCandles] = useState(false)
  const [reconnectCount, setReconnectCount] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const prevPrices = useRef<Record<string, number>>({})
  const reconnectAttempt = useRef(0)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load watchlist
  useEffect(() => {
    if (!auth.logged_in) return
    stocksApi.getWatchlist().then(r => setWatchlist(r.data)).catch(() => {})
  }, [auth.logged_in])

  // Connect WebSocket and subscribe to all watchlist items
  useEffect(() => {
    if (!auth.logged_in || watchlist.length === 0) return
    connectWS()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close(1000, 'unmount')  // code 1000 = intentional, suppresses auto-reconnect
    }
  }, [auth.logged_in, watchlist])

  const connectWS = () => {
    if (wsRef.current) wsRef.current.close()
    // Dynamic WS URL — works from any browser via Nginx or direct access
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host  = window.location.host  // e.g. "192.168.1.10" or "yourdomain.com"
    const ws    = new WebSocket(`${proto}//${host}/api/live/ws/multiplex`)
    wsRef.current = ws
    setWsStatus('connecting')

    ws.onopen = () => {
      setWsStatus('open')
      reconnectAttempt.current = 0
      setReconnectCount(0)
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
      watchlist.forEach(item => {
        ws.send(JSON.stringify({ action: 'subscribe', exchange: item.exchange, token: item.token }))
      })
      setSubscribed(new Set(watchlist.map(w => w.tsym)))
    }

    ws.onmessage = (e) => {
      try {
        const tick = JSON.parse(e.data)
        // Backend emits: { type:'tick', token, symbol, ltp, open, high, low, close, volume, change_pct }
        // Map to Quote shape used in table: { tsym, lp, pc, v, h, l, o, c, bp1, sp1 }
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

        // Flash animation
        if (mapped.lp != null && prevPrices.current[key] != null) {
          const dir = mapped.lp > prevPrices.current[key] ? 'up' : mapped.lp < prevPrices.current[key] ? 'down' : null
          if (dir) {
            setFlashMap(p => ({ ...p, [key]: dir! }))
            setTimeout(() => setFlashMap(p => { const n = { ...p }; delete n[key]; return n }), 800)
          }
        }
        if (mapped.lp != null) prevPrices.current[key] = mapped.lp

        setQuotes(prev => ({ ...prev, [key]: { ...prev[key], ...mapped } }))
      } catch {}
    }

    ws.onerror = () => setWsStatus('error')
    ws.onclose = (event) => {
      setWsStatus('closed')
      if (event.code === 1000) return  // intentional close — don't retry
      const attempt = reconnectAttempt.current
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 200
      reconnectAttempt.current = attempt + 1
      setReconnectCount(attempt + 1)
      reconnectTimer.current = setTimeout(() => {
        if (watchlist.length > 0) connectWS()
      }, delay)
    }
  }

  const transformCandles = (candles: any[]) =>
    candles.map(c => ({
      ...c,
      datetime: new Date(typeof c.datetime === 'number' ? c.datetime * 1000 : c.datetime)
        .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      isUp: c.close >= c.open,
    }))

  const loadIntraday = async (item: WatchlistItem) => {
    setSelectedCandle(item.tsym)
    setLoadingCandles(true)
    setIntradayData([])
    try {
      const r = await liveApi.getIntraday(item.exchange, item.token)
      setIntradayData(transformCandles(r.data.candles || []))
    } catch {
      setIntradayData([])
    } finally {
      setLoadingCandles(false)
    }
  }


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
        {watchlist.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: '40px 32px', color: 'var(--text-secondary)', marginBottom: 20 }}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>⭐</div>
            <p>Add stocks to your watchlist to see live quotes</p>
            <Link href="/stocks" className="btn btn-primary" style={{ marginTop: 14, display: 'inline-flex' }}>Go to Stock Search</Link>
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
                    <th style={{ textAlign: 'right' }}>Prev Close</th>
                    <th style={{ textAlign: 'right' }}>Volume</th>
                    <th style={{ textAlign: 'right' }}>Bid</th>
                    <th style={{ textAlign: 'right' }}>Ask</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {watchlist.map(item => {
                    const q: Quote = quotes[item.tsym] || quotes[item.token] || {}
                    const flash = flashMap[item.tsym] || flashMap[item.token]
                    const chg = fmtChange(q)
                    const isUp = q.pc != null && q.pc >= 0

                    return (
                      <tr key={item.tsym} style={{
                        background: flash === 'up' ? 'rgba(34,197,94,0.08)' : flash === 'down' ? 'rgba(239,68,68,0.08)' : 'transparent',
                        transition: 'background 0.3s'
                      }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: subscribed.has(item.tsym) && wsStatus === 'open' ? 'var(--green)' : 'var(--text-muted)', flexShrink: 0 }} />
                            <div>
                              <div style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.9375rem' }}>{item.tsym}</div>
                              {item.cname && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{item.cname}</div>}
                            </div>
                            <span className="badge badge-blue" style={{ fontSize: '0.65rem' }}>{item.exchange}</span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', fontSize: '1rem', color: flash === 'up' ? 'var(--green)' : flash === 'down' ? 'var(--red)' : 'var(--text-primary)' }}>
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
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-muted)', fontSize: '0.875rem' }}>{fmtPrice(q.c)}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                          {q.v != null ? q.v.toLocaleString() : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--green)', fontSize: '0.875rem' }}>{fmtPrice(q.bp1)}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--red)', fontSize: '0.875rem' }}>{fmtPrice(q.sp1)}</td>
                        <td>
                          <button
                            className={`btn btn-sm ${selectedCandle === item.tsym ? 'btn-primary' : 'btn-ghost'}`}
                            style={{ padding: '2px 8px' }}
                            onClick={() => selectedCandle === item.tsym ? setSelectedCandle(null) : loadIntraday(item)}
                            title="Intraday chart"
                          >📈</button>
                        </td>
                      </tr>
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
              <div className="stat-value" style={{ fontSize: '1.25rem' }}>
                {(() => { const best = Object.values(quotes).sort((a,b)=>(b.pc??-99)-(a.pc??-99))[0]; return best?.tsym || '—' })()}
              </div>
              <div className="stat-sub" style={{ color: 'var(--green)' }}>
                {(() => { const best = Object.values(quotes).sort((a,b)=>(b.pc??-99)-(a.pc??-99))[0]; return best?.pc != null ? `+${best.pc.toFixed(2)}%` : '' })()}
              </div>
            </div>
            <div className="stat-card blue">
              <div className="stat-label">WebSocket</div>
              <div className="stat-value" style={{ fontSize: '1rem', paddingTop: 8 }}>
                <span style={{ color: wsStatus === 'open' ? 'var(--green)' : 'var(--red)' }}>{wsStatus}</span>
              </div>
              <div className="stat-sub">{subscribed.size} symbols subscribed</div>
            </div>
          </div>
        )}

        {/* Intraday candlestick chart */}
        {selectedCandle && (() => {
          const minP = intradayData.length ? Math.min(...intradayData.map((c: any) => c.low)) * 0.999 : 0
          const maxP = intradayData.length ? Math.max(...intradayData.map((c: any) => c.high)) * 1.001 : 1

          const CandleShape = (props: any) => {
            const { x, width, payload, background } = props
            if (!payload || !background || background.height <= 0) return null
            const { open, high, low, close, isUp } = payload
            const range = maxP - minP || 1
            const toY = (price: number) =>
              background.y + background.height - ((price - minP) / range) * background.height
            const color = isUp ? '#22c55e' : '#ef4444'
            const midX = x + width / 2
            const bodyW = Math.max(width * 0.65, 2)
            return (
              <g>
                <line x1={midX} y1={toY(high)} x2={midX} y2={toY(low)} stroke={color} strokeWidth={1} />
                <rect
                  x={midX - bodyW / 2}
                  y={Math.min(toY(open), toY(close))}
                  width={bodyW}
                  height={Math.max(Math.abs(toY(open) - toY(close)), 1)}
                  fill={color}
                />
              </g>
            )
          }

          return (
            <div className="card fade-in" style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3>📈 {selectedCandle} — Intraday</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  {!loadingCandles && intradayData.length > 0 && (
                    <button className="btn btn-secondary btn-sm"
                      onClick={() => { const item = watchlist.find(w => w.tsym === selectedCandle); if (item) loadIntraday(item) }}>
                      ↻ Refresh
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => setSelectedCandle(null)}>✕</button>
                </div>
              </div>
              {loadingCandles && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-secondary)', padding: '20px 0' }}>
                  <div className="spinner" /> Loading candles...
                </div>
              )}
              {!loadingCandles && intradayData.length === 0 && (
                <p style={{ color: 'var(--text-muted)', padding: '20px 0' }}>No intraday data available for this symbol</p>
              )}
              {!loadingCandles && intradayData.length > 0 && (
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={intradayData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="datetime" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis domain={[minP, maxP]} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} width={65}
                      tickFormatter={(v: number) => v.toFixed(2)} />
                    <Tooltip
                      contentStyle={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6 }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.[0]) return null
                        const d = payload[0].payload
                        return (
                          <div style={{ padding: '8px 12px', background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.8rem' }}>
                            <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-secondary)' }}>{d.datetime}</div>
                            <div>O: {d.open?.toFixed(2)}  H: {d.high?.toFixed(2)}</div>
                            <div>L: {d.low?.toFixed(2)}  C: {d.close?.toFixed(2)}</div>
                            <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>Vol: {d.volume?.toLocaleString()}</div>
                          </div>
                        )
                      }}
                    />
                    <Bar dataKey="high" shape={<CandleShape />} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          )
        })()}
      </div>
    </>
  )
}
