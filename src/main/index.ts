import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import type {
  ExportQuizResult,
  ImportQuizResult,
  MemeInfo,
  MemePopResult,
  MemeSavePayload,
  MemeSaveResult,
  MemeState,
  QuizState,
  SaveQuizResult,
  ServerInfo,
  StartQuizResult,
  StateSnapshot,
  StoredQuiz,
  StudentInfo
} from '../shared/types'
import { MEME_DURATION_MS } from '../shared/types'
import { startServer, type QuizServer } from './server'
import { checkFirewallRules, installFirewallRules } from './firewall'
import { openAppData, runtimeQuizForStart, type MemeStore, type QuizLibrary } from './db'
import { MemeAssets, MEME_DIR_NAME, MEME_MAX_BYTES, buildPopPayload, seedSampleMeme } from './memes/store'
import { parseQuizJson, serializeQuiz } from './quizFormat'
import { describeError, importQuizFile } from './import'

let win: BrowserWindow | null = null
let server: QuizServer | null = null
let library: QuizLibrary | null = null
let memeStore: MemeStore | null = null
let memeAssets: MemeAssets | null = null
let latestStudents: StudentInfo[] = []
let latestServer: ServerInfo | null = null
let latestQuiz: QuizState = {
  status: 'lobby',
  title: null,
  endsAt: null,
  timerPaused: false,
  remainingMs: null,
  questions: [],
  answeredByStudent: {},
  endReason: null
}
let latestLockMode = true
/** The last meme pop, or null when none was sent. */
let latestMeme: MemeState | null = null
/** Clears the "a meme is showing" flag once its time is up. */
let memeTimer: NodeJS.Timeout | null = null

const snapshot = (): StateSnapshot | null =>
  latestServer
    ? {
        server: latestServer,
        students: latestStudents,
        quiz: latestQuiz,
        lockMode: latestLockMode,
        meme: latestMeme
      }
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
    },
    memes: memeAssets ?? undefined
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
    // A new session starts without a meme on screen.
    latestMeme = null
    if (memeTimer) clearTimeout(memeTimer)
    memeTimer = null
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

  // --- timer control. Instructor-only, IPC-only; the server broadcasts
  // time_update to phones and publishes fresh dashboard state itself. ---

  ipcMain.handle('server:pauseTimer', () => {
    if (!server) return false
    const ok = server.pauseTimer()
    if (ok) latestQuiz = server.session.quizState()
    if (ok) pushState()
    return ok
  })

  ipcMain.handle('server:resumeTimer', () => {
    if (!server) return false
    const ok = server.resumeTimer()
    if (ok) latestQuiz = server.session.quizState()
    if (ok) pushState()
    return ok
  })

  ipcMain.handle('server:adjustTimer', (_event, deltaMs: unknown) => {
    if (!server || typeof deltaMs !== 'number' || !Number.isFinite(deltaMs)) return false
    const ok = server.adjustTimer(deltaMs)
    if (ok) latestQuiz = server.session.quizState()
    if (ok) pushState()
    return ok
  })

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
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: 'Word', extensions: ['docx'] }
        ]
      })
      if (open.canceled || !open.filePaths[0]) {
        return { ok: false, error: 'Import was cancelled.', cancelled: true }
      }
      const filePath = open.filePaths[0]
      const ext = extname(filePath).toLowerCase()

      if (ext === '.json') {
        const text = await fs.readFile(filePath, 'utf8')
        const parsed = parseQuizJson(text)
        if (!parsed.ok) return { ok: false, error: parsed.error }
        return { ok: true, quiz: library.importQuiz(parsed.quiz) }
      }

      if (ext === '.docx') {
        const result = await importQuizFile(filePath, 'auto')
        if (!result.ok) return { ok: false, error: result.error }
        const imported = library.importQuiz(result.quiz)
        return {
          ok: true,
          report: {
            id: imported.id,
            title: imported.title,
            questionCount: imported.questions.length,
            warnings: result.warnings.map((w) => ({ questionIndex: w.questionIndex, message: w.message })),
            questions: imported.questions.map((q) => ({ id: q.id, type: q.type, body: q.body, sourceText: q.sourceText }))
          }
        }
      }

      if (ext === '.md' || ext === '.markdown') {
        const result = await importQuizFile(filePath, 'auto')
        if (!result.ok) return { ok: false, error: result.error }
        const imported = library.importQuiz(result.quiz)
        return {
          ok: true,
          report: {
            id: imported.id,
            title: imported.title,
            questionCount: imported.questions.length,
            warnings: result.warnings.map((w) => ({ questionIndex: w.questionIndex, message: w.message })),
            questions: imported.questions.map((q) => ({ id: q.id, type: q.type, body: q.body, sourceText: q.sourceText }))
          }
        }
      }

      return { ok: false, error: `unsupported file type${ext ? ` ${ext}` : ''}; use .docx, .md, .markdown or .json` }
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
  })

  // Reading the firewall needs no admin; installing always comes from a click.
  ipcMain.handle('firewall:status', () => checkFirewallRules())
  ipcMain.handle('firewall:install', () => installFirewallRules())

  // --- memes: the instructor's jumpscare tray ---

  ipcMain.handle('memes:list', () => memeStore?.list() ?? [])

  ipcMain.handle('memes:save', (_event, payload: unknown): MemeSaveResult => {
    if (!memeStore || !memeAssets) return { ok: false, error: 'The meme tray is not open.' }
    try {
      const p = payload as Partial<MemeSavePayload> | null
      if (!p || typeof p.name !== 'string' || !p.name.trim()) {
        return { ok: false, error: 'The image has no name.' }
      }
      if (p.mime !== 'image/jpeg' && p.mime !== 'image/png') {
        return { ok: false, error: 'Only JPEG and PNG images are supported.' }
      }
      const bytes = toBytes(p.bytes)
      if (!bytes || bytes.length === 0) return { ok: false, error: 'The image is empty.' }
      if (bytes.length > MEME_MAX_BYTES) {
        return { ok: false, error: 'The compressed image is larger than 2 MB.' }
      }
      const width = typeof p.width === 'number' ? p.width : 0
      const height = typeof p.height === 'number' ? p.height : 0
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        return { ok: false, error: 'The image has no usable size.' }
      }
      const thumb = typeof p.thumb === 'string' ? p.thumb : ''
      if (thumb && !thumb.startsWith('data:image/')) {
        return { ok: false, error: 'The thumbnail is not a data URL.' }
      }
      const id = randomUUID()
      const fileName = memeAssets.write(id, bytes, p.mime)
      const row = memeStore.insert({
        id,
        name: p.name.trim().slice(0, 120),
        fileName,
        mime: p.mime,
        width,
        height,
        byteSize: bytes.length,
        thumb
      })
      const meme: MemeInfo = {
        id: row.id,
        name: row.name,
        mime: row.mime,
        width: row.width,
        height: row.height,
        byteSize: row.byteSize,
        thumb: row.thumb,
        createdAt: row.createdAt
      }
      return { ok: true, meme }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('memes:delete', (_event, id: unknown) => {
    if (typeof id !== 'string' || !memeStore || !memeAssets) return false
    const row = memeStore.get(id)
    if (!row) return false
    memeAssets.remove(row.fileName)
    return memeStore.delete(id)
  })

  // The full image as a data URL, for the instructor's own preview only.
  ipcMain.handle('memes:data', (_event, id: unknown) => {
    if (typeof id !== 'string' || !memeAssets) return null
    const asset = memeAssets.byId(id)
    if (!asset) return null
    const bytes = memeAssets.read(asset.fileName)
    if (!bytes) return null
    return `data:${asset.mime};base64,${bytes.toString('base64')}`
  })

  // --- meme pops (instructor commands, IPC-only) ---

  ipcMain.handle('server:popMeme', (_event, memeId: unknown, studentIds: unknown): MemePopResult => {
    if (!server) return { ok: false, error: 'The server is not ready yet.' }
    if (typeof memeId !== 'string') return { ok: false, error: 'No meme is selected.' }
    const payload = memeStore ? buildPopPayload(memeStore, memeId, MEME_DURATION_MS) : null
    if (!payload) return { ok: false, error: 'That meme is no longer in the tray.' }
    const targets = toIdList(studentIds)
    const sent = server.popMeme(payload, targets)
    latestMeme = { memeId: payload.memeId, at: Date.now(), targets: targets ?? [], active: true }
    scheduleMemeExpiry()
    pushState()
    return { ok: true, sent }
  })

  ipcMain.handle('server:hideMeme', (_event, studentIds: unknown): MemePopResult => {
    if (!server) return { ok: false, error: 'The server is not ready yet.' }
    const targets = toIdList(studentIds)
    const sent = server.hideMeme(targets)
    if (latestMeme) latestMeme = { ...latestMeme, active: false }
    if (memeTimer) clearTimeout(memeTimer)
    memeTimer = null
    pushState()
    return { ok: true, sent }
  })
}

/** The student ids of a targeted pop; undefined means every student. */
function toIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids.length > 0 ? ids : undefined
}

/** The image bytes as they arrive over IPC. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}

/** The meme is only "showing" for its own duration; then the flag clears. */
function scheduleMemeExpiry(): void {
  if (memeTimer) clearTimeout(memeTimer)
  memeTimer = setTimeout(() => {
    memeTimer = null
    if (!latestMeme || !latestMeme.active) return
    latestMeme = { ...latestMeme, active: false }
    pushState()
  }, MEME_DURATION_MS)
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const data = openAppData(join(userData, 'quiz-library.db'))
  library = data.quizzes
  memeStore = data.memes
  memeAssets = new MemeAssets(memeStore, join(userData, MEME_DIR_NAME))
  memeAssets.ensure()
  // The sample meme is seeded on a brand-new profile only, next to the
  // sample quiz: deleting every meme never brings it back.
  if (data.fresh) seedSampleMeme(memeAssets, app.getAppPath())
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
  if (memeTimer) clearTimeout(memeTimer)
  library?.close()
  library = null
  memeStore = null
  memeAssets = null
})
