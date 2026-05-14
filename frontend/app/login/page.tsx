'use client'
// app/login/page.tsx — FlatTrade Login with OTP flow
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { authApi } from '@/lib/api'
import { useAppStore } from '@/lib/store'

type Step = 'idle' | 'credentials' | 'starting' | 'waiting_otp' | 'completing' | 'done' | 'error'

export default function LoginPage() {
  const router = useRouter()
  const { auth, setAuth, resetAuth } = useAppStore()
  const [step, setStep] = useState<Step>('idle')
  const [password, setPassword] = useState('')
  const [panOrDob, setPanOrDob] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [forceLogin, setForceLogin] = useState(false)
  const pollRef = useRef<NodeJS.Timeout | null>(null)

  // Auto-redirect only after a fresh successful login (step = 'done'), not on page load
  useEffect(() => {
    if (step === 'done' && auth.logged_in) {
      const t = setTimeout(() => router.push('/'), 1500)
      return () => clearTimeout(t)
    }
  }, [step, auth.logged_in, router])

  // Poll auth status while login is in progress
  useEffect(() => {
    if (!['starting', 'waiting_otp', 'completing'].includes(step)) return

    pollRef.current = setInterval(async () => {
      try {
        const res = await authApi.getStatus()
        const data = res.data
        setAuth(data)

        if (data.status === 'waiting_otp') setStep('waiting_otp')
        else if (data.status === 'completing') setStep('completing')
        else if (data.status === 'done') { setStep('done'); clearInterval(pollRef.current!) }
        else if (data.status === 'error') { setStep('error'); setError(data.error || 'Login failed'); clearInterval(pollRef.current!) }
      } catch {}
    }, 1500)

    return () => clearInterval(pollRef.current!)
  }, [step, setAuth])

  // OTP timeout countdown
  useEffect(() => {
    if (step !== 'waiting_otp') return
    setCountdown(300)
    const id = setInterval(() => setCountdown((c) => (c > 0 ? c - 1 : 0)), 1000)
    return () => clearInterval(id)
  }, [step])

  const handleStartLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password || !panOrDob) return
    setError(null)
    setStep('starting')
    try {
      await authApi.startLogin(password, panOrDob)
    } catch (err: any) {
      setStep('error')
      setError(err.response?.data?.detail || 'Failed to start login')
    }
  }

  const handleSubmitOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!otp || otp.length < 4) return
    setStep('completing')
    try {
      await authApi.submitOtp(otp)
    } catch (err: any) {
      setStep('error')
      setError(err.response?.data?.detail || 'OTP submission failed')
    }
  }

  const handleLogout = async () => {
    await authApi.logout()
    resetAuth()
    setForceLogin(false)
    setStep('idle')
    setPassword('')
    setPanOrDob('')
    setOtp('')
  }

  const handleForceLogin = async () => {
    await authApi.logout()
    resetAuth()
    setForceLogin(true)
    setStep('idle')
    setPassword('')
    setPanOrDob('')
    setOtp('')
  }

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  // ── Render ─────────────────────────────────────────────────────────────────

  if ((auth.logged_in || step === 'done') && !forceLogin) {
    const ageHours = auth.token_age_hours ?? 0
    const hoursLeft = auth.token_hours_remaining ?? 0
    const ageWarning = hoursLeft <= 1

    return (
      <div className="login-page">
        <div className="login-card fade-in">
          <div className="login-logo">
            <div className="login-logo-icon">✅</div>
            <h1 style={{ fontSize: '1.5rem', textAlign: 'center' }}>Session Active</h1>
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
              Logged in as <strong style={{ color: 'var(--accent-bright)' }}>{auth.client_id}</strong>
            </p>
          </div>

          <div className="status-steps">
            <div className="status-step done">
              <span className="step-icon">✅</span>
              <span>Credentials verified</span>
            </div>
            <div className="status-step done">
              <span className="step-icon">📱</span>
              <span>OTP verified</span>
            </div>
            <div className="status-step done">
              <span className="step-icon">🔑</span>
              <span style={{ color: ageWarning ? 'var(--yellow)' : undefined }}>
                Token active — {ageHours.toFixed(1)}h old · {hoursLeft}h remaining
              </span>
            </div>
          </div>

          {ageWarning && (
            <div style={{
              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
              borderRadius: 'var(--radius-sm)', padding: '10px 14px',
              color: 'var(--yellow)', fontSize: '0.875rem', margin: '12px 0'
            }}>
              ⚠ Token expires in {hoursLeft}h. Consider re-logging in soon.
            </div>
          )}

          <div className="flex gap-3 mt-4">
            <button className="btn btn-primary w-full" onClick={() => router.push('/')}>
              Go to Dashboard
            </button>
            <button className="btn btn-secondary" onClick={handleForceLogin} title="Generate a new token">
              🔄 Re-Login
            </button>
            <button className="btn btn-danger" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (step === 'waiting_otp') {
    return (
      <div className="login-page">
        <div className="login-card fade-in">
          <div className="login-logo">
            <div className="login-logo-icon" style={{ background: 'linear-gradient(135deg, #f59e0b, #ef4444)' }}>📱</div>
            <h1 style={{ fontSize: '1.5rem', textAlign: 'center' }}>Enter OTP</h1>
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.875rem' }}>
              FlatTrade sent an OTP to your registered mobile / email.
              <br />Enter it below. Expires in{' '}
              <span style={{ color: countdown < 60 ? 'var(--red)' : 'var(--yellow)', fontWeight: 600 }}>
                {formatTime(countdown)}
              </span>
            </p>
          </div>

          <div className="status-steps" style={{ marginBottom: 20 }}>
            <div className="status-step done">
              <span className="step-icon">✅</span>
              <span>Credentials accepted</span>
            </div>
            <div className="status-step active">
              <span className="step-icon">⏳</span>
              <span>Waiting for OTP...</span>
            </div>
            <div className="status-step waiting">
              <span className="step-icon">🔑</span>
              <span>Token generation</span>
            </div>
          </div>

          <form onSubmit={handleSubmitOtp}>
            <div className="form-group">
              <input
                className="otp-input"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="••••••"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                autoFocus
                autoComplete="one-time-code"
                id="otp-input"
              />
            </div>
            <button
              className="btn btn-primary w-full btn-lg"
              type="submit"
              disabled={otp.length < 4}
              id="submit-otp-btn"
            >
              Submit OTP →
            </button>
          </form>
        </div>
      </div>
    )
  }

  if (step === 'starting' || step === 'completing') {
    return (
      <div className="login-page">
        <div className="login-card fade-in">
          <div className="login-logo">
            <div className="login-logo-icon">⚡</div>
            <h1 style={{ fontSize: '1.5rem', textAlign: 'center' }}>
              {step === 'starting' ? 'Connecting...' : 'Verifying OTP...'}
            </h1>
          </div>
          <div className="status-steps">
            <div className={`status-step ${step === 'completing' ? 'done' : 'active'}`}>
              <span className="step-icon">{step === 'completing' ? '✅' : <div className="spinner" style={{ width: 16, height: 16 }} />}</span>
              <span>Authenticating with FlatTrade</span>
            </div>
            <div className={`status-step ${step === 'completing' ? 'active' : 'waiting'}`}>
              <span className="step-icon">📱</span>
              <span>OTP verification</span>
            </div>
            <div className="status-step waiting">
              <span className="step-icon">🔑</span>
              <span>Token generation</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Default: credentials form ──────────────────────────────────────────────
  return (
    <div className="login-page">
      <div className="login-card fade-in">
        <div className="login-logo">
          <div className="login-logo-icon">⚡</div>
          <h1 style={{ fontSize: '1.75rem', textAlign: 'center' }}>Subaru QuantDash</h1>
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.875rem' }}>
            Connect to FlatTrade to begin
          </p>
        </div>

        {error && (
          <div style={{
            background: 'var(--red-dim)', border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 'var(--radius-sm)', padding: '10px 14px',
            color: 'var(--red)', fontSize: '0.875rem', marginBottom: 20
          }}>
            ⚠ {error}
          </div>
        )}

        <form onSubmit={handleStartLogin}>
          <div className="form-group">
            <label className="form-label" htmlFor="ft-password">FlatTrade Password</label>
            <input
              id="ft-password"
              className="input input-password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="ft-pan">PAN Card / Date of Birth</label>
            <input
              id="ft-pan"
              className="input"
              type="text"
              placeholder="ABCDE1234F or DD/MM/YYYY"
              value={panOrDob}
              onChange={(e) => setPanOrDob(e.target.value)}
              required
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Used only for FlatTrade authentication — not stored anywhere.
            </span>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{
              background: 'var(--accent-glow)', border: '1px solid rgba(59,130,246,0.2)',
              borderRadius: 'var(--radius-sm)', padding: '10px 14px',
              fontSize: '0.8125rem', color: 'var(--text-secondary)'
            }}>
              💡 A browser will open headlessly, log in automatically, and pause for you to enter the OTP.
            </div>
          </div>

          <button
            className="btn btn-primary w-full btn-lg"
            type="submit"
            disabled={!password || !panOrDob}
            id="start-login-btn"
          >
            Connect to FlatTrade
          </button>
        </form>

        <div className="divider" />
        <p style={{ textAlign: 'center', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
          🔒 All credentials are only sent to your local backend — never to any third party.
        </p>
      </div>
    </div>
  )
}
