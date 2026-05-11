'use client'
// app/stocks/page.tsx — Stock Search & Watchlist
import { useState, useEffect, useRef, useCallback } from 'react'
import { stocksApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import Link from 'next/link'

interface StockResult {
  tsym: string
  token: string
  exchange: string
  cname?: string
}

interface WatchlistItem extends StockResult {
  id: string
  added_at: string
}

export default function StocksPage() {
  const { auth } = useAppStore()
  const [query, setQuery] = useState('')
  const [exchange, setExchange] = useState('NSE')
  const [results, setResults] = useState<StockResult[]>([])
  const [searching, setSearching] = useState(false)
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [watchlistLoading, setWatchlistLoading] = useState(true)
  const [addingMap, setAddingMap] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const watchlistSet = new Set(watchlist.map((w) => w.tsym))

  const showToast = (msg: string, type: 'ok' | 'err' = 'ok') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // Load watchlist on mount
  useEffect(() => {
    stocksApi.getWatchlist()
      .then((res) => setWatchlist(res.data))
      .catch(() => {})
      .finally(() => setWatchlistLoading(false))
  }, [])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim() || query.length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await stocksApi.search(query, exchange)
        setResults(res.data)
      } catch (err: any) {
        if (err.response?.status === 401) showToast('Login to FlatTrade first', 'err')
      } finally {
        setSearching(false)
      }
    }, 400)
  }, [query, exchange])

  const handleAdd = async (stock: StockResult) => {
    setAddingMap((m) => ({ ...m, [stock.tsym]: true }))
    try {
      await stocksApi.addToWatchlist(stock)
      const fresh = await stocksApi.getWatchlist()
      setWatchlist(fresh.data)
      showToast(`✅ ${stock.tsym} added to watchlist`)
    } catch {
      showToast('Failed to add to watchlist', 'err')
    } finally {
      setAddingMap((m) => ({ ...m, [stock.tsym]: false }))
    }
  }

  const handleRemove = async (tsym: string) => {
    try {
      await stocksApi.removeFromWatchlist(tsym)
      setWatchlist((w) => w.filter((i) => i.tsym !== tsym))
      showToast(`Removed ${tsym}`)
    } catch {
      showToast('Failed to remove', 'err')
    }
  }

  return (
    <>
      {/* Topbar */}
      <div className="topbar">
        <span className="topbar-title">🔍 Stock Search</span>
        <div className="topbar-actions">
          <span className="badge badge-blue">{watchlist.length} in watchlist</span>
          {!auth.logged_in && (
            <Link href="/login" className="btn btn-primary btn-sm">Login first</Link>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 70, right: 24, zIndex: 9999,
          background: toast.type === 'ok' ? 'var(--green-dim)' : 'var(--red-dim)',
          border: `1px solid ${toast.type === 'ok' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          color: toast.type === 'ok' ? 'var(--green)' : 'var(--red)',
          padding: '10px 18px', borderRadius: 'var(--radius-md)',
          fontWeight: 500, fontSize: '0.9rem', boxShadow: 'var(--shadow-md)',
          animation: 'fadeIn 0.2s ease'
        }}>
          {toast.msg}
        </div>
      )}

      <div className="page-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 24, alignItems: 'start' }}>

          {/* Left — Search */}
          <div>
            <div className="page-header">
              <h1>Search Stocks</h1>
              <p>Search NSE or BSE stocks by name or symbol</p>
            </div>

            {/* Search bar */}
            <div className="card" style={{ marginBottom: 20, padding: 20 }}>
              <div style={{ display: 'flex', gap: 12, marginBottom: 0 }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input
                    className="input"
                    id="stock-search-input"
                    type="text"
                    placeholder="Search by name or symbol (e.g. INFY, Reliance)"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                    autoComplete="off"
                    style={{ paddingLeft: 40 }}
                  />
                  <span style={{
                    position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
                    color: 'var(--text-muted)', pointerEvents: 'none'
                  }}>🔍</span>
                </div>
                <select
                  className="input"
                  id="exchange-select"
                  value={exchange}
                  onChange={(e) => setExchange(e.target.value)}
                  style={{ width: 100 }}
                >
                  <option value="NSE">NSE</option>
                  <option value="BSE">BSE</option>
                </select>
              </div>
            </div>

            {/* Results */}
            {!auth.logged_in && (
              <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔑</div>
                <p>Login to FlatTrade to search stocks</p>
                <Link href="/login" className="btn btn-primary" style={{ marginTop: 16, display: 'inline-flex' }}>
                  Login
                </Link>
              </div>
            )}

            {auth.logged_in && searching && (
              <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--text-secondary)' }}>
                <div className="spinner" />
                <span>Searching {exchange}...</span>
              </div>
            )}

            {auth.logged_in && !searching && results.length > 0 && (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {results.length} results for &quot;{query}&quot; on {exchange}
                </div>
                {results.map((stock) => (
                  <div key={stock.tsym} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '13px 16px', borderBottom: '1px solid var(--border)',
                    transition: 'background 0.15s'
                  }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{stock.tsym}</div>
                      {stock.cname && (
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {stock.cname}
                        </div>
                      )}
                    </div>
                    <span className="badge badge-blue" style={{ flexShrink: 0 }}>{stock.exchange}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontFamily: 'monospace', flexShrink: 0 }}>
                      #{stock.token}
                    </span>
                    {watchlistSet.has(stock.tsym) ? (
                      <span className="badge badge-green" style={{ flexShrink: 0 }}>✓ Added</span>
                    ) : (
                      <button
                        className="btn btn-secondary btn-sm"
                        id={`add-${stock.tsym}`}
                        onClick={() => handleAdd(stock)}
                        disabled={addingMap[stock.tsym]}
                        style={{ flexShrink: 0 }}
                      >
                        {addingMap[stock.tsym] ? <div className="spinner" style={{ width: 14, height: 14 }} /> : '+ Add'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {auth.logged_in && !searching && query.length >= 2 && results.length === 0 && (
              <div className="card" style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)' }}>
                No results found for &quot;{query}&quot; on {exchange}
              </div>
            )}

            {auth.logged_in && !searching && query.length < 2 && (
              <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '2rem', marginBottom: 8 }}>💡</div>
                <p>Type at least 2 characters to search</p>
                <p style={{ fontSize: '0.8125rem', marginTop: 6 }}>Try: INFY, TCS, RELIANCE, NIFTY</p>
              </div>
            )}
          </div>

          {/* Right — Watchlist */}
          <div style={{ position: 'sticky', top: 58 }}>
            <h2 style={{ marginBottom: 14, fontSize: '1.0625rem' }}>⭐ Watchlist</h2>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {watchlistLoading && (
                <div style={{ padding: 24, display: 'flex', gap: 12, alignItems: 'center', color: 'var(--text-secondary)' }}>
                  <div className="spinner" /> Loading...
                </div>
              )}
              {!watchlistLoading && watchlist.length === 0 && (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>⭐</div>
                  No stocks added yet.<br />Search and click &quot;+ Add&quot; to build your list.
                </div>
              )}
              {watchlist.map((item) => (
                <div key={item.tsym} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '11px 14px', borderBottom: '1px solid var(--border)',
                  transition: 'background 0.15s'
                }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{item.tsym}</div>
                    {item.cname && (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.cname}
                      </div>
                    )}
                  </div>
                  <span className="badge badge-blue" style={{ fontSize: '0.7rem' }}>{item.exchange}</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleRemove(item.tsym)}
                    style={{ color: 'var(--text-muted)', padding: '4px 8px' }}
                    title="Remove from watchlist"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {watchlist.length > 0 && (
                <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
                  <Link href="/data" className="btn btn-primary btn-sm w-full" style={{ justifyContent: 'center' }}>
                    💾 Download Data for These →
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
