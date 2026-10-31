import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { existsSync, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, dirname, join } from 'node:path'
import type {
  ExportQuizResult,
  ImportQuizResult,
  MemeInfo,
  MemePopResult,
  MemeSavePayload,
  MemeSaveResult,
  MemeState,
  QuestionType,
  QuizState,
  ResultEndReason,
  ResultOperationResult,
  ResultSessionMeta,
  SaveQuizResult,
  SaveResultAnswerInput,
  ServerInfo,
  StartQuizResult,
  StateSnapshot,
  StoredQuiz,
  StoredQuestion,
  StudentInfo
} from '../shared/types'
import { MEME_DURATION_MS, PORT_RANGE, QUESTION_TYPES } from '../shared/types'
import { startServer, type QuizServer } from './server'
import { checkFirewallRules, installFirewallRules, buildInstallCommands, FIREWALL_RULES, FIREWALL_SETUP_FILE } from './firewall'
import { openAppData, runtimeQuizForStart, type MemeStore, type QuizLibrary, type ResultsStore } from './db'
import { buildSessionSnapshot } from './results/session'
import { MemeAssets, MEME_DIR_NAME, MEME_MAX_BYTES, buildPopPayload, seedSampleMeme } from './memes/store'
import { parseQuizJson, serializeQuiz } from './quizFormat'
import { describeError, importQuizFile } from './import'
import { createAiManagerWithStore, createProviderForStore, ModelStore, type ModelInfo, type DownloadResult } from './ai'
import { fileBlocks, textBlocks } from './ai/corpus'
import { LazyEmbedder, LlamaEmbedder } from './ai/rag/embeddings'
import type { AiManager } from './ai'
import type {
  AiStatus,
  AiTiming,
  GenerateOptions,
  AutoKeyOptions,
  AutoKeyResult
} from './ai/types'

let win: BrowserWindow | null = null
let server: QuizServer | null = null
let library: QuizLibrary | null = null
let dbPath = ''
let memeStore: MemeStore | null = null
let resultsStore: ResultsStore | null = null
let aiManager: AiManager | null = null
let modelStore: ModelStore | null = null
let embedder: LazyEmbedder | null = null
let memeAssets: MemeAssets | null = null
let latestStudents: StudentInfo[] = []
let latestServer: ServerInfo | null = null
/** The library quiz of the running session, kept for the results snapshot. */
let activeQuiz: StoredQuiz | null = null
/** When the running session started. */
let activeQuizStartedAt: number | null = null
/** The result session of the current run, once it has been saved. */
let savedResultId: string | null = null
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
/**
 * The run of questions that is going on, so the time it takes can be
 * measured: the start-up is the time until the first question is ready.
 */
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

/**
 * Where setup-firewall.bat lives.
 *
 * In a packaged build it is an extra resource next to the app.asar, so the
 * folder is the resources folder. While developing it sits in the project
 * folder. Returns null when the file is not there at all, so the caller can
 * say so instead of opening the wrong folder.
 */
function firewallSetupPath(): string | null {
  const candidates = [
    join(process.resourcesPath, FIREWALL_SETUP_FILE),
    join(app.getAppPath(), FIREWALL_SETUP_FILE)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Opens the manual setup file in the file manager, so the instructor can run
 * it as administrator when the app could not raise its own prompt.
 */
function openFirewallSetup(): boolean {
  const file = firewallSetupPath()
  if (!file) return false
  shell.showItemInFolder(file)
  return true
}

/**
 * Asks the instructor, once at startup, whether the firewall may be opened.
 *
 * Without this the only sign that a phone cannot connect is a notice on the
 * dashboard, which is easy to miss - and a phone that cannot connect looks
 * like a broken app rather than a blocked port. The prompt is skipped when
 * the rules are already there, and "Not now" changes nothing: the dashboard
 * still offers the button.
 */
async function promptForFirewallSetup(): Promise<void> {
  if (process.platform !== 'win32') return
  const status = await checkFirewallRules()
  if (!status.supported || status.missing.length === 0) return

  // Wait for the window, so the prompt is not hidden behind it.
  if (win && !win.isVisible()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4000)
      win?.once('ready-to-show', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  const options = {
    type: 'warning' as const,
    title: 'Phones cannot connect yet',
    message: 'Phones cannot connect to this PC yet.',
    detail:
      `Windows Firewall is blocking the quiz server on ports ${PORT_RANGE}, so phones on the ` +
      'same Wi-Fi cannot join. Windows will ask for permission to change this. ' +
      'You can change your mind later from the dashboard.',
    buttons: ['Allow phones to connect', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response !== 0) return
  await installFirewallRules()
}

/**
 * Snapshots the session into the results store. Called for every way a quiz
 * can end (the instructor's button and the timer) and by the manual save.
 * There is one result session per run: a new snapshot replaces the old one.
 */
function persistResults(reason: ResultEndReason | null): ResultSessionMeta | null {
  if (!server || !resultsStore) return null
  const students = server.session.list()
  if (students.length === 0) return null

  const snapshot = buildSessionSnapshot({
    quiz: activeQuiz,
    runtime: server.session.quizSnapshot(),
    quizTitle: activeQuiz?.title ?? server.session.quizState().title ?? 'Quiz',
    startedAt: activeQuizStartedAt,
    endedAt: Date.now(),
    endReason: reason,
    students,
    answers: server.session.answersSnapshot()
  })
  if (snapshot.questions.length === 0) return null

  // One result session per run: the newer snapshot replaces the older.
  if (savedResultId) {
    resultsStore.delete(savedResultId)
    savedResultId = null
  }

  const meta = resultsStore.createFromSession(snapshot)
  savedResultId = meta.id
  return meta
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: 'Quiz Instructor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
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
    onQuizEnded: (reason) => {
      persistResults(reason)
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
    // A new run has its own result session.
    activeQuiz = null
    activeQuizStartedAt = null
    savedResultId = null
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
    // The library quiz is kept for the results snapshot: it carries the
    // full answer keys, not just the flattened ones the run needs.
    activeQuiz = library.get(quizId)
    activeQuizStartedAt = Date.now()
    savedResultId = null
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
    const schema = z.object({ id: z.string(), title: z.string(), timeLimitSec: z.number(), questions: z.array(z.any()) })
    const parsed = schema.safeParse(quiz)
    if (!parsed.success) return { ok: false, error: 'Received an invalid quiz object.' }
    try {
      return { ok: true, quiz: library.save(parsed.data as StoredQuiz) }
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
          { name: 'All supported files', extensions: ['json', 'md', 'markdown', 'docx', 'pdf'] },
          { name: 'Word & PDF', extensions: ['docx', 'pdf'] },
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: 'JSON', extensions: ['json'] }
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

      // Word, PDF and Markdown all go through the same reader and give the
      // same report back: the questions that came out, and what to look at.
      if (ext === '.docx' || ext === '.pdf' || ext === '.md' || ext === '.markdown') {
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

      return { ok: false, error: `unsupported file type${ext ? ` ${ext}` : ''}; use .docx, .pdf, .md, .markdown or .json` }
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
  })

  // --- data backup/restore ---
  ipcMain.handle('data:backup', async () => {
    if (!win || !dbPath) return { ok: false, error: 'No database.' }
    try {
      const save = await dialog.showSaveDialog(win, { title: 'Backup data', defaultPath: 'quiz-instructor-backup.db', filters: [{ name: 'Database', extensions: ['db'] }] })
      if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled', cancelled: true }
      await fs.copyFile(dbPath, save.filePath)
      return { ok: true, path: save.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('firewall:install', () => installFirewallRules())
  // The same commands, one per line, so the instructor can run them by hand
  // when the app could not raise its own prompt.
  ipcMain.handle('firewall:manual', () => buildInstallCommands(FIREWALL_RULES))
  // Opens the folder that holds setup-firewall.bat.
  ipcMain.handle('firewall:openSetup', () => openFirewallSetup())

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

  // --- results: the score sheets of finished sessions ---

  ipcMain.handle('results:list', () => resultsStore?.list() ?? [])

  ipcMain.handle('results:get', (_event, id: unknown) => {
    if (typeof id !== 'string' || !resultsStore) return null
    return resultsStore.get(id)
  })

  ipcMain.handle('results:delete', (_event, id: unknown) => {
    if (typeof id !== 'string' || !resultsStore) return false
    const deleted = resultsStore.delete(id)
    if (deleted && id === savedResultId) savedResultId = null
    return deleted
  })

  ipcMain.handle('results:updateAnswer', (_event, input: unknown): ResultOperationResult => {
    if (!resultsStore) return { ok: false, error: 'The results are not open.' }
    if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid answer update.' }
    const { answerId, pointsAwarded, correct, notes } = input as Partial<SaveResultAnswerInput>
    if (typeof answerId !== 'string') return { ok: false, error: 'Invalid answer id.' }
    if (typeof pointsAwarded !== 'number' || !Number.isFinite(pointsAwarded)) {
      return { ok: false, error: 'The points must be a number.' }
    }
    if (correct !== undefined && correct !== null && typeof correct !== 'boolean') {
      return { ok: false, error: 'The correct flag must be true, false or null.' }
    }
    if (notes !== undefined && notes !== null && typeof notes !== 'string') {
      return { ok: false, error: 'The note must be text.' }
    }
    return resultsStore.updateAnswer({ answerId, pointsAwarded, correct, notes })
  })

  // Exports one saved session as a CSV score sheet.
  ipcMain.handle('results:exportCsv', async (_event, id: unknown): Promise<{ ok: boolean; path?: string; error?: string }> => {
    if (!resultsStore) return { ok: false, error: 'The results are not open.' }
    if (typeof id !== 'string') return { ok: false, error: 'Invalid session id.' }
    const detail = resultsStore.get(id)
    if (!detail) return { ok: false, error: 'That session is no longer available.' }
    if (!win) return { ok: false, error: 'The window is not available.' }
    try {
      const save = await dialog.showSaveDialog(win, {
        title: 'Export results as CSV',
        defaultPath: `${detail.meta.quizTitle.replace(/[\\/:*?"<>|]/g, '_')}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (save.canceled || !save.filePath) return { ok: false, error: 'Export was cancelled.', cancelled: true } as any
      const esc = (v: unknown): string => {
        const text = v === null || v === undefined ? '' : String(v)
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
      }
      const lines: string[] = []
      lines.push(['Student', 'Finished', 'Total awarded', 'Total possible', ...detail.questions.map((q) => `Q${q.number}`)].join(','))
      for (const student of detail.students) {
        const byQuestion = new Map(student.answers.map((a) => [a.questionId, a]))
        const row = [
          esc(student.studentName),
          student.finished ? 'yes' : 'no',
          student.totalPointsAwarded,
          student.totalPointsPossible,
          ...detail.questions.map((q) => {
            const a = byQuestion.get(q.id)
            if (!a) return ''
            return `${a.pointsAwarded}/${a.pointsPossible}`
          })
        ]
        lines.push(row.join(','))
      }
      await fs.writeFile(save.filePath, lines.join('\r\n') + '\r\n', 'utf8')
      return { ok: true, path: save.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Saves the running session as it stands; the end of the quiz saves again.
  ipcMain.handle('results:createFromCurrent', () => {
    if (!server || !resultsStore) return null
    const state = server.session.quizState()
    if (state.status === 'lobby') return null
    return persistResults(state.endReason)
  })

  // --- step 5: AI question generation ---

  ipcMain.handle('ai:status', async (): Promise<AiStatus> => {
    if (!aiManager) return { ready: false, provider: 'none', model: 'none' }
    return aiManager.refreshStatus()
  })

  ipcMain.handle('ai:info', (): { modelsDir: string; enginePath: string | null } => {
    if (!modelStore) return { modelsDir: '', enginePath: null }
    return { modelsDir: modelStore.getModelsDir(), enginePath: modelStore.getEnginePath() }
  })

  ipcMain.handle('ai:timing', (): AiTiming => {
    if (!modelStore) {
      return { secondsPerQuestion: 6, startUpSeconds: 10, runs: 0 }
    }
    return modelStore.getTiming()
  })

  ipcMain.handle('ai:selectFile', async () => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select a source file',
      properties: ['openFile'],
      filters: [
        { name: 'All supported', extensions: ['docx', 'pdf', 'md', 'markdown', 'txt'] },
        { name: 'Word', extensions: ['docx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Text', extensions: ['txt'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('ai:readFile', async (_event, filePath: unknown): Promise<string> => {
    if (typeof filePath !== 'string' || !aiManager) return ''
    try {
      return await aiManager.extractText(filePath)
    } catch {
      return ''
    }
  })


  ipcMain.handle('ai:generate', async (_event, opts: unknown): Promise<ImportQuizResult> => {
    if (!library || !aiManager) return { ok: false, error: 'The AI provider is not available.' }
    try {
      if (!opts || typeof opts !== 'object') return { ok: false, error: 'Invalid generation options.' }
      const o = opts as {
        sourceText?: string
        filePath?: string
        topic?: string
        questionTypes?: string[]
        count?: number
        points?: number
      }
      const sourceText = typeof o.sourceText === 'string' ? o.sourceText : ''
      const filePath = typeof o.filePath === 'string' && o.filePath.length > 0 ? o.filePath : undefined
      const topic = typeof o.topic === 'string' ? o.topic : ''
      const questionTypes = Array.isArray(o.questionTypes)
        ? o.questionTypes.filter((t): t is QuestionType => typeof t === 'string' && QUESTION_TYPES.includes(t as QuestionType))
        : []
      const count = typeof o.count === 'number' && o.count > 0 ? o.count : 5
      const points = typeof o.points === 'number' && o.points > 0 ? o.points : 1

      const result = await aiManager.generate({
        sourceText,
        filePath,
        topic,
        questionTypes,
        count,
        points
      })

      if (result.error) return { ok: false, error: result.error }
      if (result.questions.length === 0) {
        return { ok: false, error: 'The AI did not write a single valid question.' }
      }

      const quiz = library.create('AI generated quiz')
      quiz.questions = result.questions.map((q) => ({
        ...q,
        id: randomUUID(),
        status: 'draft' as const
      }))
      const saved = library.save(quiz)

      const warnings: { questionIndex: number | null; message: string }[] = []
      if (result.dropped && result.dropped > 0) {
        const reasons = (result.reasons ?? [])
          .sort((a, b) => b.count - a.count)
          .map((r) => `${r.count} because ${r.reason}`)
          .join(', ')
        warnings.push({
          questionIndex: null,
          message: `The model wrote ${result.written ?? result.dropped} questions. ${
            result.dropped
          } were left out${reasons ? ` (${reasons})` : ''}. Fewer question types give more questions.`
        })
      }

      return {
        ok: true,
        report: {
          id: saved.id,
          title: saved.title,
          questionCount: saved.questions.length,
          warnings,
          questions: saved.questions.map((q) => ({
            id: q.id,
            type: q.type,
            body: q.body,
            sourceText: q.sourceText
          }))
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('ai:autoKey', async (_event, input: unknown): Promise<AutoKeyResult> => {
    if (!aiManager) return { questions: [] }
    try {
      if (!input || typeof input !== 'object') return { questions: [] }
      const o = input as { questions?: unknown; sourceText?: string }
      if (!Array.isArray(o.questions)) return { questions: [] }
      const questions = o.questions.filter((q): q is StoredQuestion =>
        q && typeof q === 'object' &&
        typeof (q as { type?: unknown }).type === 'string' &&
        QUESTION_TYPES.includes((q as { type: string }).type as QuestionType)
      )
      const opts: AutoKeyOptions = {
        questions: questions as StoredQuestion[],
        sourceText: typeof o.sourceText === 'string' ? o.sourceText : undefined
      }
      return aiManager.autoKey(opts)
    } catch (err) {
      console.error('ai:autoKey failed:', err)
      return { questions: [] }
    }
  })

  // --- AI model registry ---

  ipcMain.handle('ai:models', (): ModelInfo[] => {
    if (!modelStore) return []
    return modelStore.listModels()
  })

  ipcMain.handle('ai:setModel', (_event, modelId: unknown): boolean => {
    if (!modelStore || !aiManager) return false
    if (modelId !== null && typeof modelId !== 'string') return false
    const changed = modelStore.setActiveModel(modelId)
    if (!changed) return false
    // The chosen model answers from now on, without a restart.
    aiManager.setProvider(createProviderForStore(modelStore))
    return true
  })

  ipcMain.handle('ai:deleteModel', (_event, modelId: unknown): boolean => {
    if (!modelStore || !aiManager) return false
    if (typeof modelId !== 'string') return false
    const deleted = modelStore.deleteModel(modelId)
    if (!deleted) return false
    // Deleting the active model falls back to the built-in generator.
    aiManager.setProvider(createProviderForStore(modelStore))
    return true
  })

  ipcMain.handle('ai:downloadModel', async (_event, modelId: unknown): Promise<DownloadResult> => {
    if (!modelStore) return { ok: false, error: 'The model store is not initialized.' }
    if (typeof modelId !== 'string') return { ok: false, error: 'Invalid model id.' }
    return modelStore.downloadModel(modelId, (progress) => {
      win?.webContents.send('ai:modelProgress', { modelId, ...progress })
    })
  })

  ipcMain.handle('ai:setEngine', (_event, enginePath: unknown): boolean => {
    if (!modelStore || !aiManager) return false
    if (enginePath !== null && typeof enginePath !== 'string') return false
    const saved = modelStore.setEnginePath(enginePath)
    if (!saved) return false
    aiManager.setProvider(createProviderForStore(modelStore))
    return true
  })

  ipcMain.handle('ai:downloadEngine', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!modelStore || !aiManager) return { ok: false, error: 'The model store is not initialized.' }
    const result = await modelStore.downloadEngine((percent) => {
      win?.webContents.send('ai:engineProgress', { percent })
    })
    if (result.ok) aiManager.setProvider(createProviderForStore(modelStore))
    return result
  })

  ipcMain.handle('ai:setEmbeddingModel', (_event, modelId: unknown): boolean => {
    if (!modelStore) return false
    if (modelId !== null && typeof modelId !== 'string') return false
    const changed = modelStore.setActiveEmbeddingModel(modelId)
    if (!changed) return false
    // The user swapped the search model: drop the running server so the next
    // search starts the new one.
    embedder?.stop()
    return true
  })

   ipcMain.handle('ai:selectEngine', async (): Promise<string | null> => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select the llama.cpp binary',
      properties: ['openFile'],
      filters: [{ name: 'Executables', extensions: ['exe', 'bat', 'cmd'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
}

/**
 * Remembers how long a run of questions took, so the next estimate is
 * closer to the truth.
 *
 * The start-up is the time until the first question was ready; the rest is
 * the time the questions themselves took.
 */
function rememberRunTiming(startedAt: number, firstAt: number | null, questions: number): void {
  if (!modelStore || questions <= 0) return
  const elapsedMs = Date.now() - startedAt
  const startUpMs = Math.min(elapsedMs, Math.max(0, (firstAt ?? startedAt) - startedAt))
  const perQuestion = (elapsedMs - startUpMs) / 1000 / questions
  if (!Number.isFinite(perQuestion) || perQuestion <= 0) return
  modelStore.recordTiming(Math.min(120, startUpMs / 1000), perQuestion)
}

/**
 * The embedder for the search by meaning.
 *
 * It only works when the small embedding model and the llama.cpp server are
 * there; without them the app searches by words alone.
 */
function createEmbedder(): LazyEmbedder {  return new LazyEmbedder(() => {
    if (!modelStore) return null
    const modelPath = modelStore.embeddingModelPath()
    if (!modelPath) return null
    const enginePath = modelStore.getEnginePath()
    if (!enginePath) return null
    const serverPath = join(dirname(enginePath), 'llama-server.exe')
    if (!existsSync(serverPath)) return null
    return new LlamaEmbedder({ binaryPath: serverPath, modelPath })
  })
}

/** The student ids of a targeted pop; undefined means every student. */function toIdList(value: unknown): string[] | undefined {
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
  dbPath = join(userData, 'quiz-library.db')
  // Local crash logging (no telemetry): record uncaught errors for diagnostics.
  const crashLog = join(userData, 'crash.log')
  const logCrash = (label: string, err: unknown) => {
    try {
      const line = `[${new Date().toISOString()}] ${label}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
      require('node:fs').appendFileSync(crashLog, line)
    } catch { /* never throw from crash handler */ }
  }
  process.on('uncaughtException', (err) => logCrash('uncaughtException', err))
  process.on('unhandledRejection', (err) => logCrash('unhandledRejection', err))
  const data = openAppData(dbPath)
  library = data.quizzes
  memeStore = data.memes
  resultsStore = data.results
  modelStore = new ModelStore(join(userData, 'models'))
  embedder = createEmbedder()
  aiManager = createAiManagerWithStore(
    modelStore,
    {
      index: data.ai,
      embedder,
      corpus: async (opts) => {
        if (opts.filePath) return fileBlocks(opts.filePath)
        return textBlocks(opts.sourceText)
      }
    },
    (progress) => {
      win?.webContents.send('ai:generateProgress', progress)
    }
  )
  memeAssets = new MemeAssets(memeStore, join(userData, MEME_DIR_NAME))
  memeAssets.ensure()
  // The sample meme is seeded on a brand-new profile only, next to the
  // sample quiz: deleting every meme never brings it back. It lives in the
  // project folder while developing and beside the asar once packaged.
  if (data.fresh) {
    seedSampleMeme(memeAssets, [app.getAppPath(), process.resourcesPath])
  }
  registerIpc()
  await boot()
  // Asked once, after the window is up, so the prompt is not the first thing
  // on screen. It never blocks the app: "Not now" just leaves the dashboard
  // notice in place.
  void promptForFirewallSetup()
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
  resultsStore = null
  aiManager = null
  modelStore = null
  memeAssets = null
  embedder?.stop()
  embedder = null
})


