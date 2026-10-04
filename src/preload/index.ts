import { contextBridge, ipcRenderer } from 'electron'
import type { FirewallInstallResult, FirewallStatus, StateSnapshot } from '../shared/types'

// The renderer never talks to the server directly; everything goes through here.
const api = {
  getState: (): Promise<StateSnapshot | null> => ipcRenderer.invoke('server:info'),
  newSession: (): Promise<StateSnapshot | null> => ipcRenderer.invoke('server:newSession'),
  kick: (studentId: string): Promise<boolean> => ipcRenderer.invoke('server:kick', studentId),
  selectIp: (ip: string): Promise<boolean> => ipcRenderer.invoke('server:selectIp', ip),
  firewallStatus: (): Promise<FirewallStatus> => ipcRenderer.invoke('firewall:status'),
  /** Triggers the UAC prompt. Only ever called from an explicit instructor click. */
  firewallInstall: (): Promise<FirewallInstallResult> => ipcRenderer.invoke('firewall:install'),
  onStateChanged: (cb: (state: StateSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, state: StateSnapshot): void => cb(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  }
}

export type QuizApi = typeof api

contextBridge.exposeInMainWorld('quiz', api)