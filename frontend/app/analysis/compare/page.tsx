'use client'
// app/analysis/compare/page.tsx — Multi-stock comparison
import { useState, useEffect } from 'react'
import { dataApi, analysisApi } from '@/lib/api'

const COLORS = ['#3b82f6','#22c55e','#f59e0b','#a855f7','#ef4444','#06b6d4','#f97316','#84cc16']

export default function ComparePage() {
  const [symbols, setSymbols] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [excludeDays, setExcludeDays] = useState<string[]>([])
  const [interval, setInterval] = useState(1)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<Record<string, any> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'normalized'|'returns'|'correlation'|'metrics'>('normalized')

  useEffect(() => {
    dataApi.getSummary()
      .then(r => setSymbols(r.data.filter((s: any) => !s.symbol.includes('_')).map((s: any) => s.symbol)))
      .catch(() => {})
  }, [])

  const toggleSymbol = (s: string) =>
    setSelected(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])

  const handleRun = async () => {
    if (selected.length < 2) return
    setRunning(true); setError(null); setResults(null)
    try {
      const allResults: Record<string, any> = {}
      await Promise.all(selected.map(async sym => {
        const res = await analysisApi.run({
          symbol: sym,
          analysis_types: ['returns'],
          interval_minutes: interval,
          exclude_weekdays: excludeDays,
          date_from: dateFrom || null,
          date_to: dateTo || null,
        })
        allResults[sym] = res.data
      }))
      setResults(allResults)
      setActiveView('normalized')
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setRunning(false)
    }
  }

  // Build normalized price series for SVG chart
  const buildNormalized = () => {
    if (!results) return {}
    const series: Record<string, {x: number, y: number}[]> = {}
    for (const [sym, data] of Object.entries(results)) {
      const ret = data.returns?.series
      if (!ret || !Array.isArray(ret)) continue
      let cumulative = 100
      series[sym] = ret.map((r: any, i: number) => {
        cumulative *= (1 + (r.daily_return || 0) / 100)
        return { x: i, y: cumulative }
      })
    }
    return series
  }

  // Correlation matrix
  const buildCorrelation = () => {
    if (!results) return null
    const syms = Object.keys(results)
    const returnsMap: Record<string, number[]> = {}
    for (const [sym, data] of Object.entries(results)) {
      returnsMap[sym] = (data.returns?.series || []).map((r: any) => r.daily_return || 0)
    }
    const corr: number[][] = syms.map((s1, i) =>
      syms.map((s2, j) => {
        if (i === j) return 1
        const a = returnsMap[s1], b = returnsMap[s2]
        const n = Math.min(a.length, b.length)
        if (n < 2) return 0
        const meanA = a.slice(0,n).reduce((s,v)=>s+v,0)/n
        const meanB = b.slice(0,n).reduce((s,v)=>s+v,0)/n
        const cov = a.slice(0,n).reduce((s,v,k)=>s+(v-meanA)*(b[k]-meanB),0)/n
        const stdA = Math.sqrt(a.slice(0,n).reduce((s,v)=>s+(v-meanA)**2,0)/n)
        const stdB = Math.sqrt(b.slice(0,n).reduce((s,v)=>s+(v-meanB)**2,0)/n)
        return stdA && stdB ? cov/(stdA*stdB) : 0
      })
    )
    return { syms, corr }
  }

  const normalized = buildNormalized()
  const correlation = buildCorrelation()

  return (
    <>
      <div className="topbar">
        <span className="topbar-title">⚖️ Compare Stocks</span>
      </div>

      <div className="page-body">
        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24, alignItems: 'start' }}>

          {/* Config */}
          <div style={{ position: 'sticky', top: 58 }}>
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginBottom: 14 }}>Select Stocks</h3>
              {symbols.length === 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No data — download stocks first</p>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                {symbols.map((s, i) => (
                  <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: selected.includes(s) ? 'var(--accent-glow)' : 'transparent', border: `1px solid ${selected.includes(s) ? 'rgba(59,130,246,0.3)' : 'transparent'}`, transition: 'all 0.15s' }}>
                    <input type="checkbox" checked={selected.includes(s)} onChange={() => toggleSymbol(s)} />
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: COLORS[symbols.indexOf(s) % COLORS.length], flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: '0.875rem', fontFamily: 'monospace' }}>{s}</span>
                  </label>
                ))}
              </div>
              {selected.length > 0 && (
                <div style={{ marginTop: 10, fontSize: '0.8rem', color: 'var(--text-muted)' }}>{selected.length} selected</div>
              )}
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginBottom: 12 }}>⚙️ Options</h3>
              <div className="form-group">
                <label className="form-label">Interval</label>
                <select className="input" value={interval} onChange={e => setInterval(Number(e.target.value))}>
                  {[[1,'1min'],[5,'5min'],[15,'15min'],[60,'1hr']].map(([v,l]) =>
                    <option key={v} value={v}>{l}</option>
                  )}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">From</label>
                  <input className="input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">To</label>
                  <input className="input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
                </div>
              </div>
            </div>

            <button className="btn btn-primary w-full btn-lg" onClick={handleRun}
              disabled={running || selected.length < 2}>
              {running ? <><div className="spinner" style={{ width: 18, height: 18 }} /> Running...</> : `▶ Compare ${selected.length} Stocks`}
            </button>
            {selected.length < 2 && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: 8 }}>Select at least 2 stocks</p>}
          </div>

          {/* Results */}
          <div>
            {error && (
              <div style={{ background: 'var(--red-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius-md)', padding: 14, color: 'var(--red)', marginBottom: 16 }}>
                ❌ {error}
              </div>
            )}

            {!results && !running && (
              <div className="card" style={{ textAlign: 'center', padding: '60px 32px', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '3rem', marginBottom: 16 }}>⚖️</div>
                <h2 style={{ color: 'var(--text-primary)', marginBottom: 8 }}>Select & Compare</h2>
                <p>Pick 2 or more stocks from the panel and run comparison</p>
              </div>
            )}

            {running && (
              <div className="card" style={{ textAlign: 'center', padding: '60px 32px' }}>
                <div className="spinner" style={{ width: 40, height: 40, margin: '0 auto 16px', borderWidth: 3 }} />
                <p style={{ color: 'var(--text-secondary)' }}>Running comparison for {selected.join(', ')}...</p>
              </div>
            )}

            {results && (
              <div className="fade-in">
                {/* View tabs */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
                  {[['normalized','📈 Normalized'],['returns','📊 Returns'],['correlation','🔗 Correlation'],['metrics','📋 Metrics']].map(([v,l]) => (
                    <button key={v} className={`btn btn-sm ${activeView === v ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveView(v as any)}>{l}</button>
                  ))}
                </div>

                {/* Legend */}
                <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                  {selected.map((s, i) => (
                    <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.875rem' }}>
                      <div style={{ width: 14, height: 3, borderRadius: 2, background: COLORS[i % COLORS.length] }} />
                      <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>{s}</span>
                    </div>
                  ))}
                </div>

                {/* Normalized chart */}
                {activeView === 'normalized' && (() => {
                  const allY = Object.values(normalized).flatMap(s => s.map(p => p.y))
                  const maxX = Math.max(...Object.values(normalized).map(s => s.length))
                  const minY = Math.min(...allY), maxY = Math.max(...allY)
                  const W = 800, H = 300, PAD = 50
                  const cW = W - PAD * 2, cH = H - PAD * 2
                  const xS = (i: number) => PAD + (i / (maxX - 1)) * cW
                  const yS = (v: number) => PAD + (1 - (v - minY) / (maxY - minY)) * cH

                  return (
                    <div className="card">
                      <h3 style={{ marginBottom: 16 }}>📈 Normalized Performance (base 100)</h3>
                      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H * 0.65 }}>
                        {[0,25,50,75,100].map(pct => {
                          const y = PAD + (pct / 100) * cH
                          return <line key={pct} x1={PAD} y1={y} x2={PAD + cW} y2={y} stroke="var(--border)" strokeWidth="1" />
                        })}
                        <line x1={PAD} y1={yS(100)} x2={PAD + cW} y2={yS(100)} stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" strokeDasharray="6,4" />
                        {Object.entries(normalized).map(([sym, pts], i) => {
                          const d = pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${xS(p.x)},${yS(p.y)}`).join(' ')
                          return <path key={sym} d={d} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="2" strokeLinejoin="round" />
                        })}
                        {/* y-axis labels */}
                        {[minY, 100, maxY].map((v, i) => (
                          <text key={i} x={PAD - 6} y={yS(v)} textAnchor="end" dominantBaseline="middle" fill="var(--text-muted)" fontSize="11">
                            {v.toFixed(0)}
                          </text>
                        ))}
                      </svg>
                    </div>
                  )
                })()}

                {/* Returns comparison */}
                {activeView === 'returns' && (
                  <div style={{ display: 'grid', gap: 16 }}>
                    {selected.map((sym, i) => {
                      const ret = results[sym]?.returns || []
                      const vals = ret.map((r: any) => r.daily_return || 0)
                      const mean = vals.reduce((a: number, b: number) => a + b, 0) / vals.length
                      const std = Math.sqrt(vals.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / vals.length)
                      const positive = vals.filter((v: number) => v > 0).length
                      return (
                        <div key={sym} className="card">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                            <div style={{ width: 12, height: 12, borderRadius: '50%', background: COLORS[i % COLORS.length] }} />
                            <h3>{sym}</h3>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                            {[
                              ['Mean Return', `${mean.toFixed(3)}%`],
                              ['Std Dev', `${std.toFixed(3)}%`],
                              ['Win Rate', `${vals.length ? ((positive / vals.length) * 100).toFixed(1) : '—'}%`],
                              ['Samples', vals.length.toLocaleString()],
                            ].map(([l, v]) => (
                              <div key={l} style={{ background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)', padding: '10px 14px' }}>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>{l}</div>
                                <div style={{ fontWeight: 700, fontSize: '1.1rem', fontFamily: 'monospace', color: COLORS[i % COLORS.length] }}>{v}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Correlation matrix */}
                {activeView === 'correlation' && correlation && (
                  <div className="card">
                    <h3 style={{ marginBottom: 16 }}>🔗 Return Correlation Matrix</h3>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', minWidth: 400 }}>
                        <thead>
                          <tr>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: '0.75rem' }}></th>
                            {correlation.syms.map(s => <th key={s} style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: '0.875rem', fontFamily: 'monospace' }}>{s}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {correlation.corr.map((row, i) => (
                            <tr key={i}>
                              <td style={{ padding: '8px 12px', fontWeight: 700, fontFamily: 'monospace', color: COLORS[i % COLORS.length], fontSize: '0.875rem' }}>{correlation.syms[i]}</td>
                              {row.map((v, j) => {
                                const abs = Math.abs(v)
                                const bg = i === j ? 'var(--bg-overlay)' : v > 0.7 ? `rgba(34,197,94,${abs * 0.4})` : v < -0.3 ? `rgba(239,68,68,${abs * 0.4})` : 'transparent'
                                return (
                                  <td key={j} style={{ padding: '8px 12px', textAlign: 'center', fontFamily: 'monospace', fontSize: '0.9rem', background: bg, borderRadius: 4, fontWeight: i === j ? 700 : 400, color: i === j ? 'var(--text-muted)' : abs > 0.6 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                                    {v.toFixed(3)}
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ marginTop: 12, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      🟢 High positive correlation (&gt;0.7) · 🔴 Negative correlation (&lt;-0.3)
                    </div>
                  </div>
                )}

                {/* Metrics table */}
                {activeView === 'metrics' && (
                  <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
                      <h3>📋 Returns Summary</h3>
                    </div>
                    <div className="table-wrapper" style={{ border: 'none', borderRadius: 0 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Symbol</th>
                            <th>Mean Return</th>
                            <th>Std Dev</th>
                            <th>Min</th>
                            <th>Max</th>
                            <th>Win Rate</th>
                            <th>Records</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selected.map((sym, i) => {
                            const vals = (results[sym]?.returns || []).map((r: any) => r.daily_return || 0)
                            if (!vals.length) return <tr key={sym}><td colSpan={7}>{sym}: no data</td></tr>
                            const mean = vals.reduce((a: number,b: number)=>a+b,0)/vals.length
                            const std = Math.sqrt(vals.reduce((a: number,b: number)=>a+(b-mean)**2,0)/vals.length)
                            const win = ((vals.filter((v: number)=>v>0).length/vals.length)*100)
                            return (
                              <tr key={sym}>
                                <td><div style={{ display:'flex', alignItems:'center', gap:8 }}>
                                  <div style={{ width:10, height:10, borderRadius:'50%', background:COLORS[i%COLORS.length] }} />
                                  <span style={{ fontWeight:700, fontFamily:'monospace' }}>{sym}</span>
                                </div></td>
                                <td style={{ color: mean >= 0 ? 'var(--green)' : 'var(--red)', fontFamily:'monospace' }}>{mean.toFixed(4)}%</td>
                                <td style={{ fontFamily:'monospace' }}>{std.toFixed(4)}%</td>
                                <td style={{ color:'var(--red)', fontFamily:'monospace' }}>{Math.min(...vals).toFixed(3)}%</td>
                                <td style={{ color:'var(--green)', fontFamily:'monospace' }}>{Math.max(...vals).toFixed(3)}%</td>
                                <td><span className={`badge ${win>=50?'badge-green':'badge-red'}`}>{win.toFixed(1)}%</span></td>
                                <td style={{ color:'var(--text-muted)' }}>{vals.length.toLocaleString()}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
