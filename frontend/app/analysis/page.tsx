'use client'
import { useState, useEffect, useRef } from 'react'
import { PanelLeftClose, PanelLeftOpen, ChevronDown } from 'lucide-react'
import { dataApi, analysisApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  ComposedChart, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, Cell, Brush,
} from 'recharts'
import html2canvas from 'html2canvas'

const ANALYSIS_TYPES = [
  { id: 'price',       label: 'Price',       icon: '💹', desc: 'OHLCV price chart with volume' },
  { id: 'returns',     label: 'Returns',     icon: '📈', desc: 'Daily/period return distribution' },
  { id: 'volatility',  label: 'Volatility',  icon: '〰️', desc: 'Rolling std deviation & ATR' },
  { id: 'technicals',  label: 'Technical',   icon: '📊', desc: 'RSI, MACD, Bollinger Bands' },
  { id: 'volume',      label: 'Volume',      icon: '📦', desc: 'Volume profile & OBV' },
  { id: 'patterns',    label: 'Patterns',    icon: '🕯️', desc: 'Candlestick pattern detection' },
  { id: 'drawdown',    label: 'Drawdown',    icon: '📉', desc: 'Max drawdown & recovery' },
  { id: 'seasonality', label: 'Seasonality', icon: '📅', desc: 'Best months & weekdays to trade' },
  { id: 'momentum',    label: 'Momentum',    icon: '🚀', desc: 'Rate of change & momentum score' },
  { id: 'riskreturn',  label: 'Risk/Return', icon: '⚖️',  desc: 'Sharpe, Sortino, VaR, win rate' },
]

const DATE_PRESETS = [
  { label: '1W',  days: 7 },
  { label: '2W',  days: 14 },
  { label: '1M',  days: 30 },
  { label: '3M',  days: 90 },
  { label: '6M',  days: 180 },
  { label: '1Y',  days: 365 },
  { label: '5Y',  days: 1825 },
]

const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday']

export default function AnalysisPage() {

  const { symbols: cachedSymbols, setSymbols: cacheSymbols } = useAppStore()
  const [symbols, setSymbols] = useState<string[]>([])
  const [summaries, setSummaries] = useState<any[]>([])   // full summary for interval cache detection
  const [loadingSymbols, setLoadingSymbols] = useState(true)
  const [symbol, setSymbol] = useState('')
  const [selectedTypes, setSelectedTypes] = useState(['technicals'])
  const [excludeDays, setExcludeDays] = useState<string[]>([])
  const [excludeMonthStart, setExcludeMonthStart] = useState(false)
  const [excludeMonthEnd, setExcludeMonthEnd] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [activePreset, setActivePreset] = useState<number | null>(null)
  const [interval, setInterval] = useState(1)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedList, setSavedList] = useState<any[]>([])
  const [activeTab, setActiveTab] = useState(0)
  const [panelHidden, setPanelHidden] = useState(false)
  const [configOpen, setConfigOpen] = useState(true)
  const [typesOpen, setTypesOpen] = useState(true)

  useEffect(() => {
    if (localStorage.getItem('analysis-panel-hidden') === 'true') setPanelHidden(true)
    if (localStorage.getItem('analysis-config-open') === 'false') setConfigOpen(false)
    if (localStorage.getItem('analysis-types-open') === 'false') setTypesOpen(false)
  }, [])

  useEffect(() => {
    const paramSymbol = new URLSearchParams(window.location.search).get('symbol')
    // Pre-fill from cache immediately so the UI isn't blank while loading
    if (cachedSymbols.length) {
      setSymbols(cachedSymbols)
      if (paramSymbol && cachedSymbols.includes(paramSymbol)) setSymbol(paramSymbol)
      else setSymbol(cachedSymbols[0])
    }
    // Always fetch fresh — cache can be stale if data was deleted
    dataApi.getSummary().then(r => {
      setSummaries(r.data)
      const syms = r.data.filter((s: any) => !s.symbol.includes('_')).map((s: any) => s.symbol)
      setSymbols(syms)
      cacheSymbols(syms)
      setSymbol(prev => {
        if (prev && syms.includes(prev)) return prev
        if (paramSymbol && syms.includes(paramSymbol)) return paramSymbol
        return syms[0] || ''
      })
    }).catch(() => {}).finally(() => setLoadingSymbols(false))
    analysisApi.listSaved().then(r => setSavedList(r.data)).catch(() => {})
  }, [])

  const toggleType = (id: string) => setSelectedTypes(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
  )
  const toggleDay = (d: string) => setExcludeDays(prev =>
    prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]
  )

  const applyPreset = (days: number) => {
    const to = new Date()
    const from = new Date()
    from.setDate(from.getDate() - days)
    setDateTo(to.toISOString().split('T')[0])
    setDateFrom(from.toISOString().split('T')[0])
    setActivePreset(days)
  }

  const handleRun = async () => {
    if (!symbol || !selectedTypes.length) return
    setRunning(true); setError(null); setResult(null)
    try {
      const res = await analysisApi.run({
        symbol, analysis_types: selectedTypes,
        interval_minutes: interval,
        exclude_weekdays: excludeDays,
        exclude_month_start: excludeMonthStart,
        exclude_month_end: excludeMonthEnd,
        date_from: dateFrom || null,
        date_to: dateTo || null,
      })
      setResult(res.data)
      setActiveTab(0)
      // If we auto-resampled, refresh summaries so the banner clears
      if (interval > 1) {
        dataApi.getSummary().then(r => setSummaries(r.data)).catch(() => {})
      }
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setRunning(false)
    }
  }

  // Check if the selected interval is already cached for the selected symbol
  const intervalLabel = `${interval}min`
  const symbolSummary = summaries.find(s => s.symbol === symbol)
  const hasCachedInterval = interval === 1 || (
    symbolSummary?.resampled_versions?.some((v: any) => v.interval === intervalLabel)
  )
  const willResample = interval > 1 && !hasCachedInterval

  const handleSave = async () => {
    if (!result) return
    setSaving(true)
    try {
      await analysisApi.save({ symbol, result, filters: { excludeDays, excludeMonthStart, excludeMonthEnd, dateFrom, dateTo, interval } })
      const fresh = await analysisApi.listSaved()
      setSavedList(fresh.data)
      alert('✅ Analysis saved!')
    } catch { alert('Save failed') } finally { setSaving(false) }
  }

  const METADATA_KEYS = ['symbol', 'filtered_records', 'date_from', 'date_to', 'avg_close', 'mode', 'symbols']
  const resultKeys = result ? Object.keys(result).filter(k => !METADATA_KEYS.includes(k)) : []

  return (
    <>
      <div className="topbar">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => { const next = !panelHidden; setPanelHidden(next); localStorage.setItem('analysis-panel-hidden', String(next)) }}
          title={panelHidden ? 'Show configuration panel' : 'Hide configuration panel'}
          style={{ padding: '6px 8px', flexShrink: 0 }}
        >
          {panelHidden ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        <span className="topbar-title">📊 Single Stock Analysis</span>
        <div className="topbar-actions">
          {result && <button className="btn btn-secondary btn-sm" onClick={handleSave} disabled={saving}>💾 Save</button>}
        </div>
      </div>

      <div className="page-body">
        <div className="analysis-grid" style={{ display: 'grid', gridTemplateColumns: panelHidden ? '1fr' : '320px 1fr', gap: 24, alignItems: 'start' }}>

          {/* Filter panel */}
          {!panelHidden && <div className="config-panel-sticky">
            <div className="card" style={{ marginBottom: 16 }}>
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: configOpen ? 14 : 0, userSelect: 'none' }}
                onClick={() => { const next = !configOpen; setConfigOpen(next); localStorage.setItem('analysis-config-open', String(next)) }}
              >
                <h3>⚙️ Configuration</h3>
                <ChevronDown size={16} style={{ color: 'var(--text-muted)', transition: 'transform 0.2s ease', transform: configOpen ? 'rotate(0deg)' : 'rotate(-90deg)', flexShrink: 0 }} />
              </div>

              {configOpen && <>
                <div className="form-group">
                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    Symbol
                    {loadingSymbols && <div className="spinner" style={{ width: 12, height: 12 }} />}
                  </label>
                  {loadingSymbols ? (
                    <div className="input" style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
                      <div className="spinner" style={{ width: 13, height: 13, flexShrink: 0 }} />
                      Checking available data…
                    </div>
                  ) : symbols.length === 0 ? (
                    <div className="input" style={{ color: 'var(--yellow)', display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
                      ⚠ No data downloaded yet
                    </div>
                  ) : (
                    <select className="input" value={symbol} onChange={e => setSymbol(e.target.value)}>
                      {symbols.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label">Interval</label>
                  <select className="input" value={interval} onChange={e => setInterval(Number(e.target.value))}>
                    {[[1,'1min'],[2,'2min'],[3,'3min'],[5,'5min'],[10,'10min'],[15,'15min'],[30,'30min'],[60,'1hr']].map(([v,l]) =>
                      <option key={v} value={v}>{l}</option>
                    )}
                  </select>
                  {interval > 1 && (
                    <div style={{
                      marginTop: 7, padding: '7px 10px', borderRadius: 'var(--radius-sm)', fontSize: '0.775rem', lineHeight: 1.5,
                      background: willResample ? 'rgba(234,179,8,0.08)' : 'rgba(34,197,94,0.08)',
                      border: `1px solid ${willResample ? 'rgba(234,179,8,0.25)' : 'rgba(34,197,94,0.25)'}`,
                      color: willResample ? 'var(--yellow)' : 'var(--green)',
                    }}>
                      {willResample
                        ? `⏳ No cached ${intervalLabel} data — will auto-resample from 1min on first run (a few seconds, then cached).`
                        : `✓ Cached ${intervalLabel} data available — will run instantly.`}
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label">Date range</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
                    {DATE_PRESETS.map(p => (
                      <button
                        key={p.days}
                        className={`btn btn-sm ${activePreset === p.days ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '3px 10px', fontSize: '0.775rem' }}
                        onClick={() => applyPreset(p.days)}
                      >
                        {p.label}
                      </button>
                    ))}
                    <button
                      className={`btn btn-sm ${!activePreset && (dateFrom || dateTo) ? 'btn-secondary' : 'btn-ghost'}`}
                      style={{ padding: '3px 10px', fontSize: '0.775rem' }}
                      onClick={() => { setDateFrom(''); setDateTo(''); setActivePreset(null) }}
                    >
                      All
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, overflow: 'hidden' }}>
                    <input
                      className="input" type="date" value={dateFrom}
                      onChange={e => { setDateFrom(e.target.value); setActivePreset(null) }}
                      style={{ fontSize: '0.8rem', minWidth: 0 }}
                    />
                    <input
                      className="input" type="date" value={dateTo}
                      onChange={e => { setDateTo(e.target.value); setActivePreset(null) }}
                      style={{ fontSize: '0.8rem', minWidth: 0 }}
                    />
                  </div>
                  {(dateFrom || dateTo) && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                      {dateFrom || '…'} → {dateTo || '…'}
                    </div>
                  )}
                </div>

                <label className="form-label">Exclude weekdays</label>
                <div className="checkbox-group" style={{ marginBottom: 14 }}>
                  {WEEKDAYS.map(d => (
                    <div key={d} className={`checkbox-chip ${excludeDays.includes(d) ? 'active' : ''}`} onClick={() => toggleDay(d)}>
                      {d.slice(0,3)}
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                  {[['excludeMonthStart','Exclude 1st of month'],['excludeMonthEnd','Exclude last of month']].map(([key, label]) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                      <input type="checkbox"
                        checked={key === 'excludeMonthStart' ? excludeMonthStart : excludeMonthEnd}
                        onChange={e => key === 'excludeMonthStart' ? setExcludeMonthStart(e.target.checked) : setExcludeMonthEnd(e.target.checked)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </>}
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: typesOpen ? 12 : 0, cursor: 'pointer', userSelect: 'none' }}
                onClick={() => { const next = !typesOpen; setTypesOpen(next); localStorage.setItem('analysis-types-open', String(next)) }}
              >
                <h3>🔬 Analysis Types</h3>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {typesOpen && <>
                    <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                      onClick={e => { e.stopPropagation(); setSelectedTypes(ANALYSIS_TYPES.map(t => t.id)) }}>All</button>
                    <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                      onClick={e => { e.stopPropagation(); setSelectedTypes([]) }}>Clear</button>
                  </>}
                  <ChevronDown size={16} style={{ color: 'var(--text-muted)', transition: 'transform 0.2s ease', transform: typesOpen ? 'rotate(0deg)' : 'rotate(-90deg)', flexShrink: 0 }} />
                </div>
              </div>
              {typesOpen && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ANALYSIS_TYPES.map(t => (
                  <div key={t.id}
                    className={`checkbox-chip ${selectedTypes.includes(t.id) ? 'active' : ''}`}
                    style={{ borderRadius: 'var(--radius-sm)', padding: '9px 12px' }}
                    onClick={() => toggleType(t.id)}
                  >
                    <span>{t.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{t.label}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.desc}</div>
                    </div>
                    <span style={{ color: selectedTypes.includes(t.id) ? 'var(--accent-bright)' : 'var(--text-muted)' }}>
                      {selectedTypes.includes(t.id) ? '✓' : ''}
                    </span>
                  </div>
                ))}
              </div>}
            </div>

            <button className="btn btn-primary w-full btn-lg" onClick={handleRun}
              disabled={running || loadingSymbols || !symbol || !selectedTypes.length || symbols.length === 0}>
              {running
                ? <><div className="spinner" style={{ width: 18, height: 18 }} /> {willResample ? 'Resampling & Analyzing...' : 'Running...'}</>
                : loadingSymbols
                  ? <><div className="spinner" style={{ width: 18, height: 18 }} /> Checking data…</>
                  : '▶ Run Analysis'}
            </button>
          </div>}

          {/* Results panel */}
          <div>
            {error && (
              <div style={{ background: 'var(--red-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius-md)', padding: '14px 18px', color: 'var(--red)', marginBottom: 16 }}>
                ❌ {error}
              </div>
            )}

            {!result && !running && (
              <div className="card" style={{ textAlign: 'center', padding: '60px 32px', color: 'var(--text-secondary)' }}>
                {loadingSymbols ? (
                  <>
                    <div className="spinner" style={{ width: 36, height: 36, margin: '0 auto 16px', borderWidth: 3 }} />
                    <h2 style={{ marginBottom: 8, color: 'var(--text-primary)' }}>Checking available data…</h2>
                    <p>Loading your downloaded stocks.</p>
                  </>
                ) : symbols.length === 0 ? (
                  <>
                    <div style={{ fontSize: '3rem', marginBottom: 16 }}>📭</div>
                    <h2 style={{ marginBottom: 8, color: 'var(--text-primary)' }}>No data available</h2>
                    <p>You haven&apos;t downloaded any stock data yet.</p>
                    <a href="/data" className="btn btn-primary" style={{ marginTop: 16, display: 'inline-flex' }}>📥 Download Data</a>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: '3rem', marginBottom: 16 }}>📊</div>
                    <h2 style={{ marginBottom: 8, color: 'var(--text-primary)' }}>Configure & Run</h2>
                    <p>Select a symbol and analysis types, then click Run Analysis.</p>
                  </>
                )}
              </div>
            )}

            {running && (
              <div className="card" style={{ textAlign: 'center', padding: '60px 32px' }}>
                <div className="spinner" style={{ width: 40, height: 40, margin: '0 auto 16px', borderWidth: 3 }} />
                <p style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>
                  {willResample
                    ? `Resampling ${symbol} to ${intervalLabel}...`
                    : `Running analysis for ${symbol}...`}
                </p>
                {willResample && (
                  <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                    Building {intervalLabel} candles from 1min data. This only happens once — result will be cached.
                  </p>
                )}
              </div>
            )}

            {result && (
              <div className="fade-in">
                {/* Summary bar */}
                <div className="card" style={{ marginBottom: 16, padding: '14px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: '1.125rem' }}>{result.symbol || symbol}</span>
                    {result.filtered_records != null && (
                      <span className="badge badge-blue">{result.filtered_records.toLocaleString()} candles</span>
                    )}
                    {result.date_from && (
                      <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                        {result.date_from} → {result.date_to}
                      </span>
                    )}
                    {result.avg_close != null && (
                      <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                        Avg Close: <strong style={{ fontFamily: 'monospace' }}>₹{result.avg_close.toLocaleString()}</strong>
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                      {selectedTypes.map(t => ANALYSIS_TYPES.find(a => a.id === t)?.icon).join('  ')}
                    </span>
                  </div>
                </div>

                {/* Result tabs */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
                  {resultKeys.map((key, i) => (
                    <button key={key}
                      className={`btn btn-sm ${activeTab === i ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setActiveTab(i)}
                    >
                      {ANALYSIS_TYPES.find(a => a.id === key)?.icon || '📋'} {key}
                    </button>
                  ))}
                </div>

                {resultKeys.map((key, i) => i === activeTab && (
                  <ResultSection key={key} label={key} data={result[key]} />
                ))}
              </div>
            )}

            {/* Saved analyses */}
            {savedList.length > 0 && (
              <div className="card" style={{ marginTop: 24, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
                  <h3>💾 Saved Analyses</h3>
                </div>
                {savedList.map((s: any) => (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                    borderBottom: '1px solid var(--border)'
                  }}>
                    <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>{s.symbol}</span>
                    <span className="badge badge-blue">{s.analysis_type}</span>
                    <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                      {new Date(s.created_at).toLocaleDateString()}
                    </span>
                    <button className="btn btn-secondary btn-sm" onClick={async () => {
                      const r = await analysisApi.getSaved(s.id)
                      setResult(r.data.result)
                      setSymbol(s.symbol)
                    }}>Load</button>
                    <button className="btn btn-danger btn-sm" onClick={async () => {
                      await analysisApi.deleteSaved(s.id)
                      setSavedList(l => l.filter(x => x.id !== s.id))
                    }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Chart descriptions ────────────────────────────────────────────────────────
const CHART_INFO: Record<string, { what: string; positive: string; negative: string; tip: string }> = {
  price: {
    what: 'Raw OHLCV price chart — closing price as a line/area with the high-low range shaded, and volume bars below. The most fundamental view of a stock.',
    positive: 'Price trending up with expanding volume = healthy bullish move backed by conviction. Higher highs and higher lows = uptrend.',
    negative: 'Price falling on high volume = strong selling pressure. Lower highs and lower lows = downtrend. Flat price on low volume = no interest.',
    tip: 'Use the date preset buttons (1W, 1M, 1Y…) to zoom into different periods. Compare the slope in short vs long periods to judge momentum.',
  },
  returns: {
    what: 'Shows the percentage price change per candle over time, plus a distribution histogram of how often each return magnitude occurred.',
    positive: 'Bars above zero = price went up that candle. A right-skewed histogram means more large gains than large losses.',
    negative: 'Bars below zero = price fell. A left-skewed histogram means frequent large drops — a red flag for volatility risk.',
    tip: 'Look for a roughly symmetric bell curve. Fat tails (many extreme values) signal high risk. Mean close to 0 = neutral drift.',
  },
  volatility: {
    what: 'Rolling 20-period annualized volatility — how much the price is fluctuating relative to its average. Higher = more uncertain.',
    positive: 'Low, stable volatility (flat line near the bottom) = predictable price action. Good for trend-following strategies.',
    negative: 'Spikes in the line = periods of panic or news events. Sustained high volatility = higher risk, wider stop losses needed.',
    tip: 'Compare volatility levels to current period. If current vol is near historical highs, the stock is in an unstable phase.',
  },
  technicals: {
    what: 'Three sub-charts: (1) Price with SMA/EMA overlays and Bollinger Bands, (2) RSI momentum oscillator (0–100), (3) MACD trend indicator.',
    positive: 'RSI > 50 = bullish momentum. Price above SMA/EMA = uptrend. MACD line above signal line = buy signal. Green MACD histogram = strengthening trend.',
    negative: 'RSI < 30 = oversold (potential reversal up). RSI > 70 = overbought (potential reversal down). Price below MAs = downtrend. Red MACD histogram = weakening.',
    tip: 'RSI 30/70 lines are marked. Use EMA 9 for short-term signals, SMA 20 for medium-term trend direction. Bollinger Band squeezes precede big moves.',
  },
  volume: {
    what: 'Trading volume bars with a 20-period moving average and the closing price overlaid on a secondary axis.',
    positive: 'Volume spike + price rise = strong buying conviction. Volume consistently above MA20 = sustained interest in the stock.',
    negative: 'Price rise on low volume = weak rally, likely to reverse. Volume spike + price drop = panic selling or institutional exit.',
    tip: 'The best trades happen when price and volume move together. Divergence (price up, volume down) is a warning sign.',
  },
  patterns: {
    what: 'Average returns grouped by hour of day (left) and day of week (right). Reveals intraday and weekly seasonal patterns.',
    positive: 'Green bars = that hour/day historically produces positive returns on average. Consistent green = reliable time-based edge.',
    negative: 'Red bars = historically negative periods. Avoid entering long positions during persistently red hours/days.',
    tip: 'Use these to time entries. If Friday afternoon is consistently red, avoid holding over the weekend. Market open (9–10am) is often volatile.',
  },
  drawdown: {
    what: 'Shows how far the price fell from its running peak at each point in time. The red reference line marks the worst historical drawdown.',
    positive: 'Shallow, short-lived dips (small drawdowns that recover quickly) = resilient stock with strong buying support.',
    negative: 'Deep drawdowns that take months to recover = high-risk stock. The max drawdown % tells you the worst-case loss a holder experienced.',
    tip: 'Max drawdown is the key risk metric. A stock with -50% max drawdown needed a +100% gain just to break even. Use this for position sizing.',
  },
  seasonality: {
    what: 'Shows which calendar months and weekdays have historically produced the best average returns and win rates. Based on all available data.',
    positive: 'Months with positive avg_return AND win_rate > 55% are historically strong entry periods. Higher candle count = more reliable signal.',
    negative: 'Red bars (negative avg_return) and low win rates flag historically weak periods — timing entries here carries extra risk.',
    tip: 'Use seasonality as a timing confirmation alongside price and momentum signals. A stock entering its historically best month with strong momentum is a high-conviction setup.',
  },
  momentum: {
    what: 'Rate of Change (ROC) measures how much price has moved over 1, 5, and 20 periods. The composite score weights all three into a BUY/SELL/NEUTRAL signal.',
    positive: 'All three ROC lines above zero = broad-based upward momentum. BUY signal = price consistently trending up across multiple timeframes.',
    negative: 'ROC lines below zero = price losing ground. Divergence (fast ROC down but slow ROC up) = short-term pullback in an uptrend.',
    tip: 'The 20-period ROC reflects the broader trend. Fast ROC (1-period) spikes are noise; use them with slow ROC context. A BUY signal while price is above 20-period high is the strongest setup.',
  },
  riskreturn: {
    what: 'Quantifies the quality of returns — not just how much, but how consistently. Sharpe > 1 is good, > 2 is excellent. Win rate > 50% means more profitable days than not.',
    positive: 'High Sharpe + high Sortino = strong risk-adjusted returns. Profit factor > 1.5 = gains more than offset losses. Rolling Sharpe above 1 = reliable performance.',
    negative: 'Sharpe < 0 = losing risk-adjusted money. VaR 95% shows the worst expected single-period loss 5% of the time — large values signal significant downside risk.',
    tip: 'Compare Sortino to Sharpe: if Sortino >> Sharpe, volatility is mostly upside (good). If similar, volatility is symmetric. Profit factor < 1 = losses outweigh gains overall.',
  },
}

function ChartInfo({ type }: { type: string }) {
  const info = CHART_INFO[type]
  if (!info) return null
  return (
    <div style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: '0.8125rem', lineHeight: 1.6 }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{info.what}</div>
      <div className="chart-info-grid">
        <div style={{ background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.15)', borderRadius: 6, padding: '7px 10px' }}>
          <span style={{ color: 'var(--green)', fontWeight: 600, marginRight: 6 }}>↑ Positive</span>
          <span style={{ color: 'var(--text-muted)' }}>{info.positive}</span>
        </div>
        <div style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6, padding: '7px 10px' }}>
          <span style={{ color: 'var(--red)', fontWeight: 600, marginRight: 6 }}>↓ Negative</span>
          <span style={{ color: 'var(--text-muted)' }}>{info.negative}</span>
        </div>
      </div>
      <div style={{ color: 'var(--accent-bright)', fontSize: '0.775rem' }}>
        💡 {info.tip}
      </div>
    </div>
  )
}

// ── Shared chart helpers ───────────────────────────────────────────────────────
const fmtDate = (s: string) => {
  if (!s) return ''
  try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) }
  catch { return s }
}
const tooltipStyle = {
  contentStyle: { background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.8rem' },
  labelStyle: { color: 'var(--text-secondary)', marginBottom: 4 },
  itemStyle: { color: 'var(--text-primary)' },
}
const axisStyle = { fill: 'var(--text-muted)', fontSize: 11 }

// Thin down large datasets so Recharts stays fast
const sampleRows = (rows: any[], max = 500) =>
  rows.length > max ? rows.filter((_: any, i: number) => i % Math.ceil(rows.length / max) === 0) : rows

// ── Fullscreen modal ──────────────────────────────────────────────────────────
function FullscreenModal({ label, data, onClose }: { label: string; data: any; onClose: () => void }) {
  const info = ANALYSIS_TYPES.find(a => a.id === label)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const renderChart = (fs: boolean) => {
    switch (data.type) {
      case 'price':      return <PriceChart data={data} fullscreen={fs} />
      case 'returns':    return <ReturnsChart data={data} fullscreen={fs} />
      case 'volatility': return <VolatilityChart data={data} fullscreen={fs} />
      case 'technicals': return <TechnicalsChart data={data} fullscreen={fs} />
      case 'volume':     return <VolumeChart data={data} fullscreen={fs} />
      case 'drawdown':    return <DrawdownChart data={data} fullscreen={fs} />
      case 'patterns':    return <PatternsChart data={data} fullscreen={fs} />
      case 'seasonality': return <SeasonalityChart data={data} fullscreen={fs} />
      case 'momentum':    return <MomentumChart data={data} fullscreen={fs} />
      case 'riskreturn':  return <RiskReturnChart data={data} fullscreen={fs} />
      default:            return <StatsTable data={data} />
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <h2 style={{ margin: 0 }}>{info?.icon} {info?.label || label}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Drag the brush below charts to zoom · Esc to close</span>
          <button className="btn btn-secondary btn-sm" onClick={onClose} style={{ fontSize: '1.1rem', lineHeight: 1, padding: '4px 10px' }}>✕</button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', background: 'var(--bg-base)' }}>
        {renderChart(true)}
      </div>
    </div>
  )
}

// ── Result renderer ────────────────────────────────────────────────────────────
function ResultSection({ label, data }: { label: string; data: any }) {
  const chartRef = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  if (!data) return null
  if (data.error) return (
    <div style={{ background: 'var(--red-dim)', border: '1px solid rgba(239,68,68,0.2)',
      borderRadius: 'var(--radius-md)', padding: '14px 18px', color: 'var(--red)', marginBottom: 16 }}>
      ❌ {label}: {data.error}
    </div>
  )
  const info = ANALYSIS_TYPES.find(a => a.id === label)

  const handleDownload = async () => {
    if (!chartRef.current) return
    const canvas = await html2canvas(chartRef.current, { backgroundColor: '#0f1424', scale: 2 })
    const link = document.createElement('a')
    link.download = `${label}-${Date.now()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const renderChart = (fs = false) => {
    switch (data.type) {
      case 'price':      return <PriceChart data={data} fullscreen={fs} />
      case 'returns':    return <ReturnsChart data={data} fullscreen={fs} />
      case 'volatility': return <VolatilityChart data={data} fullscreen={fs} />
      case 'technicals': return <TechnicalsChart data={data} fullscreen={fs} />
      case 'volume':     return <VolumeChart data={data} fullscreen={fs} />
      case 'drawdown':    return <DrawdownChart data={data} fullscreen={fs} />
      case 'patterns':    return <PatternsChart data={data} fullscreen={fs} />
      case 'seasonality': return <SeasonalityChart data={data} fullscreen={fs} />
      case 'momentum':    return <MomentumChart data={data} fullscreen={fs} />
      case 'riskreturn':  return <RiskReturnChart data={data} fullscreen={fs} />
      default:            return <StatsTable data={data} />
    }
  }

  return (
    <>
      {fullscreen && <FullscreenModal label={label} data={data} onClose={() => setFullscreen(false)} />}
      <div ref={chartRef} className="card fade-in" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3>{info?.icon} {info?.label || label}</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setFullscreen(true)} title="Expand to fullscreen">⛶ Expand</button>
            <button className="btn btn-secondary btn-sm" onClick={handleDownload}>↓ PNG</button>
          </div>
        </div>
        {renderChart()}
      </div>
    </>
  )
}

// ── Per-type chart components ─────────────────────────────────────────────────

const brushStyle = { stroke: 'var(--accent)', fill: 'var(--bg-overlay)', fillOpacity: 0.8 }

function PriceChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const rows = data.data || []
  if (!rows.length) return <p style={{ color: 'var(--text-muted)' }}>No price data available.</p>

  const firstClose = rows[0]?.close ?? 0
  const lastClose  = rows[rows.length - 1]?.close ?? 0
  const totalChange = firstClose ? ((lastClose - firstClose) / firstClose) * 100 : 0
  const isUp = totalChange >= 0

  return (
    <>
      <ChartInfo type="price" />

      {/* Period summary chips */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          ['Open',  `₹${rows[0]?.close?.toFixed(2)}`],
          ['Close', `₹${lastClose.toFixed(2)}`],
          ['High',  `₹${Math.max(...rows.map((r: any) => r.high)).toFixed(2)}`],
          ['Low',   `₹${Math.min(...rows.map((r: any) => r.low)).toFixed(2)}`],
          ['Change', `${isUp ? '+' : ''}${totalChange.toFixed(2)}%`],
        ].map(([label, val]) => (
          <div key={label} style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '7px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
            <div style={{
              fontWeight: 700, fontFamily: 'monospace', fontSize: '0.9rem',
              color: label === 'Change' ? (isUp ? 'var(--green)' : 'var(--red)') : 'var(--text-primary)'
            }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Close price area chart */}
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Close Price</div>
      <ResponsiveContainer width="100%" height={fullscreen ? 480 : 260}>
        <ComposedChart data={rows} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <defs>
            <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={isUp ? 'var(--green)' : 'var(--red)'} stopOpacity={0.2} />
              <stop offset="95%" stopColor={isUp ? 'var(--green)' : 'var(--red)'} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
          <YAxis tick={axisStyle} width={65} domain={['auto', 'auto']} tickFormatter={(v: number) => `₹${v.toFixed(0)}`} />
          <Tooltip
            {...tooltipStyle}
            labelFormatter={fmtDate}
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null
              const d = payload[0].payload
              return (
                <div style={{ ...tooltipStyle.contentStyle }}>
                  <div style={{ ...tooltipStyle.labelStyle, fontWeight: 600 }}>{fmtDate(d.datetime)}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', marginTop: 4, fontSize: '0.78rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>O</span><span style={{ fontFamily: 'monospace' }}>₹{d.open?.toFixed(2)}</span>
                    <span style={{ color: 'var(--green)' }}>H</span><span style={{ fontFamily: 'monospace' }}>₹{d.high?.toFixed(2)}</span>
                    <span style={{ color: 'var(--red)' }}>L</span><span style={{ fontFamily: 'monospace' }}>₹{d.low?.toFixed(2)}</span>
                    <span style={{ color: 'var(--accent-bright)' }}>C</span><span style={{ fontFamily: 'monospace', fontWeight: 700 }}>₹{d.close?.toFixed(2)}</span>
                  </div>
                </div>
              )
            }}
          />
          {/* High-low range as faint area */}
          <Area type="monotone" dataKey="high" stroke="transparent" fill="var(--border)" fillOpacity={0.3} dot={false} name="High" isAnimationActive={false} legendType="none" />
          <Area type="monotone" dataKey="low"  stroke="transparent" fill="var(--bg-surface)" fillOpacity={1} dot={false} name="Low" isAnimationActive={false} legendType="none" />
          {/* Close price line */}
          <Area type="monotone" dataKey="close"
            stroke={isUp ? 'var(--green)' : 'var(--red)'}
            strokeWidth={2}
            fill="url(#priceGrad)"
            dot={false} name="Close" isAnimationActive={false}
          />
          <Brush dataKey="datetime" height={22} tickFormatter={fmtDate} {...brushStyle} />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Volume sub-chart */}
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '14px 0 6px' }}>Volume</div>
      <ResponsiveContainer width="100%" height={fullscreen ? 130 : 90}>
        <BarChart data={rows} margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
          <XAxis dataKey="datetime" tick={false} axisLine={false} />
          <YAxis tick={axisStyle} width={65} tickFormatter={(v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(v)} />
          <Tooltip {...tooltipStyle} formatter={(v: number) => [v.toLocaleString(), 'Volume']} labelFormatter={fmtDate} />
          <Bar dataKey="volume" name="Volume" fill={isUp ? 'var(--green)' : 'var(--red)'} fillOpacity={0.45} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </>
  )
}

function ReturnsChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const series = data.series || []
  const histogram = data.histogram || []
  const stats = data.stats || {}
  return (
    <>
      <ChartInfo type="returns" />
      <div className="returns-stats-grid">
        {(['mean', 'std', 'skew', 'kurt', 'min', 'max'] as const).map(k => (
          <div key={k} style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '8px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2, textTransform: 'capitalize' }}>{k}</div>
            <div style={{ fontSize: '0.875rem', fontWeight: 600, fontFamily: 'monospace' }}>
              {typeof stats[k] === 'number' ? stats[k].toFixed(3) : '—'}
            </div>
          </div>
        ))}
      </div>

      {series.length > 0 && (
        <>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Daily Returns</div>
          <ResponsiveContainer width="100%" height={fullscreen ? 400 : 180}>
            <LineChart data={sampleRows(series)} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
              <YAxis tick={axisStyle} tickFormatter={(v: number) => `${v.toFixed(2)}%`} width={56} />
              <Tooltip {...tooltipStyle} formatter={(v: number) => [`${v.toFixed(4)}%`, 'Return']} labelFormatter={fmtDate} />
              <ReferenceLine y={0} stroke="var(--border-light)" strokeDasharray="4 2" />
              <Line type="monotone" dataKey="daily_return" stroke="var(--accent)" dot={false} strokeWidth={1.5} name="Return" isAnimationActive={false} />
              <Brush dataKey="datetime" height={22} tickFormatter={fmtDate} {...brushStyle} />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}

      {histogram.length > 0 && (
        <>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '14px 0 6px' }}>Return Distribution</div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={histogram} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="bin" tick={axisStyle} tickFormatter={(v: number) => v.toFixed(1)} />
              <YAxis tick={axisStyle} width={40} />
              <Tooltip {...tooltipStyle} formatter={(v: number) => [v, 'Count']} labelFormatter={(v: number) => `Bin: ${Number(v).toFixed(3)}`} />
              <Bar dataKey="count" name="Count" radius={[2, 2, 0, 0]}>
                {histogram.map((entry: any, i: number) => (
                  <Cell key={i} fill={entry.bin >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.75} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </>
  )
}

function VolatilityChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const series = data.rolling_vol || []
  return (
    <>
      <ChartInfo type="volatility" />
      {data.current_annualized_vol != null && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '6px 14px', fontSize: '0.875rem', color: 'var(--yellow)', fontFamily: 'monospace', fontWeight: 700 }}>
            Annualized Vol: {data.current_annualized_vol.toFixed(2)}%
          </span>
        </div>
      )}
      {series.length > 0 && (
        <ResponsiveContainer width="100%" height={fullscreen ? 480 : 220}>
          <LineChart data={sampleRows(series)} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
            <YAxis tick={axisStyle} width={52} />
            <Tooltip {...tooltipStyle} formatter={(v: number) => [v.toFixed(4), 'Volatility']} labelFormatter={fmtDate} />
            <Line type="monotone" dataKey="value" stroke="var(--yellow)" dot={false} strokeWidth={2} name="Rolling Vol" isAnimationActive={false} />
            <Brush dataKey="datetime" height={22} tickFormatter={fmtDate} {...brushStyle} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </>
  )
}

function TechnicalsChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const sample = sampleRows(data.data || [])
  return (
    <>
      <ChartInfo type="technicals" />
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Price & Moving Averages</div>
      <ResponsiveContainer width="100%" height={fullscreen ? 420 : 240}>
        <ComposedChart data={sample} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
          <YAxis tick={axisStyle} width={60} domain={['auto', 'auto']} />
          <Tooltip {...tooltipStyle} formatter={(v: number) => v.toFixed(2)} labelFormatter={fmtDate} />
          <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
          <Area type="monotone" dataKey="bb_upper" stroke="#06b6d4" strokeWidth={1} strokeDasharray="5 3" fill="#06b6d4" fillOpacity={0.08} name="BB Upper" dot={false} isAnimationActive={false} legendType="none" />
          <Area type="monotone" dataKey="bb_lower" stroke="#06b6d4" strokeWidth={1} strokeDasharray="5 3" fill="var(--bg-surface)" fillOpacity={1} name="BB Lower" dot={false} isAnimationActive={false} legendType="none" />
          <Line type="monotone" dataKey="bb_middle" stroke="#06b6d4" strokeWidth={1} strokeDasharray="2 3" dot={false} name="BB Mid" isAnimationActive={false} legendType="none" />
          <Line type="monotone" dataKey="close" stroke="var(--text-secondary)" dot={false} strokeWidth={1.5} name="Close" isAnimationActive={false} />
          <Line type="monotone" dataKey="sma_20" stroke="var(--accent)" dot={false} strokeWidth={1.5} name="SMA 20" isAnimationActive={false} />
          <Line type="monotone" dataKey="ema_9" stroke="var(--green)" dot={false} strokeWidth={1.5} name="EMA 9" isAnimationActive={false} />
          <Line type="monotone" dataKey="ema_21" stroke="var(--yellow)" dot={false} strokeWidth={1.5} name="EMA 21" isAnimationActive={false} />
          <Brush dataKey="datetime" height={22} tickFormatter={fmtDate} {...brushStyle} />
        </ComposedChart>
      </ResponsiveContainer>

      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '14px 0 6px' }}>RSI (14)</div>
      <ResponsiveContainer width="100%" height={fullscreen ? 220 : 130}>
        <LineChart data={sample} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
          <YAxis domain={[0, 100]} tick={axisStyle} width={35} />
          <Tooltip {...tooltipStyle} formatter={(v: number) => [v.toFixed(2), 'RSI']} labelFormatter={fmtDate} />
          <ReferenceLine y={70} stroke="var(--red)" strokeDasharray="4 2" strokeOpacity={0.6} />
          <ReferenceLine y={30} stroke="var(--green)" strokeDasharray="4 2" strokeOpacity={0.6} />
          <Line type="monotone" dataKey="rsi_14" stroke="var(--purple)" dot={false} strokeWidth={1.5} name="RSI" isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>

      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '14px 0 6px' }}>MACD</div>
      <ResponsiveContainer width="100%" height={fullscreen ? 220 : 130}>
        <ComposedChart data={sample} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
          <YAxis tick={axisStyle} width={50} domain={['auto', 'auto']} />
          <Tooltip {...tooltipStyle} formatter={(v: number) => v.toFixed(4)} labelFormatter={fmtDate} />
          <ReferenceLine y={0} stroke="var(--border-light)" />
          <Bar dataKey="macd_hist" name="Histogram" isAnimationActive={false}>
            {sample.map((entry: any, i: number) => (
              <Cell key={i} fill={entry.macd_hist >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.6} />
            ))}
          </Bar>
          <Line type="monotone" dataKey="macd" stroke="var(--accent)" dot={false} strokeWidth={1.5} name="MACD" isAnimationActive={false} />
          <Line type="monotone" dataKey="macd_signal" stroke="var(--yellow)" dot={false} strokeWidth={1.5} name="Signal" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  )
}

function VolumeChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const sample = sampleRows(data.data || [])
  return (
    <>
      <ChartInfo type="volume" />
      <ResponsiveContainer width="100%" height={fullscreen ? 500 : 240}>
        <ComposedChart data={sample} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
          <YAxis yAxisId="vol" tick={axisStyle} width={65}
            tickFormatter={(v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(v)} />
          <YAxis yAxisId="price" orientation="right" tick={axisStyle} width={55} domain={['auto', 'auto']} />
          <Tooltip {...tooltipStyle}
            formatter={(v: number, name: string) => name === 'Close' ? [v.toFixed(2), name] : [v.toLocaleString(), name]}
            labelFormatter={fmtDate}
          />
          <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
          <Bar yAxisId="vol" dataKey="volume" name="Volume" fill="var(--accent)" fillOpacity={0.4} isAnimationActive={false} />
          <Line yAxisId="vol" type="monotone" dataKey="vol_ma20" stroke="var(--yellow)" dot={false} strokeWidth={1.5} name="Vol MA20" isAnimationActive={false} />
          <Line yAxisId="price" type="monotone" dataKey="close" stroke="var(--green)" dot={false} strokeWidth={1.5} name="Close" isAnimationActive={false} />
          <Brush dataKey="datetime" height={22} tickFormatter={fmtDate} {...brushStyle} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  )
}

function DrawdownChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const sample = sampleRows(data.data || [])
  return (
    <>
      <ChartInfo type="drawdown" />
      {data.max_drawdown_pct != null && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ background: 'var(--red-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '6px 14px', fontSize: '0.875rem', color: 'var(--red)', fontFamily: 'monospace', fontWeight: 700 }}>
            Max Drawdown: {data.max_drawdown_pct.toFixed(2)}%
          </span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={fullscreen ? 480 : 200}>
        <AreaChart data={sample} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
          <YAxis tick={axisStyle} width={52} tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
          <Tooltip {...tooltipStyle} formatter={(v: number) => [`${v.toFixed(4)}%`, 'Drawdown']} labelFormatter={fmtDate} />
          {data.max_drawdown_pct != null && (
            <ReferenceLine y={data.max_drawdown_pct} stroke="var(--red)" strokeDasharray="6 2"
              label={{ value: 'Max DD', fill: 'var(--red)', fontSize: 10 }} />
          )}
          <ReferenceLine y={0} stroke="var(--border-light)" />
          <Area type="monotone" dataKey="drawdown" stroke="var(--red)" fill="var(--red)" fillOpacity={0.15} dot={false} name="Drawdown" isAnimationActive={false} />
          <Brush dataKey="datetime" height={22} tickFormatter={fmtDate} {...brushStyle} />
        </AreaChart>
      </ResponsiveContainer>
    </>
  )
}

function PatternsChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const hourly = data.hourly || []
  const dow = data.day_of_week || []
  return (
    <>
      <ChartInfo type="patterns" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
      <div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Avg Return by Hour</div>
        <ResponsiveContainer width="100%" height={fullscreen ? 400 : 200}>
          <BarChart data={hourly} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="hour" tick={axisStyle} />
            <YAxis tick={axisStyle} width={52} tickFormatter={(v: number) => `${v.toFixed(2)}%`} />
            <Tooltip {...tooltipStyle} formatter={(v: number) => [`${v.toFixed(4)}%`, 'Avg Return']} />
            <Bar dataKey="avg_return" name="Avg Return" radius={[3, 3, 0, 0]}>
              {hourly.map((entry: any, i: number) => (
                <Cell key={i} fill={entry.avg_return >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.75} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Avg Return by Day</div>
        <ResponsiveContainer width="100%" height={fullscreen ? 400 : 200}>
          <BarChart data={dow} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="day" tick={axisStyle} />
            <YAxis tick={axisStyle} width={52} tickFormatter={(v: number) => `${v.toFixed(2)}%`} />
            <Tooltip {...tooltipStyle}
              content={({ active, payload }) => {
                if (!active || !payload?.[0]) return null
                const d = payload[0].payload
                return (
                  <div style={{ ...tooltipStyle.contentStyle }}>
                    <div style={{ ...tooltipStyle.labelStyle, fontWeight: 600 }}>{d.day}</div>
                    <div>Avg: {d.avg_return?.toFixed(4)}%</div>
                    <div style={{ color: 'var(--text-muted)' }}>Std: {d.std?.toFixed(4)}% · n={d.count}</div>
                  </div>
                )
              }}
            />
            <Bar dataKey="avg_return" name="Avg Return" radius={[3, 3, 0, 0]}>
              {dow.map((entry: any, i: number) => (
                <Cell key={i} fill={entry.avg_return >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.75} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      </div>
    </>
  )
}

function StatsTable({ data }: { data: any }) {
  if (!data || typeof data !== 'object') return null
  const entries = Object.entries(data).filter(([k]) => k !== 'type')
  if (!entries.length) return null
  return (
    <div className="table-wrapper">
      <table>
        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td style={{ color: 'var(--text-secondary)' }}>{k.replace(/_/g, ' ')}</td>
              <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                {typeof v === 'number' ? v.toFixed(4) : typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Seasonality Chart ─────────────────────────────────────────────────────────
function SeasonalityChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const monthly = data.monthly || []
  const weekday = data.weekday || []
  if (!monthly.length && !weekday.length) return <p style={{ color: 'var(--text-muted)' }}>No seasonality data available.</p>

  const bestMonth = [...monthly].sort((a: any, b: any) => b.avg_return - a.avg_return)[0]
  const bestDay   = [...weekday].sort((a: any, b: any) => b.avg_return - a.avg_return)[0]

  const h = fullscreen ? 280 : 200

  return (
    <>
      <ChartInfo type="seasonality" />

      {/* Summary chips */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {bestMonth && (
          <div style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '7px 14px' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2 }}>Best Month</div>
            <div style={{ fontWeight: 700, color: bestMonth.avg_return >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'monospace' }}>
              {bestMonth.month} ({bestMonth.avg_return >= 0 ? '+' : ''}{bestMonth.avg_return.toFixed(3)}%)
            </div>
          </div>
        )}
        {bestDay && (
          <div style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '7px 14px' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2 }}>Best Day</div>
            <div style={{ fontWeight: 700, color: bestDay.avg_return >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'monospace' }}>
              {bestDay.day} ({bestDay.avg_return >= 0 ? '+' : ''}{bestDay.avg_return.toFixed(3)}%)
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
        {monthly.length > 0 && (
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Monthly Average Return</div>
            <ResponsiveContainer width="100%" height={h}>
              <BarChart data={monthly} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" tick={axisStyle} />
                <YAxis tick={axisStyle} tickFormatter={(v: number) => `${v.toFixed(2)}%`} width={55} />
                <Tooltip
                  {...tooltipStyle}
                  content={({ active, payload }) => {
                    if (!active || !payload?.[0]) return null
                    const d = payload[0].payload
                    return (
                      <div style={{ ...tooltipStyle.contentStyle }}>
                        <div style={{ ...tooltipStyle.labelStyle, fontWeight: 600 }}>{d.month}</div>
                        <div>Avg Return: {d.avg_return >= 0 ? '+' : ''}{d.avg_return?.toFixed(4)}%</div>
                        <div style={{ color: 'var(--text-muted)' }}>Win Rate: {d.win_rate?.toFixed(1)}% · n={d.count}</div>
                      </div>
                    )
                  }}
                />
                <Bar dataKey="avg_return" name="Avg Return" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                  {monthly.map((entry: any, i: number) => (
                    <Cell key={i} fill={entry.avg_return >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.75} />
                  ))}
                </Bar>
                <ReferenceLine y={0} stroke="var(--border)" strokeWidth={2} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {weekday.length > 0 && (
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Day-of-Week Average Return</div>
            <ResponsiveContainer width="100%" height={h}>
              <BarChart data={weekday} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" tick={axisStyle} />
                <YAxis tick={axisStyle} tickFormatter={(v: number) => `${v.toFixed(2)}%`} width={55} />
                <Tooltip
                  {...tooltipStyle}
                  content={({ active, payload }) => {
                    if (!active || !payload?.[0]) return null
                    const d = payload[0].payload
                    return (
                      <div style={{ ...tooltipStyle.contentStyle }}>
                        <div style={{ ...tooltipStyle.labelStyle, fontWeight: 600 }}>{d.day}</div>
                        <div>Avg Return: {d.avg_return >= 0 ? '+' : ''}{d.avg_return?.toFixed(4)}%</div>
                        <div style={{ color: 'var(--text-muted)' }}>Win Rate: {d.win_rate?.toFixed(1)}% · n={d.count}</div>
                      </div>
                    )
                  }}
                />
                <Bar dataKey="avg_return" name="Avg Return" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                  {weekday.map((entry: any, i: number) => (
                    <Cell key={i} fill={entry.avg_return >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.75} />
                  ))}
                </Bar>
                <ReferenceLine y={0} stroke="var(--border)" strokeWidth={2} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </>
  )
}

// ── Momentum Chart ────────────────────────────────────────────────────────────
function MomentumChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const series  = data.series  || []
  const current = data.current || {}
  if (!series.length) return <p style={{ color: 'var(--text-muted)' }}>No momentum data available.</p>

  const signal = current.signal || 'NEUTRAL'
  const signalColor = signal === 'BUY' ? 'var(--green)' : signal === 'SELL' ? 'var(--red)' : 'var(--text-muted)'

  return (
    <>
      <ChartInfo type="momentum" />

      {/* Signal + current ROC chips */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Signal</div>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: signalColor }}>{signal}</div>
        </div>
        {[['ROC 1-period', current.roc_1], ['ROC 5-period', current.roc_5], ['ROC 20-period', current.roc_20]].map(([label, val]) => (
          val != null && (
            <div key={String(label)} style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '7px 14px' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
              <div style={{ fontWeight: 700, fontFamily: 'monospace', color: (val as number) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {(val as number) >= 0 ? '+' : ''}{(val as number).toFixed(3)}%
              </div>
            </div>
          )
        ))}
      </div>

      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>Rate of Change (ROC)</div>
      <ResponsiveContainer width="100%" height={fullscreen ? 480 : 240}>
        <LineChart data={series} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
          <YAxis tick={axisStyle} width={60} tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
          <Tooltip
            {...tooltipStyle}
            labelFormatter={fmtDate}
            formatter={(v: number, name: string) => [`${v >= 0 ? '+' : ''}${v.toFixed(4)}%`, name]}
          />
          <ReferenceLine y={0} stroke="var(--border)" strokeWidth={2} strokeDasharray="4 4" />
          <Line dataKey="roc_1"  stroke="var(--accent-bright)" strokeWidth={1.5} dot={false} name="ROC 1" isAnimationActive={false} />
          <Line dataKey="roc_5"  stroke="var(--yellow)"        strokeWidth={1.5} dot={false} name="ROC 5" isAnimationActive={false} />
          <Line dataKey="roc_20" stroke="#a855f7"              strokeWidth={2}   dot={false} name="ROC 20" isAnimationActive={false} />
          <Legend />
          <Brush dataKey="datetime" height={22} tickFormatter={fmtDate} {...brushStyle} />
        </LineChart>
      </ResponsiveContainer>
    </>
  )
}

// ── Risk/Return Chart ─────────────────────────────────────────────────────────
function RiskReturnChart({ data, fullscreen }: { data: any; fullscreen?: boolean }) {
  const sharpe  = data.rolling_sharpe || []
  const metrics = data.metrics || {}
  if (!sharpe.length && !Object.keys(metrics).length) return <p style={{ color: 'var(--text-muted)' }}>No risk/return data available.</p>

  const endSharpe = sharpe.length ? sharpe[sharpe.length - 1].sharpe : null

  const metricChips: { label: string; val: number | null; fmt: (v: number) => string; good: (v: number) => boolean }[] = [
    { label: 'Sharpe',        val: metrics.sharpe,        fmt: (v: number) => v.toFixed(3), good: (v: number) => v > 1 },
    { label: 'Sortino',       val: metrics.sortino,       fmt: (v: number) => v.toFixed(3), good: (v: number) => v > 1 },
    { label: 'Win Rate',      val: metrics.win_rate_pct,  fmt: (v: number) => `${v.toFixed(1)}%`, good: (v: number) => v > 50 },
    { label: 'Profit Factor', val: metrics.profit_factor, fmt: (v: number) => v.toFixed(3), good: (v: number) => v > 1 },
    { label: 'VaR 95%',       val: metrics.var_95_pct,    fmt: (v: number) => `${v.toFixed(3)}%`, good: (v: number) => v > -2 },
    { label: 'CVaR 95%',      val: metrics.cvar_95_pct,   fmt: (v: number) => `${v.toFixed(3)}%`, good: (v: number) => v > -3 },
  ]

  return (
    <>
      <ChartInfo type="riskreturn" />

      {/* Metrics grid */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        {metricChips.map(({ label, val, fmt, good }) => val != null && (
          <div key={label} style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '8px 14px', minWidth: 110 }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
            <div style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.9rem', color: good(val) ? 'var(--green)' : 'var(--red)' }}>
              {fmt(val)}
            </div>
          </div>
        ))}
      </div>

      {sharpe.length > 0 && (
        <>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 6 }}>
            Rolling 20-Period Sharpe Ratio
            {endSharpe != null && (
              <span style={{ marginLeft: 8, fontWeight: 600, color: endSharpe > 1 ? 'var(--green)' : endSharpe > 0 ? 'var(--yellow)' : 'var(--red)' }}>
                Current: {endSharpe.toFixed(3)}
              </span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={fullscreen ? 480 : 220}>
            <LineChart data={sharpe} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="datetime" tickFormatter={fmtDate} tick={axisStyle} interval="preserveStartEnd" />
              <YAxis tick={axisStyle} width={60} tickFormatter={(v: number) => v.toFixed(2)} />
              <Tooltip
                {...tooltipStyle}
                labelFormatter={fmtDate}
                formatter={(v: number) => [v.toFixed(4), 'Sharpe Ratio']}
              />
              <ReferenceLine y={0} stroke="var(--red)"    strokeWidth={1.5} strokeDasharray="4 4" label={{ value: '0', fill: 'var(--red)',    fontSize: 11, position: 'insideTopRight' }} />
              <ReferenceLine y={1} stroke="var(--green)"  strokeWidth={1.5} strokeDasharray="4 4" label={{ value: 'Good (1.0)', fill: 'var(--green)', fontSize: 11, position: 'insideTopRight' }} />
              <Line dataKey="sharpe" stroke="var(--accent-bright)" strokeWidth={2} dot={false} name="Sharpe" isAnimationActive={false} />
              <Brush dataKey="datetime" height={22} tickFormatter={fmtDate} {...brushStyle} />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </>
  )
}
