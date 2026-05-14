'use client'
// components/Sidebar.tsx
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  Home, Search, Database, BarChart2, Scale,
  Brain, Package, Radio, Bell, KeyRound,
  Zap, Menu, X, ChevronLeft, ChevronRight, type LucideIcon,
} from 'lucide-react'
import { authApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'

type NavItem = { href: string; icon: LucideIcon; label: string; exact?: boolean }
type NavSection = { section: string; items: NavItem[] }

const NAV: NavSection[] = [
  {
    section: 'Market',
    items: [
      { href: '/stocks', icon: Search,   label: 'Stock Search' },
      { href: '/data',   icon: Database, label: 'Data Manager' },
    ],
  },
  {
    section: 'Analysis',
    items: [
      { href: '/analysis',         icon: BarChart2, label: 'Single Analysis', exact: true },
      { href: '/analysis/compare', icon: Scale,     label: 'Compare' },
    ],
  },
  {
    section: 'Intelligence',
    items: [
      { href: '/ml/train',  icon: Brain,   label: 'Train Model' },
      { href: '/ml/models', icon: Package, label: 'Saved Models' },
    ],
  },
  {
    section: 'Live',
    items: [
      { href: '/live',        icon: Radio, label: 'Live Quotes',  exact: true },
      { href: '/live/alerts', icon: Bell,  label: 'Price Alerts' },
    ],
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const { auth, setAuth } = useAppStore()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // Restore collapse preference from localStorage
  useEffect(() => {
    if (localStorage.getItem('sidebar-collapsed') === 'true') {
      setCollapsed(true)
    }
  }, [])

  // Apply/remove body class and persist
  useEffect(() => {
    if (collapsed) {
      document.body.classList.add('sidebar-collapsed')
      localStorage.setItem('sidebar-collapsed', 'true')
    } else {
      document.body.classList.remove('sidebar-collapsed')
      localStorage.setItem('sidebar-collapsed', 'false')
    }
    return () => document.body.classList.remove('sidebar-collapsed')
  }, [collapsed])

  // Close sidebar on route change (mobile)
  useEffect(() => { setMobileOpen(false) }, [pathname])

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
    <>
      {/* Mobile hamburger */}
      <button
        className="sidebar-mobile-toggle"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
        style={{ position: 'fixed', top: 12, left: 12, zIndex: 300 }}
      >
        <Menu size={22} />
      </button>

      {/* Backdrop */}
      <div
        className={`sidebar-backdrop${mobileOpen ? ' mobile-open' : ''}`}
        onClick={() => setMobileOpen(false)}
      />

      <aside className={`sidebar${mobileOpen ? ' mobile-open' : ''}`}>
        {/* Close button (mobile) */}
        <button
          className="sidebar-mobile-toggle"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
          style={{ position: 'absolute', top: 12, right: 12, zIndex: 301 }}
        >
          <X size={20} />
        </button>

        {/* Logo */}
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">
            <Zap size={18} />
          </div>
          <span className="sidebar-logo-text">Subaru QuantDash</span>
        </div>

        {/* Nav */}
        <nav className="sidebar-nav">
          <Link
            href="/"
            className={`nav-item ${pathname === '/' ? 'active' : ''}`}
            title="Dashboard"
          >
            <span className="nav-item-icon"><Home size={16} /></span>
            <span className="nav-label">Dashboard</span>
          </Link>

          {NAV.map((section) => (
            <div key={section.section}>
              <div className="nav-section-label">{section.section}</div>
              {section.items.map((item) => {
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={item.label}
                    className={`nav-item ${(item.exact ? pathname === item.href : pathname.startsWith(item.href)) ? 'active' : ''}`}
                  >
                    <span className="nav-item-icon"><Icon size={16} /></span>
                    <span className="nav-label">{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}

          <div className="nav-section-label">Account</div>
          <Link
            href="/login"
            title={auth.logged_in ? 'Session' : 'Login'}
            className={`nav-item ${pathname === '/login' ? 'active' : ''}`}
          >
            <span className="nav-item-icon"><KeyRound size={16} /></span>
            <span className="nav-label">{auth.logged_in ? 'Session' : 'Login'}</span>
          </Link>
        </nav>

        {/* Collapse toggle */}
        <div className="sidebar-collapse-toggle">
          <button
            className="nav-item"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <span className="nav-item-icon">
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </span>
            <span className="nav-label" style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
              Collapse
            </span>
          </button>
        </div>

        {/* Footer — session status */}
        <div className="sidebar-footer">
          <div className="session-badge">
            <div className={`session-dot ${auth.logged_in ? 'online' : 'offline'}`} />
            <div className="session-info" style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {auth.logged_in ? (auth.client_id ?? 'Connected') : 'Not logged in'}
              </div>
              {auth.logged_in && auth.token_hours_remaining !== null && (
                <div style={{ fontSize: '0.7rem', color: auth.token_hours_remaining <= 1 ? 'var(--yellow)' : 'var(--text-muted)' }}>
                  Expires in: {auth.token_hours_remaining.toFixed(1)}h
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
