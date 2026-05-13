'use client'
// app/ml/train/page.tsx — ML Model Training with SSE progress
import { useState, useEffect, useRef } from 'react'
import { dataApi, mlApi } from '@/lib/api'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts'

const MODEL_TYPES = [
  { id: 'random_forest',   label: 'Random Forest',   icon: '🌲', desc: 'Fast, interpretable, good baseline' },
  { id: 'xgboost',         label: 'XGBoost',         icon: '⚡', desc: 'High accuracy gradient boosting' },
  { id: 'lightgbm',        label: 'LightGBM',        icon: '💨', desc: 'Fast training on large datasets' },
  { id: 'lstm',            label: 'LSTM (TensorFlow)',icon: '🧠', desc: 'Sequential deep learning, slower' },
]

const ALL_FEATURES = [
  { id: 'rsi',      label: 'RSI',           group: 'Momentum' },
  { id: 'macd',     label: 'MACD',          group: 'Momentum' },
  { id: 'macd_signal', label: 'MACD Signal', group: 'Momentum' },
  { id: 'sma_20',   label: 'SMA 20',        group: 'Trend' },
  { id: 'ema_20',   label: 'EMA 20',        group: 'Trend' },
  { id: 'sma_50',   label: 'SMA 50',        group: 'Trend' },
  { id: 'bb_upper', label: 'BB Upper',      group: 'Volatility' },
  { id: 'bb_lower', label: 'BB Lower',      group: 'Volatility' },
  { id: 'atr',      label: 'ATR',           group: 'Volatility' },
  { id: 'volume',   label: 'Volume',        group: 'Volume' },
  { id: 'obv',      label: 'OBV',           group: 'Volume' },
  { id: 'vwap',     label: 'VWAP',          group: 'Volume' },
  { id: 'return_1', label: 'Return 1',      group: 'Returns' },
  { id: 'return_5', label: 'Return 5',      group: 'Returns' },
  { id: 'return_10',label: 'Return 10',     group: 'Returns' },
]

const FEATURE_GROUPS = Array.from(new Set(ALL_FEATURES.map(f => f.group)))

interface LogEntry { text: string; type: 'info'|'ok'|'err'|'warn' }

export default function TrainPage() {
  const router = useRouter()
  const { symbols: cachedSymbols, setSymbols: cacheSymbols } = useAppStore()
  const [symbols, setSymbols] = useState<string[]>([])
  const [symbol, setSymbol] = useState('')
  const [modelType, setModelType] = useState('random_forest')
  const [features, setFeatures] = useState(['rsi','macd','sma_20','volume','return_1','return_5'])
  const [targetHorizon, setTargetHorizon] = useState(5)
  const [interval, setInterval] = useState(1)
  const [testSplit, setTestSplit] = useState(0.2)
  const [lstmLayers, setLstmLayers] = useState(2)
  const [lstmUnits, setLstmUnits] = useState(64)
  const [lstmEpochs, setLstmEpochs] = useState(20)
  const [lstmSeqLen, setLstmSeqLen] = useState(60)
  const [nEstimators, setNEstimators] = useState(200)
  const [maxDepth, setMaxDepth] = useState(6)
  const [training, setTraining] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [metrics, setMetrics] = useState<any>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [lossHistory, setLossHistory] = useState<{ epoch: number; loss: number; val_loss?: number }[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (cachedSymbols.length) { setSymbols(cachedSymbols); setSymbol(cachedSymbols[0]) }
    dataApi.getSummary()
      .then(r => {
        const syms = r.data.filter((s: any) => !s.symbol.includes('_')).map((s: any) => s.symbol)
        setSymbols(syms)
        cacheSymbols(syms)
        setSymbol(prev => (prev && syms.includes(prev)) ? prev : (syms[0] || ''))
      }).catch(() => {})
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  const addLog = (text: string, type: LogEntry['type'] = 'info') =>
    setLogs(p => [...p, { text, type }])

  const toggleFeature = (id: string) =>
    setFeatures(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])

  const toggleGroup = (group: string) => {
    const groupFeatures = ALL_FEATURES.filter(f => f.group === group).map(f => f.id)
    const allSelected = groupFeatures.every(f => features.includes(f))
    setFeatures(p => allSelected
      ? p.filter(f => !groupFeatures.includes(f))
      : Array.from(new Set([...p, ...groupFeatures]))
    )
  }

  const handleTrain = () => {
    if (!symbol || !features.length) return
    setTraining(true); setLogs([]); setMetrics(null); setModelId(null); setLossHistory([])
    addLog(`Starting ${MODEL_TYPES.find(m => m.id === modelType)?.label} training for ${symbol}`, 'info')
    addLog(`Features: ${features.join(', ')}`, 'info')

    const payload = mlApi.buildTrainPayload({
      symbol,
      modelType,
      features,
      targetHorizon,
      interval,
      testSplit,
      hyperparams: modelType === 'lstm'
        ? { lstm_layers: lstmLayers, units: lstmUnits, epochs: lstmEpochs, lookback_steps: lstmSeqLen }
        : { n_estimators: nEstimators, max_depth: maxDepth },
    })

    mlApi.train(payload)
      .then(res => {
        const { task_id, model_id } = res.data
        addLog(`Task dispatched. Model ID: ${model_id}`, 'info')

        const pollInterval = setInterval(() => {
          mlApi.getTaskStatus(task_id)
            .then(r => {
              const d = r.data
              switch (d.state) {
                case 'PENDING':
                  addLog('Waiting for worker...', 'info')
                  break
                case 'PROGRESS':
                  if (d.type === 'epoch') {
                    addLog(`Epoch ${d.epoch}/${d.total}: loss=${d.loss?.toFixed(4)}`, 'info')
                    setLossHistory(prev => [...prev, { epoch: d.epoch, loss: d.loss }])
                  } else {
                    addLog(d.msg || 'Training...', 'info')
                  }
                  break
                case 'SUCCESS':
                  clearInterval(pollInterval)
                  setMetrics(d.metrics)
                  setModelId(d.model_id)
                  addLog(`Training complete! Model saved as ${d.model_id}`, 'ok')
                  setTraining(false)
                  break
                case 'FAILURE':
                  clearInterval(pollInterval)
                  addLog(`Training failed: ${d.msg}`, 'err')
                  setTraining(false)
                  break
              }
            })
            .catch(err => {
              clearInterval(pollInterval)
              addLog(`Poll error: ${err.message}`, 'err')
              setTraining(false)
            })
        }, 1000)
      })
      .catch(err => {
        addLog(`Failed to start training: ${err.message}`, 'err')
        setTraining(false)
      })
  }

  return (
    <>
      <div className="topbar">
        <span className="topbar-title">🧠 Train ML Model</span>
        <div className="topbar-actions">
          {modelId && (
            <button className="btn btn-primary btn-sm" onClick={() => router.push('/ml/models')}>
              View Saved Models →
            </button>
          )}
        </div>
      </div>

      <div className="page-body">
        <div className="analysis-grid" style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 24, alignItems: 'start' }}>

          {/* Config panel */}
          <div style={{ position: 'sticky', top: 58, display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Model & symbol */}
            <div className="card">
              <h3 style={{ marginBottom: 14 }}>⚙️ Configuration</h3>
              <div className="form-group">
                <label className="form-label">Symbol</label>
                <select className="input" value={symbol} onChange={e => setSymbol(e.target.value)} disabled={training}>
                  {symbols.length === 0 && <option>No data downloaded</option>}
                  {symbols.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Interval</label>
                  <select className="input" value={interval} onChange={e => setInterval(Number(e.target.value))} disabled={training}>
                    {[[1,'1min'],[5,'5min'],[15,'15min'],[60,'1hr']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Target (candles ahead)</label>
                  <select className="input" value={targetHorizon} onChange={e => setTargetHorizon(Number(e.target.value))} disabled={training}>
                    {[1,3,5,10,15,20,30].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Test split: {(testSplit * 100).toFixed(0)}%</label>
                <input type="range" min="0.1" max="0.4" step="0.05" value={testSplit}
                  onChange={e => setTestSplit(Number(e.target.value))} disabled={training}
                  style={{ width: '100%', accentColor: 'var(--accent)' }} />
              </div>
            </div>

            {/* Model type */}
            <div className="card">
              <h3 style={{ marginBottom: 12 }}>🤖 Model Type</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {MODEL_TYPES.map(m => (
                  <div key={m.id}
                    onClick={() => !training && setModelType(m.id)}
                    style={{
                      padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${modelType === m.id ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
                      background: modelType === m.id ? 'var(--accent-glow)' : 'var(--bg-raised)',
                      cursor: training ? 'not-allowed' : 'pointer',
                      transition: 'all 0.15s'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '1.1rem' }}>{m.icon}</span>
                      <span style={{ fontWeight: 600, fontSize: '0.875rem', color: modelType === m.id ? 'var(--accent-bright)' : 'var(--text-primary)' }}>{m.label}</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 3, paddingLeft: 28 }}>{m.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Hyperparams */}
            {modelType === 'lstm' ? (
              <div className="card">
                <h3 style={{ marginBottom: 12 }}>🔬 LSTM Hyperparams</h3>
                {[
                  ['Layers', lstmLayers, setLstmLayers, [1,2,3,4]],
                  ['Units per layer', lstmUnits, setLstmUnits, [32,64,128,256]],
                  ['Epochs', lstmEpochs, setLstmEpochs, [10,20,50,100]],
                  ['Sequence length', lstmSeqLen, setLstmSeqLen, [20,40,60,100]],
                ].map(([label, val, setter, opts]: any) => (
                  <div className="form-group" key={label} style={{ marginBottom: 10 }}>
                    <label className="form-label">{label}</label>
                    <select className="input" value={val} onChange={e => setter(Number(e.target.value))} disabled={training}>
                      {opts.map((o: number) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card">
                <h3 style={{ marginBottom: 12 }}>🔬 Hyperparams</h3>
                <div className="form-group">
                  <label className="form-label">N Estimators / Trees</label>
                  <select className="input" value={nEstimators} onChange={e => setNEstimators(Number(e.target.value))} disabled={training}>
                    {[50,100,200,500].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Max Depth</label>
                  <select className="input" value={maxDepth} onChange={e => setMaxDepth(Number(e.target.value))} disabled={training}>
                    {[3,4,5,6,8,10].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>
            )}

            <button className="btn btn-primary w-full btn-lg" onClick={handleTrain}
              disabled={training || !symbol || !features.length}>
              {training
                ? <><div className="spinner" style={{ width: 18, height: 18 }} /> Training...</>
                : `🚀 Train ${MODEL_TYPES.find(m => m.id === modelType)?.label}`}
            </button>
          </div>

          {/* Right: features + output */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Feature selection */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <h3>🔧 Features ({features.length} selected)</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setFeatures(ALL_FEATURES.map(f => f.id))}>All</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setFeatures([])}>None</button>
                </div>
              </div>
              {FEATURE_GROUPS.map(group => (
                <div key={group} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: '0.7rem' }} onClick={() => toggleGroup(group)}>
                      {ALL_FEATURES.filter(f => f.group === group).every(f => features.includes(f.id)) ? '☑' : '☐'}
                    </button>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{group}</span>
                  </div>
                  <div className="checkbox-group">
                    {ALL_FEATURES.filter(f => f.group === group).map(f => (
                      <div key={f.id}
                        className={`checkbox-chip ${features.includes(f.id) ? 'active' : ''}`}
                        onClick={() => !training && toggleFeature(f.id)}
                      >
                        {f.label}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Training log */}
            {(logs.length > 0 || training) && (
              <div className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <h3>📋 Training Log</h3>
                  {training && <div className="spinner" style={{ width: 16, height: 16 }} />}
                </div>
                <div className="log-box" ref={logRef}>
                  {logs.map((l, i) => <div key={i} className={`log-${l.type}`}>{l.text}</div>)}
                </div>
              </div>
            )}

            {/* LSTM Loss Curve */}
            {modelType === 'lstm' && lossHistory.length > 0 && (
              <div className="card fade-in">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <h3>📉 Loss Curve</h3>
                  {training && <span style={{ fontSize: '0.75rem', color: 'var(--yellow)', fontWeight: 600 }}>live</span>}
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={lossHistory} margin={{ top: 8, right: 20, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="epoch" tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                      label={{ value: 'Epoch', position: 'insideBottom', offset: -2, fill: 'var(--text-muted)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.8rem' }}
                      labelFormatter={(v) => `Epoch ${v}`}
                      formatter={(v: number) => v.toFixed(6)}
                    />
                    <Line type="monotone" dataKey="loss" stroke="var(--accent)" dot={false} strokeWidth={2} name="Train Loss" isAnimationActive={false} />
                    <Line type="monotone" dataKey="val_loss" stroke="var(--yellow)" dot={false} strokeWidth={2} name="Val Loss" isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Metrics */}
            {metrics && (
              <div className="card fade-in">
                <h3 style={{ marginBottom: 16 }}>📈 Training Results</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
                  {[
                    { label: 'Accuracy',  val: metrics.accuracy,     fmt: (v: number) => `${(v * 100).toFixed(2)}%`, color: 'blue' },
                    { label: 'Precision', val: metrics.precision,    fmt: (v: number) => `${(v * 100).toFixed(2)}%`, color: 'green' },
                    { label: 'Recall',    val: metrics.recall,       fmt: (v: number) => `${(v * 100).toFixed(2)}%`, color: 'purple' },
                    { label: 'F1 Score',  val: metrics.f1,           fmt: (v: number) => v.toFixed(4),               color: 'yellow' },
                    { label: 'AUC-ROC',   val: metrics.auc_roc,      fmt: (v: number) => v?.toFixed(4) ?? 'N/A',     color: 'blue' },
                    { label: 'Sharpe',    val: metrics.sharpe_ratio,  fmt: (v: number) => v?.toFixed(3) ?? 'N/A',    color: 'green' },
                  ].map(({ label, val, fmt, color }) => val != null && (
                    <div key={label} className={`stat-card ${color}`}>
                      <div className="stat-label">{label}</div>
                      <div className="stat-value" style={{ fontSize: '1.375rem' }}>{fmt(val)}</div>
                    </div>
                  ))}
                </div>

                {metrics.feature_importance && (() => {
                  const fiData = Object.entries(metrics.feature_importance as Record<string, number>)
                    .sort(([, a], [, b]) => b - a)
                    .map(([feat, imp]) => ({ feat, imp: parseFloat((imp * 100).toFixed(2)) }))
                  return (
                    <>
                      <h4 style={{ marginBottom: 12, fontSize: '0.9375rem' }}>Feature Importance</h4>
                      <ResponsiveContainer width="100%" height={fiData.length * 36 + 20}>
                        <BarChart data={fiData} layout="vertical" margin={{ left: 80, right: 24, top: 4, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                          <XAxis type="number" unit="%" domain={[0, 100]} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} />
                          <YAxis type="category" dataKey="feat" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} width={75} />
                          <Tooltip
                            formatter={(v: number) => [`${v}%`, 'Importance']}
                            contentStyle={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.8rem' }}
                            labelStyle={{ color: 'var(--text-secondary)' }}
                          />
                          <Bar dataKey="imp" radius={[0, 4, 4, 0]}>
                            {fiData.map((_, i) => (
                              <Cell key={i} fill={`hsl(${220 - i * (160 / Math.max(fiData.length, 1))}, 70%, 55%)`} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </>
                  )
                })()}

                <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
                  <button className="btn btn-primary" onClick={() => router.push('/ml/models')}>📦 View All Models</button>
                  {modelId && (
                    <button className="btn btn-secondary" onClick={() => router.push(`/ml/models?predict=${modelId}`)}>
                      🔮 Predict Now
                    </button>
                  )}
                </div>
              </div>
            )}

            {!training && !logs.length && (
              <div className="card" style={{ textAlign: 'center', padding: '40px 32px', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '3rem', marginBottom: 12 }}>🧠</div>
                <h2 style={{ color: 'var(--text-primary)', marginBottom: 8 }}>Ready to Train</h2>
                <p>Select a symbol, pick features and a model type, then click Train.</p>
                {symbols.length === 0 && (
                  <p style={{ color: 'var(--yellow)', marginTop: 10 }}>
                    ⚠ <a href="/data" style={{ color: 'var(--accent-bright)' }}>Download stock data first</a>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
