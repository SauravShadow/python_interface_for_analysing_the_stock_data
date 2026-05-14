// lib/store.ts — Global state using Zustand
import { create } from 'zustand'

export interface AuthState {
  logged_in: boolean
  client_id: string | null
  token_age_hours: number | null
  token_hours_remaining: number | null
  status: 'idle' | 'running' | 'waiting_otp' | 'done' | 'error'
  error: string | null
}

interface AppState {
  auth: AuthState
  setAuth: (auth: Partial<AuthState>) => void
  resetAuth: () => void
  symbols: string[]
  setSymbols: (s: string[]) => void
}

const defaultAuth: AuthState = {
  logged_in: false,
  client_id: null,
  token_age_hours: null,
  token_hours_remaining: null,
  status: 'idle',
  error: null,
}

export const useAppStore = create<AppState>((set) => ({
  auth: defaultAuth,
  setAuth: (auth) => set((s) => ({ auth: { ...s.auth, ...auth } })),
  resetAuth: () => set({ auth: defaultAuth }),
  symbols: [],
  setSymbols: (symbols) => set({ symbols }),
}))
