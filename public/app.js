// ---- 상태 ----
const state = {
  view: "all", // 'all' | 'trash' | notebookId(number)
  notebooks: [],
  notes: [],
  currentNote: null,
  search: "",
  saveTimer: null,
};

let quill;

// ---- API 헬퍼 ----
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error((await res.json()).error || "오류");
  return res.json();
}

// ---- 로그인 ----
const loginEl = document.getElementById("login");
const appEl = document.getElementById("app");

function showLogin() {
  loginEl.classList.remove("hidden");
  appEl.classList.add("hidden");
}
function showApp() {
  loginEl.classList.add("hidden");
  appEl.classList.remove("hidden");
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = document.getElementById("password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      errEl.textContent = (await res.json()).error || "로그인 실패";
      return;
    }
    await boot();
  } catch (err) {
    errEl.textContent = "로그인 중 오류가 발생했습니다.";
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("POST", "/api/logout");
  showLogin();
});

// ---- 노트북 ----
async function loadNotebooks() {
  state.notebooks = await api("GET", "/api/notebooks");
  renderNotebooks();
  renderNotebookSelect();
}

function renderNotebooks() {
  const el = document.getElementById("notebook-list");
  el.innerHTML = "";
  for (const nb of state.notebooks) {
    const div = document.createElement("div");
    div.className =
      "notebook-item" + (state.view === nb.id ? " active" : "");
    div.innerHTML = `<span>📓 ${escapeHtml(nb.name)}</span><span class="count">${nb.note_count}</span>`;
    div.addEventListener("click", () => selectView(nb.id));
    div.addEventListener("dblclick", () => renameNotebook(nb));
    el.appendChild(div);
  }
}

function renderNotebookSelect() {
  const sel = document.getElementById("notebook-select");
  sel.innerHTML = "";
  for (const nb of state.notebooks) {
    const o = document.createElement("option");
    o.value = nb.id;
    o.textContent = nb.name;
    sel.appendChild(o);
  }
}

document
  .getElementById("new-notebook-btn")
  .addEventListener("click", async () => {
    const name = prompt("새 노트북 이름:");
    if (!name?.trim()) return;
    await api("POST", "/api/notebooks", { name: name.trim() });
    await loadNotebooks();
  });

async function renameNotebook(nb) {
  const name = prompt("노트북 이름 변경:", nb.name);
  if (name === null) return;
  if (name.trim()) {
    await api("PUT", `/api/notebooks/${nb.id}`, { name: name.trim() });
  } else if (confirm(`'${nb.name}' 노트북을 삭제할까요? (노트는 휴지통으로 이동)`)) {
    await api("DELETE", `/api/notebooks/${nb.id}`);
    if (state.view === nb.id) state.view = "all";
  } else {
    return;
  }
  await loadNotebooks();
  await loadNotes();
}

// ---- 뷰 전환 ----
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => selectView(item.dataset.view));
});

function selectView(view) {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });
  renderNotebooks();
  loadNotes();
}

// ---- 노트 목록 ----
async function loadNotes() {
  let url = "/api/notes?";
  if (state.view === "trash") url += "trash=1&";
  else if (typeof state.view === "number") url += `notebook=${state.view}&`;
  if (state.search) url += `q=${encodeURIComponent(state.search)}`;

  state.notes = await api("GET", url);
  renderNotes();
  updateListTitle();
}

function updateListTitle() {
  const t = document.getElementById("list-title");
  if (state.view === "all") t.textContent = "모든 노트";
  else if (state.view === "trash") t.textContent = "휴지통";
  else {
    const nb = state.notebooks.find((n) => n.id === state.view);
    t.textContent = nb ? nb.name : "노트";
  }
}

function renderNotes() {
  const el = document.getElementById("notes");
  el.innerHTML = "";
  if (!state.notes.length) {
    el.innerHTML = `<div class="empty-list">노트가 없습니다.</div>`;
    return;
  }
  for (const note of state.notes) {
    const div = document.createElement("div");
    div.className =
      "note-card" +
      (state.currentNote?.id === note.id ? " active" : "");
    const title = note.title?.trim() || "제목 없음";
    div.innerHTML = `
      <div class="nc-title">${note.is_pinned ? '<span class="pin-dot">📌</span> ' : ""}${escapeHtml(title)}</div>
      <div class="nc-snippet">${escapeHtml(note.snippet || "")}</div>
      <div class="nc-meta">
        <span>${formatDate(note.updated_at)}</span>
        ${note.notebook_name ? `<span>· ${escapeHtml(note.notebook_name)}</span>` : ""}
      </div>`;
    div.addEventListener("click", () => openNote(note.id));
    el.appendChild(div);
  }
}

// ---- 새 노트 ----
document.getElementById("new-note-btn").addEventListener("click", async () => {
  const notebookId =
    typeof state.view === "number"
      ? state.view
      : state.notebooks[0]?.id ?? null;
  const note = await api("POST", "/api/notes", { notebook_id: notebookId });
  if (typeof state.view !== "number" && state.view !== "all") {
    state.view = "all";
  }
  await loadNotebooks();
  await loadNotes();
  await openNote(note.id);
  document.getElementById("note-title").focus();
});

// ---- 노트 열기 / 편집 ----
async function openNote(id) {
  const note = await api("GET", `/api/notes/${id}`);
  state.currentNote = note;

  document.getElementById("empty-state").classList.add("hidden");
  document.getElementById("editor-wrap").classList.remove("hidden");
  document.getElementById("note-title").value = note.title || "";

  quill.off("text-change");
  quill.root.innerHTML = note.content || "";
  quill.on("text-change", scheduleSave);

  // 노트북 선택
  const sel = document.getElementById("notebook-select");
  sel.value = note.notebook_id ?? "";

  // 핀 버튼
  document
    .getElementById("pin-btn")
    .classList.toggle("pinned", !!note.is_pinned);

  // 휴지통 여부에 따른 버튼 표시
  const inTrash = !!note.is_trashed;
  document.getElementById("trash-btn").classList.toggle("hidden", inTrash);
  document.getElementById("pin-btn").classList.toggle("hidden", inTrash);
  document.getElementById("restore-btn").classList.toggle("hidden", !inTrash);
  document.getElementById("delete-btn").classList.toggle("hidden", !inTrash);
  quill.enable(!inTrash);
  document.getElementById("note-title").disabled = inTrash;

  renderNotes();
}

function scheduleSave() {
  setStatus("입력 중...");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNote, 800);
}

document.getElementById("note-title").addEventListener("input", scheduleSave);
document
  .getElementById("notebook-select")
  .addEventListener("change", saveNote);

async function saveNote() {
  if (!state.currentNote) return;
  const title = document.getElementById("note-title").value;
  const content = quill.root.innerHTML;
  const snippet = quill.getText().trim().slice(0, 200);
  const notebookId =
    document.getElementById("notebook-select").value || null;

  setStatus("저장 중...");
  await api("PUT", `/api/notes/${state.currentNote.id}`, {
    title,
    content,
    snippet,
    notebook_id: notebookId,
  });
  state.currentNote.title = title;
  state.currentNote.snippet = snippet;
  state.currentNote.notebook_id = notebookId;
  setStatus("저장됨 ✓");
  await loadNotebooks();
  // 목록 갱신(제목/스니펫 반영)
  await refreshListSilently();
}

async function refreshListSilently() {
  const cur = state.currentNote?.id;
  await loadNotes();
  state.currentNote && (state.currentNote.id = cur);
}

function setStatus(text) {
  document.getElementById("save-status").textContent = text;
}

// ---- 핀 / 휴지통 / 삭제 ----
document.getElementById("pin-btn").addEventListener("click", async () => {
  if (!state.currentNote) return;
  await api("PATCH", `/api/notes/${state.currentNote.id}/pin`);
  state.currentNote.is_pinned = state.currentNote.is_pinned ? 0 : 1;
  document
    .getElementById("pin-btn")
    .classList.toggle("pinned", !!state.currentNote.is_pinned);
  await loadNotes();
});

document.getElementById("trash-btn").addEventListener("click", async () => {
  if (!state.currentNote) return;
  await api("PATCH", `/api/notes/${state.currentNote.id}/trash`, {
    trashed: true,
  });
  closeEditor();
  await loadNotebooks();
  await loadNotes();
});

document.getElementById("restore-btn").addEventListener("click", async () => {
  if (!state.currentNote) return;
  await api("PATCH", `/api/notes/${state.currentNote.id}/trash`, {
    trashed: false,
  });
  closeEditor();
  await loadNotebooks();
  await loadNotes();
});

document.getElementById("delete-btn").addEventListener("click", async () => {
  if (!state.currentNote) return;
  if (!confirm("이 노트를 영구 삭제할까요? 되돌릴 수 없습니다.")) return;
  await api("DELETE", `/api/notes/${state.currentNote.id}`);
  closeEditor();
  await loadNotes();
});

function closeEditor() {
  state.currentNote = null;
  document.getElementById("editor-wrap").classList.add("hidden");
  document.getElementById("empty-state").classList.remove("hidden");
}

// ---- 검색 ----
let searchTimer;
document.getElementById("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    loadNotes();
  }, 300);
});

// ---- 유틸 ----
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

function formatDate(s) {
  if (!s) return "";
  // SQLite UTC 문자열 -> 로컬
  const d = new Date(s.replace(" ", "T") + "Z");
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

// ---- 부트스트랩 ----
function initEditor() {
  quill = new Quill("#editor", {
    theme: "snow",
    placeholder: "내용을 입력하세요...",
    modules: {
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ["bold", "italic", "underline", "strike"],
        [{ list: "ordered" }, { list: "bullet" }, { list: "check" }],
        [{ color: [] }, { background: [] }],
        ["blockquote", "code-block", "link"],
        ["clean"],
      ],
    },
  });
}

async function boot() {
  showApp();
  await loadNotebooks();
  await loadNotes();
}

(async function start() {
  initEditor();
  const me = await fetch("/api/me").then((r) => r.json());
  if (me.authed) {
    await boot();
  } else {
    showLogin();
    document.getElementById("password").focus();
  }
})();
