const STORAGE_KEY = "bread-reader-state";
const LEGACY_STORAGE_KEY = STORAGE_KEY;
const NEW_WINDOW_MS = 1000 * 60 * 60 * 24 * 3;
const TRANSLATION_BATCH_SIZE = 12;
const AUTO_TRANSLATE_ALL_DELAY_MS = 500;
const AUTO_REFRESH_AFTER_MS = 1000 * 60 * 30;
const POST_PAGE_SIZE = 100;
const FEED_REQUEST_TIMEOUT_MS = 32000;
const SERVER_STATE_SAVE_DELAY_MS = 350;
const DEFAULT_TRANSLATION_PROVIDER = "google-translate";
const BUILTIN_SOURCES = Array.isArray(window.READ_LIKE_2000_SOURCES) ? window.READ_LIKE_2000_SOURCES : [];
const BUILTIN_TRANSLATIONS = window.READ_LIKE_2000_TRANSLATIONS && typeof window.READ_LIKE_2000_TRANSLATIONS === "object"
  ? window.READ_LIKE_2000_TRANSLATIONS
  : {};

const initialState = {
  sources: [],
  posts: [],
  lastReadAt: 0,
  readPostIds: [],
  unreadPostIds: [],
  savedPostIds: [],
  viewMode: "all",
  lastRefreshAt: 0,
  failedSourceIds: [],
  readerFont: "sans",
  readerFontSize: 17,
  darkMode: false,
  panelOpen: false
};

const elements = {
  sourceForm: document.querySelector("#sourceForm"),
  sourceTitle: document.querySelector("#sourceTitle"),
  sourceUrl: document.querySelector("#sourceUrl"),
  searchInput: document.querySelector("#searchInput"),
  sourceList: document.querySelector("#sourceList"),
  sourceCount: document.querySelector("#sourceCount"),
  refreshButtons: [...document.querySelectorAll("[data-refresh]")],
  markReadButton: document.querySelector("#markReadButton"),
  viewTitle: document.querySelector("#viewTitle"),
  feedMeta: document.querySelector("#feedMeta"),
  statusLine: document.querySelector("#statusLine"),
  feedList: document.querySelector("#feedList"),
  feedScrollProgress: document.querySelector("#feedScrollProgress"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  sourceTemplate: document.querySelector("#sourceTemplate"),
  postTemplate: document.querySelector("#postTemplate"),
  viewButtons: [...document.querySelectorAll("[data-view]")],
  sidePanel: document.querySelector("#sidePanel"),
  panelToggleButton: document.querySelector("#panelToggleButton"),
  closePanelButton: document.querySelector("#closePanelButton"),
  fontSizeButton: document.querySelector("#fontSizeButton"),
  fontSansButton: document.querySelector("#fontSansButton"),
  fontSerifButton: document.querySelector("#fontSerifButton"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  themeButton: document.querySelector("#themeButton"),
  articleReader: document.querySelector("#articleReader"),
  articleReaderScroll: document.querySelector("#articleReaderScroll"),
  articleScrollProgress: document.querySelector("#articleScrollProgress"),
  closeArticleButton: document.querySelector("#closeArticleButton"),
  articleSource: document.querySelector("#articleSource"),
  articlePublishedAt: document.querySelector("#articlePublishedAt"),
  articleLanguageButton: document.querySelector("#articleLanguageButton"),
  articleTranslationStatus: document.querySelector("#articleTranslationStatus"),
  articleTitle: document.querySelector("#articleTitle"),
  articleCopy: document.querySelector("#articleCopy"),
  articleOriginalLink: document.querySelector("#articleOriginalLink")
};

let state = loadState();
state.sources = BUILTIN_SOURCES.map((source) => ({ ...source }));
applyCachedTranslations(state.posts);
let translationObserver = null;
let translationTimer = null;
let translationRunning = false;
let refreshRunning = false;
let sourcesLoaded = false;
let visiblePostLimit = POST_PAGE_SIZE;
let translationsAvailable = false;
let translationProvider = DEFAULT_TRANSLATION_PROVIDER;
const translationQueue = new Set();
let serverStateLoaded = false;
let serverStateSaveTimer = null;
let activeArticle = null;
let articleRequestToken = 0;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY));
    const posts = Array.isArray(saved.posts) ? saved.posts : [];
    const lastReadAt = Number(saved.lastReadAt || 0);
    const postsById = new Map(posts.map((post) => [post.id, post]));
    const readPostIds = Array.isArray(saved.readPostIds)
      ? saved.readPostIds.filter((id) => {
          const post = postsById.get(id);
          return !post || postSeenAt(post) > lastReadAt;
        })
      : [];

    return {
      ...initialState,
      posts,
      lastReadAt,
      readPostIds,
      unreadPostIds: Array.isArray(saved.unreadPostIds) ? saved.unreadPostIds : [],
      savedPostIds: Array.isArray(saved.savedPostIds) ? saved.savedPostIds : [],
      viewMode: ["all", "new", "unread", "saved"].includes(saved.viewMode) ? saved.viewMode : "all",
      lastRefreshAt: Number(saved.lastRefreshAt || 0),
      failedSourceIds: Array.isArray(saved.failedSourceIds) ? saved.failedSourceIds : [],
      readerFont: saved.readerFont === "serif" ? "serif" : "sans",
      readerFontSize: [15, 17, 19].includes(saved.readerFontSize) ? saved.readerFontSize : 17,
      darkMode: Boolean(saved.darkMode),
      panelOpen: Boolean(saved.panelOpen)
    };
  } catch {
    return { ...initialState };
  }
}

function serializableState() {
  const {
    posts,
    lastReadAt,
    readPostIds,
    unreadPostIds,
    savedPostIds,
    viewMode,
    lastRefreshAt,
    failedSourceIds,
    readerFont,
    readerFontSize,
    darkMode,
    panelOpen
  } = state;
  const storedPosts = posts.map((post) => ({
    id: post.id,
    sourceId: post.sourceId,
    sourceTitle: post.sourceTitle,
    title: post.titleRu ? undefined : post.title,
    titleRu: post.titleRu,
    url: post.url,
    description: post.descriptionRu ? undefined : post.description,
    descriptionRu: post.descriptionRu,
    publishedAt: post.publishedAt,
    firstSeenAt: post.firstSeenAt,
    isManual: post.isManual || undefined
  }));

  return {
    posts: storedPosts,
    lastReadAt,
    readPostIds,
    unreadPostIds,
    savedPostIds,
    viewMode,
    lastRefreshAt,
    failedSourceIds,
    readerFont,
    readerFontSize,
    darkMode,
    panelOpen
  };
}

function saveState() {
  const storedState = serializableState();

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storedState));
    scheduleServerStateSave(storedState);
    return true;
  } catch (error) {
    console.warn("Could not persist reader state", error);
    scheduleServerStateSave(storedState);
    return false;
  }
}

function scheduleServerStateSave(storedState = serializableState()) {
  if (!serverStateLoaded) return;

  window.clearTimeout(serverStateSaveTimer);
  serverStateSaveTimer = window.setTimeout(() => {
    fetch("/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: storedState })
    }).catch((error) => console.warn("Could not save reader state on the server", error));
  }, SERVER_STATE_SAVE_DELAY_MS);
}

function normalizeStoredState(saved) {
  if (!saved || !Array.isArray(saved.posts)) return null;

  return {
    ...initialState,
    ...saved,
    posts: saved.posts,
    lastReadAt: Number(saved.lastReadAt || 0),
    readPostIds: Array.isArray(saved.readPostIds) ? saved.readPostIds : [],
    unreadPostIds: Array.isArray(saved.unreadPostIds) ? saved.unreadPostIds : [],
    savedPostIds: Array.isArray(saved.savedPostIds) ? saved.savedPostIds : [],
    viewMode: ["all", "new", "unread", "saved"].includes(saved.viewMode) ? saved.viewMode : "all",
    lastRefreshAt: Number(saved.lastRefreshAt || 0),
    failedSourceIds: Array.isArray(saved.failedSourceIds) ? saved.failedSourceIds : [],
    readerFont: saved.readerFont === "serif" ? "serif" : "sans",
    readerFontSize: [15, 17, 19].includes(saved.readerFontSize) ? saved.readerFontSize : 17,
    darkMode: Boolean(saved.darkMode),
    panelOpen: Boolean(saved.panelOpen)
  };
}

async function loadServerState() {
  try {
    const response = await fetch("/api/state");

    if (!response.ok) throw new Error("Could not load reader state");

    const data = await response.json();
    const saved = normalizeStoredState(data.state);

    if (saved && (saved.lastRefreshAt >= state.lastRefreshAt || saved.posts.length > state.posts.length)) {
      state = {
        ...saved,
        sources: state.sources
      };
      applyCachedTranslations(state.posts);
      prunePostState();
    }
  } catch (error) {
    console.warn("Could not load reader state from the server", error);
  } finally {
    serverStateLoaded = true;
    render();
  }
}

async function loadSources() {
  try {
    const response = await fetch("/api/sources");

    if (!response.ok) throw new Error("Could not load sources");

    const data = await response.json();
    state.sources = Array.isArray(data.sources)
      ? data.sources.map((source) => ({ ...source }))
      : state.sources;
  } catch (error) {
    console.warn("Could not load sources from the server", error);
  } finally {
    sourcesLoaded = true;
    render();
  }
}

function normalizeUrl(value) {
  return new URL(value.trim()).toString();
}

function postId(url, title) {
  return `post-${btoa(unescape(encodeURIComponent(`${url}:${title}`))).replace(/=+$/g, "")}`;
}

function compactText(value = "") {
  const doc = new DOMParser().parseFromString(value, "text/html");
  return (doc.body.textContent || value).replace(/\s+/g, " ").trim();
}

function translationLookupKey(title, description) {
  return `${String(title || "").replace(/\s+/g, " ").trim().slice(0, 240)}\n${String(description || "").replace(/\s+/g, " ").trim().slice(0, 1200)}`;
}

function applyCachedTranslation(post) {
  const cached = BUILTIN_TRANSLATIONS[translationLookupKey(post.title, post.description)];

  if (!cached) return post;

  post.titleRu = cached.title || post.titleRu;
  post.descriptionRu = cached.description || post.descriptionRu;
  post.translationProvider = DEFAULT_TRANSLATION_PROVIDER;
  return post;
}

function applyCachedTranslations(posts) {
  posts.forEach(applyCachedTranslation);
  return posts;
}

function formatRelativeTime(dateValue) {
  const date = new Date(dateValue);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  const hours = Math.round(diff / 3600000);
  const days = Math.round(diff / 86400000);

  if (Number.isNaN(date.getTime())) return "";
  if (minutes < 2) return "сейчас";
  if (minutes < 60) return `${minutes} мин`;
  if (hours < 24) return `${hours} ч`;
  if (days < 8) return `${days} д`;

  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric"
  });
}

function setStatus(message) {
  elements.statusLine.textContent = message;
  elements.statusLine.title = "";
}

function getSortedPosts() {
  return [...state.posts].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

function postSeenAt(post) {
  const seenAt = Date.parse(post.firstSeenAt || post.publishedAt || "");
  return Number.isNaN(seenAt) ? 0 : seenAt;
}

function searchQuery() {
  return elements.searchInput.value.trim().toLowerCase();
}

function isReadPost(post) {
  if (state.unreadPostIds.includes(post.id)) return false;
  return state.readPostIds.includes(post.id) || (state.lastReadAt > 0 && postSeenAt(post) <= state.lastReadAt);
}

function isSavedPost(post) {
  return state.savedPostIds.includes(post.id);
}

function postMatchesQuery(post, query) {
  if (!query) return true;

  return [post.title, post.titleRu, post.description, post.descriptionRu, post.sourceTitle]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function getVisiblePosts() {
  const query = searchQuery();

  return getSortedPosts().filter((post) => {
    if (!postMatchesQuery(post, query)) return false;
    if (state.viewMode === "new") return isNewPost(post);
    if (state.viewMode === "unread") return !isReadPost(post);
    if (state.viewMode === "saved") return isSavedPost(post);
    return true;
  });
}

function render() {
  renderReaderPreferences();
  renderSources();
  renderPosts();
  renderViewControls();
  saveState();
  scheduleAllMissingTranslations();
  renderIcons();
  window.requestAnimationFrame(updateFeedScrollProgress);
}

function renderIcons() {
  window.lucide?.createIcons({
    attrs: {
      "aria-hidden": "true"
    }
  });
}

function setScrollProgress(element, value) {
  const progress = Math.max(0, Math.min(1, value || 0));
  element.style.setProperty("--scroll-progress", String(progress));
  element.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
}

function updateFeedScrollProgress() {
  const root = document.documentElement;
  const distance = Math.max(0, root.scrollHeight - window.innerHeight);
  setScrollProgress(elements.feedScrollProgress, distance ? window.scrollY / distance : 0);
}

function updateArticleScrollProgress() {
  const scroller = elements.articleReaderScroll;
  const distance = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  setScrollProgress(elements.articleScrollProgress, distance ? scroller.scrollTop / distance : 0);
}

function renderReaderPreferences() {
  document.body.dataset.theme = state.darkMode ? "dark" : "light";
  document.body.classList.toggle("panel-open", state.panelOpen);
  document.body.classList.toggle("article-open", Boolean(activeArticle));
  document.documentElement.style.setProperty(
    "--reader-font",
    state.readerFont === "serif" ? "Iowan Old Style, Charter, Georgia, serif" : '"Lato", system-ui, sans-serif'
  );
  document.documentElement.style.setProperty("--reader-size", `${state.readerFontSize}px`);
  elements.fontSizeButton.textContent = `${state.readerFontSize}px`;
  elements.fontSansButton.classList.toggle("is-active", state.readerFont === "sans");
  elements.fontSerifButton.classList.toggle("is-active", state.readerFont === "serif");
  elements.panelToggleButton.setAttribute("aria-expanded", String(state.panelOpen));
  elements.sidePanel.setAttribute("aria-hidden", String(!state.panelOpen));
  elements.articleReader.setAttribute("aria-hidden", String(!activeArticle));
  elements.themeButton.title = state.darkMode ? "Светлая тема" : "Тёмная тема";
  elements.themeButton.setAttribute("aria-label", elements.themeButton.title);
  elements.themeButton.innerHTML = `<i data-lucide="${state.darkMode ? "sun" : "moon"}" aria-hidden="true"></i>`;
}

function setPanelOpen(open) {
  if (open && activeArticle) {
    closeArticle({ rerender: false });
  }

  state.panelOpen = open;
  renderReaderPreferences();
  saveState();
  renderIcons();
}

function articleText(value = "") {
  return String(value)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitArticleText(value, maxLength = 2400) {
  const chunks = [];
  let remaining = articleText(value);

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength + 1);
    const sentenceBreak = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? ")
    );
    const spaceBreak = slice.lastIndexOf(" ");
    const splitAt = sentenceBreak > maxLength * 0.55 ? sentenceBreak + 1 : Math.max(spaceBreak, maxLength);

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function safeArticleUrl(value, baseUrl) {
  if (!value) return "";

  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function articleElementLinks(element, baseUrl) {
  const seen = new Set();

  return [...element.querySelectorAll("a[href]")]
    .map((link) => {
      const url = safeArticleUrl(link.getAttribute("href"), baseUrl);
      const label = articleText(link.textContent) || (url ? new URL(url).hostname : "");

      if (!url || seen.has(url)) return null;
      seen.add(url);
      return { url, label };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function articleImageSource(image, baseUrl) {
  const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
  const srcsetCandidate = srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean)
    .at(-1);
  const rawSource = image.getAttribute("src")
    || image.getAttribute("data-src")
    || image.getAttribute("data-lazy-src")
    || image.getAttribute("data-original")
    || srcsetCandidate;

  return safeArticleUrl(rawSource, baseUrl);
}

function articleMediaCaption(element) {
  const figure = element.closest("figure");
  return articleText(figure?.querySelector("figcaption")?.textContent || element.getAttribute("title") || "");
}

function articleTextBlocks(element, type, baseUrl) {
  const text = articleText(element.textContent);
  const links = articleElementLinks(element, baseUrl);
  const minimumLength = type === "heading" ? 3 : links.length ? 1 : 24;

  if (text.length < minimumLength) return [];

  return splitArticleText(text).map((chunk, index) => ({
    type,
    text: chunk,
    links: index === 0 ? links : []
  }));
}

function extractArticleBlocks(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const candidateSelectors = [
    "[itemprop='articleBody']",
    "article",
    "main",
    ".entry-content",
    ".post-content",
    ".article-content",
    ".article-body",
    ".post-body",
    ".prose",
    "#content"
  ];
  const candidates = [...new Set(candidateSelectors.flatMap((selector) => [...doc.querySelectorAll(selector)]))];
  const roots = candidates.length ? candidates : [doc.body];
  const root = roots
    .map((element) => {
      const textLength = articleText(element.textContent).length;
      const linkLength = [...element.querySelectorAll("a")]
        .reduce((total, link) => total + articleText(link.textContent).length, 0);
      return {
        element,
        score: textLength - linkLength * 1.6
      };
    })
    .sort((a, b) => b.score - a.score)[0]?.element || doc.body;

  root.querySelectorAll([
    "script",
    "style",
    "noscript",
    "nav",
    "aside",
    "footer",
    "form",
    "button",
    "svg",
    "canvas",
    "[role='navigation']",
    ".site-header",
    ".site-footer",
    ".sidebar",
    "[class*='sidebar']",
    ".widget",
    "[class*='widget']",
    ".menu",
    ".post-navigation",
    ".entry-footer",
    ".post-footer",
    ".breadcrumbs",
    ".pagination",
    ".tags",
    ".categories",
    ".comments",
    ".comment",
    "#comments",
    ".related",
    ".recommendations",
    ".share",
    ".sharing",
    ".social",
    ".newsletter",
    ".subscribe",
    "[aria-hidden='true']"
  ].join(",")).forEach((element) => element.remove());

  const blockElements = [...root.querySelectorAll("h2, h3, p, blockquote, pre, ul, ol, img, video, audio, iframe")];
  const seen = new Set();
  const blocks = [];
  let totalLength = 0;
  let listGroup = 0;

  for (const element of blockElements) {
    const tagName = element.tagName.toLowerCase();

    if (
      (["p", "h2", "h3", "pre"].includes(tagName) && element.closest("blockquote, figure, li"))
      || (tagName === "blockquote" && element.parentElement?.closest("blockquote"))
      || (["ul", "ol"].includes(tagName) && element.parentElement?.closest("ul, ol"))
      || (tagName === "img" && element.closest("picture") && element.closest("picture").querySelector("img") !== element)
    ) {
      continue;
    }

    if (tagName === "img") {
      const src = articleImageSource(element, baseUrl);
      const width = Number(element.getAttribute("width") || 0);
      const height = Number(element.getAttribute("height") || 0);

      if (!src || (width > 0 && height > 0 && width <= 4 && height <= 4) || seen.has(`media:${src}`)) {
        continue;
      }

      seen.add(`media:${src}`);
      const caption = articleMediaCaption(element);
      const linkedUrl = safeArticleUrl(element.closest("a[href]")?.getAttribute("href"), baseUrl);
      blocks.push({
        type: "image",
        src,
        href: linkedUrl,
        alt: articleText(element.getAttribute("alt") || ""),
        text: caption
      });
      totalLength += caption.length;
      continue;
    }

    if (tagName === "video" || tagName === "audio") {
      const sourceElement = element.querySelector("source[src]");
      const src = safeArticleUrl(element.getAttribute("src") || sourceElement?.getAttribute("src"), baseUrl);

      if (!src || seen.has(`media:${src}`)) continue;

      seen.add(`media:${src}`);
      const caption = articleMediaCaption(element);
      blocks.push({
        type: tagName,
        src,
        poster: tagName === "video" ? safeArticleUrl(element.getAttribute("poster"), baseUrl) : "",
        text: caption
      });
      totalLength += caption.length;
      continue;
    }

    if (tagName === "iframe") {
      const src = safeArticleUrl(element.getAttribute("src"), baseUrl);

      if (!src || seen.has(`media:${src}`)) continue;

      seen.add(`media:${src}`);
      const hostname = new URL(src).hostname.replace(/^www\./, "");
      const embeddable = [
        "youtube.com",
        "youtube-nocookie.com",
        "player.vimeo.com",
        "w.soundcloud.com",
        "open.spotify.com",
        "bandcamp.com"
      ].some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
      blocks.push({
        type: embeddable ? "embed" : "resource",
        src,
        text: articleMediaCaption(element)
      });
      continue;
    }

    if (tagName === "ul" || tagName === "ol") {
      const items = [...element.children].filter((child) => child.tagName === "LI");
      const linkedItems = items.filter((item) => {
        const textLength = articleText(item.textContent).length;
        const linkLength = [...item.querySelectorAll("a")]
          .reduce((total, link) => total + articleText(link.textContent).length, 0);
        return textLength > 0 && linkLength / textLength > 0.8;
      });

      if (
        (items.length > 10 && linkedItems.length / items.length > 0.75)
        || items.some((item) => /^(log in|sign in|subscribe)$/i.test(articleText(item.textContent)))
      ) {
        continue;
      }

      listGroup += 1;

      for (const item of items) {
        const copy = item.cloneNode(true);
        copy.querySelectorAll("ul, ol").forEach((nested) => nested.remove());
        const text = articleText(copy.textContent);

        if (!text || seen.has(`${tagName}:${text}`)) continue;

        seen.add(`${tagName}:${text}`);
        blocks.push({
          type: "list-item",
          listType: tagName,
          listGroup,
          text,
          links: articleElementLinks(copy, baseUrl)
        });
        totalLength += text.length;
      }

      continue;
    }

    const type = tagName === "h2" || tagName === "h3"
      ? "heading"
      : tagName === "blockquote"
        ? "quote"
        : tagName === "pre"
          ? "code"
          : "paragraph";
    const textBlocks = articleTextBlocks(element, type, baseUrl);

    for (const block of textBlocks) {
      if (seen.has(`${type}:${block.text}`)) continue;
      if (totalLength + block.text.length > 80000) break;
      seen.add(`${type}:${block.text}`);
      blocks.push(block);
      totalLength += block.text.length;
    }

    if (totalLength >= 80000 || blocks.length >= 240) break;
  }

  if (blocks.filter((block) => block.text).length >= 3 || blocks.some((block) => block.src)) {
    return blocks;
  }

  return String(root.textContent || "")
    .split(/\n{2,}/)
    .map(articleText)
    .filter((text) => text.length >= 24)
    .flatMap((text) => splitArticleText(text).map((chunk) => ({ type: "paragraph", text: chunk })))
    .slice(0, 160);
}

function articleTextLooksRussian(value = "") {
  const cyrillic = value.match(/[А-Яа-яЁё]/g)?.length || 0;
  const latin = value.match(/[A-Za-z]/g)?.length || 0;
  return cyrillic > 0 && cyrillic >= latin;
}

function createArticleLink(link, className = "") {
  const anchor = document.createElement("a");
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.textContent = link.label || new URL(link.url).hostname;
  if (className) anchor.className = className;
  return anchor;
}

function appendArticleLinks(element, links = [], text = "") {
  const uniqueLinks = links.filter((link, index) => links.findIndex((item) => item.url === link.url) === index);

  if (!uniqueLinks.length) return;

  if (uniqueLinks.length === 1 && articleText(uniqueLinks[0].label) === articleText(text)) {
    element.replaceChildren(createArticleLink(uniqueLinks[0]));
    return;
  }

  const linkRow = document.createElement("span");
  linkRow.className = "article-block-links";

  for (const [index, link] of uniqueLinks.entries()) {
    if (index) linkRow.append(document.createTextNode(" · "));
    linkRow.append(createArticleLink(link));
  }

  element.append(linkRow);
}

function renderArticleMedia(block, translatedCaption, showOriginal) {
  const caption = showOriginal ? block.text : translatedCaption || block.text;

  if (block.type === "resource") {
    const resource = createArticleLink({
      url: block.src,
      label: caption || "Встроенный материал"
    }, "article-resource");
    const label = resource.textContent;
    const icon = document.createElement("i");
    const labelElement = document.createElement("span");
    icon.dataset.lucide = "external-link";
    icon.setAttribute("aria-hidden", "true");
    labelElement.textContent = label;
    resource.replaceChildren(icon, labelElement);
    return resource;
  }

  const figure = document.createElement("figure");
  figure.className = `article-media article-media-${block.type}`;
  let media;

  if (block.type === "image") {
    media = document.createElement("img");
    media.src = block.src;
    media.alt = block.alt || caption || "";
    media.loading = "lazy";
    media.decoding = "async";
    media.referrerPolicy = "no-referrer-when-downgrade";
  } else if (block.type === "video" || block.type === "audio") {
    media = document.createElement(block.type);
    media.src = block.src;
    media.controls = true;
    media.preload = "metadata";

    if (block.type === "video" && block.poster) {
      media.poster = block.poster;
    }
  } else {
    media = document.createElement("iframe");
    media.src = block.src;
    media.title = caption || "Встроенный материал";
    media.loading = "lazy";
    media.referrerPolicy = "strict-origin-when-cross-origin";
    media.allow = "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture";
    media.allowFullscreen = true;
    media.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
  }

  media.addEventListener(block.type === "video" || block.type === "audio" ? "loadedmetadata" : "load", () => {
    updateArticleScrollProgress();
  }, { once: true });

  if (block.href && block.type === "image") {
    const linkedMedia = createArticleLink({ url: block.href, label: block.alt || caption || "Изображение" });
    linkedMedia.className = "article-media-link";
    linkedMedia.replaceChildren(media);
    figure.append(linkedMedia);
  } else {
    figure.append(media);
  }

  if (caption) {
    const figcaption = document.createElement("figcaption");
    figcaption.textContent = caption;
    figure.append(figcaption);
  }

  if (block.type === "embed") {
    figure.append(createArticleLink({ url: block.src, label: "Открыть встроенный материал" }, "article-embed-link"));
  }

  return figure;
}

function renderArticle() {
  if (!activeArticle) return;

  const { post, blocks, translations, showOriginal, status } = activeArticle;
  elements.articleSource.textContent = post.sourceTitle || "Блог";
  elements.articlePublishedAt.textContent = new Date(post.publishedAt).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
  elements.articleTitle.textContent = showOriginal
    ? post.title || post.titleRu || "Без заголовка"
    : post.titleRu || post.title || "Без заголовка";
  elements.articleTranslationStatus.textContent = status || "";
  elements.articleOriginalLink.href = activeArticle.url || post.url;
  elements.articleCopy.replaceChildren();
  elements.articleLanguageButton.hidden = blocks.length === 0;
  elements.articleLanguageButton.textContent = showOriginal ? "Перевод" : "Оригинал";

  let currentList = null;
  let currentListGroup = null;

  for (const [index, block] of blocks.entries()) {
    const translated = translations[index];
    const text = showOriginal ? block.text : translated || block.text;

    if (["image", "video", "audio", "embed", "resource"].includes(block.type)) {
      currentList = null;
      currentListGroup = null;
      elements.articleCopy.append(renderArticleMedia(block, translated, showOriginal));
      continue;
    }

    if (block.type === "list-item") {
      if (!currentList || currentListGroup !== block.listGroup) {
        currentList = document.createElement(block.listType === "ol" ? "ol" : "ul");
        currentListGroup = block.listGroup;
        elements.articleCopy.append(currentList);
      }

      const item = document.createElement("li");
      item.textContent = text;
      item.classList.toggle("is-translation-pending", !showOriginal && !translated);
      appendArticleLinks(item, block.links, block.text);
      currentList.append(item);
      continue;
    }

    currentList = null;
    currentListGroup = null;
    const tagName = block.type === "heading"
      ? "h3"
      : block.type === "quote"
        ? "blockquote"
        : block.type === "code"
          ? "pre"
          : "p";
    const element = document.createElement(tagName);
    element.textContent = text;
    element.classList.toggle("is-translation-pending", !showOriginal && !translated);
    appendArticleLinks(element, block.links, block.text);
    elements.articleCopy.append(element);
  }

  renderReaderPreferences();
  renderIcons();
  window.requestAnimationFrame(updateArticleScrollProgress);
}

async function translateArticle(postId, token) {
  if (!activeArticle || token !== articleRequestToken) return;

  const pending = activeArticle.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block, index }) => {
      if (!block.text) return false;
      if (activeArticle.translations[index]) return false;

      if (articleTextLooksRussian(block.text)) {
        activeArticle.translations[index] = block.text;
        return false;
      }

      return true;
    });
  const total = activeArticle.blocks.filter((block) => block.text).length;

  if (!pending.length) {
    activeArticle.status = "Текст уже на русском.";
    renderArticle();
    return;
  }

  for (let offset = 0; offset < pending.length; offset += 4) {
    if (!activeArticle || token !== articleRequestToken) return;

    const batch = pending.slice(offset, offset + 4);
    const translatedCount = activeArticle.blocks
      .filter((block, index) => block.text && activeArticle.translations[index])
      .length;
    activeArticle.status = `Переводим текст: ${translatedCount} из ${total}`;
    renderArticle();

    try {
      const response = await fetch("/api/article-translations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          postId,
          items: batch.map(({ block, index }) => ({
            id: String(index),
            text: block.text
          }))
        })
      });

      if (!response.ok) throw new Error("Could not translate article");

      const data = await response.json();

      if (!activeArticle || token !== articleRequestToken) return;

      for (const { index } of batch) {
        activeArticle.translations[index] = data.translations?.[String(index)]?.text || null;
      }
    } catch {
      activeArticle.status = "Часть текста пока осталась в оригинале.";
      renderArticle();
      return;
    }
  }

  if (!activeArticle || token !== articleRequestToken) return;

  activeArticle.status = "Переведено автоматически.";
  renderArticle();
}

async function openArticle(post) {
  const token = ++articleRequestToken;
  state.panelOpen = false;
  activeArticle = {
    post,
    url: post.url,
    blocks: [],
    translations: [],
    showOriginal: false,
    status: "Загружаем полный текст…"
  };
  elements.articleReaderScroll.scrollTop = 0;
  updateArticleScrollProgress();
  markPostRead(post.id, { rerender: false });
  renderArticle();

  try {
    const response = await fetch(`/api/article?id=${encodeURIComponent(post.id)}`);

    if (!response.ok) throw new Error("Could not load article");

    const data = await response.json();

    if (!activeArticle || token !== articleRequestToken) return;

    const blocks = extractArticleBlocks(data.html, data.url || post.url);

    if (!blocks.length) throw new Error("Article text was not found");

    activeArticle.url = data.url || post.url;
    activeArticle.blocks = blocks;
    activeArticle.translations = Array(blocks.length).fill(null);
    activeArticle.status = translationsAvailable ? "Готовим перевод…" : "Автоперевод отключён.";
    renderArticle();

    if (translationsAvailable) {
      translateArticle(post.id, token);
    }
  } catch {
    if (!activeArticle || token !== articleRequestToken) return;

    activeArticle.blocks = [{
      type: "paragraph",
      text: post.descriptionRu || post.description || "Полный текст этой публикации получить не удалось."
    }];
    activeArticle.translations = [post.descriptionRu || null];
    activeArticle.status = "Полный текст не загрузился. Показано превью.";
    renderArticle();
  }
}

function closeArticle(options = {}) {
  articleRequestToken += 1;
  activeArticle = null;
  elements.articleReaderScroll.scrollTop = 0;
  updateArticleScrollProgress();
  renderReaderPreferences();
  renderIcons();

  if (options.rerender !== false) {
    renderPosts();
  }
}

function renderSources() {
  elements.sourceList.replaceChildren();
  elements.sourceCount.textContent = sourcesLoaded ? String(state.sources.length) : "…";

  for (const source of state.sources) {
    const node = elements.sourceTemplate.content.firstElementChild.cloneNode(true);
    const failed = state.failedSourceIds.includes(source.id);

    node.classList.toggle("is-failed", failed);
    node.title = failed ? "Источник не ответил при последнем обновлении" : "";
    node.querySelector("strong").textContent = source.title;
    node.querySelector("span").textContent = source.feedUrl;
    elements.sourceList.append(node);
  }
}

function renderPosts() {
  const allPosts = getSortedPosts();
  const filteredPosts = getVisiblePosts();
  const posts = filteredPosts.slice(0, visiblePostLimit);
  const newCount = allPosts.filter(isNewPost).length;
  const unreadCount = allPosts.filter((post) => !isReadPost(post)).length;
  const savedCount = allPosts.filter(isSavedPost).length;
  const shownText = posts.length === allPosts.length ? `${allPosts.length}` : `${posts.length} из ${allPosts.length}`;
  const refreshedText = state.lastRefreshAt ? ` · обновлено ${formatRelativeTime(state.lastRefreshAt)}` : "";
  const sourceText = sourcesLoaded ? `${state.sources.length} источн.` : "источники загружаются";

  elements.viewTitle.textContent = viewTitle();
  elements.feedMeta.textContent = `${shownText} ${plural(allPosts.length, ["публикация", "публикации", "публикаций"])} · ${newCount} ${plural(newCount, ["новая", "новые", "новых"])} · ${unreadCount} непрочит. · ${savedCount} сохран. · ${sourceText}${refreshedText}`;
  elements.feedList.replaceChildren();
  elements.feedList.dataset.emptyText = emptyFeedText(allPosts.length);
  const remaining = Math.max(0, filteredPosts.length - posts.length);
  elements.loadMoreButton.hidden = remaining === 0;
  elements.loadMoreButton.textContent = remaining ? `Показать ещё (${remaining})` : "Показать ещё";
  resetTranslationObserver();

  for (const [index, post] of posts.entries()) {
    const node = elements.postTemplate.content.firstElementChild.cloneNode(true);
    const isNew = isNewPost(post);
    const sourceName = node.querySelector(".post-meta strong");
    const sourceKind = node.querySelector(".post-meta span");
    const time = node.querySelector("time");
    const title = node.querySelector(".post-title");
    const description = node.querySelector("p");
    const readButton = node.querySelector('[data-action="read"]');
    const saveButton = node.querySelector('[data-action="save"]');
    const isRead = isReadPost(post);
    const isSaved = isSavedPost(post);

    node.classList.toggle("is-new", isNew);
    node.classList.toggle("is-read", isRead);
    node.classList.toggle("is-saved", isSaved);
    node.dataset.postId = post.id;
    sourceName.textContent = post.sourceTitle || "Сохраненное";
    sourceKind.textContent = "блог";
    time.dateTime = post.publishedAt;
    time.textContent = formatRelativeTime(post.publishedAt);
    title.href = post.url;
    title.textContent = post.titleRu || post.title;
    title.title = post.titleRu && post.title ? post.title : "";
    title.addEventListener("click", (event) => {
      event.preventDefault();
      openArticle(post);
    });
    description.textContent = post.descriptionRu || post.description || "Описание не найдено.";
    description.title = post.descriptionRu && post.description ? post.description : "";
    updatePostButtons(readButton, saveButton, post);
    readButton.addEventListener("click", () => toggleReadPost(post.id));
    saveButton.addEventListener("click", () => toggleSavedPost(post.id));

    elements.feedList.append(node);

    if (shouldTranslatePost(post)) {
      if (translationObserver) {
        translationObserver.observe(node);
      } else if (index < 20) {
        queueTranslation(post.id);
      }
    }
  }

  renderIcons();
}

function renderViewControls() {
  for (const button of elements.viewButtons) {
    const active = button.dataset.view === state.viewMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function viewTitle() {
  return {
    all: "Лента",
    new: "Новые",
    unread: "Непрочитанное",
    saved: "Сохранённое"
  }[state.viewMode] || "Лента";
}

function emptyFeedText(total) {
  if (!total) return "Обнови источники, чтобы собрать ленту.";
  if (searchQuery()) return "По этому запросу ничего не нашлось.";
  if (state.viewMode === "new") return "Новых публикаций сейчас нет.";
  if (state.viewMode === "unread") return "Всё прочитано.";
  if (state.viewMode === "saved") return "Сохранённых материалов пока нет.";
  return "Публикации не найдены.";
}

function updatePostButtons(readButton, saveButton, post) {
  const isRead = isReadPost(post);
  const isSaved = isSavedPost(post);

  readButton.innerHTML = `<i data-lucide="${isRead ? "rotate-ccw" : "check"}" aria-hidden="true"></i>`;
  readButton.title = isRead ? "Вернуть в непрочитанные" : "Отметить прочитанным";
  readButton.setAttribute("aria-label", readButton.title);
  readButton.setAttribute("aria-pressed", String(isRead));

  saveButton.innerHTML = '<i data-lucide="star" aria-hidden="true"></i>';
  saveButton.title = isSaved ? "Убрать из сохранённых" : "Сохранить";
  saveButton.setAttribute("aria-label", saveButton.title);
  saveButton.setAttribute("aria-pressed", String(isSaved));
}

function markPostRead(postId, options = {}) {
  state.unreadPostIds = state.unreadPostIds.filter((id) => id !== postId);

  const post = state.posts.find((item) => item.id === postId);

  if (post && postSeenAt(post) > state.lastReadAt && !state.readPostIds.includes(postId)) {
    state.readPostIds = [...state.readPostIds, postId];
  }

  saveState();

  if (options.rerender !== false) {
    render();
  }
}

function toggleReadPost(postId) {
  const post = state.posts.find((item) => item.id === postId);

  if (!post) return;

  if (isReadPost(post)) {
    state.readPostIds = state.readPostIds.filter((id) => id !== postId);
    state.unreadPostIds = [...new Set([...state.unreadPostIds, postId])];
  } else {
    state.unreadPostIds = state.unreadPostIds.filter((id) => id !== postId);

    if (postSeenAt(post) > state.lastReadAt && !state.readPostIds.includes(postId)) {
      state.readPostIds = [...state.readPostIds, postId];
    }
  }

  render();
}

function toggleSavedPost(postId) {
  state.savedPostIds = state.savedPostIds.includes(postId)
    ? state.savedPostIds.filter((id) => id !== postId)
    : [...state.savedPostIds, postId];
  render();
}

function resetTranslationObserver() {
  if (translationObserver) {
    translationObserver.disconnect();
  }

  if (!("IntersectionObserver" in window)) {
    translationObserver = null;
    return;
  }

  translationObserver = new IntersectionObserver(handleTranslationIntersections, {
    rootMargin: "420px 0px",
    threshold: 0.01
  });
}

function handleTranslationIntersections(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;

    translationObserver.unobserve(entry.target);
    queueTranslation(entry.target.dataset.postId);
  }
}

function shouldTranslatePost(post) {
  const needsTitle = post.title && !post.titleRu;
  const needsDescription = post.description && !post.descriptionRu;

  return Boolean(needsTitle || needsDescription);
}

function scheduleAllMissingTranslations() {
  if (!translationsAvailable) return;

  window.clearTimeout(translationTimer);
  translationTimer = window.setTimeout(() => {
    translationTimer = null;
    queueAllMissingTranslations();
  }, AUTO_TRANSLATE_ALL_DELAY_MS);
}

function queueAllMissingTranslations() {
  getSortedPosts()
    .filter(shouldTranslatePost)
    .forEach((post) => translationQueue.add(post.id));

  processTranslationQueue();
}

function queueTranslation(postId) {
  if (!postId || !translationsAvailable) return;

  translationQueue.add(postId);

  if (translationTimer) return;

  translationTimer = window.setTimeout(() => {
    translationTimer = null;
    processTranslationQueue();
  }, 180);
}

async function processTranslationQueue() {
  if (translationRunning || !translationsAvailable) return;

  translationRunning = true;

  try {
    while (translationQueue.size) {
      const ids = [...translationQueue].slice(0, TRANSLATION_BATCH_SIZE);
      ids.forEach((id) => translationQueue.delete(id));

      const items = ids
        .map((id) => {
          const post = state.posts.find((item) => item.id === id);
          return post && shouldTranslatePost(post)
            ? {
                id: post.id,
                title: post.title,
                description: post.description
              }
            : null;
        })
        .filter(Boolean);

      if (!items.length) continue;

      const response = await fetch("/api/translations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items })
      });

      if (!response.ok) {
        throw new Error("Translation failed");
      }

      const data = await response.json();
      const translations = data.translations || {};
      const provider = data.provider || translationProvider;

      for (const post of state.posts) {
        if (translations[post.id]) {
          post.titleRu = translations[post.id].title || post.titleRu;
          post.descriptionRu = translations[post.id].description || post.descriptionRu;
          post.translationProvider = provider;
          updateRenderedTranslation(post);
        }
      }

      saveState();
    }

  } catch {
    setStatus("Часть заголовков и описаний пока осталась в оригинале. Сервис перевода временно не ответил.");
  } finally {
    translationRunning = false;

    if (translationQueue.size) {
      processTranslationQueue();
    }
  }
}

function updateRenderedTranslation(post) {
  const node = [...document.querySelectorAll(".post")].find((item) => item.dataset.postId === post.id);

  if (node) {
    const title = node.querySelector(".post-title");
    const description = node.querySelector("p");

    title.textContent = post.titleRu || post.title;
    title.title = post.titleRu && post.title ? post.title : "";
    description.textContent = post.descriptionRu || post.description || "Описание не найдено.";
    description.title = post.descriptionRu && post.description ? post.description : "";
  }
}

function isNewPost(post) {
  const firstSeen = Date.parse(post.firstSeenAt || "");
  const published = Date.parse(post.publishedAt || "");
  const recentPublication = !Number.isNaN(published) && Date.now() - published < NEW_WINDOW_MS;
  return recentPublication && firstSeen > state.lastReadAt && Date.now() - firstSeen < NEW_WINDOW_MS;
}

function plural(count, forms) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function shouldAutoRefresh() {
  return state.sources.length > 0 && Date.now() - state.lastRefreshAt > AUTO_REFRESH_AFTER_MS;
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");

    if (!response.ok) {
      throw new Error("Could not load config");
    }

    const config = await response.json();
    translationsAvailable = Boolean(config.translationsAvailable);
    translationProvider = config.translationProvider || DEFAULT_TRANSLATION_PROVIDER;

    if (!translationsAvailable) {
      setStatus("Автоперевод отключен на сервере.");
    }

    render();
  } catch {
    setStatus("Не получилось проверить настройки перевода.");
  }
}

async function removeSource(id) {
  const response = await fetch(`/api/sources?id=${encodeURIComponent(id)}`, { method: "DELETE" });

  if (!response.ok) {
    setStatus("Не получилось удалить блог.");
    return;
  }

  state.sources = state.sources.filter((source) => source.id !== id);
  state.posts = state.posts.filter((post) => post.sourceId !== id);
  setStatus("Блог удален из локального списка источников.");
  render();
}

async function addSource(title, rawFeedUrl) {
  const feedUrl = normalizeUrl(rawFeedUrl);
  const existing = state.sources.some((source) => source.feedUrl === feedUrl);

  if (existing) {
    setStatus("Этот блог уже есть в списке источников.");
    return;
  }

  const response = await fetch("/api/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: title.trim(),
      feedUrl
    })
  });

  if (!response.ok) {
    setStatus("Не получилось зарегистрировать блог как источник.");
    return;
  }

  const data = await response.json();
  const source = data.source;
  state.sources = [...state.sources.filter((item) => item.id !== source.id), source];
  elements.sourceForm.reset();
  setStatus(data.existing ? "Этот блог уже был в списке источников." : "Блог зарегистрирован. Обновляю только его фид...");
  render();
  const freshPosts = await fetchSource(source);
  render();
  queuePostTranslations(freshPosts);
}

function setRefreshControls(running, completed = 0, total = state.sources.length) {
  for (const button of elements.refreshButtons) {
    button.disabled = running;
    const label = button.querySelector("[data-refresh-label]");

    if (label) {
      const progress = total > 0 ? `${completed}/${total}` : "Загрузка…";
      label.textContent = running ? progress : button.id === "refreshButton" ? "Обновить ленту" : "Обновить";
    }
  }
}

async function refreshFeeds(options = {}) {
  if (refreshRunning) return;

  const requestedSources = options.sourceIds?.length
    ? state.sources.filter((source) => options.sourceIds.includes(source.id))
    : state.sources;

  if (!requestedSources.length) {
    setStatus("В списке пока нет источников.");
    return;
  }

  refreshRunning = true;
  setRefreshControls(true, 0, requestedSources.length);
  setStatus(options.automatic ? `Проверяю новые публикации: 0/${requestedSources.length}` : `Обновляю источники: 0/${requestedSources.length}`);

  const failures = [];
  const freshPosts = [];
  let completed = 0;
  let successful = 0;

  try {
    await runLimited(requestedSources, 10, async (source) => {
      try {
        const fresh = await fetchSource(source);
        freshPosts.push(...fresh);
        successful += 1;
      } catch {
        failures.push(source);
      } finally {
        completed += 1;
        setRefreshControls(true, completed, requestedSources.length);
        setStatus(`Обновляю источники: ${completed}/${requestedSources.length}`);
      }
    });

    if (failures.length) {
      const retryQueue = failures.splice(0);
      setStatus(`Повторно проверяю неответившие источники: ${retryQueue.length}`);

      let retried = 0;

      await runLimited(retryQueue, 10, async (source) => {
        try {
          const fresh = await fetchSource(source);
          freshPosts.push(...fresh);
          successful += 1;
        } catch {
          failures.push(source);
        } finally {
          retried += 1;
          setStatus(`Повторно проверяю источники: ${retried}/${retryQueue.length}`);
        }
      });
    }

    const requestedIds = new Set(requestedSources.map((source) => source.id));
    const previousFailures = state.failedSourceIds.filter((id) => !requestedIds.has(id));
    state.failedSourceIds = [...previousFailures, ...failures.map((source) => source.id)];

    if (failures.length) {
      const failedNames = failures.map((source) => source.title).join(", ");
      setStatus(`Добавлено ${freshPosts.length} новых. Ответили ${successful} из ${requestedSources.length}; не ответили: ${failures.length}.`);
      elements.statusLine.title = failedNames;
    } else {
      setStatus(freshPosts.length ? `Лента обновлена: ${freshPosts.length} новых публикаций.` : "Лента обновлена, новых публикаций нет.");
      elements.statusLine.title = "";
    }

    if (successful > 0) {
      state.lastRefreshAt = Date.now();
    }

    render();
    queuePostTranslations(freshPosts);
  } catch (error) {
    console.error("Could not refresh feeds", error);
    setStatus("Обновление прервалось. Уже полученные публикации сохранены.");
    render();
  } finally {
    refreshRunning = false;
    setRefreshControls(false);
  }
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

async function fetchSource(source) {
  const response = await fetch(`/api/feed?id=${encodeURIComponent(source.id)}`, {
    signal: AbortSignal.timeout(FEED_REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Could not load ${source.feedUrl}`);
  }

  const xml = await response.text();
  const posts = parseFeed(xml, source);
  return mergePosts(posts);
}

function parseFeed(xml, source) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  if (doc.querySelector("parsererror")) {
    throw new Error(`Could not parse ${source.feedUrl}`);
  }

  const rssItems = [...doc.querySelectorAll("item")].map((item) => ({
    title: text(item, "title") || "Без заголовка",
    url: text(item, "link") || text(item, "guid") || source.siteUrl || source.feedUrl,
    description: compactText(text(item, "description") || namespacedText(item, "content:encoded") || ""),
    publishedAt: text(item, "pubDate") || namespacedText(item, "dc:date") || text(item, "published") || text(item, "updated")
  }));

  const atomItems = [...doc.querySelectorAll("entry")].map((entry) => ({
    title: text(entry, "title") || "Без заголовка",
    url: atomLink(entry) || text(entry, "id") || source.siteUrl || source.feedUrl,
    description: compactText(text(entry, "summary") || text(entry, "content") || ""),
    publishedAt: text(entry, "published") || text(entry, "updated")
  }));

  return [...rssItems, ...atomItems].map((post) => {
    const publishedAt = new Date(post.publishedAt);

    return {
      id: postId(post.url, post.title),
      sourceId: source.id,
      sourceTitle: source.title,
      title: compactText(post.title),
      url: absoluteUrl(post.url, source.siteUrl || source.feedUrl),
      description: post.description.slice(0, 260),
      publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date().toISOString() : publishedAt.toISOString(),
      firstSeenAt: new Date().toISOString(),
      isManual: false
    };
  });
}

function text(root, selector) {
  return root.querySelector(selector)?.textContent?.trim() || "";
}

function namespacedText(root, tagName) {
  return root.getElementsByTagName(tagName)[0]?.textContent?.trim() || "";
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return base;
  }
}

function atomLink(entry) {
  const alternate = entry.querySelector("link[rel='alternate']");
  const anyLink = entry.querySelector("link");
  return alternate?.getAttribute("href") || anyLink?.getAttribute("href") || "";
}

function mergePosts(posts) {
  applyCachedTranslations(posts);
  const incomingById = new Map(posts.map((post) => [post.id, post]));
  const known = new Set(state.posts.map((post) => post.id));
  const freshPosts = posts.filter((post) => !known.has(post.id));

  state.posts = [
    ...state.posts.map((existing) => {
      const incoming = incomingById.get(existing.id);

      if (!incoming) return existing;

      return {
        ...existing,
        ...incoming,
        firstSeenAt: existing.firstSeenAt,
        titleRu: existing.titleRu,
        descriptionRu: existing.descriptionRu,
        translationProvider: existing.translationProvider
      };
    }),
    ...freshPosts
  ];
  prunePostState();
  return freshPosts;
}

function prunePostState() {
  const known = new Set(state.posts.map((post) => post.id));
  state.readPostIds = state.readPostIds.filter((id) => known.has(id));
  state.unreadPostIds = state.unreadPostIds.filter((id) => known.has(id));
  state.savedPostIds = state.savedPostIds.filter((id) => known.has(id));
}

function queuePostTranslations(posts) {
  posts
    .filter(shouldTranslatePost)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .forEach((post) => queueTranslation(post.id));
}

elements.sourceForm.addEventListener("submit", (event) => {
  event.preventDefault();

  try {
    addSource(elements.sourceTitle.value, elements.sourceUrl.value).catch(() => {
      setStatus("Не получилось добавить источник.");
    });
  } catch {
    setStatus("Проверь URL источника.");
  }
});

for (const button of elements.refreshButtons) {
  button.addEventListener("click", () => refreshFeeds());
}

elements.markReadButton.addEventListener("click", () => {
  state.lastReadAt = Date.now();
  state.readPostIds = [];
  state.unreadPostIds = [];
  setStatus("Все текущие публикации отмечены прочитанными.");
  render();
});

elements.panelToggleButton.addEventListener("click", () => {
  setPanelOpen(!state.panelOpen);
});

elements.closePanelButton.addEventListener("click", () => {
  setPanelOpen(false);
});

elements.closeArticleButton.addEventListener("click", () => {
  closeArticle();
});

elements.articleLanguageButton.addEventListener("click", () => {
  if (!activeArticle) return;
  activeArticle.showOriginal = !activeArticle.showOriginal;
  renderArticle();
});

elements.fontSizeButton.addEventListener("click", () => {
  const sizes = [15, 17, 19];
  const currentIndex = sizes.indexOf(state.readerFontSize);
  state.readerFontSize = sizes[(currentIndex + 1) % sizes.length];
  render();
});

elements.fontSansButton.addEventListener("click", () => {
  state.readerFont = "sans";
  render();
});

elements.fontSerifButton.addEventListener("click", () => {
  state.readerFont = "serif";
  render();
});

elements.themeButton.addEventListener("click", () => {
  state.darkMode = !state.darkMode;
  render();
});

elements.fullscreenButton.addEventListener("click", async () => {
  if (window.READ_LIKE_NATIVE) {
    window.location.href = "readlike://fullscreen";
    return;
  }

  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
});

elements.searchInput.addEventListener("input", () => {
  visiblePostLimit = POST_PAGE_SIZE;
  render();
});

for (const button of elements.viewButtons) {
  button.addEventListener("click", () => {
    state.viewMode = button.dataset.view || "all";
    visiblePostLimit = POST_PAGE_SIZE;
    render();
  });
}

elements.loadMoreButton.addEventListener("click", () => {
  visiblePostLimit += POST_PAGE_SIZE;
  renderPosts();
  window.requestAnimationFrame(updateFeedScrollProgress);
});

window.addEventListener("scroll", updateFeedScrollProgress, { passive: true });
window.addEventListener("resize", () => {
  updateFeedScrollProgress();
  updateArticleScrollProgress();
});
elements.articleReaderScroll.addEventListener("scroll", updateArticleScrollProgress, { passive: true });

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

  if (event.key === "/" && !isTyping) {
    event.preventDefault();
    setPanelOpen(true);
    elements.searchInput.focus();
  }

  if (event.key === "Escape") {
    if (activeArticle) {
      closeArticle();
    } else if (document.activeElement === elements.searchInput && elements.searchInput.value) {
      elements.searchInput.value = "";
      elements.searchInput.blur();
      render();
    } else if (state.panelOpen) {
      setPanelOpen(false);
    }
  }

  if (event.key.toLowerCase() === "b" && !isTyping) {
    setPanelOpen(!state.panelOpen);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shouldAutoRefresh()) {
    refreshFeeds({ automatic: true });
  }
});

async function initialize() {
  render();
  updateFeedScrollProgress();
  updateArticleScrollProgress();
  await loadSources();
  await loadServerState();
  await loadConfig();

  if (shouldAutoRefresh()) {
    refreshFeeds({ automatic: true });
  }
}

initialize();
