import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'path'
import type {
  ExportQuizResult,
  ImportQuizResult,
  QuizState,
  SaveQuizResult,
  ServerInfo,
  StartQuizResult,
  StateSnapshot,
  StoredQuiz,
  StudentInfo
} from '../shared/types'
import { startServer, type QuizServer } from './server'
import { checkFirewallRules, installFirewallRules } from './firewall'
import { openQuizLibrary, runtimeQuizForStart, QuizLibrary } from './db'
import { parseQuizJson, serializeQuiz } from './quizFormat'

let win: BrowserWindow | null = null
let server: QuizServer | null = null
let library: QuizLibrary | null = null
let latestStudents: StudentInfo[] = []
let latestServer: ServerInfo | null = null
let latestQuiz: QuizState = {
  status: 'lobby',
  title: null,
  endsAt: null,
  questions: [],
  answeredByStudent: {},
  endReason: null
}
let latestLockMode = true

const snapshot = (): StateSnapshot | null =>
  latestServer
    ? { server: latestServer, students: latestStudents, quiz: latestQuiz, lockMode: latestLockMode }
    : null

function pushState(): void {
  const state = snapshot()
  if (state && win && !win.isDestroyed()) win.webContents.send('state:changed', state)
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: 'Quiz Instructor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) await win.loadURL(devUrl)
  else await win.loadFile(join(__dirname, '../renderer/index.html'))
}

async function boot(): Promise<void> {
  server = await startServer({
    onStudentsChanged: (students) => {
      latestStudents = students
      pushState()
    },
    onServerChanged: (info) => {
      latestServer = info
      pushState()
    },
    onQuizChanged: (state) => {
      latestQuiz = state
      pushState()
    },
    onLockChanged: (lockMode) => {
      latestLockMode = lockMode
      pushState()
    }
  })
  await createWindow()
}

// --- instructor commands: local UI -> main, via IPC only ---

function registerIpc(): void {
  ipcMain.handle('server:info', () => snapshot())

  ipcMain.handle('server:newSession', () => {
    if (!server) return null
    const info = server.newSession()
    latestServer = info
    latestStudents = server.session.list()
    latestQuiz = server.session.quizState()
    latestLockMode = server.session.lockEnabled()
    pushState()
    return snapshot()
  })

  ipcMain.handle('server:startQuiz', (_event, quizId: unknown): StartQuizResult => {
    if (!server || !library) return { ok: false, message: 'The server is not ready yet.' }
    if (typeof quizId !== 'string') return { ok: false, message: 'No quiz is selected.' }
    // Refuses empty or draft quizzes and says which questions block the start.
    const attempt = runtimeQuizForStart(library, quizId)
    if (!attempt.ok) return attempt
    if (!server.startQuiz(attempt.quiz)) {
      return { ok: false, message: 'The quiz could not start. Is at least one student in the lobby?' }
    }
    latestQuiz = server.session.quizState()
    pushState()
    return { ok: true }
  })

  ipcMain.handle('server:endQuiz', () => {
    if (!server) return false
    const ok = server.endQuiz()
    if (ok) {
      latestQuiz = server.session.quizState()
      pushState()
    }
    return ok
  })

  ipcMain.handle('server:kick', (_event, studentId: unknown) => {
    if (typeof studentId !== 'string' || !server) return false
    return server.session.kick(studentId)
  })

  ipcMain.handle('server:selectIp', (_event, ip: unknown) => {
    if (typeof ip !== 'string' || !server) return false
    const ok = server.selectIp(ip)
    if (ok && latestServer) pushState()
    return ok
  })

  // --- step 3: lock and pause. Instructor commands are IPC-only. ---

  ipcMain.handle('server:setLock', (_event, on: unknown) => {
    if (typeof on !== 'boolean' || !server) return false
    server.setLock(on)
    latestLockMode = server.session.lockEnabled()
    pushState()
    return true
  })

  ipcMain.handle('server:approveResume', (_event, studentId: unknown) => {
    if (typeof studentId !== 'string' || !server) return false
    return server.approveResume(studentId)
  })

  ipcMain.handle('server:approveAllResume', () => server ? server.approveAllResume() : 0)

  // --- step 4: quiz library (SQLite). The renderer reaches it via IPC only. ---

  ipcMain.handle('lib:list', () => library?.list() ?? [])

  ipcMain.handle('lib:get', (_event, id: unknown) => {
    if (typeof id !== 'string' || !library) return null
    return library.get(id)
  })

  ipcMain.handle('lib:create', (_event, title: unknown) => {
    if (!library) return null
    return library.create(typeof title === 'string' ? title : undefined)
  })

  ipcMain.handle('lib:duplicate', (_event, id: unknown) => {
    if (typeof id !== 'string' || !library) return null
    return library.duplicate(id)
  })

  ipcMain.handle('lib:delete', (_event, id: unknown) => {
    if (typeof id !== 'string' || !library) return false
    return library.delete(id)
  })

  ipcMain.handle('lib:save', (_event, quiz: unknown): SaveQuizResult => {
    if (!library) return { ok: false, error: 'The quiz library is not open.' }
    try {
      const q = quiz as StoredQuiz
      if (
        !q || typeof q.id !== 'string' || typeof q.title !== 'string' ||
        typeof q.timeLimitSec !== 'number' || !Array.isArray(q.questions)
      ) {
        return { ok: false, error: 'Received an invalid quiz object.' }
      }
      // save() recomputes the draft/ready status from validation.
      return { ok: true, quiz: library.save(q) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('lib:export', async (_event, id: unknown): Promise<ExportQuizResult> => {
    if (!library) return { ok: false, error: 'The quiz library is not open.' }
    if (typeof id !== 'string') return { ok: false, error: 'Invalid quiz id.' }
    const quiz = library.get(id)
    if (!quiz) return { ok: false, error: 'That quiz is no longer in the library.' }
    try {
      const save = await dialog.showSaveDialog({
        title: 'Export quiz',
        defaultPath: `${quiz.title.replace(/[\\/:*?"<>|]/g, '_')}.json`,
        filters: [{ name: 'Quiz JSON', extensions: ['json'] }]
      })
      if (save.canceled || !save.filePath) {
        return { ok: false, error: 'Export was cancelled.', cancelled: true }
      }
      await fs.writeFile(save.filePath, serializeQuiz(quiz), 'utf8')
      return { ok: true, path: save.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('lib:import', async (): Promise<ImportQuizResult> => {
    if (!library) return { ok: false, error: 'The quiz library is not open.' }
    try {
      const open = await dialog.showOpenDialog({
        title: 'Import quiz',
        properties: ['openFile'],
        filters: [{ name: 'Quiz JSON', extensions: ['json'] }]
      })
      if (open.canceled || !open.filePaths[0]) {
        return { ok: false, error: 'Import was cancelled.', cancelled: true }
      }
      const text = await fs.readFile(open.filePaths[0], 'utf8')
      const parsed = parseQuizJson(text)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      return { ok: true, quiz: library.importQuiz(parsed.quiz) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Reading the firewall needs no admin; installing always comes from a click.
  ipcMain.handle('firewall:status', () => checkFirewallRules())
  ipcMain.handle('firewall:install', () => installFirewallRules())
}

app.whenReady().then(async () => {
  library = openQuizLibrary(join(app.getPath('userData'), 'quiz-library.db'))
  registerIpc()
  await boot()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void server?.close()
  server = null
  library?.close()
  library = null
})