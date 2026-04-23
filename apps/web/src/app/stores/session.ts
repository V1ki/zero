import { create } from 'zustand'

interface SessionState {
  currentSessions: { id: string; source: string; model: string; placement: string }[]
  setCurrentSessions: (sessions: SessionState['currentSessions']) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  currentSessions: [],
  setCurrentSessions: (sessions) => set({ currentSessions: sessions }),
}))
