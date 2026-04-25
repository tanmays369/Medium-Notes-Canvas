const api = typeof browser !== "undefined" ? browser : chrome;

const els = {
  status: document.getElementById("status"),
  readBtn: document.getElementById("read-btn"),
  generateBtn: document.getElementById("generate-btn"),
  saveBtn: document.getElementById("save-btn"),
  copyBtn: document.getElementById("copy-btn"),
  refreshSavedBtn: document.getElementById("refresh-saved-btn"),
  clearLogsBtn: document.getElementById("clear-logs-btn"),
  articleTitle: document.getElementById("article-title"),
  articleMeta: document.getElementById("article-meta"),
  articleExcerpt: document.getElementById("article-excerpt"),
  focusQuestion: document.getElementById("focus-question"),
  noteDepth: document.getElementById("note-depth"),
  manualHighlights: document.getElementById("manual-highlights"),
  noteTitle: document.getElementById("note-title"),
  noteTags: document.getElementById("note-tags"),
  notes: document.getElementById("notes"),
  dirtyState: document.getElementById("dirty-state"),
  savedList: document.getElementById("saved-list"),
  logs: document.getElementById("logs")
};

let currentTab = null;
let currentArticle = null;
let lastSavedSnapshot = "";
let generationPollTimer = null;

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function isSupportedArticleUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "medium.com" ||
      host.endsWith(".medium.com") ||
      host === "towardsdatascience.com" ||
      host.endsWith(".towardsdatascience.com")
    );
  } catch {
    return false;
  }
}

function noteStorageKey(url) {
  return `articleNote:${url}`;
}

function serializeCurrentDraft() {
  return JSON.stringify({
    title: els.noteTitle.value.trim(),
    tags: els.noteTags.value.trim(),
    notes: els.notes.value
  });
}

function markDirty() {
  const hasContent = els.notes.value.trim().length > 0;
  els.copyBtn.disabled = !hasContent;
  els.saveBtn.disabled = !currentArticle || !hasContent;
  els.dirtyState.textContent = serializeCurrentDraft() === lastSavedSnapshot ? "Saved" : "Unsaved";
}

function stopGenerationPolling() {
  if (generationPollTimer) {
    clearInterval(generationPollTimer);
    generationPollTimer = null;
  }
}

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function sendExtractMessage(tabId) {
  try {
    return await api.tabs.sendMessage(tabId, { type: "EXTRACT_ARTICLE" });
  } catch {
    await api.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return api.tabs.sendMessage(tabId, { type: "EXTRACT_ARTICLE" });
  }
}

function renderArticle(article) {
  els.articleTitle.textContent = article.title || "Untitled article";
  els.articleMeta.textContent = [
    article.author,
    article.publishedAt,
    `${article.wordCount || 0} words`,
    article.sourceHost
  ].filter(Boolean).join(" | ");
  els.articleExcerpt.textContent = article.excerpt || "No article text found.";
  els.noteTitle.value = article.title || "";
}

function applyGeneratedNotes(notes) {
  els.notes.value = notes.trim();
  lastSavedSnapshot = "";
  markDirty();
}

async function syncGenerationStatus() {
  if (!currentArticle?.url) return;

  const response = await api.runtime.sendMessage({
    type: "GET_GENERATION_STATUS",
    url: currentArticle.url
  });
  const job = response?.job;

  if (!job) return;

  if (job.status === "running") {
    setStatus("Still generating...", "");
    els.generateBtn.disabled = true;
    return;
  }

  stopGenerationPolling();
  els.generateBtn.disabled = false;

  if (job.status === "done" && job.notes) {
    if (job.notes.includes("Fallback notes ready") || job.notes.includes("created this clean fallback")) {
      setStatus("Old failed result ignored", "error");
      return;
    }
    if (!els.notes.value.trim()) {
      applyGeneratedNotes(job.notes);
    }
    setStatus("Generated, not saved", "ok");
    return;
  }

  if (job.status === "error") {
    setStatus(job.error || "LLM failed", "error");
  }
}

function startGenerationPolling() {
  stopGenerationPolling();
  generationPollTimer = setInterval(async () => {
    await syncGenerationStatus();
    await renderLogs();
  }, 2500);
}

async function readArticle() {
  setStatus("Reading...");
  currentTab = await activeTab();

  if (!currentTab?.id || !isSupportedArticleUrl(currentTab.url)) {
    currentArticle = null;
    stopGenerationPolling();
    setStatus("Unsupported", "error");
    els.articleTitle.textContent = "Open a Medium or Towards Data Science article first.";
    els.articleMeta.textContent = "";
    els.articleExcerpt.textContent = "This extension is restricted to medium.com and towardsdatascience.com articles.";
    els.generateBtn.disabled = true;
    markDirty();
    return;
  }

  const response = await sendExtractMessage(currentTab.id);
  if (!response?.ok || !response.article?.text) {
    setStatus("No text", "error");
    els.articleExcerpt.textContent = "Could not extract article text from this Medium page.";
    return;
  }

  currentArticle = response.article;
  renderArticle(currentArticle);
  els.generateBtn.disabled = false;
  markDirty();
  setStatus("Article ready", "ok");
  await syncGenerationStatus();
  if (els.generateBtn.disabled) startGenerationPolling();
}

async function generateNotes() {
  if (!currentArticle) return;

  setStatus("Generating...");
  els.generateBtn.disabled = true;
  const response = await api.runtime.sendMessage({
    type: "START_GENERATE_NOTES",
    article: currentArticle,
    options: {
      focusQuestion: els.focusQuestion.value,
      noteDepth: els.noteDepth.value,
      manualHighlights: els.manualHighlights.value
    }
  });

  if (!response?.ok) {
    setStatus("LLM failed", "error");
    els.generateBtn.disabled = false;
    await renderLogs();
    return;
  }

  if (response.job?.status === "done" && response.job.notes) {
    applyGeneratedNotes(response.job.notes);
    els.generateBtn.disabled = false;
    setStatus("Generated, not saved", "ok");
    await renderLogs();
    return;
  }

  setStatus("Generating in background...");
  startGenerationPolling();
}

async function saveNotes() {
  if (!currentArticle || !els.notes.value.trim()) return;

  const draft = {
    id: noteStorageKey(currentArticle.url),
    article: currentArticle,
    title: els.noteTitle.value.trim() || currentArticle.title || "Untitled Medium note",
    tags: els.noteTags.value.split(",").map((tag) => tag.trim()).filter(Boolean),
    notes: els.notes.value,
    savedAt: new Date().toISOString()
  };

  await api.storage.local.set({ [draft.id]: draft });
  lastSavedSnapshot = serializeCurrentDraft();
  markDirty();
  await renderSavedNotes();
  setStatus("Saved by click", "ok");
}

function applySavedNote(note) {
  currentArticle = note.article;
  renderArticle(note.article);
  els.noteTitle.value = note.title || note.article?.title || "";
  els.noteTags.value = (note.tags || []).join(", ");
  els.notes.value = note.notes || "";
  lastSavedSnapshot = serializeCurrentDraft();
  els.generateBtn.disabled = false;
  markDirty();
  setStatus("Loaded saved note", "ok");
}

async function getSavedNotes() {
  const all = await api.storage.local.get(null);
  return Object.values(all)
  .filter((value) => value?.id?.startsWith("articleNote:") || value?.id?.startsWith("mediumNote:"))
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

function renderSavedCard(note) {
  const card = document.createElement("article");
  card.className = "saved-card";

  const title = document.createElement("h3");
  title.textContent = note.title || "Untitled note";

  const meta = document.createElement("p");
  meta.className = "muted";
  meta.textContent = `${new Date(note.savedAt).toLocaleString()} | ${(note.tags || []).join(", ") || "no tags"}`;

  const url = document.createElement("p");
  url.className = "muted";
  url.textContent = note.article?.url || "";

  const load = document.createElement("button");
  load.type = "button";
  load.textContent = "Load";
  load.addEventListener("click", () => applySavedNote(note));

  card.append(title, meta, url, load);
  return card;
}

async function renderSavedNotes() {
  const notes = await getSavedNotes();
  els.savedList.innerHTML = "";

  if (notes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No saved notes yet.";
    els.savedList.appendChild(empty);
    return;
  }

  notes.forEach((note) => els.savedList.appendChild(renderSavedCard(note)));
}

async function copyNotes() {
  await navigator.clipboard.writeText(els.notes.value);
  setStatus("Copied", "ok");
}

function renderLogEntry(log) {
  const details = document.createElement("details");
  details.className = "log-entry";

  const summary = document.createElement("summary");
  const date = new Date(log.createdAt).toLocaleString();
  summary.textContent = `${log.status.toUpperCase()} | ${date} | ${log.articleTitle || "Untitled"}`;

  const prompt = document.createElement("pre");
  prompt.textContent = `Prompt:\n${log.prompt}`;

  const response = document.createElement("pre");
  response.textContent = log.status === "success"
    ? `Response:\n${log.response}`
    : `Error:\n${log.error || "Unknown error"}`;

  details.append(summary, prompt, response);
  return details;
}

async function renderLogs() {
  const response = await api.runtime.sendMessage({ type: "GET_LLM_LOGS" });
  const logs = response?.logs || [];
  els.logs.innerHTML = "";

  if (logs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No LLM calls yet.";
    els.logs.appendChild(empty);
    return;
  }

  logs.forEach((log) => els.logs.appendChild(renderLogEntry(log)));
}

async function clearLogs() {
  await api.runtime.sendMessage({ type: "CLEAR_LLM_LOGS" });
  await renderLogs();
  setStatus("Logs cleared", "ok");
}

els.readBtn.addEventListener("click", readArticle);
els.generateBtn.addEventListener("click", generateNotes);
els.saveBtn.addEventListener("click", saveNotes);
els.copyBtn.addEventListener("click", copyNotes);
els.refreshSavedBtn.addEventListener("click", renderSavedNotes);
els.clearLogsBtn.addEventListener("click", clearLogs);
[els.noteTitle, els.noteTags, els.notes].forEach((el) => {
  el.addEventListener("input", markDirty);
});

(async function init() {
  await Promise.all([renderLogs(), renderSavedNotes()]);
  try {
    await readArticle();
  } catch {
    setStatus("Ready");
  }
})();
