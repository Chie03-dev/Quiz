import { contextBridge, ipcRenderer } from 'electron'
import type {
  ExportQuizResult,
  FirewallInstallResult,
  FirewallStatus,
  ImportQuizResult,
  MemeInfo,
  MemePopResult,
  MemeSavePayload,
  MemeSaveResult,
  QuizMeta,
  ResultOperationResult,
  ResultSessionDetail,
  ResultSessionMeta,
  SaveQuizResult,
  SaveResultAnswerInput,
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
  /** Timer control: freeze, resume, or shift the countdown (ms delta). */
  pauseTimer: (): Promise<boolean> => ipcRenderer.invoke('server:pauseTimer'),
  resumeTimer: (): Promise<boolean> => ipcRenderer.invoke('server:resumeTimer'),
  adjustTimer: (deltaMs: number): Promise<boolean> => ipcRenderer.invoke('server:adjustTimer', deltaMs),
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
  // --- memes: the instructor's jumpscare tray ---
  listMemes: (): Promise<MemeInfo[]> => ipcRenderer.invoke('memes:list'),
  /** Stores one already-compressed meme and returns it. */
  saveMeme: (meme: MemeSavePayload): Promise<MemeSaveResult> =>
    ipcRenderer.invoke('memes:save', meme),
  deleteMeme: (id: string): Promise<boolean> => ipcRenderer.invoke('memes:delete', id),
  /** The full image as a data URL, for the instructor's own preview. */
  memeData: (id: string): Promise<string | null> => ipcRenderer.invoke('memes:data', id),
  /** Pops a meme to the listed students (everyone when no list is given). */
  popMeme: (memeId: string, studentIds?: string[]): Promise<MemePopResult> =>
    ipcRenderer.invoke('server:popMeme', memeId, studentIds),
  /** Clears the meme overlay on the listed students. */
  hideMeme: (studentIds?: string[]): Promise<MemePopResult> =>
    ipcRenderer.invoke('server:hideMeme', studentIds),
  // --- results: the score sheets of finished sessions ---
  /** Every saved session, newest first. */
  listResults: (): Promise<ResultSessionMeta[]> => ipcRenderer.invoke('results:list'),
  /** One session with its questions, students and answers. */
  getResult: (id: string): Promise<ResultSessionDetail | null> =>
    ipcRenderer.invoke('results:get', id),
  /** Deletes a session and everything that belongs to it. */
  deleteResult: (id: string): Promise<boolean> => ipcRenderer.invoke('results:delete', id),
  /** Changes the points, the correct flag or the note of one answer. */
  updateResultAnswer: (input: SaveResultAnswerInput): Promise<ResultOperationResult> =>
    ipcRenderer.invoke('results:updateAnswer', input),
  /** Saves the running session as it stands. */
  saveCurrentResult: (): Promise<ResultSessionMeta | null> =>
    ipcRenderer.invoke('results:createFromCurrent'),
  onStateChanged: (cb: (state: StateSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, state: StateSnapshot): void => cb(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  }
}

export type QuizApi = typeof api

contextBridge.exposeInMainWorld('quiz', api)