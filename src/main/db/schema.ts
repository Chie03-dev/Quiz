import type { Database } from 'better-sqlite3'

/**
 * Schema version and migrations. Bump SCHEMA_VERSION and append a migration
 * whenever a table changes; migrations run in order inside a transaction so
 * an existing library upgrades without losing data.
 */
export const SCHEMA_VERSION = 4

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
  `,
  // 2: the meme tray (the instructor's jumpscare images).
  `
  CREATE TABLE memes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    byte_size INTEGER NOT NULL,
    thumb TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 3: the results of finished sessions (the instructor's score sheet).
  `
  CREATE TABLE result_sessions (
    id TEXT PRIMARY KEY,
    quiz_id TEXT,
    quiz_title TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER NOT NULL,
    end_reason TEXT,
    total_points INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE result_students (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES result_sessions(id) ON DELETE CASCADE,
    student_name TEXT NOT NULL,
    student_key TEXT,
    finished INTEGER NOT NULL DEFAULT 0,
    total_points_awarded REAL NOT NULL DEFAULT 0,
    total_points_possible INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE result_questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES result_sessions(id) ON DELETE CASCADE,
    question_id TEXT,
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    points INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    key_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE result_answers (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES result_sessions(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL REFERENCES result_students(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES result_questions(id) ON DELETE CASCADE,
    value_json TEXT,
    correct INTEGER,
    points_awarded REAL NOT NULL DEFAULT 0,
    points_possible INTEGER NOT NULL,
    auto_graded INTEGER NOT NULL DEFAULT 1,
    notes TEXT
  );
  CREATE INDEX idx_result_students_session ON result_students(session_id);
  CREATE INDEX idx_result_questions_session ON result_questions(session_id);
   CREATE INDEX idx_result_answers_session ON result_answers(session_id);
   CREATE INDEX idx_result_answers_student_q ON result_answers(student_id, question_id);
   `,
  // 4: the AI chunk cache for RAG (retrieval-augmented generation).
  `
  CREATE TABLE ai_chunks (
    id TEXT PRIMARY KEY,
    source_ref TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_ai_chunks_source ON ai_chunks(source_ref, chunk_index);
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