const browserApi = typeof browser !== "undefined" ? browser : chrome;

function textFrom(selector) {
  const el = document.querySelector(selector);
  return el ? el.textContent.trim() : "";
}

function metaContent(selector) {
  return document.querySelector(selector)?.getAttribute("content") || "";
}

function getCanonicalUrl() {
  const canonical = document.querySelector('link[rel="canonical"]');
  return canonical?.href || location.href;
}

function cleanText(value) {
  return (value || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function getArticleNode() {
  return (
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.body
  );
}

function extractArticle() {
  const articleNode = getArticleNode();
  const title =
    cleanText(textFrom("h1")) ||
    cleanText(document.title.replace(/\|.*$/, ""));
  const author =
    cleanText(textFrom('[data-testid="authorName"]')) ||
    cleanText(textFrom('a[href*="/@"]')) ||
    cleanText(metaContent('meta[name="author"]'));
  const publishedAt =
    document.querySelector("time")?.getAttribute("datetime") ||
    cleanText(textFrom("time"));

  const blocks = Array.from(
    articleNode.querySelectorAll("h1, h2, h3, p, blockquote, li, pre")
  )
    .map((node) => cleanText(node.textContent))
    .filter((text) => text.length > 24);

  const uniqueBlocks = [];
  const seen = new Set();
  for (const block of blocks) {
    const key = block.slice(0, 120).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueBlocks.push(block);
    }
  }

  const articleText = uniqueBlocks.join("\n\n").slice(0, 9000);

  return {
    title,
    author,
    publishedAt,
    url: getCanonicalUrl(),
    sourceHost: location.hostname,
    excerpt: articleText.slice(0, 700),
    text: articleText,
    wordCount: articleText ? articleText.split(/\s+/).length : 0
  };
}

browserApi.runtime.onMessage.addListener((message) => {
  if (message?.type !== "EXTRACT_ARTICLE") return undefined;
  return Promise.resolve({ ok: true, article: extractArticle() });
});
