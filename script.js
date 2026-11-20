/*
  L'Oréal Routine Builder

  The page loads products.json, lets the user select products, and asks the
  Cloudflare Worker for a routine. Follow-up questions reuse the same
  messages array. The OpenAI key stays in the Worker, not in this file.

  messages is the full API history, including the hidden routine JSON.
  displayTurns is only what the visitor sees.
*/

/* The Worker URL is public. It is not an API key. */
const WORKER_URL = "https://loreal-routine-builder.balandraguillermo.workers.dev/";
const STORAGE_KEY = "lorealSelectedProductIds";
const DIRECTION_KEY = "lorealTextDirection";
const MESSAGE_CHAR_LIMIT = 80000;
const CONTEXT_CHAR_LIMIT = 480000;
const READ_MORE_HEIGHT = 420;
const CONTEXT_LIMIT_MESSAGE =
  "This conversation is too long for the model context. Earlier messages were kept, and this request was not sent.";

const SYSTEM_PROMPT = `You are a L'Oréal beauty advisor. Help only with skincare, haircare, makeup, fragrance, grooming, sun care, and closely related beauty routines.

If a request is unrelated to those topics, politely say that you can only help with beauty routines and products, and invite a beauty question. Do not answer the unrelated request.

When the user supplies product JSON, use only that data for the routine. Do not invent ingredients, benefits, clinical results, prices, shade ranges, or usage steps that are not in the descriptions. If a detail is missing, say that you do not have it.

Give a practical order when the products support one, such as cleanse, treat, moisturize, then protect. Keep answers concise.

Do not diagnose medical conditions. For serious skin or scalp symptoms, suggest a qualified professional.

You cannot browse the web unless a web search tool is provided in this request. Do not claim that you searched, and do not invent citations or source URLs.`;

/* Page elements */
const categoryFilter = document.getElementById("categoryFilter");
const productSearch = document.getElementById("productSearch");
const clearSearchButton = document.getElementById("clearSearch");
const resultsStatus = document.getElementById("resultsStatus");
const productsContainer = document.getElementById("productsContainer");
const selectedProductsList = document.getElementById("selectedProductsList");
const clearSelectedButton = document.getElementById("clearSelected");
const generateButton = document.getElementById("generateRoutine");
const generateLabel = document.getElementById("generateLabel");
const chatForm = document.getElementById("chatForm");
const chatBody = document.getElementById("chatBody");
const chatWindow = document.getElementById("chatWindow");
const chatStatus = document.getElementById("chatStatus");
const welcomeState = document.getElementById("welcomeState");
const userInput = document.getElementById("userInput");
const sendButton = document.getElementById("sendBtn");
const directionToggle = document.getElementById("directionToggle");
const newChatButton = document.getElementById("newChatBtn");
const newChatDialog = document.getElementById("newChatDialog");
const cancelNewChatButton = document.getElementById("cancelNewChatBtn");
const confirmNewChatButton = document.getElementById("confirmNewChatBtn");
const stopButton = document.getElementById("stopBtn");
const newMsgsButton = document.getElementById("newMsgsBtn");
const menuButton = document.getElementById("menuBtn");
const navDrawer = document.getElementById("navDrawer");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const drawerCloseButton = document.getElementById("drawerCloseBtn");
const topNav = document.querySelector(".top-nav");

/* catalog is every product. selectedIds stores the chosen product ids. */
let catalog = [];
let catalogReady = false;
let selectedIds = [];
let requestInFlight = false;
let loadingText = "";
let pendingRetry = null;
let requestSerial = 0;
let stopRequested = false;
let activeController = null;

/* messages is what we send to the Worker. displayTurns is what we show. */
let messages = [{ role: "system", content: SYSTEM_PROMPT }];
let displayTurns = [];

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* Show a prompt until the catalog has loaded. */
productsContainer.innerHTML = `
  <div class="placeholder-message">
    Loading products…
  </div>
`;

/* Turn text into safe HTML so product names cannot inject markup. */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function productName(product) {
  return product && product.name ? String(product.name) : "Unnamed product";
}

function productBrand(product) {
  return product && product.brand ? String(product.brand) : "Unknown brand";
}

function productDescription(product) {
  return product && product.description
    ? String(product.description)
    : "No description available.";
}

function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch (error) {
    return false;
  }
}

/* Current facts, prices, and recalls are the questions that need web search. */
function questionNeedsWebSearch(text) {
  const value = text.toLowerCase();
  const patterns = [
    /\b(price|priced|cost|costs|msrp|how much)\b/,
    /\b(where to buy|buy online|in stock|sold out|retailer)\b/,
    /\b(latest|newest|recently launched|this year|2024|2025|2026)\b/,
    /\b(review|reviews|rating|ratings|recall|recalled)\b/,
    /\b(official website|official site)\b/,
    /\b(news|announcement)\b/,
    /\bingredient list\b/,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

/* Load product data from JSON file */
async function loadProducts() {
  const response = await fetch("products.json");
  if (!response.ok) {
    throw new Error("The product list could not be loaded.");
  }
  const data = await response.json();
  if (!data || !Array.isArray(data.products)) {
    throw new Error("Product data was not in the expected format.");
  }
  return data.products.filter((product) => Number.isInteger(product && product.id));
}

/* Keep only ids that still exist in the catalog. */
function readStoredSelection() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const knownIds = new Set(catalog.map((product) => product.id));
    const ids = [];
    parsed.forEach((value) => {
      let id = null;
      if (typeof value === "number" && Number.isInteger(value)) id = value;
      if (typeof value === "string" && /^-?\d+$/.test(value)) id = Number(value);
      if (id === null || !knownIds.has(id) || ids.includes(id)) return;
      ids.push(id);
    });
    return ids;
  } catch (error) {
    return [];
  }
}

function saveSelection() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedIds));
  } catch (error) {
    setStatus("The selection could not be saved in this browser.", true);
  }
}

function selectedProducts() {
  return selectedIds
    .map((id) => catalog.find((product) => product.id === id))
    .filter(Boolean);
}

/* Category and keyword filters both narrow the same catalog. */
function getVisibleProducts() {
  const category = categoryFilter.value;
  const query = productSearch.value.trim().toLowerCase();
  if (!category && !query) return null;

  return catalog.filter((product) => {
    const categoryMatches = !category || product.category === category;
    if (!categoryMatches) return false;
    if (!query) return true;
    const haystack = [productName(product), productBrand(product), productDescription(product)]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function showPlaceholder(message, isError) {
  const errorClass = isError ? " is-error" : "";
  const role = isError ? ` role="alert"` : "";
  productsContainer.innerHTML = `
    <div class="placeholder-message${errorClass}"${role}>
      ${escapeHtml(message)}
    </div>
  `;
}

/* Create HTML for displaying product cards */
function renderProducts() {
  if (!catalogReady) return;

  clearSearchButton.hidden = productSearch.value.trim() === "";
  const activeId =
    document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.productId
      : "";
  const visibleProducts = getVisibleProducts();

  if (visibleProducts === null) {
    showPlaceholder("Select a category or search for a product.");
    resultsStatus.textContent = "Select a category or search for a product.";
    return;
  }

  if (visibleProducts.length === 0) {
    showPlaceholder("No products match that filter.");
    resultsStatus.textContent = "No products match that filter.";
    return;
  }

  productsContainer.innerHTML = visibleProducts
    .map((product) => {
      const selected = selectedIds.includes(product.id);
      const name = productName(product);
      const brand = productBrand(product);
      const description = productDescription(product);
      const action = selected ? "Remove" : "Add";
      const badge = selected ? `<span class="selected-badge">Selected</span>` : "";
      const image = isHttpUrl(product.image)
        ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(name)}" loading="lazy">`
        : `<div class="image-fallback">Image unavailable</div>`;

      return `
        <article
          class="product-card${selected ? " is-selected" : ""}"
          data-product-id="${product.id}"
          role="button"
          tabindex="0"
          aria-pressed="${selected ? "true" : "false"}"
          aria-describedby="desc-${product.id}"
          aria-label="${escapeHtml(action)} ${escapeHtml(brand)} ${escapeHtml(name)}"
        >
          <div class="product-photo">${image}</div>
          <div class="product-info">
            ${badge}
            <h3 dir="auto">${escapeHtml(name)}</h3>
            <p class="product-brand" dir="auto">${escapeHtml(brand)}</p>
            <p class="product-description" dir="auto" id="desc-${product.id}">${escapeHtml(description)}</p>
          </div>
        </article>
      `;
    })
    .join("");

  productsContainer.querySelectorAll("img").forEach((image) => {
    const showFallback = () => {
      const fallback = document.createElement("div");
      fallback.className = "image-fallback";
      fallback.textContent = "Image unavailable";
      image.replaceWith(fallback);
    };
    image.addEventListener("error", showFallback);
    if (image.complete && image.naturalWidth === 0) showFallback();
  });

  if (activeId) {
    const nextCard = productsContainer.querySelector(`[data-product-id="${activeId}"]`);
    if (nextCard) nextCard.focus();
  }

  resultsStatus.textContent = `Showing ${visibleProducts.length} products.`;
}

function renderSelected() {
  clearSelectedButton.disabled = selectedIds.length === 0;
  const products = selectedProducts();

  if (products.length === 0) {
    selectedProductsList.innerHTML = `
      <p class="selected-empty">No products selected yet.</p>
    `;
    return;
  }

  selectedProductsList.innerHTML = `
    <ul class="selected-list">
      ${products
        .map((product) => {
          const name = productName(product);
          const brand = productBrand(product);
          return `
            <li class="selected-chip">
              <span class="chip-label" dir="auto">${escapeHtml(brand)} — ${escapeHtml(name)}</span>
              <button type="button" data-remove-id="${product.id}">
                Remove
                <span class="visually-hidden">${escapeHtml(brand)} ${escapeHtml(name)}</span>
              </button>
            </li>
          `;
        })
        .join("")}
    </ul>
  `;
}

function toggleProduct(id) {
  if (!catalog.some((product) => product.id === id)) return;
  if (selectedIds.includes(id)) {
    selectedIds = selectedIds.filter((selectedId) => selectedId !== id);
  } else {
    selectedIds = [...selectedIds, id];
  }
  saveSelection();
  renderProducts();
  renderSelected();
}

function clearSelection() {
  selectedIds = [];
  saveSelection();
  renderProducts();
  renderSelected();
}

function setStatus(message, isError) {
  chatStatus.textContent = message || "";
  chatStatus.classList.toggle("is-error", Boolean(isError && message));
}

function updateSendState() {
  sendButton.disabled = requestInFlight || userInput.value.trim() === "";
}

function setBusy(isBusy) {
  requestInFlight = isBusy;
  generateButton.disabled = isBusy;
  userInput.disabled = isBusy;
  stopButton.hidden = !isBusy;
  newChatButton.disabled = !isBusy && displayTurns.length === 0;
  document.querySelectorAll(".starter-chip").forEach((chip) => {
    chip.disabled = isBusy;
  });
  generateLabel.textContent = isBusy ? "Please wait…" : "Generate Routine";
  chatWindow.setAttribute("aria-busy", isBusy ? "true" : "false");
  updateSendState();
}

function resizeComposer() {
  userInput.style.height = "auto";
  userInput.style.height = `${Math.min(userInput.scrollHeight, 112)}px`;
}

function safeCitations(value, webSearchUsed) {
  if (!webSearchUsed || !Array.isArray(value)) return [];
  const citations = [];
  value.forEach((item) => {
    if (!item || !isHttpUrl(item.url) || citations.some((citation) => citation.url === item.url)) {
      return;
    }
    citations.push({
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : item.url,
      url: item.url,
    });
  });
  return citations.slice(0, 8);
}

function routineRequestLabel(count) {
  const noun = count === 1 ? "product" : "products";
  return `Generate a routine for my ${count} selected ${noun}.`;
}

function conversationExceedsLimit(nextMessages) {
  const total = nextMessages.reduce((sum, message) => sum + message.content.length, 0);
  return (
    total > CONTEXT_CHAR_LIMIT ||
    nextMessages.some((message) => message.content.length > MESSAGE_CHAR_LIMIT)
  );
}

function makeLink(label, url) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.dir = "ltr";
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = label;
  const hint = document.createElement("span");
  hint.className = "visually-hidden";
  hint.textContent = " (opens in a new tab)";
  anchor.appendChild(hint);
  return anchor;
}

function cleanUrl(value) {
  return String(value).replace(/[),.;!?]+$/g, "");
}

/* Turn trusted text into text nodes, bold tags, and validated links. */
function appendInline(parent, text) {
  const pattern =
    /(\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<]+)/g;
  let lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    if (match[2] || match[3]) {
      const strong = document.createElement("strong");
      strong.textContent = match[2] || match[3];
      parent.appendChild(strong);
    } else if (match[4] && isHttpUrl(match[5])) {
      parent.appendChild(makeLink(match[4], match[5]));
    } else if (match[0].startsWith("http") && isHttpUrl(cleanUrl(match[0]))) {
      const url = cleanUrl(match[0]);
      parent.appendChild(makeLink(url, url));
    } else {
      parent.appendChild(document.createTextNode(match[0]));
    }
    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function isMarkdownBlockStart(line) {
  return /^(#{1,3})\s+\S/.test(line) || /^[-*]\s+\S/.test(line) || /^\d+\.\s+\S/.test(line);
}

function appendPlainText(parent, text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  lines.forEach((line, index) => {
    if (index > 0) parent.appendChild(document.createElement("br"));
    parent.appendChild(document.createTextNode(line));
  });
}

/* Render a limited Markdown subset with DOM nodes, never raw HTML. */
function appendMarkdown(parent, text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const element = document.createElement(heading[1].length >= 3 ? "h4" : "h3");
      appendInline(element, heading[2]);
      parent.appendChild(element);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const list = document.createElement("ul");
      while (index < lines.length && /^[-*]\s+\S/.test(lines[index])) {
        const item = document.createElement("li");
        appendInline(item, lines[index].replace(/^[-*]\s+/, ""));
        list.appendChild(item);
        index += 1;
      }
      parent.appendChild(list);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const list = document.createElement("ol");
      while (index < lines.length && /^\d+\.\s+\S/.test(lines[index])) {
        const item = document.createElement("li");
        appendInline(item, lines[index].replace(/^\d+\.\s+/, ""));
        list.appendChild(item);
        index += 1;
      }
      parent.appendChild(list);
      continue;
    }

    const paragraph = document.createElement("p");
    let firstLine = true;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      if (!firstLine) paragraph.appendChild(document.createElement("br"));
      appendInline(paragraph, lines[index]);
      firstLine = false;
      index += 1;
    }
    parent.appendChild(paragraph);
  }
}

function appendCitations(parent, citations) {
  const safe = citations.filter((citation) => citation && isHttpUrl(citation.url));
  if (safe.length === 0) return;
  const block = document.createElement("div");
  block.className = "citations";
  const title = document.createElement("p");
  title.className = "citations-title";
  title.textContent = "Sources from web search";
  const list = document.createElement("ol");
  safe.forEach((citation) => {
    const item = document.createElement("li");
    const label = citation.title && citation.title.trim() ? citation.title.trim() : citation.url;
    item.appendChild(makeLink(label, citation.url));
    list.appendChild(item);
  });
  block.append(title, list);
  parent.appendChild(block);
}

/* "2:35 PM" today, "Yesterday, 2:35 PM", or a full date. Timestamps stay on screen only. */
function formatTimestamp(ts) {
  const date = new Date(ts);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (daysAgo === 0) return time;
  if (daysAgo === 1) return `Yesterday, ${time}`;
  const day = date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  return `${day}, ${time}`;
}

function timeElement(ts) {
  const time = document.createElement("time");
  time.className = "msg-time";
  time.dateTime = new Date(ts).toISOString();
  time.textContent = formatTimestamp(ts);
  return time;
}

/* The copy button uses the answer the visitor can read, not the hidden product JSON. */
function visibleAnswerText(turn) {
  let text = turn.content;
  if (turn.webSearchUsed && (!turn.citations || turn.citations.length === 0)) {
    text += "\n\nWeb search ran, and no source links were returned.";
  }
  if (turn.citations && turn.citations.length > 0) {
    text += "\n\nSources from web search\n";
    text += turn.citations.map((citation) => `${citation.title}\n${citation.url}`).join("\n");
  }
  return text;
}

async function copyText(text, button) {
  let success = false;
  try {
    await navigator.clipboard.writeText(text);
    success = true;
  } catch (error) {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    try {
      success = document.execCommand("copy");
    } catch (copyError) {
      success = false;
    }
    helper.remove();
  }
  button.textContent = success ? "Copied!" : "Copy failed";
  window.setTimeout(() => {
    button.textContent = "Copy response";
  }, 1500);
}

/* Long replies can collapse. Routines stay open so the full plan is visible first. */
function setupReadMore(article, turn) {
  const body = article.querySelector(".bubble-body");
  if (!body || body.scrollHeight <= READ_MORE_HEIGHT) return;

  if (turn.kind !== "routine" && turn.collapsed === undefined) turn.collapsed = true;
  if (turn.collapsed) body.classList.add("is-collapsed");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "read-more-btn";
  const collapsed = body.classList.contains("is-collapsed");
  button.textContent = collapsed ? "Read more" : "Read less";
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  button.addEventListener("click", () => {
    const isCollapsed = body.classList.toggle("is-collapsed");
    turn.collapsed = isCollapsed;
    button.textContent = isCollapsed ? "Read more" : "Read less";
    button.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  });
  body.insertAdjacentElement("afterend", button);
}

function isNearBottom() {
  return chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 80;
}

function scrollChatToBottom() {
  chatBody.scrollTop = chatBody.scrollHeight;
  newMsgsButton.hidden = true;
}

/* Rebuild the visible chat. mode is "bottom", "smart", or "preserve". */
function renderChat(mode) {
  const wasNear = isNearBottom();
  const previousTop = chatBody.scrollTop;
  chatWindow.replaceChildren();
  welcomeState.hidden = displayTurns.length > 0 || requestInFlight;

  displayTurns.forEach((turn) => {
    const article = document.createElement("article");
    article.className = `chat-bubble ${turn.role === "user" ? "user" : "assistant"}`;

    const who = document.createElement("p");
    who.className = "visually-hidden";
    who.textContent = turn.role === "user" ? "You said:" : "Advisor said:";
    article.appendChild(who);

    if (turn.role === "assistant") {
      const label = document.createElement("p");
      label.className = "msg-label";
      label.textContent = "L'Oréal Beauty Advisor";
      article.appendChild(label);
    }

    const body = document.createElement("div");
    body.className = turn.role === "assistant" ? "bubble-body" : "bubble-text";
    const text = document.createElement("div");
    text.className = "bubble-text";
    text.dir = "auto";
    if (turn.role === "assistant") {
      appendMarkdown(text, turn.content);
      body.appendChild(text);
      if (turn.webSearchUsed && (!turn.citations || turn.citations.length === 0)) {
        const note = document.createElement("p");
        note.className = "search-note";
        note.textContent = "Web search ran, and no source links were returned.";
        body.appendChild(note);
      }
      appendCitations(body, turn.citations || []);
      article.appendChild(body);
    } else {
      appendPlainText(text, turn.content);
      article.appendChild(text);
    }

    if (turn.role === "assistant") {
      const footer = document.createElement("div");
      footer.className = "msg-footer";
      footer.appendChild(timeElement(turn.ts || Date.now()));
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "copy-btn";
      copyButton.textContent = "Copy response";
      copyButton.addEventListener("click", () => {
        copyText(visibleAnswerText(turn), copyButton);
      });
      footer.appendChild(copyButton);
      article.appendChild(footer);
    } else {
      article.appendChild(timeElement(turn.ts || Date.now()));
      if (turn.stopped) {
        const stopped = document.createElement("p");
        stopped.className = "stopped-label";
        stopped.textContent = "Response stopped";
        article.appendChild(stopped);
      }
    }

    chatWindow.appendChild(article);
    if (turn.role === "assistant") setupReadMore(article, turn);
  });

  if (requestInFlight) {
    const typing = document.createElement("article");
    typing.className = "chat-bubble assistant typing-bubble";
    typing.setAttribute("aria-label", loadingText || "Beauty Advisor is typing");
    const typingText = document.createElement("span");
    typingText.className = "visually-hidden";
    typingText.textContent = loadingText || "Beauty Advisor is typing";
    typing.appendChild(typingText);
    const dots = document.createElement("div");
    dots.className = "bubble-body";
    for (let index = 0; index < 3; index += 1) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("aria-hidden", "true");
      dots.appendChild(dot);
    }
    typing.appendChild(dots);
    chatWindow.appendChild(typing);
  }

  if (pendingRetry) {
    const errorBox = document.createElement("div");
    errorBox.className = "msg-error";
    errorBox.setAttribute("role", "alert");
    const errorText = document.createElement("p");
    errorText.className = "error-text";
    errorText.textContent = pendingRetry.message;
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "retry-btn";
    retryButton.textContent = "Retry";
    retryButton.addEventListener("click", () => {
      const saved = pendingRetry;
      if (!saved || requestInFlight) return;
      pendingRetry = null;
      askAdvisor(saved.userText, saved.options);
    });
    errorBox.append(errorText, retryButton);
    chatWindow.appendChild(errorBox);
  }

  if (mode === "bottom" || (mode === "smart" && wasNear)) {
    scrollChatToBottom();
  } else if (mode === "smart") {
    chatBody.scrollTop = previousTop;
    newMsgsButton.hidden = false;
  } else {
    chatBody.scrollTop = previousTop;
    if (wasNear) newMsgsButton.hidden = true;
  }
}

function routinePrompt(products) {
  const payload = products.map((product) => ({
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    description: product.description,
    image: product.image,
  }));

  return [
    "Create a practical routine using only the selected products below.",
    "This request replaces any earlier product list.",
    "Use only the facts in this JSON. Do not add ingredients, benefits, or steps that those descriptions do not support.",
    "",
    "Selected products JSON:",
    JSON.stringify(payload),
  ].join("\n");
}

function safeErrorText(error) {
  const message = error && error.message ? String(error.message) : "";
  if (!message || /sk-|api[_-]?key|bearer\s+/i.test(message)) {
    return "The advisor could not respond. Please try again.";
  }
  return message;
}

function markStoppedTurn() {
  const visibleTurn = displayTurns[displayTurns.length - 1];
  if (visibleTurn && visibleTurn.role === "user") visibleTurn.stopped = true;
}

/* The visible sentence stays in the chat. userText is what the Worker receives. */
async function askAdvisor(userText, options) {
  if (requestInFlight) return;

  const settings = options || {};
  const webSearch = Boolean(settings.webSearch);
  const kind = settings.kind === "routine" ? "routine" : "chat";
  const visibleText = settings.displayText || userText;
  const nextMessages = [...messages, { role: "user", content: userText }];
  if (conversationExceedsLimit(nextMessages)) {
    setStatus(CONTEXT_LIMIT_MESSAGE, true);
    if (settings.restoreText) userInput.value = settings.restoreText;
    resizeComposer();
    updateSendState();
    return;
  }

  const serial = ++requestSerial;
  stopRequested = false;
  const historyBefore = messages.map((message) => ({ ...message }));
  const turnsBefore = displayTurns.map((turn) => ({ ...turn }));
  const controller = new AbortController();
  activeController = controller;

  messages = nextMessages;
  displayTurns.push({
    role: "user",
    content: visibleText,
    ts: Date.now(),
    kind,
  });
  pendingRetry = null;
  loadingText = webSearch
    ? "Requesting web search…"
    : kind === "routine"
      ? "Creating your routine…"
      : "Sending your question…";
  setBusy(true);
  setStatus(
    webSearch
      ? "Sending your question. Web search is requested for this message."
      : kind === "routine"
        ? "Creating your routine from the selected products."
        : "Sending your question.",
    false
  );
  renderChat("bottom");

  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        webSearch,
      }),
      signal: controller.signal,
    });
    if (serial !== requestSerial) return;

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (serial !== requestSerial) return;

    /* Stop discards the reply. The question stays visible, but it is not a completed API turn. */
    if (stopRequested) {
      messages = historyBefore;
      markStoppedTurn();
      pendingRetry = null;
      setStatus("Response stopped.", false);
      return;
    }

    const reply =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "";

    if (!response.ok || typeof reply !== "string" || !reply.trim()) {
      const workerMessage = data && data.error && data.error.message;
      throw new Error(workerMessage || "The advisor could not respond. Please try again.");
    }

    const webSearchUsed = data.webSearchUsed === true;
    const citations = safeCitations(data.citations, webSearchUsed);
    messages.push({ role: "assistant", content: reply.trim() });
    displayTurns.push({
      role: "assistant",
      content: reply.trim(),
      citations,
      webSearchUsed,
      ts: Date.now(),
      kind,
    });
    if (settings.restoreText && userInput.value === settings.restoreText) {
      userInput.value = "";
      resizeComposer();
    }
    setStatus("", false);
  } catch (error) {
    if (serial !== requestSerial) return;
    if (stopRequested || (error && error.name === "AbortError")) {
      messages = historyBefore;
      markStoppedTurn();
      pendingRetry = null;
      setStatus("Response stopped.", false);
      return;
    }

    messages = historyBefore;
    displayTurns = turnsBefore;
    pendingRetry = {
      userText,
      options: {
        webSearch,
        kind,
        displayText: settings.displayText || "",
        restoreText: settings.restoreText || "",
      },
      message: safeErrorText(error),
    };
    setStatus(safeErrorText(error), true);
    if (settings.restoreText) userInput.value = settings.restoreText;
    resizeComposer();
  } finally {
    if (serial !== requestSerial) return;
    const wasStopped = stopRequested;
    if (activeController === controller) activeController = null;
    stopRequested = false;
    setBusy(false);
    renderChat(wasStopped ? "bottom" : "smart");
  }
}

/* New Chat clears the conversation only. Selected products and filters stay. */
function resetConversation() {
  requestSerial += 1;
  stopRequested = false;
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  messages = [{ role: "system", content: SYSTEM_PROMPT }];
  displayTurns = [];
  pendingRetry = null;
  userInput.value = "";
  resizeComposer();
  setStatus("", false);
  setBusy(false);
  newMsgsButton.hidden = true;
  renderChat("bottom");
}

function applyDirection(direction) {
  const nextDirection = direction === "rtl" ? "rtl" : "ltr";
  document.documentElement.dir = nextDirection;
  const rtl = nextDirection === "rtl";
  directionToggle.setAttribute("aria-pressed", rtl ? "true" : "false");
  directionToggle.textContent = rtl ? "LTR" : "RTL";
  directionToggle.setAttribute(
    "aria-label",
    rtl ? "Switch to left-to-right layout" : "Switch to right-to-left layout"
  );
  try {
    localStorage.setItem(DIRECTION_KEY, nextDirection);
  } catch (error) {
    /* The layout still changes if storage is unavailable. */
  }
}

function restoreDirection() {
  let stored = "";
  try {
    stored = localStorage.getItem(DIRECTION_KEY) || "";
  } catch (error) {
    stored = "";
  }
  applyDirection(stored === "rtl" ? "rtl" : "ltr");
}

function stopResponding() {
  if (!requestInFlight || !activeController) return;
  stopRequested = true;
  activeController.abort();
}

/* Drawer helpers. Hover-open is only for a fine pointer, not a touch screen. */
let closeTimer = null;
let pointerOverButton = false;
let hoverLocked = false;

function openDrawer(moveFocus) {
  navDrawer.inert = false;
  navDrawer.classList.add("open");
  drawerBackdrop.classList.add("open");
  topNav.classList.add("menu-open");
  menuButton.setAttribute("aria-expanded", "true");
  menuButton.setAttribute("aria-label", "Close menu");
  document.body.classList.add("drawer-open");
  if (moveFocus) drawerCloseButton.focus();
}

function closeDrawer(restoreFocus) {
  navDrawer.classList.remove("open");
  drawerBackdrop.classList.remove("open");
  topNav.classList.remove("menu-open");
  navDrawer.inert = true;
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.setAttribute("aria-label", "Open menu");
  document.body.classList.remove("drawer-open");
  if (restoreFocus) menuButton.focus();
}

function cancelDrawerClose() {
  window.clearTimeout(closeTimer);
}

function scheduleDrawerClose() {
  cancelDrawerClose();
  closeTimer = window.setTimeout(() => {
    if (navDrawer.contains(document.activeElement)) return;
    closeDrawer(false);
  }, prefersReducedMotion() ? 0 : 250);
}

function explicitDrawerClose() {
  hoverLocked = pointerOverButton;
  cancelDrawerClose();
  closeDrawer(true);
}

function bindDrawer() {
  const hoverCapable = window.matchMedia("(hover: hover) and (pointer: fine)");
  if (hoverCapable.matches) {
    menuButton.addEventListener("mouseenter", () => {
      pointerOverButton = true;
      cancelDrawerClose();
      if (!hoverLocked && !navDrawer.classList.contains("open")) openDrawer(false);
    });
    menuButton.addEventListener("mouseleave", () => {
      pointerOverButton = false;
      hoverLocked = false;
      if (navDrawer.classList.contains("open")) scheduleDrawerClose();
    });
    navDrawer.addEventListener("mouseenter", cancelDrawerClose);
    navDrawer.addEventListener("mouseleave", () => {
      if (navDrawer.classList.contains("open")) scheduleDrawerClose();
    });
    navDrawer.addEventListener("focusin", cancelDrawerClose);
  }

  menuButton.addEventListener("click", () => {
    cancelDrawerClose();
    if (navDrawer.classList.contains("open")) explicitDrawerClose();
    else openDrawer(true);
  });
  drawerCloseButton.addEventListener("click", explicitDrawerClose);
  drawerBackdrop.addEventListener("click", explicitDrawerClose);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !navDrawer.classList.contains("open")) return;
    if (newChatDialog.open) return;
    explicitDrawerClose();
  });

  navDrawer.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusables = navDrawer.querySelectorAll("button, a");
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  navDrawer.querySelectorAll(".drawer-link").forEach((link) => {
    link.addEventListener("click", explicitDrawerClose);
  });
}

function bindEvents() {
  categoryFilter.addEventListener("change", renderProducts);

  productSearch.addEventListener("input", renderProducts);
  productSearch.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && productSearch.value) {
      productSearch.value = "";
      renderProducts();
    }
  });

  clearSearchButton.addEventListener("click", () => {
    productSearch.value = "";
    productSearch.focus();
    renderProducts();
  });

  productsContainer.addEventListener("click", (event) => {
    const card = event.target.closest(".product-card");
    if (!card) return;
    toggleProduct(Number(card.dataset.productId));
  });

  productsContainer.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".product-card");
    if (!card) return;
    event.preventDefault();
    toggleProduct(Number(card.dataset.productId));
  });

  selectedProductsList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-id]");
    if (!button) return;
    toggleProduct(Number(button.dataset.removeId));
    const nextButton = selectedProductsList.querySelector("[data-remove-id]");
    (nextButton || productSearch).focus();
  });

  clearSelectedButton.addEventListener("click", () => {
    clearSelection();
    productSearch.focus();
  });

  generateButton.addEventListener("click", () => {
    if (requestInFlight) return;
    const products = selectedProducts();
    if (products.length === 0) {
      setStatus("Select at least one product before generating a routine.", true);
      return;
    }
    askAdvisor(routinePrompt(products), {
      webSearch: false,
      kind: "routine",
      displayText: routineRequestLabel(products.length),
    });
  });

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    const text = userInput.value.trim();
    if (!text) return;
    userInput.value = "";
    resizeComposer();
    askAdvisor(text, {
      webSearch: questionNeedsWebSearch(text),
      restoreText: text,
    });
  });

  userInput.addEventListener("input", () => {
    resizeComposer();
    updateSendState();
  });

  userInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  document.querySelectorAll(".starter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (requestInFlight) return;
      const question = chip.dataset.question || "";
      askAdvisor(question, { webSearch: questionNeedsWebSearch(question) });
    });
  });

  stopButton.addEventListener("click", stopResponding);
  newMsgsButton.addEventListener("click", scrollChatToBottom);
  chatBody.addEventListener("scroll", () => {
    if (isNearBottom()) newMsgsButton.hidden = true;
  });

  newChatButton.addEventListener("click", () => {
    if (typeof newChatDialog.showModal === "function") newChatDialog.showModal();
  });
  cancelNewChatButton.addEventListener("click", () => {
    newChatDialog.close();
    newChatButton.focus();
  });
  confirmNewChatButton.addEventListener("click", () => {
    resetConversation();
    newChatDialog.close();
    userInput.focus();
  });

  directionToggle.addEventListener("click", () => {
    const rtl = document.documentElement.dir === "rtl";
    applyDirection(rtl ? "ltr" : "rtl");
  });

  bindDrawer();
}

async function init() {
  bindEvents();
  restoreDirection();
  renderSelected();
  renderChat("preserve");
  updateSendState();

  try {
    catalog = await loadProducts();
    catalogReady = true;
    selectedIds = readStoredSelection();
    saveSelection();
    renderProducts();
    renderSelected();
  } catch (error) {
    showPlaceholder(
      "The product list could not be loaded. Refresh the page to try again.",
      true
    );
    resultsStatus.textContent = "The product list could not be loaded.";
  }
}

init();
