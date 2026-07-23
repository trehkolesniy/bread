import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const sourcesFile = path.join(dataDir, "sources.json");
const translationsFile = path.join(dataDir, "translations.json");
const articleTranslationsFile = path.join(dataDir, "article-translations.json");
const readerStateFile = path.join(dataDir, "reader-state.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiLiveModel = process.env.GEMINI_MODEL || "gemini-3.1-flash-live-preview";
const translationProvider = geminiApiKey ? "gemini-live" : "google-translate";
const translationModel = geminiApiKey ? geminiLiveModel : "google-translate";
const translationCacheVersion = geminiApiKey ? "gemini-live-preview-v1" : "google-preview-v2";
const translationsDisabled = process.env.DISABLE_TRANSLATIONS === "1";
const googleTranslateEndpoint = "https://translate.googleapis.com/translate_a/single";
const geminiLiveEndpoint =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const previewMarkers = {
  titleStart: "RL2K_TITLE_START",
  titleEnd: "RL2K_TITLE_END",
  descriptionStart: "RL2K_DESCRIPTION_START",
  descriptionEnd: "RL2K_DESCRIPTION_END"
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sourceId(feedUrl) {
  return `source-${createHash("sha1").update(feedUrl).digest("hex").slice(0, 12)}`;
}

function cacheKey(value) {
  return createHash("sha1").update(value).digest("hex");
}

function normalizeHttpUrl(value) {
  const parsed = new URL(String(value || "").trim());

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }

  return parsed.toString();
}

async function readSources() {
  try {
    const saved = JSON.parse(await readFile(sourcesFile, "utf8"));
    return Array.isArray(saved.sources) ? saved.sources : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeSources(sources) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(sourcesFile, `${JSON.stringify({ sources }, null, 2)}\n`);
}

async function readTranslations() {
  try {
    const saved = JSON.parse(await readFile(translationsFile, "utf8"));
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeTranslations(translations) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(translationsFile, `${JSON.stringify(translations, null, 2)}\n`);
}

async function readArticleTranslations() {
  try {
    const saved = JSON.parse(await readFile(articleTranslationsFile, "utf8"));
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeArticleTranslations(translations) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(articleTranslationsFile, `${JSON.stringify(translations)}\n`);
}

async function readReaderState() {
  try {
    const saved = JSON.parse(await readFile(readerStateFile, "utf8"));
    return saved && typeof saved === "object" ? saved : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeReaderState(state) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(readerStateFile, `${JSON.stringify(state)}\n`);
}

async function handleTranslationCacheScript(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  const cache = await readTranslations();
  const translations = {};

  for (const entry of Object.values(cache)) {
    const source = entry?.source;
    const translated = entry?.translated;

    if (!source || !translated) continue;

    const key = `${source.title || ""}\n${source.description || ""}`;
    translations[key] = {
      title: translated.title || "",
      description: translated.description || ""
    };
  }

  const payload = JSON.stringify(translations).replace(/</g, "\\u003c");
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`window.READ_LIKE_2000_TRANSLATIONS = ${payload};\n`);
}

function publicSource(source) {
  return {
    id: source.id,
    title: source.title,
    siteUrl: source.siteUrl,
    feedUrl: source.feedUrl,
    parser: source.parser || "feed",
    createdAt: source.createdAt
  };
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i"));
  return match ? match[1].replace(/^["']|["']$/g, "") : "";
}

function decodeHtml(value = "") {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };

  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    const lower = code.toLowerCase();

    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return named[lower] || entity;
  });
}

function stripHtml(value = "") {
  return decodeHtml(String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function looksRussian(value = "") {
  const cyrillic = value.match(/[А-Яа-яЁё]/g)?.length || 0;
  const latin = value.match(/\p{Script=Latin}/gu)?.length || 0;
  return cyrillic > 0 && cyrillic >= latin;
}

async function runLimited(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });

  await Promise.all(workers);
}

function normalizePreviewText(text, maxLength) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeTranslationInput(text, maxLength) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function protectTranslationText(text) {
  const tokens = [];
  const protectedText = String(text).replace(
    /`[^`]+`|https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
    (value) => {
      const placeholder = `RL2K_TOKEN_${tokens.length}`;
      tokens.push({ placeholder, value });
      return placeholder;
    }
  );

  return { text: protectedText, tokens };
}

function restoreTranslationText(text, tokens) {
  return tokens.reduce((value, token) => value.replaceAll(token.placeholder, token.value), text);
}

async function translateTextToRussian(text, options = {}) {
  const normalized = normalizeTranslationInput(text, 1800);

  if (!normalized || (!options.force && looksRussian(normalized))) {
    return normalized;
  }

  const protectedText = protectTranslationText(normalized);
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: "ru",
    hl: "ru",
    dt: "t",
    q: protectedText.text
  });

  const response = await fetch(`${googleTranslateEndpoint}?${params}`, {
    headers: {
      "accept": "application/json, text/javascript, */*;q=0.8",
      "user-agent": "bread/2.0"
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`Google Translate responded with ${response.status}`);
  }

  const data = await response.json();
  const translated = Array.isArray(data?.[0]) ? data[0].map((part) => part?.[0] || "").join("") : "";
  return restoreTranslationText(translated.trim(), protectedText.tokens) || normalized;
}

function textBetween(value, start, end) {
  const startIndex = value.indexOf(start);

  if (startIndex === -1) return null;

  const contentStart = startIndex + start.length;
  const endIndex = value.indexOf(end, contentStart);

  if (endIndex === -1) return null;

  return value.slice(contentStart, endIndex).replace(/\s+/g, " ").trim();
}

function parseTranslatedPreviewBlock(value) {
  const title = textBetween(value, previewMarkers.titleStart, previewMarkers.titleEnd);
  const description = textBetween(value, previewMarkers.descriptionStart, previewMarkers.descriptionEnd);

  if (title === null || description === null) return null;

  return {
    title: normalizePreviewText(title, 240),
    description: normalizePreviewText(description, 1200)
  };
}

async function translatePreviewWithGoogle({ title, description }) {
  const normalizedTitle = normalizePreviewText(title, 240);
  const normalizedDescription = normalizePreviewText(description, 1200);

  if (!normalizedTitle && !normalizedDescription) {
    return { title: normalizedTitle, description: normalizedDescription };
  }

  if ((!normalizedTitle || looksRussian(normalizedTitle)) && (!normalizedDescription || looksRussian(normalizedDescription))) {
    return { title: normalizedTitle, description: normalizedDescription };
  }

  const previewBlock = [
    previewMarkers.titleStart,
    normalizedTitle,
    previewMarkers.titleEnd,
    previewMarkers.descriptionStart,
    normalizedDescription,
    previewMarkers.descriptionEnd
  ].join("\n");
  const translatedBlock = await translateTextToRussian(previewBlock, { force: true });
  const parsed = parseTranslatedPreviewBlock(translatedBlock);

  if (parsed) {
    return {
      title: parsed.title || normalizedTitle,
      description: parsed.description || normalizedDescription
    };
  }

  return {
    title: normalizedTitle ? await translateTextToRussian(normalizedTitle) : "",
    description: normalizedDescription ? await translateTextToRussian(normalizedDescription) : ""
  };
}

function appendTranscript(current, chunk) {
  const next = String(chunk || "");

  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;

  return `${current}${/^\s/.test(next) || /\s$/.test(current) ? "" : " "}${next}`;
}

function parseGeminiTranslation(transcript, original) {
  const normalized = String(transcript || "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/Заголовок\s*:\s*(.*?)\s+Описание\s*:\s*(.*)$/i);

  if (!match) {
    throw new Error("Gemini Live returned an unreadable translation");
  }

  return {
    title: normalizePreviewText(match[1], 240) || original.title,
    description: normalizePreviewText(match[2], 1200) || original.description
  };
}

async function requestGeminiLiveTranscript(prompt, options = {}) {
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const endpoint = new URL(geminiLiveEndpoint);
  endpoint.searchParams.set("key", geminiApiKey);
  const systemInstruction = options.systemInstruction || [
    "Ты профессиональный переводчик редакционных текстов на русский язык.",
    "Переводи точно, естественно и кратко, сохраняя имена, названия, числа и смысл.",
    "Не добавляй пояснений, оценок или фактов от себя.",
    "Всегда отвечай строго в формате: Заголовок: <перевод>. Описание: <перевод>."
  ].join(" ");

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.binaryType = "arraybuffer";
    let transcript = "";
    let settled = false;
    let turnCompleteTimer = null;
    const timeout = setTimeout(
      () => finish(new Error("Gemini Live translation timed out")),
      options.timeoutMs || 35000
    );

    function finish(error, value = "") {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);
      clearTimeout(turnCompleteTimer);

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }

      if (error) {
        reject(error);
      } else {
        resolve(value.trim());
      }
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        setup: {
          model: `models/${geminiLiveModel}`,
          outputAudioTranscription: {},
          generationConfig: {
            responseModalities: ["AUDIO"],
            thinkingConfig: {
              thinkingLevel: "minimal"
            }
          },
          systemInstruction: {
            parts: [{
              text: systemInstruction
            }]
          }
        }
      }));
    });

    socket.addEventListener("message", async (event) => {
      let message;

      try {
        const raw = typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data);
        message = JSON.parse(raw);
      } catch {
        finish(new Error("Gemini Live returned invalid JSON"));
        return;
      }

      if (message.setupComplete) {
        socket.send(JSON.stringify({
          realtimeInput: {
            text: prompt
          }
        }));
        return;
      }

      const serverContent = message.serverContent;
      const chunk = serverContent?.outputTranscription?.text;

      if (chunk) {
        transcript = appendTranscript(transcript, chunk);
      }

      if (serverContent?.turnComplete) {
        turnCompleteTimer = setTimeout(() => {
          finish(
            transcript ? null : new Error("Gemini Live returned no translation"),
            transcript
          );
        }, 500);
      }
    });

    socket.addEventListener("error", () => {
      finish(new Error("Could not connect to Gemini Live"));
    });

    socket.addEventListener("close", (event) => {
      if (!settled) {
        const reason = String(event.reason || "").trim();
        finish(new Error(reason ? `Gemini Live closed: ${reason}` : "Gemini Live closed before responding"));
      }
    });
  });
}

async function translatePreviewWithGeminiLive({ title, description }) {
  const normalizedTitle = normalizePreviewText(title, 240);
  const normalizedDescription = normalizePreviewText(description, 1200);

  if (!normalizedTitle && !normalizedDescription) {
    return { title: normalizedTitle, description: normalizedDescription };
  }

  if ((!normalizedTitle || looksRussian(normalizedTitle)) && (!normalizedDescription || looksRussian(normalizedDescription))) {
    return { title: normalizedTitle, description: normalizedDescription };
  }

  const prompt = [
    "Переведи на русский язык заголовок и краткое описание публикации.",
    "Не сокращай описание и не пересказывай его.",
    `Исходный заголовок: ${normalizedTitle || "(нет заголовка)"}`,
    `Исходное описание: ${normalizedDescription || "(нет описания)"}`
  ].join("\n");
  const transcript = await requestGeminiLiveTranscript(prompt);

  return parseGeminiTranslation(transcript, {
    title: normalizedTitle,
    description: normalizedDescription
  });
}

async function translatePreviewToRussian(item) {
  if (geminiApiKey) {
    try {
      return {
        translated: await translatePreviewWithGeminiLive(item),
        provider: "gemini-live",
        model: geminiLiveModel
      };
    } catch (error) {
      console.warn(`Gemini Live translation failed, using Google Translate: ${error.message}`);
    }
  }

  return {
    translated: await translatePreviewWithGoogle(item),
    provider: "google-translate",
    model: "gtx"
  };
}

function splitTranslationText(value, maxLength = 1400) {
  const text = normalizeTranslationInput(value, 12000);
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength + 1);
    const sentenceBreak = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
      slice.lastIndexOf("\n")
    );
    const spaceBreak = slice.lastIndexOf(" ");
    const splitAt = sentenceBreak > maxLength * 0.55 ? sentenceBreak + 1 : Math.max(spaceBreak, maxLength);

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function cleanArticleTranslation(value, original) {
  const translated = String(value || "")
    .replace(/^[*_`#\s]*(?:перевод|translation)\s*:\s*/i, "")
    .replace(/[*_`#]/g, "")
    .trim();

  return translated || original;
}

async function translateArticleChunkWithGeminiLive(text) {
  const prompt = [
    "Переведи следующий фрагмент статьи на русский язык.",
    "Сохрани смысл, тон, имена, числа и ссылки.",
    "Не сокращай, не пересказывай и ничего не добавляй.",
    "Ответь только переводом, без вводных слов и комментариев.",
    "",
    text
  ].join("\n");
  const transcript = await requestGeminiLiveTranscript(prompt, {
    timeoutMs: 55000,
    systemInstruction: [
      "Ты профессиональный литературный переводчик с английского и других языков на русский.",
      "Переводи редакционные тексты точно и естественно.",
      "Не сокращай исходный текст, не пересказывай его и не добавляй комментариев.",
      "Сохраняй имена, числа, ссылки и авторский тон.",
      "Всегда отвечай только переводом."
    ].join(" ")
  });

  return cleanArticleTranslation(transcript, text);
}

async function translateArticleTextToRussian(text) {
  const normalized = normalizeTranslationInput(text, 12000);

  if (!normalized || looksRussian(normalized)) {
    return {
      translated: normalized,
      provider: "original",
      model: "none"
    };
  }

  const chunks = splitTranslationText(normalized);

  if (geminiApiKey) {
    try {
      const translatedChunks = [];

      for (const chunk of chunks) {
        translatedChunks.push(await translateArticleChunkWithGeminiLive(chunk));
      }

      return {
        translated: translatedChunks.join(" "),
        provider: "gemini-live",
        model: geminiLiveModel
      };
    } catch (error) {
      console.warn(`Gemini Live article translation failed, using Google Translate: ${error.message}`);
    }
  }

  const translatedChunks = [];

  for (const chunk of chunks) {
    translatedChunks.push(await translateTextToRussian(chunk));
  }

  return {
    translated: translatedChunks.join(" "),
    provider: "google-translate",
    model: "gtx"
  };
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;

    if (body.length > maxBytes) {
      throw new Error("Request body is too large");
    }
  }

  return body ? JSON.parse(body) : {};
}

async function handleReaderState(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, { state: await readReaderState() });
    return;
  }

  if (req.method === "PUT") {
    try {
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      const state = body?.state;

      if (!state || !Array.isArray(state.posts)) {
        throw new Error("Invalid reader state");
      }

      await writeReaderState(state);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Could not save reader state" });
    }
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

function canonicalHostname(value) {
  return String(value || "").toLowerCase().replace(/^www\./, "");
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

function hostMatches(candidate, allowed) {
  const candidateHost = canonicalHostname(candidate);
  const allowedHost = canonicalHostname(allowed);

  return candidateHost === allowedHost
    || candidateHost.endsWith(`.${allowedHost}`)
    || allowedHost.endsWith(`.${candidateHost}`);
}

function isPrivateHostname(hostname) {
  const host = canonicalHostname(hostname);

  if (!host || host === "localhost" || host.endsWith(".local")) return true;

  const ipVersion = isIP(host);

  if (ipVersion === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 10
      || host.startsWith("127.")
      || host.startsWith("169.254.")
      || host.startsWith("192.168.")
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
  }

  if (ipVersion === 6) {
    return host === "::1"
      || host.startsWith("fc")
      || host.startsWith("fd")
      || host.startsWith("fe80:");
  }

  return false;
}

async function registeredArticle(id) {
  const readerState = await readReaderState();
  const post = readerState?.posts?.find((item) => item.id === id);

  if (!post?.url || !post?.sourceId) {
    throw requestError(404, "Unknown article");
  }

  const sources = await readSources();
  const source = sources.find((item) => item.id === post.sourceId);

  if (!source) {
    throw requestError(404, "Unknown article source");
  }

  const articleUrl = new URL(post.url);
  const allowedHosts = [source.siteUrl, source.feedUrl]
    .filter(Boolean)
    .map((value) => new URL(value).hostname);

  if (
    !["http:", "https:"].includes(articleUrl.protocol)
    || isPrivateHostname(articleUrl.hostname)
    || !allowedHosts.some((host) => hostMatches(articleUrl.hostname, host))
  ) {
    throw requestError(400, "Article URL does not belong to its registered source");
  }

  return { post, source, articleUrl };
}

async function responseTextWithLimit(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") || 0);

  if (contentLength > maxBytes) {
    throw new Error("Article is too large");
  }

  const decoder = new TextDecoder();
  let body = "";

  for await (const chunk of response.body) {
    body += decoder.decode(chunk, { stream: true });

    if (body.length > maxBytes) {
      throw new Error("Article is too large");
    }
  }

  return `${body}${decoder.decode()}`;
}

async function handleArticle(req, res, requestUrl) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const id = String(requestUrl.searchParams.get("id") || "");
    const { post, source, articleUrl } = await registeredArticle(id);
    const response = await fetch(articleUrl, {
      headers: {
        "accept": "text/html, application/xhtml+xml;q=0.9, */*;q=0.6",
        "user-agent": "bread/2.0"
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      throw new Error(`Article responded with ${response.status}`);
    }

    const finalUrl = new URL(response.url);

    if (isPrivateHostname(finalUrl.hostname) || !hostMatches(finalUrl.hostname, articleUrl.hostname)) {
      throw new Error("Article redirected outside its registered source");
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("Article did not return HTML");
    }

    const html = await responseTextWithLimit(response, 2_500_000);
    sendJson(res, 200, {
      id: post.id,
      url: finalUrl.toString(),
      sourceTitle: source.title,
      html
    });
  } catch (error) {
    const status = Number(error?.status) || 502;
    sendJson(res, status, { error: error instanceof Error ? error.message : "Could not load article" });
  }
}

async function handleArticleTranslations(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (translationsDisabled) {
    sendJson(res, 503, { error: "Translations are disabled" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const postId = String(body.postId || "");
    await registeredArticle(postId);
    const items = Array.isArray(body.items) ? body.items.slice(0, 4) : [];
    const cache = await readArticleTranslations();
    const translations = {};
    const missing = [];

    for (const item of items) {
      const id = String(item?.id || "");
      const text = normalizeTranslationInput(item?.text, 12000);

      if (!id || !text) continue;

      const key = cacheKey(`${postId}\n${text}`);
      const cached = cache[key];

      if (cached?.translated) {
        translations[id] = {
          text: cached.translated,
          provider: cached.provider,
          model: cached.model
        };
      } else {
        missing.push({ id, text, key });
      }
    }

    await runLimited(missing, 2, async (item) => {
      const result = await translateArticleTextToRussian(item.text);
      cache[item.key] = {
        translated: result.translated,
        provider: result.provider,
        model: result.model,
        updatedAt: new Date().toISOString()
      };
      translations[item.id] = {
        text: result.translated,
        provider: result.provider,
        model: result.model
      };
    });

    if (missing.length) {
      await writeArticleTranslations(cache);
    }

    sendJson(res, 200, { translations });
  } catch (error) {
    const status = Number(error?.status) || 502;
    sendJson(res, status, { error: error instanceof Error ? error.message : "Could not translate article" });
  }
}

function resolvePublicPath(pathname) {
  const normalized = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const requested = normalized === "/" ? "/index.html" : normalized;
  return path.join(publicDir, requested);
}

function handleConfig(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  sendJson(res, 200, {
    translationsAvailable: !translationsDisabled,
    translationProvider,
    translationModel
  });
}

async function handleSources(req, res, requestUrl) {
  if (req.method === "GET") {
    const sources = await readSources();
    sendJson(res, 200, { sources: sources.map(publicSource) });
    return;
  }

  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const feedUrl = normalizeHttpUrl(body.feedUrl);
      const siteUrl = body.siteUrl ? normalizeHttpUrl(body.siteUrl) : new URL(feedUrl).origin;
      const title = String(body.title || "").trim() || new URL(siteUrl).hostname.replace(/^www\./, "");
      const sources = await readSources();
      const existing = sources.find((source) => source.feedUrl === feedUrl);

      if (existing) {
        sendJson(res, 200, { source: publicSource(existing), existing: true });
        return;
      }

      const source = {
        id: sourceId(feedUrl),
        title,
        siteUrl,
        feedUrl,
        createdAt: new Date().toISOString()
      };

      sources.push(source);
      await writeSources(sources);
      sendJson(res, 201, { source: publicSource(source) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid source" });
    }
    return;
  }

  if (req.method === "DELETE") {
    const id = requestUrl.searchParams.get("id");

    if (!id) {
      sendJson(res, 400, { error: "Missing source id" });
      return;
    }

    const sources = await readSources();
    const nextSources = sources.filter((source) => source.id !== id);

    if (nextSources.length === sources.length) {
      sendJson(res, 404, { error: "Unknown source" });
      return;
    }

    await writeSources(nextSources);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleFeed(req, res, requestUrl) {
  const id = requestUrl.searchParams.get("id");

  if (!id) {
    sendJson(res, 400, { error: "Missing source id" });
    return;
  }

  const sources = await readSources();
  const source = sources.find((item) => item.id === id);

  if (!source) {
    sendJson(res, 404, { error: "Unknown source" });
    return;
  }

  if (source.parser === "dated-html-index") {
    await handleDatedHtmlIndex(res, source);
    return;
  }

  if (source.parser === "british-library-blog-index") {
    await handleBritishLibraryBlogIndex(res, source);
    return;
  }

  try {
    const response = await fetch(source.feedUrl, {
      headers: {
        "accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "user-agent": "bread/2.0"
      },
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      sendJson(res, response.status, { error: `Feed responded with ${response.status}` });
      return;
    }

    const body = await response.text();
    res.writeHead(200, {
      "content-type": response.headers.get("content-type") || "application/xml; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : "Could not fetch feed" });
  }
}

async function handleTranslations(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (translationsDisabled) {
    sendJson(res, 503, { error: "Translations are disabled" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 24) : [];
    const cache = await readTranslations();
    const translations = {};
    const missing = [];

    for (const item of items) {
      const id = String(item?.id || "");
      const title = normalizePreviewText(item?.title, 240);
      const description = normalizePreviewText(item?.description, 1200);

      if (!id || (!title && !description)) continue;

      const key = cacheKey(`${translationCacheVersion}:${title}\n${description}`);

      if (cache[key]?.translated) {
        translations[id] = cache[key].translated;
      } else {
        missing.push({ id, title, description, key });
      }
    }

    await runLimited(missing, 2, async (item) => {
      const result = await translatePreviewToRussian(item);
      cache[item.key] = {
        source: {
          title: item.title,
          description: item.description
        },
        translated: result.translated,
        target: "ru",
        provider: result.provider,
        model: result.model,
        updatedAt: new Date().toISOString()
      };
      translations[item.id] = result.translated;
    });

    if (missing.length) {
      await writeTranslations(cache);
    }

    sendJson(res, 200, { provider: translationProvider, translations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not translate previews";
    sendJson(res, 502, { error: message });
  }
}

async function handleDatedHtmlIndex(res, source) {
  try {
    const response = await fetch(source.feedUrl || source.siteUrl, {
      headers: {
        "accept": "text/html, */*;q=0.8",
        "user-agent": "bread/2.0"
      },
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      sendJson(res, response.status, { error: `Index responded with ${response.status}` });
      return;
    }

    const html = await response.text();
    const base = source.siteUrl || source.feedUrl;
    const origin = new URL(base).origin;
    const items = [...html.matchAll(/<a\b[^>]*>/gi)]
      .map(([tag]) => {
        const href = attr(tag, "href");
        const title = attr(tag, "aria-label") || attr(tag, "title");
        const dateMatch = href.match(/(20\d{2})-(\d{2})-(\d{2})/);

        if (!href || !title || !dateMatch) return null;

        const url = new URL(href, base).toString();
        if (!url.startsWith(origin)) return null;

        return {
          title,
          url,
          date: new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.date - a.date)
      .slice(0, 50);

    const itemXml = items
      .map((item) => `
        <item>
          <title>${escapeXml(item.title)}</title>
          <link>${escapeXml(item.url)}</link>
          <guid>${escapeXml(item.url)}</guid>
          <pubDate>${item.date.toUTCString()}</pubDate>
          <description>${escapeXml(`Материал из ${source.title}`)}</description>
        </item>`)
      .join("");

    const body = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>${escapeXml(source.title)}</title>
          <link>${escapeXml(source.siteUrl)}</link>
          <description>${escapeXml(`Индекс публикаций ${source.title}`)}</description>
          ${itemXml}
        </channel>
      </rss>`;

    res.writeHead(200, {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : "Could not fetch index" });
  }
}

function parseBritishLibraryDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}) ([A-Za-z]+) (20\d{2})$/);
  const months = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11
  };

  if (!match) return new Date();

  return new Date(Date.UTC(Number(match[3]), months[match[2].toLowerCase()] ?? 0, Number(match[1])));
}

async function handleBritishLibraryBlogIndex(res, source) {
  try {
    const response = await fetch(source.feedUrl || source.siteUrl, {
      headers: {
        "accept": "text/html, */*;q=0.8",
        "user-agent": "bread/2.0"
      },
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      sendJson(res, response.status, { error: `British Library index responded with ${response.status}` });
      return;
    }

    const html = await response.text();
    const base = source.siteUrl || source.feedUrl;
    const itemPattern = /<a\b[^>]+href="(\/stories\/blogs\/posts\/[^"]+)"[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span\b[^>]*ListCard[^>]*subtitle[^>]*>([\s\S]*?)<\/span>[\s\S]*?<p\b[^>]*ListCard[^>]*description[^>]*>([\s\S]*?)<\/p>/gi;
    const seen = new Set();
    const items = [];

    for (const match of html.matchAll(itemPattern)) {
      const url = new URL(decodeHtml(match[1]), base).toString();

      if (seen.has(url)) continue;
      seen.add(url);

      items.push({
        url,
        title: stripHtml(match[2]),
        date: parseBritishLibraryDate(stripHtml(match[3])),
        description: stripHtml(match[4])
      });
    }

    const itemXml = items
      .sort((a, b) => b.date - a.date)
      .map((item) => `
        <item>
          <title>${escapeXml(item.title)}</title>
          <link>${escapeXml(item.url)}</link>
          <guid>${escapeXml(item.url)}</guid>
          <pubDate>${item.date.toUTCString()}</pubDate>
          <description>${escapeXml(item.description)}</description>
        </item>`)
      .join("");

    const body = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>${escapeXml(source.title)}</title>
          <link>${escapeXml(source.siteUrl)}</link>
          <description>${escapeXml("Latest British Library blog posts")}</description>
          ${itemXml}
        </channel>
      </rss>`;

    res.writeHead(200, {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : "Could not fetch British Library blog index" });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/config") {
    handleConfig(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/sources") {
    await handleSources(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/state") {
    await handleReaderState(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/article") {
    await handleArticle(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/article-translations") {
    await handleArticleTranslations(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/feed") {
    await handleFeed(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/translations") {
    await handleTranslations(req, res);
    return;
  }

  if (requestUrl.pathname === "/translation-cache.js") {
    await handleTranslationCacheScript(req, res);
    return;
  }

  try {
    const filePath = resolvePublicPath(requestUrl.pathname);
    const ext = path.extname(filePath);
    const body = await readFile(filePath);

    res.writeHead(200, {
      "content-type": contentTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`bread is running at http://${host}:${port}`);
});
