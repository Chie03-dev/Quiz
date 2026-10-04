import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { ServerInfo, StateSnapshot, StudentInfo } from '../shared/types'
import { startServer, type QuizServer } from './server'
import { checkFirewallRules, installFirewallRules } from './firewall'

let win: BrowserWindow | null = null
let server: QuizServer | null = null
let latestStudents: StudentInfo[] = []
let latestServer: ServerInfo | null = null

const snapshot = (): StateSnapshot | null =>
  latestServer ? { server: latestServer, students: latestStudents } : null

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
    pushState()
    return snapshot()
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