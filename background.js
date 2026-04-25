const api = typeof browser !== "undefined" ? browser : chrome;
const POLLINATIONS_URL = "https://text.pollinations.ai/openai";
const MAX_LOGS = 30;
const REQUEST_TIMEOUT_MS = 90000;
const STALE_JOB_MS = 120000;
const generationJobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function shortId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getStored(key, fallback) {
  const result = await api.storage.local.get(key);
  return result[key] ?? fallback;
}

async function appendLlmLog(entry) {
  const logs = await getStored("llmLogs", []);
  const nextLogs = [{ id: shortId(), createdAt: nowIso(), ...entry }, ...logs].slice(0, MAX_LOGS);
  await api.storage.local.set({ llmLogs: nextLogs });
  return nextLogs;
}

function generationKey(url) {
  return `generation:${url}`;
}

async function setGenerationStatus(key, status) {
  await api.storage.local.set({
    [key]: {
      ...status,
      updatedAt: nowIso()
    }
  });
}

async function getGenerationStatus(url) {
  if (!url) return null;
  const key = generationKey(url);
  const status = await getStored(key, null);

  if (status?.status === "running" && !generationJobs.has(key)) {
    const updatedAt = new Date(status.updatedAt || status.startedAt || 0).getTime();
    if (Date.now() - updatedAt > STALE_JOB_MS) {
      const staleStatus = {
        ...status,
        status: "error",
        error: "The previous generation was interrupted. Click Generate to start again."
      };
      await setGenerationStatus(key, staleStatus);
      return staleStatus;
    }
  }

  return status;
}

function buildPrompt(article, options = {}) {
  const focusQuestion = options.focusQuestion?.trim() || "No user focus question provided.";
  const manualHighlights = options.manualHighlights?.trim() || "No manual highlights provided.";
  const noteDepth = options.noteDepth || "deep";

  return [
    "You are a clear note-taking assistant for Medium and Towards Data Science articles.",
    "Write useful study notes for a student or developer who wants to understand the article quickly and remember it later.",
    "",
    "Important output rules:",
    "- Return only the finished notes in Markdown.",
    "- Do not return JSON.",
    "- Do not include role, reasoning_content, tool_calls, analysis, planning, or explanation of how you will answer.",
    "- Use plain language. Avoid academic or corporate jargon unless the article uses it, and explain technical terms in simple words.",
    "- Ground every note in the article text. Do not invent facts, links, citations, numbers, quotes, author intent, or examples.",
    "- If something is unclear or missing, say \"The article does not say.\"",
    "- Make the notes complete enough to study from, but easy to scan.",
    "",
    `Depth target: ${noteDepth}`,
    `Reader focus question: ${focusQuestion}`,
    `Reader manual highlights or rough notes: ${manualHighlights}`,
    "",
    "Use this exact structure:",
    "# <article title>",
    "",
    "## At A Glance",
    "- Author: <author or unknown>",
    "- Source: <url>",
    "- Length: <word count>",
    "- Main idea: <one simple sentence>",
    "- Best for: <who would benefit from reading this>",
    "",
    "## Short Summary",
    "<5-7 clear sentences. Explain what the article is about, what problem it addresses, what it teaches, and the conclusion.>",
    "",
    "## Key Takeaways",
    "- <takeaway in plain language>",
    "- <takeaway in plain language>",
    "- <takeaway in plain language>",
    "",
    "## Detailed Notes",
    "### 1. <section title>",
    "- What it says: <main point>",
    "- Why it matters: <practical meaning>",
    "- Article support: <specific phrase, example, or detail from the article>",
    "",
    "### 2. <section title>",
    "- What it says: <main point>",
    "- Why it matters: <practical meaning>",
    "- Article support: <specific phrase, example, or detail from the article>",
    "",
    "## Terms Explained",
    "- <term>: <simple definition based on the article>",
    "",
    "## Examples From The Article",
    "- <example>: <what this example shows>",
    "",
    "## Important Lines",
    "- \"<short exact quote from the article>\"",
    "  - Why it matters: <simple explanation>",
    "",
    "## Things To Remember",
    "- <memory-friendly point>",
    "- <memory-friendly point>",
    "- <memory-friendly point>",
    "",
    "## Reader Focus",
    "- Focus question answer: <answer the user's focus question if possible>",
    "- Manual highlights used: <how the user's highlights connect, or \"No manual highlights provided.\">",
    "",
    "## Follow-Up Questions",
    "- <question the reader should ask next>",
    "- <question the reader should ask next>",
    "",
    "## Flashcards",
    "- Q: <question>",
    "  A: <answer>",
    "- Q: <question>",
    "  A: <answer>",
    "",
    "## Tags",
    "- <short tag>",
    "- <short tag>",
    "- <short tag>",
    "",
    `Article title: ${article.title || "Untitled"}`,
    `Author: ${article.author || "Unknown"}`,
    `URL: ${article.url}`,
    `Word count: ${article.wordCount || "Unknown"}`,
    "",
    "Article text:",
    article.text || article.excerpt || ""
  ].join("\n");
}

function extractPollinationsText(text) {
  try {
    const parsed = JSON.parse(text);
    return (
      parsed.output ||
      parsed.text ||
      parsed.content ||
      parsed.message?.content ||
      parsed.choices?.[0]?.message?.content ||
      ""
    );
  } catch {
    return text;
  }
}

function isInvalidNoteOutput(text) {
  const trimmed = (text || "").trim();
  return (
    !trimmed ||
    trimmed.startsWith("{") ||
    trimmed.includes('"reasoning_content"') ||
    trimmed.includes("reasoning_content") ||
    trimmed.includes("tool_calls") ||
    /^we need to/i.test(trimmed) ||
    /^let'?s /i.test(trimmed)
  );
}

async function requestPollinations(prompt, model = "openai") {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(POLLINATIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "Return only final Markdown notes. Never return reasoning, JSON, role fields, or tool call fields."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 1800,
        reasoning_effort: "low",
        stream: false,
        private: true
      })
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Pollinations took too long to respond. Try again with a shorter article or fewer highlights.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Pollinations request failed with ${response.status}`);
  }

  return extractPollinationsText(text);
}

async function callPollinations(prompt) {
  const primary = await requestPollinations(prompt, "openai");
  if (!isInvalidNoteOutput(primary)) return primary;

  const retryPrompt = [
    "Return final notes only. Do not include reasoning or JSON.",
    "",
    prompt
  ].join("\n");
  const retry = await requestPollinations(retryPrompt, "mistral");
  if (!isInvalidNoteOutput(retry)) return retry;

  throw new Error("Pollinations returned no final note content. Please retry in a moment.");
}

async function runGenerationJob(key, article, options) {
  const prompt = buildPrompt(article, options);
  const startedAt = nowIso();

  try {
    const notes = await callPollinations(prompt);
    await setGenerationStatus(key, {
      status: "done",
      article,
      options,
      notes,
      startedAt,
      finishedAt: nowIso()
    });
    await appendLlmLog({
      status: "success",
      articleTitle: article.title,
      articleUrl: article.url,
      model: "openai",
      prompt,
      response: notes,
      startedAt,
      finishedAt: nowIso()
    });
  } catch (err) {
    await setGenerationStatus(key, {
      status: "error",
      article,
      options,
      error: err.message || "Pollinations request failed.",
      startedAt,
      finishedAt: nowIso()
    });
    await appendLlmLog({
      status: "error",
      articleTitle: article.title,
      articleUrl: article.url,
      model: "openai",
      prompt,
      response: "",
      error: err.message || String(err),
      startedAt,
      finishedAt: nowIso()
    });
  } finally {
    generationJobs.delete(key);
  }
}

async function startGeneration(article, options) {
  const key = generationKey(article.url);
  const existing = await getGenerationStatus(article.url);

  if (generationJobs.has(key) || existing?.status === "running") {
    return { ok: true, job: existing };
  }

  const job = {
    status: "running",
    article,
    options,
    startedAt: nowIso()
  };
  await setGenerationStatus(key, job);

  const promise = runGenerationJob(key, article, options);
  generationJobs.set(key, promise);

  return { ok: true, job };
}

api.runtime.onMessage.addListener((message) => {
  if (message?.type === "START_GENERATE_NOTES") {
    return startGeneration(message.article, message.options);
  }

  if (message?.type === "GET_GENERATION_STATUS") {
    return getGenerationStatus(message.url).then((job) => ({ ok: true, job }));
  }

  if (message?.type === "GET_LLM_LOGS") {
    return getStored("llmLogs", []).then((logs) => ({ ok: true, logs }));
  }

  if (message?.type === "CLEAR_LLM_LOGS") {
    return api.storage.local.set({ llmLogs: [] }).then(() => ({ ok: true }));
  }

  return undefined;
});
