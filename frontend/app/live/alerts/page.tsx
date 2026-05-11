'use client'
// app/live/alerts/page.tsx — Price Alerts
import { useState, useEffect } from 'react'
import { liveApi, stocksApi } from '@/lib/api'

interface Alert {
  id: string
  exchange: string
  token: string
  tsym: string
  condition: 'above' | 'below'
  price: number
  triggered: boolean
  created_at: string
  triggered_at?: string
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [watchlist, setWatchlist] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ tsym: '', condition: 'above', price: '' })
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    Promise.all([
      liveApi.listAlerts().catch(() => ({ data: [] })),
      stocksApi.getWatchlist().catch(() => ({ data: [] })),
    ]).then(([a, w]) => {
      setAlerts(a.data)
      setWatchlist(w.data)
      if (w.data.length) setForm(f => ({ ...f, tsym: w.data[0].tsym }))
    }).finally(() => setLoading(false))
  }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const item = watchlist.find(w => w.tsym === form.tsym)
    if (!item || !form.price) return
    setAdding(true)
    try {
      await liveApi.addAlert({
        exchange: item.exchange,
        token: item.token,
        tsym: item.tsym,
        condition: form.condition,
        price: parseFloat(form.price),
      })
      const res = await liveApi.listAlerts()
      setAlerts(res.data)
      setForm(f => ({ ...f, price: '' }))
    } catch (e: any) {
      alert(e.response?.data?.detail || e.message)
    } finally {
      setAdding(false)
    }
  }

  const pending = alerts.filter(a => !a.triggered)
  const triggered = alerts.filter(a => a.triggered)

  const fmtDate = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })

  return (
    <>
      <div className="topbar">
        <span className="topbar-title">🔔 Price Alerts</span>
        <div className="topbar-actions">
          <span className="badge badge-blue">{pending.length} active</span>
          <span className="badge badge-green">{triggered.length} triggered</span>
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 24, alignItems: 'start' }}>

          {/* Add alert form */}
          <div className="card" style={{ position: 'sticky', top: 58 }}>
            <h3 style={{ marginBottom: 16 }}>➕ New Alert</h3>
            <form onSubmit={handleAdd}>
              <div className="form-group">
                <label className="form-label">Symbol</label>
                <select className="input" value={form.tsym} onChange={e => setForm(f => ({ ...f, tsym: e.target.value }))}>
                  {watchlist.length === 0 && <option>Add stocks to watchlist first</option>}
                  {watchlist.map(w => <option key={w.tsym} value={w.tsym}>{w.tsym}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Condition</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['above', 'below'].map(c => (
                    <button key={c} type="button"
                      className={`btn ${form.condition === c ? 'btn-primary' : 'btn-secondary'} btn-sm`}
                      style={{ flex: 1 }}
                      onClick={() => setForm(f => ({ ...f, condition: c }))}>
                      {c === 'above' ? '📈 Above' : '📉 Below'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Price</label>
                <input className="input" type="number" step="0.01" placeholder="e.g. 1850.00"
                  value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
                  style={{ fontFamily: 'monospace' }} required />
              </div>
              {form.tsym && form.price && (
                <div style={{ background: 'var(--accent-glow)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 14, fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  Alert when <strong style={{ color: 'var(--accent-bright)' }}>{form.tsym}</strong> goes{' '}
                  <strong style={{ color: form.condition === 'above' ? 'var(--green)' : 'var(--red)' }}>{form.condition}</strong>{' '}
                  <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>₹{parseFloat(form.price || '0').toFixed(2)}</strong>
                </div>
              )}
              <button className="btn btn-primary w-full" type="submit"
                disabled={adding || !form.tsym || !form.price || watchlist.length === 0}>
                {adding ? <><div className="spinner" style={{ width: 16, height: 16 }} /> Adding...</> : '🔔 Set Alert'}
              </button>
            </form>

            <div className="divider" />
            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              <p>Alerts are checked against live WebSocket ticks. The backend will log when a condition is met.</p>
            </div>
          </div>

          {/* Alert lists */}
          <div>
            {loading && (
              <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', color: 'var(--text-secondary)' }}>
                <div className="spinner" /> Loading alerts...
              </div>
            )}

            {!loading && alerts.length === 0 && (
              <div className="card" style={{ textAlign: 'center', padding: '60px 32px', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '3rem', marginBottom: 12 }}>🔔</div>
                <h2 style={{ color: 'var(--text-primary)', marginBottom: 8 }}>No Alerts Set</h2>
                <p>Add a price alert using the form to get notified when a stock hits your target</p>
              </div>
            )}

            {/* Active alerts */}
            {pending.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ marginBottom: 12 }}>⏳ Active Alerts</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {pending.map(a => (
                    <div key={a.id} className="card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ fontSize: '1.5rem' }}>{a.condition === 'above' ? '📈' : '📉'}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '1rem' }}>{a.tsym}</div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                          Trigger when price goes{' '}
                          <span style={{ color: a.condition === 'above' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{a.condition}</span>{' '}
                          <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>₹{a.price.toFixed(2)}</span>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>Set {fmtDate(a.created_at)}</div>
                      </div>
                      <span className="badge badge-blue">{a.exchange}</span>
                      <span className="badge badge-yellow">⏳ Waiting</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Triggered alerts */}
            {triggered.length > 0 && (
              <div>
                <h3 style={{ marginBottom: 12 }}>✅ Triggered Alerts</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {triggered.map(a => (
                    <div key={a.id} className="card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, borderColor: 'rgba(34,197,94,0.2)', background: 'var(--green-dim)' }}>
                      <div style={{ fontSize: '1.5rem' }}>✅</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '1rem' }}>{a.tsym}</div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                          Hit target: <span style={{ color: a.condition === 'above' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{a.condition}</span>{' '}
                          <span style={{ fontFamily: 'monospace' }}>₹{a.price.toFixed(2)}</span>
                        </div>
                        {a.triggered_at && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>Triggered {fmtDate(a.triggered_at)}</div>
                        )}
                      </div>
                      <span className="badge badge-green">✓ Triggered</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
