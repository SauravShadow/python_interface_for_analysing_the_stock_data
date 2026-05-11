'use client'
// components/Sidebar.tsx
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { authApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'

const NAV = [
  {
    section: 'Market',
    items: [
      { href: '/stocks', icon: '🔍', label: 'Stock Search' },
      { href: '/data',   icon: '💾', label: 'Data Manager' },
    ],
  },
  {
    section: 'Analysis',
    items: [
      { href: '/analysis',         icon: '📊', label: 'Single Analysis' },
      { href: '/analysis/compare', icon: '⚖️',  label: 'Compare' },
    ],
  },
  {
    section: 'Intelligence',
    items: [
      { href: '/ml/train',   icon: '🧠', label: 'Train Model' },
      { href: '/ml/models',  icon: '📦', label: 'Saved Models' },
    ],
  },
  {
    section: 'Live',
    items: [
      { href: '/live',       icon: '📡', label: 'Live Quotes' },
      { href: '/live/alerts',icon: '🔔', label: 'Price Alerts' },
    ],
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const { auth, setAuth } = useAppStore()

  // Poll auth status every 30s
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await authApi.getStatus()
        setAuth(res.data)
      } catch {}
    }
    poll()
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [setAuth])

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">⚡</div>
        <span className="sidebar-logo-text">QuantDash</span>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        <Link
          href="/"
          className={`nav-item ${pathname === '/' ? 'active' : ''}`}
        >
          <span className="nav-item-icon">🏠</span>
          Dashboard
        </Link>

        {NAV.map((section) => (
          <div key={section.section}>
            <div className="nav-section-label">{section.section}</div>
            {section.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item ${pathname.startsWith(item.href) ? 'active' : ''}`}
              >
                <span className="nav-item-icon">{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </div>
        ))}

        <div className="nav-section-label">Account</div>
        <Link
          href="/login"
          className={`nav-item ${pathname === '/login' ? 'active' : ''}`}
        >
          <span className="nav-item-icon">🔑</span>
          {auth.logged_in ? 'Session' : 'Login'}
        </Link>
      </nav>

      {/* Footer — session status */}
      <div className="sidebar-footer">
        <div className="session-badge">
          <div className={`session-dot ${auth.logged_in ? 'online' : 'offline'}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, truncate: 'ellipsis' }}>
              {auth.logged_in ? (auth.client_id ?? 'Connected') : 'Not logged in'}
            </div>
            {auth.logged_in && auth.token_age_hours !== null && (
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                Token age: {auth.token_age_hours.toFixed(1)}h
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
