'use client'
// app/data/page.tsx — Data Manager: download, resample, delete with SSE progress
import { useState, useEffect, useRef } from 'react'
import { dataApi, createSSEStream } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import Link from 'next/link'

interface DataSummary {
  symbol: string
  records: number
  date_from: string | null
  date_to: string | null
  size_kb: number
  resampled_versions: string[]
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
  const [stockInput, setStockInput] = useState('')
  const [downloadDays, setDownloadDays] = useState(365)
  const [chunkDays, setChunkDays] = useState(50)
  const [downloadExchange, setDownloadExchange] = useState('NSE')
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  // Resample state
  const [resampleSymbol, setResampleSymbol] = useState('')
  const [resampleInterval, setResampleInterval] = useState(5)
  const [resampleDays, setResampleDays] = useState(90)
  const [resampling, setResampling] = useState(false)

  const loadSummary = async () => {
    try {
      const res = await dataApi.getSummary()
      setSummaries(res.data)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { loadSummary() }, [])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  const addLog = (text: string, type: LogEntry['type'] = 'info') => {
    setLogs((prev) => [...prev, { text, type }])
  }

  const handleDownload = () => {
    const stocks = stockInput.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
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

    // POST with SSE response
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

  const handleResample = async () => {
    if (!resampleSymbol) return
    setResampling(true)
    try {
      const res = await dataApi.resample(resampleSymbol, resampleInterval, resampleDays)
      const d = res.data
      await loadSummary()
      alert(`✅ Resampled to ${resampleInterval}min: ${d.records} candles\n${d.date_from} → ${d.date_to}`)
    } catch (err: any) {
      alert(`Error: ${err.response?.data?.detail || err.message}`)
    } finally {
      setResampling(false)
    }
  }

  const handleDelete = async (symbol: string) => {
    if (!confirm(`Delete all data for ${symbol}? This cannot be undone.`)) return
    try {
      await dataApi.deleteSymbol(symbol)
      setSummaries(s => s.filter(i => i.symbol !== symbol))
    } catch (err: any) {
      alert(`Error: ${err.response?.data?.detail || err.message}`)
    }
  }

  const fmtDate = (s: string | null) => s ? s.slice(0, 10) : '—'

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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>

          {/* Download panel */}
          <div className="card">
            <div className="card-header">
              <h2>📥 Download Data</h2>
              {!auth.logged_in && <span className="badge badge-red">Login required</span>}
            </div>

            <div className="form-group">
              <label className="form-label">Stock Symbols (one per line or comma-separated)</label>
              <textarea
                className="input"
                id="stocks-textarea"
                rows={5}
                placeholder={'INFY\nTCS\nRELIANCE\nor: INFY, TCS, RELIANCE'}
                value={stockInput}
                onChange={(e) => setStockInput(e.target.value)}
                style={{ resize: 'vertical', fontFamily: 'var(--font-mono)' }}
                disabled={downloading}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
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
                <label className="form-label">Chunk size</label>
                <select className="input" value={chunkDays} onChange={e => setChunkDays(Number(e.target.value))} disabled={downloading}>
                  {[30, 50, 75, 100].map(d => <option key={d} value={d}>{d}d</option>)}
                </select>
              </div>
            </div>

            <button
              className="btn btn-primary w-full"
              id="download-btn"
              onClick={handleDownload}
              disabled={downloading || !auth.logged_in || !stockInput.trim()}
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

          {/* Resample panel */}
          <div className="card">
            <div className="card-header">
              <h2>🔄 Resample</h2>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: 20 }}>
              Convert 1-min data to a higher interval (5min, 15min, 1h etc.) and save as a separate file.
            </p>

            <div className="form-group">
              <label className="form-label">Symbol (must be downloaded first)</label>
              <select
                className="input"
                id="resample-symbol"
                value={resampleSymbol}
                onChange={e => setResampleSymbol(e.target.value)}
              >
                <option value="">— Select symbol —</option>
                {summaries.filter(s => !s.symbol.includes('_')).map(s => (
                  <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Interval (minutes)</label>
                <select className="input" value={resampleInterval} onChange={e => setResampleInterval(Number(e.target.value))}>
                  {[2, 3, 5, 10, 15, 30, 60, 120, 240].map(v => (
                    <option key={v} value={v}>{v >= 60 ? `${v / 60}h` : `${v}min`}</option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Last N days</label>
                <select className="input" value={resampleDays} onChange={e => setResampleDays(Number(e.target.value))}>
                  {[30, 60, 90, 180, 365].map(d => <option key={d} value={d}>{d}d</option>)}
                </select>
              </div>
            </div>

            <button
              className="btn btn-secondary w-full"
              id="resample-btn"
              onClick={handleResample}
              disabled={resampling || !resampleSymbol}
            >
              {resampling ? <><div className="spinner" style={{ width: 16, height: 16 }} /> Resampling...</> : '🔄 Resample'}
            </button>

            <div className="divider" />

            <h3 style={{ marginBottom: 12, fontSize: '0.9375rem' }}>Common intervals</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {[[2,'2min'],[3,'3min'],[5,'5min'],[10,'10min'],[15,'15min'],[30,'30min'],[60,'1hr'],[120,'2hr']].map(([val, label]) => (
                <button
                  key={val}
                  className={`checkbox-chip ${resampleInterval === val ? 'active' : ''}`}
                  onClick={() => setResampleInterval(Number(val))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
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
                    <th>Records</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Size</th>
                    <th>Resampled</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.filter(s => !s.symbol.includes('_')).map(item => (
                    <tr key={item.symbol}>
                      <td>
                        <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>{item.symbol}</span>
                      </td>
                      <td>
                        <span style={{ color: 'var(--accent-bright)' }}>{item.records.toLocaleString()}</span>
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{fmtDate(item.date_from)}</td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{fmtDate(item.date_to)}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{item.size_kb.toFixed(0)} KB</td>
                      <td>
                        {item.resampled_versions.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {item.resampled_versions.map(v => (
                              <span key={v} className="badge badge-blue" style={{ fontSize: '0.7rem' }}>{v}</span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>—</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Link
                            href={`/analysis?symbol=${item.symbol}`}
                            className="btn btn-secondary btn-sm"
                          >
                            📊
                          </Link>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDelete(item.symbol)}
                            title="Delete data"
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
