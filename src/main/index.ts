import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { QuizState, ServerInfo, StateSnapshot, StudentInfo } from '../shared/types'
import { startServer, type QuizServer } from './server'
import { SAMPLE_QUIZ } from './sampleQuiz'
import { checkFirewallRules, installFirewallRules } from './firewall'

let win: BrowserWindow | null = null
let server: QuizServer | null = null
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

  ipcMain.handle('server:startQuiz', () => {
    if (!server) return false
    const ok = server.startQuiz(SAMPLE_QUIZ)
    if (ok) {
      latestQuiz = server.session.quizState()
      pushState()
    }
    return ok
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

  // Reading the firewall needs no admin; installing always comes from a click.
  ipcMain.handle('firewall:status', () => checkFirewallRules())
  ipcMain.handle('firewall:install', () => installFirewallRules())
}

app.whenReady().then(async () => {
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
})