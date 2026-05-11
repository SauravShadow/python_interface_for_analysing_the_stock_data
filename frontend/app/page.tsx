'use client'
// app/page.tsx — Dashboard homepage
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { dataApi, mlApi, liveApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'

interface Summary {
  totalStocks: number
  totalRecords: number
  trainedModels: number
}

export default function DashboardPage() {
  const router = useRouter()
  const { auth } = useAppStore()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [dataRes, mlRes] = await Promise.all([
          dataApi.getSummary().catch(() => ({ data: [] })),
          mlApi.listModels().catch(() => ({ data: [] })),
        ])
        setSummary({
          totalStocks: dataRes.data.length,
          totalRecords: dataRes.data.reduce((s: number, d: any) => s + (d.records || 0), 0),
          trainedModels: mlRes.data.length,
        })
      } catch {}
      setLoading(false)
    }
    load()
  }, [])

  const QuickAction = ({ href, icon, title, desc, color }: any) => (
    <Link href={href} style={{ textDecoration: 'none' }}>
      <div className="card" style={{
        cursor: 'pointer',
        transition: 'all 0.18s ease',
        borderColor: 'var(--border)',
      }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.borderColor = color
          ;(e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'
          ;(e.currentTarget as HTMLElement).style.boxShadow = `0 8px 24px rgba(0,0,0,0.4)`
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'
          ;(e.currentTarget as HTMLElement).style.transform = 'none'
          ;(e.currentTarget as HTMLElement).style.boxShadow = 'none'
        }}
      >
        <div style={{ fontSize: '1.75rem', marginBottom: 12 }}>{icon}</div>
        <h3 style={{ marginBottom: 6, fontSize: '1rem' }}>{title}</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8625rem', lineHeight: 1.5 }}>{desc}</p>
      </div>
    </Link>
  )

  return (
    <>
      {/* Topbar */}
      <div className="topbar">
        <span className="topbar-title">Dashboard</span>
        <div className="topbar-actions">
          {!auth.logged_in && (
            <Link href="/login" className="btn btn-primary btn-sm">
              🔑 Login to FlatTrade
            </Link>
          )}
        </div>
      </div>

      <div className="page-body">
        {/* Welcome */}
        <div className="page-header">
          <h1>Welcome back {auth.client_id ? `, ${auth.client_id}` : ''} 👋</h1>
          <p>Your algorithmic trading intelligence platform</p>
        </div>

        {/* Session warning */}
        {!auth.logged_in && (
          <div style={{
            background: 'var(--yellow-dim)', border: '1px solid rgba(245,158,11,0.25)',
            borderRadius: 'var(--radius-md)', padding: '14px 18px',
            marginBottom: 24, fontSize: '0.9rem', display: 'flex',
            alignItems: 'center', gap: 12
          }}>
            <span>⚠️</span>
            <div>
              <strong style={{ color: 'var(--yellow)' }}>Not connected to FlatTrade.</strong>
              <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>
                Some features require a live session.
              </span>
              <Link href="/login" style={{ color: 'var(--accent-bright)', marginLeft: 12, fontWeight: 600 }}>
                Login →
              </Link>
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="stat-grid">
          <div className="stat-card blue">
            <div className="stat-label">Stocks Downloaded</div>
            <div className="stat-value">
              {loading ? <div className="skeleton" style={{ height: 36, width: 60 }} /> : (summary?.totalStocks ?? 0)}
            </div>
            <div className="stat-sub">Local CSV files</div>
          </div>
          <div className="stat-card green">
            <div className="stat-label">Total Candles</div>
            <div className="stat-value">
              {loading ? <div className="skeleton" style={{ height: 36, width: 80 }} /> : (summary?.totalRecords?.toLocaleString() ?? '0')}
            </div>
            <div className="stat-sub">1-min OHLCV records</div>
          </div>
          <div className="stat-card purple">
            <div className="stat-label">Trained Models</div>
            <div className="stat-value">
              {loading ? <div className="skeleton" style={{ height: 36, width: 40 }} /> : (summary?.trainedModels ?? 0)}
            </div>
            <div className="stat-sub">RF / XGB / LSTM</div>
          </div>
          <div className="stat-card yellow">
            <div className="stat-label">Session Status</div>
            <div className="stat-value" style={{ fontSize: '1.1rem', marginTop: 6 }}>
              {auth.logged_in
                ? <span className="badge badge-green">● Active</span>
                : <span className="badge badge-red">● Offline</span>}
            </div>
            {auth.token_age_hours != null && (
              <div className="stat-sub">Token {auth.token_age_hours.toFixed(1)}h old</div>
            )}
          </div>
        </div>

        {/* Quick actions */}
        <h2 style={{ marginBottom: 16, fontSize: '1.125rem' }}>Quick Actions</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16, marginBottom: 32 }}>
          <QuickAction href="/stocks"          icon="🔍" title="Search & Watchlist" desc="Find NSE/BSE stocks and manage your watchlist" color="var(--accent)" />
          <QuickAction href="/data"            icon="💾" title="Download Data"      desc="Download historical OHLCV data with progress" color="var(--green)" />
          <QuickAction href="/analysis"        icon="📊" title="Run Analysis"       desc="Technical analysis with advanced date filters" color="var(--purple)" />
          <QuickAction href="/analysis/compare"icon="⚖️"  title="Compare Stocks"    desc="Normalized prices, correlation, beta analysis" color="var(--yellow)" />
          <QuickAction href="/ml/train"        icon="🧠" title="Train ML Model"     desc="Random Forest, XGBoost, or LSTM training" color="var(--purple)" />
          <QuickAction href="/live"            icon="📡" title="Live Market"        desc="Real-time quotes, charts and ML signals" color="var(--green)" />
        </div>

        {/* Workflow guide */}
        <h2 style={{ marginBottom: 16, fontSize: '1.125rem' }}>Recommended Workflow</h2>
        <div className="card">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[
              { n: 1, icon: '🔑', title: 'Login',          desc: 'Connect to FlatTrade — token lasts until midnight',            href: '/login' },
              { n: 2, icon: '🔍', title: 'Search Stocks',  desc: 'Find stocks on NSE or BSE and add to your watchlist',         href: '/stocks' },
              { n: 3, icon: '💾', title: 'Download Data',  desc: 'Get up to 3650 days of 1-min OHLCV data per stock',           href: '/data' },
              { n: 4, icon: '📊', title: 'Analyse',        desc: 'Apply filters, run technical analysis, compare and save',     href: '/analysis' },
              { n: 5, icon: '🧠', title: 'Train a Model',  desc: 'Pick features, choose RF/XGB/LSTM, see metrics & predictions',href: '/ml/train' },
              { n: 6, icon: '📡', title: 'Go Live',        desc: 'Monitor real-time quotes with live ML signals and alerts',     href: '/live' },
            ].map((step, i, arr) => (
              <Link key={step.n} href={step.href} style={{ textDecoration: 'none' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 16,
                  padding: '14px 0',
                  borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                  transition: 'all 0.15s ease',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.paddingLeft = '8px'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.paddingLeft = '0'}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: 'var(--bg-raised)', border: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-bright)',
                    flexShrink: 0
                  }}>{step.n}</div>
                  <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{step.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{step.title}</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{step.desc}</div>
                  </div>
                  <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>→</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
