import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type { Quiz } from '../../shared/types'
import { quizStartError } from '../../shared/validation'
import { toRuntimeQuiz } from '../quizFormat'
import { QuizLibrary } from './library'
import { MemeStore } from './memes'
import { ResultsStore } from './results'
import { migrate } from './schema'

export { QuizLibrary } from './library'
export { MemeStore } from './memes'
export { ResultsStore } from './results'
export { SCHEMA_VERSION } from './schema'

/**
 * Picks the right better-sqlite3 binary. The npm package's default build
 * targets the plain Node that ran the install (used by `npm run check`);
 * inside Electron that build has the wrong ABI, so a prebuilt Electron
 * binary fetched by scripts/ensure-native.cjs is passed explicitly.
 */
function nativeOptions(): { nativeBinding?: string } {
  if (!process.versions.electron) return {}
  const addon = join(dirname(require.resolve('better-sqlite3/package.json')), 'native', 'electron.node')
  if (!existsSync(addon)) {
    throw new Error(
      'The Electron build of better-sqlite3 is missing. Run `npm install` with network access; ' +
        'scripts/ensure-native.cjs downloads it (no compiler needed).'
    )
  }
  return { nativeBinding: addon }
}

/**
 * The app's own data: the quiz library, the meme tray and the results of
 * finished sessions, all on one database connection so they never fight over
 * the same SQLite file.
 */
export interface AppData {
  quizzes: QuizLibrary
  memes: MemeStore
  results: ResultsStore
  /** True when the database file was brand new: the sample data is seeded then. */
  fresh: boolean
}

/**
 * Opens the database at filePath, runs pending migrations, and seeds the
 * sample quiz on the very first run. The file lives in app.getPath('userData')
 * when the app opens it; tests pass a temp path.
 */
export function openAppData(filePath: string): AppData {
  const db = new Database(filePath, nativeOptions())
  db.pragma('foreign_keys = ON')
  const fresh = migrate(db)
  const quizzes = new QuizLibrary(db)
  const memes = new MemeStore(db)
  const results = new ResultsStore(db)
  if (fresh) quizzes.seedSampleQuiz()
  return { quizzes, memes, results, fresh }
}

/** The quiz library alone; kept for the test scripts and older call sites. */
export function openQuizLibrary(filePath: string): QuizLibrary {
  return openAppData(filePath).quizzes
}

export type StartAttempt = { ok: true; quiz: Quiz } | { ok: false; message: string }

/**
 * Loads a quiz for starting. Refuses quizzes with no questions or with any
 * invalid (draft) question, naming the ones that block the start. Validation
 * is recomputed, so a stale stored 'ready' never starts a draft.
 */
export function runtimeQuizForStart(library: QuizLibrary, quizId: string): StartAttempt {
  const stored = library.get(quizId)
  if (!stored) return { ok: false, message: 'That quiz is no longer in the library.' }
  const problem = quizStartError(stored)
  if (problem) return { ok: false, message: problem }
  return { ok: true, quiz: toRuntimeQuiz(stored) }
}