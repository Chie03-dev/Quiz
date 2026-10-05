import { contextBridge, ipcRenderer } from 'electron'
import type {
  ExportQuizResult,
  FirewallInstallResult,
  FirewallStatus,
  ImportQuizResult,
  QuizMeta,
  SaveQuizResult,
  StartQuizResult,
  StateSnapshot,
  StoredQuiz
} from '../shared/types'

// The renderer never talks to the server directly; everything goes through here.
const api = {
  getState: (): Promise<StateSnapshot | null> => ipcRenderer.invoke('server:info'),
  newSession: (): Promise<StateSnapshot | null> => ipcRenderer.invoke('server:newSession'),
  kick: (studentId: string): Promise<boolean> => ipcRenderer.invoke('server:kick', studentId),
  /** Starts the selected library quiz; a refusal says which questions block it. */
  startQuiz: (quizId: string): Promise<StartQuizResult> =>
    ipcRenderer.invoke('server:startQuiz', quizId),
  endQuiz: (): Promise<boolean> => ipcRenderer.invoke('server:endQuiz'),
  setLock: (on: boolean): Promise<boolean> => ipcRenderer.invoke('server:setLock', on),
  approveResume: (studentId: string): Promise<boolean> =>
    ipcRenderer.invoke('server:approveResume', studentId),
  approveAllResume: (): Promise<number> => ipcRenderer.invoke('server:approveAllResume'),
  selectIp: (ip: string): Promise<boolean> => ipcRenderer.invoke('server:selectIp', ip),
  firewallStatus: (): Promise<FirewallStatus> => ipcRenderer.invoke('firewall:status'),
  /** Triggers the UAC prompt. Only ever called from an explicit instructor click. */
  firewallInstall: (): Promise<FirewallInstallResult> => ipcRenderer.invoke('firewall:install'),
  // --- step 4: quiz library ---
  listQuizzes: (): Promise<QuizMeta[]> => ipcRenderer.invoke('lib:list'),
  getQuiz: (id: string): Promise<StoredQuiz | null> => ipcRenderer.invoke('lib:get', id),
  createQuiz: (title?: string): Promise<StoredQuiz | null> =>
    ipcRenderer.invoke('lib:create', title),
  duplicateQuiz: (id: string): Promise<QuizMeta | null> =>
    ipcRenderer.invoke('lib:duplicate', id),
  deleteQuiz: (id: string): Promise<boolean> => ipcRenderer.invoke('lib:delete', id),
  /** Saves and returns the quiz with recomputed draft/ready statuses. */
  saveQuiz: (quiz: StoredQuiz): Promise<SaveQuizResult> => ipcRenderer.invoke('lib:save', quiz),
  /** Opens a save dialog and writes the interchange JSON. */
  exportQuiz: (id: string): Promise<ExportQuizResult> => ipcRenderer.invoke('lib:export', id),
  /** Opens a file dialog, validates the JSON and adds the quiz to the library. */
  importQuiz: (): Promise<ImportQuizResult> => ipcRenderer.invoke('lib:import'),
  onStateChanged: (cb: (state: StateSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, state: StateSnapshot): void => cb(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  }
}

export type QuizApi = typeof api

contextBridge.exposeInMainWorld('quiz', api)