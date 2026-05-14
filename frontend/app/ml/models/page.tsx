'use client'
// app/ml/models/page.tsx — Saved Models list + Predict
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { mlApi } from '@/lib/api'
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts'

interface MLModel {
  id: string
  name: string
  symbol: string
  model_type: string
  task: string
  metrics: Record<string, number> | null
  created_at: string
  // from /ml/models/{id} detail endpoint:
  features?: string[]
  hyperparams?: Record<string, any>
  model_path?: string
  data_interval?: string
}

const getMetric = (m: MLModel, key: string): number | null => m.metrics?.[key] ?? null


const MODEL_ICONS: Record<string, string> = {
  random_forest: '🌲', xgboost: '⚡', lightgbm: '💨', lstm: '🧠',
}

export default function ModelsPage() {
  const router = useRouter()
  const [models, setModels] = useState<MLModel[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [selectedModel, setSelectedModel] = useState<MLModel | null>(null)
  const [predictHorizon, setPredictHorizon] = useState(10)
  const [predicting, setPredicting] = useState(false)
  const [prediction, setPrediction] = useState<any>(null)
  const [recentPrices, setRecentPrices] = useState<{ datetime: string; close: number }[]>([])
  const [showDetail, setShowDetail] = useState<MLModel | null>(null)
  const [backtest, setBacktest] = useState<any>(null)
  const [loadingBacktest, setLoadingBacktest] = useState(false)

  useEffect(() => {
    mlApi.listModels()
      .then(r => { setModels(r.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  // Auto-select model from query param
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('predict')
    if (id && models.length) {
      const m = models.find(m => m.id === id)
      if (m) setSelectedModel(m)
    }
  }, [models])

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this model?')) return
    await mlApi.deleteModel(id)
    setModels(p => p.filter(m => m.id !== id))
    if (selectedModel?.id === id) { setSelectedModel(null); setBacktest(null) }
  }

  const handleBacktest = async () => {
    if (!selectedModel) return
    setLoadingBacktest(true); setBacktest(null)
    try {
      const r = await mlApi.backtest(selectedModel.id)
      setBacktest(r.data)
    } catch (e: any) {
      alert(e.response?.data?.detail || e.message)
    } finally {
      setLoadingBacktest(false)
    }
  }

  const handlePredict = async () => {
    if (!selectedModel) return
    setPredicting(true); setPrediction(null); setRecentPrices([])
    try {
      const [predRes, pricesRes] = await Promise.all([
        mlApi.predict(selectedModel.id, selectedModel.symbol, predictHorizon),
        mlApi.getRecentPrices(selectedModel.symbol, selectedModel.data_interval || '1min', 60),
      ])
      setPrediction(predRes.data)
      setRecentPrices(pricesRes.data.prices)
    } catch (e: any) {
      alert(e.response?.data?.detail || e.message)
    } finally {
      setPredicting(false)
    }
  }

  const filtered = models.filter(m =>
    !filter || m.symbol.toLowerCase().includes(filter.toLowerCase()) || m.model_type.includes(filter.toLowerCase())
  )

  const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  const fmtPct = (v: number | null) => v != null ? `${(v * 100).toFixed(2)}%` : '—'

  return (
    <>
      <div className="topbar">
        <span className="topbar-title">📦 Saved Models</span>
        <div className="topbar-actions">
          <span className="badge badge-blue">{models.length} models</span>
          <button className="btn btn-primary btn-sm" onClick={() => router.push('/ml/train')}>+ Train New</button>
        </div>
      </div>

      <div className="page-body">
        <div className="models-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 24, alignItems: 'start' }}>

          {/* Models table */}
          <div>
            {/* Search */}
            <div style={{ marginBottom: 16 }}>
              <input className="input" placeholder="Filter by symbol or model type..."
                value={filter} onChange={e => setFilter(e.target.value)} />
            </div>

            {loading && (
              <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', color: 'var(--text-secondary)' }}>
                <div className="spinner" /> Loading models...
              </div>
            )}

            {!loading && models.length === 0 && (
              <div className="card" style={{ textAlign: 'center', padding: '60px 32px', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '3rem', marginBottom: 12 }}>📦</div>
                <h2 style={{ color: 'var(--text-primary)', marginBottom: 8 }}>No Models Yet</h2>
                <p>Train your first model to see it here.</p>
                <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => router.push('/ml/train')}>
                  🧠 Train a Model
                </button>
              </div>
            )}

            {filtered.length > 0 && (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="table-wrapper" style={{ border: 'none', borderRadius: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Symbol</th>
                        <th>Accuracy</th>
                        <th>F1</th>
                        <th>Sharpe</th>
                        <th>Horizon</th>
                        <th>Trained</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(m => (
                        <tr key={m.id}
                          style={{ cursor: 'pointer', background: selectedModel?.id === m.id ? 'var(--accent-glow)' : 'transparent' }}
                          onClick={() => { const next = selectedModel?.id === m.id ? null : m; setSelectedModel(next); setBacktest(null); setPrediction(null) }}
                        >
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span>{MODEL_ICONS[m.model_type] || '🤖'}</span>
                              <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                                {m.model_type.replace(/_/g, ' ')}
                              </span>
                            </div>
                          </td>
                          <td><span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{m.symbol}</span></td>
                          <td>
                            {(() => { const acc = getMetric(m, 'accuracy'); return (
                              <span style={{ color: (acc ?? 0) >= 0.55 ? 'var(--green)' : (acc ?? 0) >= 0.5 ? 'var(--yellow)' : 'var(--red)' }}>
                                {fmtPct(acc)}
                              </span>
                            )})()}
                          </td>
                          <td style={{ fontFamily: 'monospace' }}>{getMetric(m, 'f1')?.toFixed(4) ?? '—'}</td>
                          <td style={{ fontFamily: 'monospace', color: (getMetric(m, 'sharpe') ?? 0) > 1 ? 'var(--green)' : 'var(--text-secondary)' }}>
                            {getMetric(m, 'sharpe')?.toFixed(3) ?? '—'}
                          </td>
                          <td style={{ color: 'var(--text-secondary)' }}>
                            {m.hyperparams?.target_horizon ?? '—'}c · {m.data_interval ?? '—'}
                          </td>
                          <td style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{fmtDate(m.created_at)}</td>
                          <td onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="btn btn-secondary btn-sm" onClick={() => setShowDetail(m)} title="Details">ℹ</button>
                              <button className="btn btn-danger btn-sm" onClick={() => handleDelete(m.id)} title="Delete">🗑</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Predict panel */}
          <div style={{ position: 'sticky', top: 58 }}>
            {!selectedModel ? (
              <div className="card" style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '2rem', marginBottom: 10 }}>🔮</div>
                <p>Click a model to select it for prediction</p>
              </div>
            ) : (
              <div className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                  <span style={{ fontSize: '1.5rem' }}>{MODEL_ICONS[selectedModel.model_type] || '🤖'}</span>
                  <div>
                    <h3>{selectedModel.symbol}</h3>
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                      {selectedModel.model_type.replace(/_/g, ' ')}
                    </div>
                  </div>
                  <span className={`badge ${(getMetric(selectedModel,'accuracy') ?? 0) >= 0.55 ? 'badge-green' : 'badge-yellow'}`} style={{ marginLeft: 'auto' }}>
                    {fmtPct(getMetric(selectedModel, 'accuracy'))}
                  </span>
                </div>

                {/* Model quick stats */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
                  {[
                    ['F1 Score', getMetric(selectedModel, 'f1')?.toFixed(4) ?? '—'],
                    ['Sharpe', getMetric(selectedModel, 'sharpe')?.toFixed(3) ?? '—'],
                    ['Horizon', selectedModel.hyperparams?.target_horizon != null ? `${selectedModel.hyperparams.target_horizon}c` : '—'],
                    ['Interval', selectedModel.data_interval ?? '—'],
                  ].map(([l, v]) => (
                    <div key={l} style={{ background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)', padding: '8px 12px' }}>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }}>{l}</div>
                      <div style={{ fontWeight: 700, fontFamily: 'monospace' }}>{v}</div>
                    </div>
                  ))}
                </div>

                {/* Features */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>FEATURES</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {(selectedModel.features ?? []).map(f => (
                      <span key={f} className="badge badge-blue" style={{ fontSize: '0.7rem' }}>{f}</span>
                    ))}
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Prediction horizon (candles)</label>
                  <select className="input" value={predictHorizon} onChange={e => setPredictHorizon(Number(e.target.value))}>
                    {[1, 3, 5, 10, 15, 20].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>

                <button className="btn btn-primary w-full" onClick={handlePredict} disabled={predicting}>
                  {predicting ? <><div className="spinner" style={{ width: 16, height: 16 }} /> Predicting...</> : '🔮 Run Prediction'}
                </button>

                {/* Confusion matrix from training metrics */}
                {selectedModel.metrics?.confusion_matrix && selectedModel.metrics?.confusion_labels && (() => {
                  const cm = selectedModel.metrics.confusion_matrix as unknown as number[][]
                  const labels = selectedModel.metrics.confusion_labels as unknown as string[]
                  const total = cm.flat().reduce((a: number, b: number) => a + b, 0)
                  return (
                    <div style={{ marginTop: 16 }}>
                      <div className="divider" />
                      <h4 style={{ marginBottom: 10 }}>🔲 Confusion Matrix</h4>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                        Actual ↓ / Predicted →
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: `80px repeat(${labels.length}, 1fr)`, gap: 3, fontSize: '0.72rem' }}>
                        <div />
                        {labels.map(l => <div key={l} style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text-secondary)' }}>{l}</div>)}
                        {cm.map((row: number[], ri: number) => [
                          <div key={`l${ri}`} style={{ fontWeight: 700, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}>{labels[ri]}</div>,
                          ...row.map((cell: number, ci: number) => (
                            <div key={`${ri}-${ci}`} style={{
                              background: ri === ci ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.12)',
                              border: `1px solid ${ri === ci ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.2)'}`,
                              borderRadius: 4, padding: '6px 4px', textAlign: 'center',
                              fontWeight: ri === ci ? 700 : 400, fontFamily: 'monospace',
                            }}>
                              {cell}
                              <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                                {total ? `${(cell/total*100).toFixed(0)}%` : ''}
                              </div>
                            </div>
                          )),
                        ])}
                      </div>
                    </div>
                  )
                })()}

                {/* Backtest section */}
                {selectedModel.model_type !== 'lstm' && (
                  <div style={{ marginTop: 16 }}>
                    <div className="divider" />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <h4>📊 Backtest</h4>
                      <button className="btn btn-secondary btn-sm" onClick={handleBacktest} disabled={loadingBacktest}>
                        {loadingBacktest ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Running...</> : '▶ Run Backtest'}
                      </button>
                    </div>

                    {backtest && !backtest.skipped && (
                      <div className="fade-in">
                        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                          <div style={{ background: 'var(--bg-raised)', borderRadius: 6, padding: '6px 12px' }}>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Win Rate</div>
                            <div style={{ fontWeight: 700, fontFamily: 'monospace', color: backtest.win_rate >= 55 ? 'var(--green)' : backtest.win_rate >= 50 ? 'var(--yellow)' : 'var(--red)' }}>
                              {backtest.win_rate?.toFixed(1)}%
                            </div>
                          </div>
                          <div style={{ background: 'var(--bg-raised)', borderRadius: 6, padding: '6px 12px' }}>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Correct / Total</div>
                            <div style={{ fontWeight: 700, fontFamily: 'monospace' }}>
                              {backtest.correct} / {backtest.total}
                            </div>
                          </div>
                        </div>

                        {backtest.equity_curve?.length > 0 && (() => {
                          const endEq = backtest.equity_curve[backtest.equity_curve.length - 1]?.equity ?? 100
                          const lineColor = endEq > 100 ? 'var(--green)' : 'var(--red)'
                          return (
                            <>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                                Simulated equity curve (start = 100)
                              </div>
                              <ResponsiveContainer width="100%" height={160}>
                                <LineChart data={backtest.equity_curve} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                                  <XAxis dataKey="datetime" tick={false} />
                                  <YAxis domain={['auto', 'auto']} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} width={45} />
                                  <Tooltip
                                    contentStyle={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.75rem' }}
                                    formatter={(v: number) => [v.toFixed(2), 'Equity']}
                                  />
                                  <ReferenceLine y={100} stroke="var(--border-light)" strokeDasharray="4 2"
                                    label={{ value: 'Start', fill: 'var(--text-muted)', fontSize: 9 }} />
                                  <Line type="monotone" dataKey="equity" stroke={lineColor} strokeWidth={2} dot={false} name="Equity" isAnimationActive={false} />
                                </LineChart>
                              </ResponsiveContainer>
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>
                                +1 per correct directional prediction, −0.5 per wrong. Above 100 = positive historical edge.
                              </div>
                            </>
                          )
                        })()}
                      </div>
                    )}
                    {backtest?.skipped && (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{backtest.reason}</div>
                    )}
                  </div>
                )}

                {/* Prediction result */}
                {prediction && (
                  <div className="fade-in" style={{ marginTop: 20 }}>
                    <div className="divider" />
                    <h4 style={{ marginBottom: 14 }}>🔮 Prediction</h4>

                    <div style={{
                      textAlign: 'center', padding: '20px',
                      background: prediction.signal === 'BUY' ? 'var(--green-dim)' : prediction.signal === 'SELL' ? 'var(--red-dim)' : 'var(--bg-raised)',
                      border: `1px solid ${prediction.signal === 'BUY' ? 'rgba(34,197,94,0.3)' : prediction.signal === 'SELL' ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-md)', marginBottom: 14
                    }}>
                      <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>
                        {prediction.signal === 'BUY' ? '📈' : prediction.signal === 'SELL' ? '📉' : '➡️'}
                      </div>
                      <div style={{
                        fontSize: '1.5rem', fontWeight: 800,
                        color: prediction.signal === 'BUY' ? 'var(--green)' : prediction.signal === 'SELL' ? 'var(--red)' : 'var(--text-secondary)'
                      }}>
                        {prediction.signal}
                      </div>
                      {prediction.confidence != null && (
                        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: 6 }}>
                          Confidence: <strong>{(prediction.confidence * 100).toFixed(1)}%</strong>
                        </div>
                      )}
                    </div>

                    {prediction.probabilities && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        {Object.entries(prediction.probabilities).map(([label, prob]: [string, any]) => (
                          <div key={label} style={{ flex: 1, background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)', padding: '8px', textAlign: 'center' }}>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>{label}</div>
                            <div style={{ fontWeight: 700, fontFamily: 'monospace', color: label === 'BUY' ? 'var(--green)' : label === 'SELL' ? 'var(--red)' : 'var(--text-secondary)' }}>
                              {(prob * 100).toFixed(1)}%
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Prediction chart: recent actual prices + predicted extension */}
                    {recentPrices.length > 0 && (() => {
                      const lastClose = recentPrices[recentPrices.length - 1]?.close
                      const lastDt = recentPrices[recentPrices.length - 1]?.datetime
                      const predColor = prediction.signal === 'BUY' ? 'var(--green)'
                        : prediction.signal === 'SELL' ? 'var(--red)' : 'var(--yellow)'

                      const chartData = [
                        ...recentPrices.map(p => ({ datetime: p.datetime, actual: p.close })),
                        ...(prediction.predictions ?? []).map((p: any) => ({
                          datetime: `+${p.candle}`,
                          predicted: p.value ?? (p.direction === 'UP' ? lastClose * 1.001 : lastClose * 0.999),
                        })),
                      ]

                      return (
                        <div style={{ marginTop: 14 }}>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                            Price context (60 candles + {predictHorizon} predicted)
                          </div>
                          <ResponsiveContainer width="100%" height={160}>
                            <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                              <XAxis dataKey="datetime" tick={false} />
                              <YAxis domain={['auto', 'auto']} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} width={52} />
                              <Tooltip
                                contentStyle={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.75rem' }}
                                formatter={(v: number) => v.toFixed(2)}
                              />
                              <ReferenceLine x={lastDt} stroke="var(--border-light)" strokeDasharray="4 2"
                                label={{ value: 'Now', fill: 'var(--text-muted)', fontSize: 9 }} />
                              <Line type="monotone" dataKey="actual" stroke="var(--text-secondary)" dot={false} strokeWidth={1.5} name="Actual" isAnimationActive={false} />
                              <Line type="monotone" dataKey="predicted" stroke={predColor} dot={{ r: 3, fill: predColor }}
                                strokeWidth={2} strokeDasharray="5 3" name="Predicted" isAnimationActive={false} />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </div>
                      )
                    })()}

                    <div style={{ marginTop: 12, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Predicted at {new Date(prediction.predicted_at || Date.now()).toLocaleTimeString()}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Detail modal */}
        {showDetail && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            onClick={() => setShowDetail(null)}>
            <div className="card fade-in" style={{ maxWidth: 600, width: '100%', maxHeight: '80vh', overflowY: 'auto' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <h2>{MODEL_ICONS[showDetail.model_type]} {showDetail.symbol} — {showDetail.model_type.replace(/_/g, ' ')}</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowDetail(null)}>✕</button>
              </div>
              <div className="table-wrapper">
                <table>
                  <tbody>
                    {[
                      ['Model ID', showDetail.id],
                      ['Name', showDetail.name],
                      ['Symbol', showDetail.symbol],
                      ['Type', showDetail.model_type],
                      ['Task', showDetail.task],
                      ['Features', (showDetail.features ?? []).join(', ') || '—'],
                      ['Accuracy', fmtPct(getMetric(showDetail, 'accuracy'))],
                      ['F1 Score', getMetric(showDetail, 'f1')?.toFixed(6) ?? '—'],
                      ['Sharpe', getMetric(showDetail, 'sharpe')?.toFixed(4) ?? '—'],
                      ['Interval', showDetail.data_interval ?? '—'],
                      ['File', showDetail.model_path ?? '—'],
                      ['Trained', fmtDate(showDetail.created_at)],
                    ].map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ color: 'var(--text-muted)', width: 140, fontSize: '0.8125rem' }}>{k}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8125rem', wordBreak: 'break-all' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
