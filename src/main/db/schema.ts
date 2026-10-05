import type { Database } from 'better-sqlite3'

/**
 * Schema version and migrations. Bump SCHEMA_VERSION and append a migration
 * whenever a table changes; migrations run in order inside a transaction so
 * an existing library upgrades without losing data.
 */
export const SCHEMA_VERSION = 1

const MIGRATIONS: string[] = [
  // 1: the step-4 quiz library.
  `
  CREATE TABLE quizzes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    time_limit_sec INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    points INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    key_json TEXT NOT NULL,
    source_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('draft', 'ready'))
  );
  CREATE INDEX questions_by_quiz ON questions(quiz_id, position);
  `
]

/**
 * Applies every pending migration. Returns true when the database was empty
 * (a brand-new file) — the caller seeds the sample quiz in that case, so
 * deleting quizzes later never resurrects it. PRAGMA user_version holds the
 * schema version.
 */
export function migrate(db: Database): boolean {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `The quiz library uses schema v${current}, but this app only knows up to v${SCHEMA_VERSION}.`
    )
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (!step) throw new Error(`Missing migration for schema v${v + 1}`)
    db.transaction(() => {
      db.exec(step)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return current === 0
}