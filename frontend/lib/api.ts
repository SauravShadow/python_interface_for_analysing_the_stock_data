// lib/api.ts — Axios client pre-configured for the backend
import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

// ── Auth ──────────────────────────────────────────────────────────────────────
export const authApi = {
  startLogin: (password: string, pan_or_dob: string) =>
    api.post('/auth/start-login', { password, pan_or_dob }),
  submitOtp: (otp: string) =>
    api.post('/auth/submit-otp', { otp }),
  getStatus: () =>
    api.get('/auth/status'),
  logout: () =>
    api.post('/auth/logout'),
}

// ── Stocks ────────────────────────────────────────────────────────────────────
export const stocksApi = {
  search: (q: string, exchange: string = 'NSE') =>
    api.get('/stocks/search', { params: { q, exchange } }),
  getWatchlist: () =>
    api.get('/stocks/watchlist'),
  addToWatchlist: (item: { tsym: string; token: string; exchange: string; cname?: string }) =>
    api.post('/stocks/watchlist', item),
  removeFromWatchlist: (tsym: string) =>
    api.delete(`/stocks/watchlist/${tsym}`),
}

// ── Data ──────────────────────────────────────────────────────────────────────
export const dataApi = {
  getSummary: () =>
    api.get('/data/summary'),
  resample: (symbol: string, interval_minutes: number, days: number) =>
    api.post('/data/resample', { symbol, interval_minutes, days }),
  deleteSymbol: (symbol: string) =>
    api.delete(`/data/${symbol}`),
}

// ── Analysis ──────────────────────────────────────────────────────────────────
interface AnalysisRunPayload {
  symbol: string
  analysis_types: string[]
  interval_minutes?: number
  exclude_weekdays?: string[]
  exclude_month_start?: boolean
  exclude_month_end?: boolean
  date_from?: string | null
  date_to?: string | null
  exchange?: string
}
export const analysisApi = {
  // Converts single-stock frontend format to backend AnalysisRunRequest format
  run: (p: AnalysisRunPayload) =>
    api.post('/analysis/run', {
      mode: 'single',
      symbols: [p.symbol],
      exchange: p.exchange || 'NSE',
      analysis_types: p.analysis_types,
      filters: {
        interval: p.interval_minutes ? `${p.interval_minutes}min` : '1min',
        exclude_weekdays: p.exclude_weekdays || [],
        exclude_first_of_month: p.exclude_month_start || false,
        exclude_last_of_month: p.exclude_month_end || false,
        date_from: p.date_from || null,
        date_to: p.date_to || null,
      },
    }),
  listSaved: () =>
    api.get('/analysis/saved'),
  getSaved: (id: string) =>
    api.get(`/analysis/saved/${id}`),
  save: (p: { symbol: string; result: object; filters: object }) =>
    api.post('/analysis/save', {
      name: `${p.symbol} — ${new Date().toLocaleDateString()}`,
      mode: 'single',
      symbols: [p.symbol],
      config: p.filters,
      results_summary: p.result,
      action: 'new',
    }),
  deleteSaved: (id: string) =>
    api.delete(`/analysis/saved/${id}`),
}

// ── ML ────────────────────────────────────────────────────────────────────────
export const mlApi = {
  listFeatures: () =>
    api.get('/ml/features'),
  listModels: (symbol?: string) =>
    api.get('/ml/models', { params: symbol ? { symbol } : {} }),
  getModel: (id: string) =>
    api.get(`/ml/models/${id}`),
  // Train: frontend field names → backend TrainRequest field names
  buildTrainPayload: (p: {
    symbol: string; modelType: string; features: string[];
    targetHorizon: number; interval: number; testSplit: number;
    hyperparams: object; exchange?: string;
  }) => ({
    name: `${p.symbol}-${p.modelType}-${Date.now()}`,
    symbol: p.symbol,
    exchange: p.exchange || 'NSE',
    interval: `${p.interval}min`,
    features: p.features,
    model_type: p.modelType,
    task: 'classification',
    split_ratio: 1 - p.testSplit,   // backend split_ratio = train fraction
    hyperparams: { ...p.hyperparams, target_horizon: p.targetHorizon },
    filters: {},
    lookback_steps: 10,
  }),
  predict: (model_id: string, symbol: string, horizon_candles: number) =>
    api.post('/ml/predict', { model_id, symbol, horizon_candles }),
  getRecentPrices: (symbol: string, interval: string = '1min', n: number = 60) =>
    api.get(`/ml/recent-prices/${symbol}`, { params: { interval, n } }),
  deleteModel: (id: string) =>
    api.delete(`/ml/models/${id}`),
}

// ── Live ──────────────────────────────────────────────────────────────────────
export const liveApi = {
  getQuote: (exchange: string, token: string) =>
    api.get(`/live/quote/${exchange}/${token}`),
  getMultipleQuotes: (tokens: string[], exchange: string = 'NSE') =>
    api.get('/live/quotes', { params: { tokens: tokens.join(','), exchange } }),
  // Map frontend { tsym, condition, price } → backend { symbol, above/below }
  addAlert: (p: { tsym: string; exchange: string; token: string; condition: 'above'|'below'; price: number }) =>
    api.post('/live/alerts', {
      symbol: p.tsym,
      exchange: p.exchange,
      token: p.token,
      above: p.condition === 'above' ? p.price : null,
      below: p.condition === 'below' ? p.price : null,
    }),
  listAlerts: () =>
    api.get('/live/alerts'),
  getIntraday: (exchange: string, token: string) =>
    api.get(`/live/intraday/${exchange}/${token}`),
}

// ── SSE helper ────────────────────────────────────────────────────────────────
export function createSSEStream(
  url: string,
  onMessage: (data: object) => void,
  onDone?: () => void
): () => void {
  const controller = new AbortController()

  fetch(url, { signal: controller.signal })
    .then(async (res) => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) { onDone?.(); break }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              onMessage(JSON.parse(line.slice(6)))
            } catch {}
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') console.error('[SSE]', err)
      onDone?.()
    })

  return () => controller.abort()
}
