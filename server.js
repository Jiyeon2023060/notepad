import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, initSchema } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser(SESSION_SECRET));

if (!APP_PASSWORD) {
  console.warn(
    "[경고] APP_PASSWORD 가 설정되지 않았습니다. 인증 없이 접근 가능합니다."
  );
}

// ---- 인증 ----
const COOKIE = "np_auth";

function makeToken() {
  // 비밀번호 기반 서명 토큰. 비밀번호가 바뀌면 기존 토큰 무효화됨.
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update("authed:" + APP_PASSWORD)
    .digest("hex");
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  return req.signedCookies[COOKIE] === makeToken();
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!APP_PASSWORD || password === APP_PASSWORD) {
    res.cookie(COOKIE, makeToken(), {
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30일
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ authed: isAuthed(req), authRequired: Boolean(APP_PASSWORD) });
});

// ---- 노트북 API ----
app.get("/api/notebooks", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.execute(`
      SELECT nb.id, nb.name, nb.created_at,
        (SELECT COUNT(*) FROM notes n WHERE n.notebook_id = nb.id AND n.is_trashed = 0) AS note_count
      FROM notebooks nb
      ORDER BY nb.name COLLATE NOCASE
    `);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

app.post("/api/notebooks", requireAuth, async (req, res, next) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "이름이 필요합니다." });
    const r = await db.execute({
      sql: "INSERT INTO notebooks (name) VALUES (?)",
      args: [name],
    });
    res.json({ id: Number(r.lastInsertRowid), name });
  } catch (e) {
    next(e);
  }
});

app.put("/api/notebooks/:id", requireAuth, async (req, res, next) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "이름이 필요합니다." });
    await db.execute({
      sql: "UPDATE notebooks SET name = ? WHERE id = ?",
      args: [name, req.params.id],
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.delete("/api/notebooks/:id", requireAuth, async (req, res, next) => {
  try {
    // 노트북 삭제 시 소속 노트는 휴지통으로
    await db.execute({
      sql: "UPDATE notes SET is_trashed = 1 WHERE notebook_id = ?",
      args: [req.params.id],
    });
    await db.execute({
      sql: "DELETE FROM notebooks WHERE id = ?",
      args: [req.params.id],
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---- 노트 API ----
// 목록: ?notebook=ID | ?trash=1 | ?q=검색어
app.get("/api/notes", requireAuth, async (req, res, next) => {
  try {
    const { notebook, trash, q } = req.query;
    const where = [];
    const args = [];

    if (trash === "1") {
      where.push("n.is_trashed = 1");
    } else {
      where.push("n.is_trashed = 0");
      if (notebook) {
        where.push("n.notebook_id = ?");
        args.push(notebook);
      }
    }
    if (q) {
      where.push("(n.title LIKE ? OR n.snippet LIKE ?)");
      args.push(`%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT n.id, n.notebook_id, n.title, n.snippet, n.is_pinned, n.is_trashed,
             n.created_at, n.updated_at, nb.name AS notebook_name
      FROM notes n
      LEFT JOIN notebooks nb ON nb.id = n.notebook_id
      WHERE ${where.join(" AND ")}
      ORDER BY n.is_pinned DESC, n.updated_at DESC
    `;
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

app.get("/api/notes/:id", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.execute({
      sql: "SELECT * FROM notes WHERE id = ?",
      args: [req.params.id],
    });
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

app.post("/api/notes", requireAuth, async (req, res, next) => {
  try {
    const notebookId = req.body?.notebook_id ?? null;
    const r = await db.execute({
      sql: "INSERT INTO notes (notebook_id, title, content, snippet) VALUES (?, '', '', '')",
      args: [notebookId],
    });
    const { rows } = await db.execute({
      sql: "SELECT * FROM notes WHERE id = ?",
      args: [Number(r.lastInsertRowid)],
    });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

app.put("/api/notes/:id", requireAuth, async (req, res, next) => {
  try {
    const { title, content, snippet, notebook_id } = req.body || {};
    await db.execute({
      sql: `UPDATE notes
            SET title = ?, content = ?, snippet = ?, notebook_id = ?,
                updated_at = datetime('now')
            WHERE id = ?`,
      args: [
        title ?? "",
        content ?? "",
        snippet ?? "",
        notebook_id ?? null,
        req.params.id,
      ],
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// 핀 토글
app.patch("/api/notes/:id/pin", requireAuth, async (req, res, next) => {
  try {
    await db.execute({
      sql: "UPDATE notes SET is_pinned = CASE is_pinned WHEN 1 THEN 0 ELSE 1 END WHERE id = ?",
      args: [req.params.id],
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// 휴지통으로 이동 / 복원
app.patch("/api/notes/:id/trash", requireAuth, async (req, res, next) => {
  try {
    const trashed = req.body?.trashed ? 1 : 0;
    await db.execute({
      sql: "UPDATE notes SET is_trashed = ?, updated_at = datetime('now') WHERE id = ?",
      args: [trashed, req.params.id],
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// 영구 삭제
app.delete("/api/notes/:id", requireAuth, async (req, res, next) => {
  try {
    await db.execute({
      sql: "DELETE FROM notes WHERE id = ?",
      args: [req.params.id],
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---- 정적 파일 ----
app.use(express.static(path.join(__dirname, "public")));

// 에러 핸들러
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "서버 오류", detail: String(err?.message || err) });
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`메모장 서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("DB 초기화 실패:", e);
    process.exit(1);
  });
