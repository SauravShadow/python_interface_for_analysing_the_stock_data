// app/layout.tsx — Root layout
import type { Metadata } from 'next'
import './globals.css'
import Sidebar from '@/components/Sidebar'

export const metadata: Metadata = {
  title: 'QuantDash — Python Intelligence Dashboard',
  description: 'Algorithmic trading intelligence: data management, technical analysis, ML and live market data.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Sidebar />
          <div className="main-content">
            {children}
          </div>
        </div>
      </body>
    </html>
  )
}
