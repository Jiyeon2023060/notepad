import { createClient } from "@libsql/client";

const url = process.env.TURSO_URL;
const authToken = process.env.TURSO_TOKEN;

if (!url) {
  throw new Error("TURSO_URL 환경변수가 설정되지 않았습니다.");
}

export const db = createClient({ url, authToken });

// 앱 시작 시 테이블 생성 (없을 때만)
export async function initSchema() {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS notebooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notebook_id INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        snippet TEXT NOT NULL DEFAULT '',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_trashed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id)`,
      `CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC)`,
    ],
    "write"
  );

  // 노트북이 하나도 없으면 기본 노트북 생성
  const { rows } = await db.execute("SELECT COUNT(*) AS c FROM notebooks");
  if (Number(rows[0].c) === 0) {
    await db.execute({
      sql: "INSERT INTO notebooks (name) VALUES (?)",
      args: ["내 노트"],
    });
  }
}
