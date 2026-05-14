'use client'
// app/data/page.tsx — Data Manager: download and manage historical stock data
import { useState, useEffect, useRef } from 'react'
import { dataApi, stocksApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import Link from 'next/link'

interface DataSummary {
  symbol: string
  exchange: string
  records: number
  date_from: string | null
  date_to: string | null
  last_updated: string | null
}

interface LogEntry {
  text: string
  type: 'info' | 'ok' | 'err' | 'warn'
}

interface DownloadProgress {
  current: number
  total: number
  currentSymbol: string
  done: boolean
}

export default function DataPage() {
  const { auth } = useAppStore()

  const [summaries, setSummaries] = useState<DataSummary[]>([])
  const [loading, setLoading] = useState(true)

  // Download form state
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchDebounce = useRef<NodeJS.Timeout | null>(null)
  const [downloadDays, setDownloadDays] = useState(365)
  const [chunkDays, setChunkDays] = useState(50)
  const [downloadExchange, setDownloadExchange] = useState('NSE')
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  const loadSummary = async () => {
    try {
      const res = await dataApi.getSummary()
      setSummaries(res.data)
    } catch {}
    setLoading(false)
  }

  useEffect(() => {
    loadSummary()
    // Pre-fill from ?symbols=INFY,TCS URL param (coming from Stock Search)
    const syms = new URLSearchParams(window.location.search).get('symbols')
    if (syms) {
      const parsed = syms.split(',').map(s => s.trim()).filter(Boolean)
      if (parsed.length) setSelectedSymbols(parsed)
    }
  }, [])

  // Live search debounce
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    if (!searchQuery.trim() || searchQuery.length < 2) { setSearchResults([]); setShowDropdown(false); return }
    searchDebounce.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await stocksApi.search(searchQuery, downloadExchange)
        setSearchResults(res.data.slice(0, 10))
        setShowDropdown(true)
      } catch { setSearchResults([]) }
      finally { setSearching(false) }
    }, 350)
  }, [searchQuery, downloadExchange])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  const addLog = (text: string, type: LogEntry['type'] = 'info') => {
    setLogs((prev) => [...prev, { text, type }])
  }

  const addSymbol = (tsym: string) => {
    const sym = tsym.trim().toUpperCase()
    if (sym && !selectedSymbols.includes(sym)) setSelectedSymbols(prev => [...prev, sym])
    setSearchQuery('')
    setShowDropdown(false)
  }

  const removeSymbol = (sym: string) => setSelectedSymbols(prev => prev.filter(s => s !== sym))

  const handleDownload = () => {
    const stocks = selectedSymbols
    if (!stocks.length) return

    setDownloading(true)
    setLogs([])
    setProgress({ current: 0, total: stocks.length, currentSymbol: '', done: false })
    addLog(`Starting download for ${stocks.length} stock(s)...`, 'info')

    const url = `/api/data/download`
    const payload = {
      stocks,
      exchange: downloadExchange,
      days: downloadDays,
      chunk_days: chunkDays,
    }

    const controller = new AbortController()
    cancelRef.current = () => controller.abort()

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).then(async (res) => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue
          try {
            const data = JSON.parse(part.slice(6))
            handleSSEEvent(data)
          } catch {}
        }
      }
    }).catch((err) => {
      if (err.name !== 'AbortError') addLog(`Error: ${err.message}`, 'err')
    }).finally(() => {
      setDownloading(false)
      loadSummary()
    })
  }

  const handleSSEEvent = (data: any) => {
    switch (data.type) {
      case 'search':
        setProgress(p => ({ ...p!, current: data.index, currentSymbol: data.stock }))
        addLog(`[${data.index + 1}/${data.total}] Searching: ${data.stock}`, 'info')
        break
      case 'found':
        addLog(`  ✓ Found: ${data.symbol} (token: ${data.token})`, 'ok')
        break
      case 'fresh':
        addLog(`  📥 Downloading ${data.days} days of fresh data...`, 'info')
        break
      case 'incremental':
        addLog(`  🔄 Incremental update from ${data.from}`, 'info')
        break
      case 'up_to_date':
        addLog(`  ✅ Already up to date`, 'ok')
        break
      case 'chunk':
        addLog(`  📦 Chunk ${data.from} → ${data.to}: ${data.records} records`, 'info')
        break
      case 'done':
        addLog(`  ✅ ${data.symbol}: ${data.total.toLocaleString()} total records (${data.new} new)`, 'ok')
        break
      case 'error':
        addLog(`  ❌ ${data.stock}: ${data.msg}`, 'err')
        break
      case 'complete':
        setProgress(p => ({ ...p!, done: true, current: p!.total }))
        addLog(`\n✅ All done! Downloaded ${data.total_stocks} stock(s)`, 'ok')
        break
      default:
        break
    }
  }

  const handleDelete = async (symbol: string, exchange: string) => {
    if (!confirm(`Delete all data for ${symbol} (${exchange})? This cannot be undone.`)) return
    try {
      await dataApi.deleteSymbol(symbol, exchange)
      setSummaries(s => s.filter(i => !(i.symbol === symbol && i.exchange === exchange)))
    } catch (err: any) {
      alert(`Error: ${err.response?.data?.detail || err.message}`)
    }
  }

  const fmtDate = (s: string | null | undefined) => s ? s.slice(0, 10) : '—'

  return (
    <>
      <div className="topbar">
        <span className="topbar-title">💾 Data Manager</span>
        <div className="topbar-actions">
          <span className="badge badge-blue">{summaries.length} stocks saved</span>
          <button className="btn btn-secondary btn-sm" onClick={loadSummary}>↻ Refresh</button>
        </div>
      </div>

      <div className="page-body">

        {/* Help banner */}
        <div style={{
          background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
          borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 20,
          fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.6,
        }}>
          <strong style={{ color: 'var(--accent-bright)' }}>ℹ How data works: </strong>
          Download 1-minute historical candles for any stock. When you run analysis or train an ML model
          at a different interval (e.g. 5min), the system <strong>automatically resamples and caches</strong> that
          interval — it will appear in the table below. Deleting a stock removes its 1min data and all cached interval files.
        </div>

        {/* Download panel — full width */}
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <h2>📥 Download Data</h2>
            {!auth.logged_in && <span className="badge badge-red">Login required</span>}
          </div>

          <div className="form-group">
            <label className="form-label">Stock Symbols</label>

            {/* Selected chips */}
            {selectedSymbols.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {selectedSymbols.map(sym => (
                  <div key={sym} style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    background: 'var(--accent-glow)', border: '1px solid rgba(59,130,246,0.3)',
                    borderRadius: 20, padding: '4px 10px', fontSize: '0.8125rem', fontWeight: 600, fontFamily: 'monospace'
                  }}>
                    {sym}
                    {!downloading && (
                      <button onClick={() => removeSymbol(sym)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1, padding: '0 0 0 2px', fontSize: '0.9rem' }}>
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {!downloading && (
                  <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.75rem' }}
                    onClick={() => setSelectedSymbols([])}>
                    Clear all
                  </button>
                )}
              </div>
            )}

            {/* Search to add */}
            {!downloading && (
              <div ref={searchRef} style={{ position: 'relative' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      className="input"
                      placeholder={auth.logged_in ? 'Search stock name or symbol to add…' : 'Type exact symbol (e.g. INFY-EQ) — login for search'}
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && searchQuery.trim()) {
                          if (searchResults.length > 0) addSymbol(searchResults[0].tsym)
                          else addSymbol(searchQuery)
                        }
                      }}
                      style={{ paddingRight: searching ? 36 : 12 }}
                    />
                    {searching && (
                      <div className="spinner" style={{ width: 14, height: 14, position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }} />
                    )}
                  </div>
                  <button className="btn btn-secondary" style={{ flexShrink: 0 }}
                    onClick={() => {
                      if (!searchQuery.trim()) return
                      // Use first search result if available (avoids picking wrong symbol like SBINMID150 for "SBIN")
                      addSymbol(searchResults.length > 0 ? searchResults[0].tsym : searchQuery)
                    }}>
                    + Add
                  </button>
                </div>

                {/* Dropdown results */}
                {showDropdown && searchResults.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4,
                    background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-md)', maxHeight: 220, overflowY: 'auto'
                  }}>
                    {searchResults.map(r => (
                      <div key={r.tsym}
                        onClick={() => addSymbol(r.tsym)}
                        style={{
                          padding: '9px 14px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center',
                          borderBottom: '1px solid var(--border)', transition: 'background 0.1s'
                        }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                      >
                        <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.875rem', minWidth: 100 }}>{r.tsym}</span>
                        {r.cname && <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.cname}</span>}
                        {selectedSymbols.includes(r.tsym) && <span className="badge badge-green" style={{ marginLeft: 'auto', flexShrink: 0 }}>✓</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {selectedSymbols.length === 0 && (
              <div style={{ fontSize: '0.775rem', color: 'var(--text-muted)', marginTop: 6 }}>
                Search by name or symbol and click to add. Coming from Stock Search? Symbols are pre-filled above.
              </div>
            )}
          </div>

          <div className="data-settings-grid">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Exchange</label>
              <select className="input" value={downloadExchange} onChange={e => setDownloadExchange(e.target.value)} disabled={downloading}>
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Days</label>
              <select className="input" value={downloadDays} onChange={e => setDownloadDays(Number(e.target.value))} disabled={downloading}>
                {[30, 90, 180, 365, 730, 1095, 1825, 3650].map(d => (
                  <option key={d} value={d}>{d === 3650 ? '10yr' : d === 1825 ? '5yr' : d === 1095 ? '3yr' : d === 730 ? '2yr' : d === 365 ? '1yr' : `${d}d`}</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Chunk size
                <span title="The broker API can't return years of data in one call. Your date range is split into chunks of this many days. Smaller = more reliable. Larger = fewer API calls." style={{ cursor: 'help', color: 'var(--text-muted)', fontSize: '0.8rem' }}>ⓘ</span>
              </label>
              <select className="input" value={chunkDays} onChange={e => setChunkDays(Number(e.target.value))} disabled={downloading}>
                {[30, 50, 75, 100].map(d => <option key={d} value={d}>{d}d</option>)}
              </select>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                {chunkDays === 30 && 'Conservative — use if getting timeouts'}
                {chunkDays === 50 && 'Recommended — works with most brokers'}
                {chunkDays === 75 && 'Faster — fewer API calls, slightly riskier'}
                {chunkDays === 100 && 'Fastest — may hit broker rate limits'}
              </div>
            </div>
          </div>

          <button
            className="btn btn-primary w-full"
            id="download-btn"
            onClick={handleDownload}
            disabled={downloading || !auth.logged_in || selectedSymbols.length === 0}
          >
            {downloading ? (
              <><div className="spinner" style={{ width: 16, height: 16 }} /> Downloading...</>
            ) : '📥 Start Download'}
          </button>

          {/* Progress */}
          {progress && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                <span>{progress.done ? '✅ Complete' : `Processing: ${progress.currentSymbol}`}</span>
                <span>{progress.current}/{progress.total}</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {/* Log */}
          {logs.length > 0 && (
            <div className="log-box" ref={logRef} style={{ marginTop: 14 }}>
              {logs.map((log, i) => (
                <div key={i} className={`log-${log.type}`}>{log.text}</div>
              ))}
            </div>
          )}
        </div>

        {/* Saved data table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2>📁 Saved Stocks</h2>
            {loading && <div className="spinner" />}
          </div>

          {!loading && summaries.length === 0 && (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <div style={{ fontSize: '2rem', marginBottom: 12 }}>📭</div>
              <p>No data downloaded yet. Use the form above to download your first stock.</p>
            </div>
          )}

          {summaries.length > 0 && (
            <div className="table-wrapper" style={{ border: 'none', borderRadius: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Exchange</th>
                    <th>Records</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map(item => (
                    <tr key={`${item.symbol}-${item.exchange}`}>
                      <td>
                        <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>{item.symbol}</span>
                      </td>
                      <td>
                        <span className="badge badge-blue">{item.exchange}</span>
                      </td>
                      <td>
                        <span style={{ color: 'var(--accent-bright)' }}>{item.records.toLocaleString()}</span>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>1min candles</div>
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{fmtDate(item.date_from)}</td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{fmtDate(item.date_to)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Link
                            href={`/analysis?symbol=${item.symbol}`}
                            className="btn btn-secondary btn-sm"
                            title="Analyse"
                          >
                            📊
                          </Link>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDelete(item.symbol, item.exchange)}
                            title="Delete all data"
                          >
                            🗑
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
