import http from "node:http";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = new URL("../dist/", import.meta.url);
const DATA_DIR = new URL("../data/", import.meta.url);
const KNOWLEDGE_FILE = new URL(process.env.KNOWLEDGE_FILE || "../data/knowledge.json", import.meta.url);
const CHAT_FILE = new URL("../data/chat-history.json", import.meta.url);
const LOG_FILE = new URL("../data/server-logs.json", import.meta.url);
const SETTINGS_FILE = new URL("../data/settings.json", import.meta.url);
const CACHE_FILE = new URL("../data/response-cache.json", import.meta.url);
const CONVERSATION_FILE = new URL("../data/conversation-memory.json", import.meta.url);
const NOT_VERIFIED = "I couldn't find verified information from the official university data.";
const ANSWER_ENGINE_VERSION = "2026-09-26-viva-hardening-v44";

async function loadLocalEnv() {
  try {
    const raw = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!process.env[key]) process.env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional.
  }
}

await loadLocalEnv();
await mkdir(DATA_DIR, { recursive: true });

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const officialSiteUrl = normalizeBaseUrl(process.env.OFFICIAL_SITE_URL || "https://gonouniversity.edu.bd/");
const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const openAiBaseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const openAiProviderName = process.env.OPENAI_PROVIDER_NAME || (openAiBaseUrl.includes("groq.com") ? "Groq" : openAiBaseUrl.includes("openrouter.ai") ? "OpenRouter" : "OpenAI");
const openAiModel = process.env.OPENAI_MODEL || (openAiProviderName === "Groq" ? "openai/gpt-oss-120b" : "gpt-4o-mini");
const maxRequestBytes = Number(process.env.MAX_REQUEST_BYTES || 36 * 1024 * 1024);
const maxAttachmentBytes = Number(process.env.MAX_ATTACHMENT_BYTES || 12 * 1024 * 1024);
const rateWindowMs = Number(process.env.RATE_WINDOW_MS || 60_000);
const rateLimit = Number(process.env.RATE_LIMIT || 60);
const responseCache = new Map();
const rateBuckets = new Map();
const attachmentSessions = new Map();
const conversationSessions = new Map();
const fileWriteQueues = new Map();
let imageCaptionerPromise = null;
let ollamaAvailability = { checkedAt: 0, available: false };

let knowledgeCache;
let knowledgeLoadPromise;
let retrievalIndexCache = { knowledge: null, records: [] };
let responseCacheLoadPromise;
let conversationMemoryLoadPromise;
let rebuildState = { running: false, startedAt: null, finishedAt: null, exitCode: null, message: "" };

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/?$/, "/");
  } catch {
    return "https://gonouniversity.edu.bd/";
  }
}

function envSecret(name) {
  const value = String(process.env[name] || "").trim();
  if (!value || /^your_|^change_this/i.test(value)) return "";
  return value;
}

const languagePatterns = [
  [/গণ\s*বিশ্ববিদ্যাল(?:য়|য়)(?:ের)?/g, " gono bishwabidyalay university "],
  [/প্রতিষ্ঠাতা/g, " founder "],
  [/প্রতিষ্ঠিত|প্রতিষ্ঠা/g, " established "],
  [/কবে/g, " when "],
  [/এবং/g, " and "],
  [/[কক]ি|কী/g, " ki "],
  [/কে/g, " ke "],
  [/কার/g, " kar "],
  [/কোথায়|কোথায়/g, " kothay "],
  [/কত/g, " koto "],
  [/নাম্বার|নম্বর/g, " number "],
  [/নাম/g, " name "],
  [/দাও|দেন|দেও|দে/g, " dao "],
  [/বলো|বলুন/g, " bolo "],
  [/আছে|আসে/g, " ache "],
  [/লেখা|লিখা|লিখেছে|লেখছে/g, " lekha "],
  [/পড়ে|পড়ো|পড়ুন|পড়ুন/g, " read "],
  [/ভর্তি/g, " vorti admission "],
  [/ফি|ফিস/g, " fee "],
  [/খরচ/g, " cost "],
  [/টাকা/g, " taka "],
  [/চেয়ারম্যান|চেয়ারম্যান|চেয়ারপারসন|চেয়ারপারসন/g, " chairman head "],
  [/প্রধান|হেড/g, " head "],
  [/ভিপি/g, " vp "],
  [/জিএস/g, " gs general secretary "],
  [/ভাইস[\s-]*প্রেসিডেন্ট/g, " vice president vp "],
  [/ভিসি|ভাইস[\s-]*চ্যান্সেলর/g, " vice chancellor vc "],
  [/বিভাগ|ডিপার্টমেন্ট/g, " department dept "],
  [/শিক্ষক|শিক্ষিকা|টিচার/g, " teacher faculty "],
  [/ফ্যাকাল্টি/g, " faculty "],
  [/ফোন|মোবাইল|কল/g, " phone mobile contact "],
  [/ইমেইল|মেইল/g, " email "],
  [/ছবি|ইমেজ|ফটো/g, " image photo chobi "],
  [/ফাইল/g, " file "],
  [/পিডিএফ/g, " pdf "],
  [/সারাংশ|সংক্ষেপ|সামারি/g, " summary "],
  [/এটা|এইটা|ওটা|ঐটা/g, " eta eita "],
  [/ফার্মেসি/g, " pharmacy "],
  [/সিএসই/g, " cse "],
];

const banglishPatterns = [
  [/\bmedial\s+physics\b/g, " medical physics "],
  [/\b(likha|likhae|likhse|likhsen|lekse|lekhse|lekhsen)\b/g, " lekha "],
  [/\b(ki\s+likha|ki\s+lekha|ki\s+lekse|ki\s+likhse)\b/g, " ki lekha "],
  [/\b(nam|naam)\b/g, " name "],
  [/\b(nambar|numberta|num|nmbr|nbr|nmb|mobile\s+number)\b/g, " number "],
  [/\b(daw|dau|dao|den|deyen)\b/g, " dao "],
  [/\b(ase|ache|asey|achhe)\b/g, " ache "],
  [/\b(vorti|vorty|bhorti|admissioner|admission-er)\b/g, " vorti admission "],
  [/\b(tution|tuition|tution-er|tuition-er|tutioner|tuitioner)\b/g, " tuition fee "],
  [/\b(khoroch|khroch|kharach|kharoch|khoroc)\b/g, " cost fee "],
  [/\b(tk|taka|poisa)\b/g, " taka "],
  [/\b(fe|fees|fee|feeta|feestructure)\b/g, " fee "],
  [/\b(chairmen|chairman|chairperson|hod|head)\b/g, " chairman head "],
  [/\b(dept|departmenter|department-er)\b/g, " department dept "],
  [/\b(chobi|pic|photo|image)\b/g, " image photo chobi "],
  [/\b(saransho|sarangsho|songkhep|summery)\b/g, " summary "],
  [/\b(pharma|farmacy)\b/g, " pharmacy "],
];

function normalizeQuestion(text) {
  let value = String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’‘]/g, "'");
  for (const [pattern, replacement] of languagePatterns) value = value.replace(pattern, replacement);
  for (const [pattern, replacement] of banglishPatterns) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, " ").trim();
}

function cleanOfficialDisplayText(text) {
  return String(text || "")
    .replace(/\bMicrobiololgy\b/gi, "Microbiology")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function securityHeaders(extra = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": process.env.CORS_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-token",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    ...extra,
  };
}

function json(res, status, body) {
  res.writeHead(status, securityHeaders());
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local").split(",")[0].trim();
}

function consumeRateBucket(key, limit) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { resetAt: now + rateWindowMs, count: 0 };
  if (now > bucket.resetAt) {
    bucket.resetAt = now + rateWindowMs;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count <= limit;
}

function rateLimitOk(req, sessionId = "") {
  const ip = clientIp(req);
  const publicIpOk = consumeRateBucket(`ip:${ip}`, rateLimit * 5);
  const sessionOk = sessionId ? consumeRateBucket(`session:${ip}:${sessionId}`, rateLimit) : true;
  return publicIpOk && sessionOk;
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomicUnsafe(url, value) {
  const targetPath = fileURLToPath(url);
  const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpPath, JSON.stringify(value, null, 2));
  try {
    await rename(tmpPath, targetPath);
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(error.code)) throw error;
    await copyFile(tmpPath, targetPath);
    await unlink(tmpPath).catch(() => {});
  }
}

function queueFileWrite(url, operation) {
  const key = fileURLToPath(url);
  const previous = fileWriteQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  fileWriteQueues.set(key, next);
  return next.finally(() => {
    if (fileWriteQueues.get(key) === next) fileWriteQueues.delete(key);
  });
}

async function writeJsonAtomic(url, value) {
  return queueFileWrite(url, () => writeJsonAtomicUnsafe(url, value));
}

async function appendJsonList(url, item, maxItems = 1000) {
  return queueFileWrite(url, async () => {
    const list = await readJson(url, []);
    list.push(item);
    await writeJsonAtomicUnsafe(url, list.slice(-maxItems));
  });
}

async function logServerEvent(item) {
  try {
    await appendJsonList(LOG_FILE, item);
  } catch (error) {
    console.error("Could not write server log:", error.message);
  }
}

function cleanConversationTurns(turns = []) {
  return turns
    .filter((item) => item && ["user", "assistant"].includes(item.role) && String(item.text || "").trim())
    .map((item) => ({ role: item.role, text: String(item.text).trim().slice(0, 6000) }));
}

function cleanConversationEntities(entities = {}) {
  const person = entities?.person;
  if (!person?.name) return {};
  return {
    person: {
      name: String(person.name).slice(0, 160),
      department: String(person.department || "").slice(0, 220),
      profileUrl: String(person.profileUrl || "").slice(0, 500),
    },
  };
}

function sameConversationTurn(a, b) {
  return a?.role === b?.role && normalizeQuestion(a?.text || "") === normalizeQuestion(b?.text || "");
}

function mergeConversationHistory(stored = [], incoming = [], limit = 120) {
  const earlier = cleanConversationTurns(stored);
  const recent = cleanConversationTurns(incoming);
  let overlap = 0;
  const maximum = Math.min(earlier.length, recent.length);
  for (let size = maximum; size > 0; size -= 1) {
    const tail = earlier.slice(-size);
    if (tail.every((turn, index) => sameConversationTurn(turn, recent[index]))) {
      overlap = size;
      break;
    }
  }
  const merged = [...earlier, ...recent.slice(overlap)];
  return merged.filter((turn, index) => index === 0 || !sameConversationTurn(turn, merged[index - 1])).slice(-limit);
}

async function loadConversationMemory() {
  if (conversationMemoryLoadPromise) return conversationMemoryLoadPromise;
  if (conversationSessions.size) return;
  conversationMemoryLoadPromise = (async () => {
    const saved = await readJson(CONVERSATION_FILE, []);
    for (const session of saved.slice(-100)) {
      if (!session?.sessionId) continue;
      conversationSessions.set(session.sessionId, {
        updatedAt: Number(session.updatedAt || Date.now()),
        turns: cleanConversationTurns(session.turns).slice(-120),
        entities: cleanConversationEntities(session.entities),
      });
    }
  })().finally(() => {
    conversationMemoryLoadPromise = null;
  });
  return conversationMemoryLoadPromise;
}

function conversationHistory(sessionId) {
  return conversationSessions.get(sessionId)?.turns || [];
}

function conversationEntity(sessionId, type) {
  return conversationSessions.get(sessionId)?.entities?.[type] || null;
}

function setConversationEntity(sessionId, type, entity) {
  if (!entity) return;
  const current = conversationSessions.get(sessionId) || { updatedAt: Date.now(), turns: [], entities: {} };
  const nextEntities = cleanConversationEntities({
    ...(current.entities || {}),
    [type]: entity,
  });
  conversationSessions.set(sessionId, { ...current, updatedAt: Date.now(), entities: nextEntities });
}

function rememberConversation(sessionId, turns) {
  const current = conversationSessions.get(sessionId);
  conversationSessions.set(sessionId, {
    updatedAt: Date.now(),
    turns: cleanConversationTurns(turns).slice(-120),
    entities: cleanConversationEntities(current?.entities),
  });
  const sessions = [...conversationSessions.entries()]
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
    .slice(-100)
    .map(([savedSessionId, value]) => ({ sessionId: savedSessionId, ...value }));
  writeJsonAtomic(CONVERSATION_FILE, sessions).catch((error) => {
    logServerEvent({ at: new Date().toISOString(), level: "warn", message: error.message, scope: "conversation_memory" });
  });
}

function rememberConversationExchange(sessionId, history, message, answer) {
  const turns = cleanConversationTurns(history);
  if (!sameConversationTurn(turns.at(-1), { role: "user", text: message })) turns.push({ role: "user", text: message });
  turns.push({ role: "assistant", text: answer });
  rememberConversation(sessionId, turns);
}

async function loadSettings() {
  const configuredAiProviders = [
    envSecret("GEMINI_API_KEY") ? "gemini" : "",
    envSecret("OPENAI_API_KEY") ? openAiProviderName.toLowerCase() : "",
    "ollama-or-retrieval",
  ].filter(Boolean);
  return {
    officialSiteUrl,
    maxPages: Number(process.env.MAX_PAGES || 2000),
    crawlConcurrency: Number(process.env.CRAWL_CONCURRENCY || 10),
    aiProvider: configuredAiProviders.join(" -> "),
    freeAiProviders: "Groq, Gemini, OpenRouter, or local Ollama through the server",
    ...((await readJson(SETTINGS_FILE, null)) || {}),
  };
}

async function isOllamaAvailable(force = false) {
  const now = Date.now();
  if (!force && now - ollamaAvailability.checkedAt < 30_000) return ollamaAvailability.available;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
    ollamaAvailability = { checkedAt: now, available: response.ok };
    return response.ok;
  } catch {
    ollamaAvailability = { checkedAt: now, available: false };
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadKnowledge(force = false) {
  if (knowledgeCache && !force) return knowledgeCache;
  if (knowledgeLoadPromise && !force) return knowledgeLoadPromise;
  const loadPromise = (async () => {
    const raw = await readFile(KNOWLEDGE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    parsed.pages = Array.isArray(parsed.pages) ? parsed.pages : [];
    parsed.faculty = Array.isArray(parsed.faculty) ? parsed.faculty : [];
    parsed.roles = Array.isArray(parsed.roles) ? parsed.roles : [];
    parsed.fees = Array.isArray(parsed.fees) ? parsed.fees : [];
    parsed.programs = Array.isArray(parsed.programs) ? parsed.programs : [];
    parsed.contacts = Array.isArray(parsed.contacts) ? parsed.contacts : [];
    parsed.notices = Array.isArray(parsed.notices) ? parsed.notices : [];
    parsed.documents = Array.isArray(parsed.documents) ? parsed.documents : [];
    knowledgeCache = parsed;
    retrievalIndexCache = { knowledge: null, records: [] };
    return knowledgeCache;
  })();
  knowledgeLoadPromise = loadPromise;
  try {
    return await loadPromise;
  } finally {
    if (knowledgeLoadPromise === loadPromise) knowledgeLoadPromise = null;
  }
}

function cleanExtractedText(text) {
  return (text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxRequestBytes) {
        const error = new Error("Request body is too large. Upload a smaller image/PDF.");
        error.status = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

function attachmentBuffer(attachment) {
  if (!attachment?.data || typeof attachment.data !== "string") return null;
  const base64 = attachment.data.includes(",") ? attachment.data.split(",").pop() : attachment.data;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > maxAttachmentBytes) return null;
  return buffer;
}

function attachmentBase64(attachment) {
  if (!attachment?.data || typeof attachment.data !== "string") return "";
  return attachment.data.includes(",") ? attachment.data.split(",").pop() : attachment.data;
}

async function extractPdfText(buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ first: 30 });
    return cleanExtractedText(result.text);
  } finally {
    await parser.destroy();
  }
}

async function extractImageText(buffer) {
  const { createWorker } = await import("tesseract.js");
  const preferredLangs = process.env.OCR_LANGS || "eng+ben";
  const languages = preferredLangs === "eng" ? ["eng"] : [preferredLangs, "eng"];
  let lastError;
  for (const language of languages) {
    let worker;
    try {
      worker = await createWorker(language);
      const result = await worker.recognize(buffer);
      return cleanExtractedText(result.data?.text || "");
    } catch (error) {
      lastError = error;
    } finally {
      await worker?.terminate();
    }
  }
  throw lastError || new Error("OCR failed");
}

async function getImageCaptioner() {
  if (!imageCaptionerPromise) {
    imageCaptionerPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = process.env.TRANSFORMERS_CACHE || "./data/model-cache";
      return pipeline("image-to-text", process.env.IMAGE_CAPTION_MODEL || "Xenova/vit-gpt2-image-captioning");
    })();
  }
  return imageCaptionerPromise;
}

async function captionImage(buffer, mimeType = "image/png") {
  const { RawImage } = await import("@huggingface/transformers");
  const image = await RawImage.fromBlob(new Blob([buffer], { type: mimeType || "image/png" }));
  const captioner = await getImageCaptioner();
  const output = await captioner(image, { max_new_tokens: 28 });
  return cleanExtractedText(Array.isArray(output) ? output[0]?.generated_text : output?.generated_text);
}

async function extractImageUnderstanding(buffer, mimeType) {
  const [ocrResult, captionResult] = await Promise.allSettled([extractImageText(buffer), captionImage(buffer, mimeType)]);
  return {
    text: ocrResult.status === "fulfilled" ? ocrResult.value : "",
    visualCaption: captionResult.status === "fulfilled" ? captionResult.value : "",
    error:
      ocrResult.status === "rejected" && captionResult.status === "rejected"
        ? `OCR failed: ${ocrResult.reason?.message || ocrResult.reason}; caption failed: ${captionResult.reason?.message || captionResult.reason}`
        : "",
  };
}

async function extractAttachmentText(attachment) {
  const buffer = attachmentBuffer(attachment);
  const mimeType = String(attachment?.mimeType || "").toLowerCase();
  const name = String(attachment?.name || "attachment");
  if (!buffer) return { title: name, url: "", text: "", error: "File is empty or too large." };

  try {
    if (mimeType === "application/pdf" || /\.pdf$/i.test(name)) return { title: name, url: "", text: await extractPdfText(buffer) };
    if (mimeType.startsWith("image/")) {
      const image = await extractImageUnderstanding(buffer, mimeType);
      return { title: name, url: "", text: image.text, visualCaption: image.visualCaption, error: image.error, mimeType, data: attachmentBase64(attachment) };
    }
    if (mimeType.startsWith("text/") || /\.(txt|md|csv)$/i.test(name)) {
      return { title: name, url: "", text: cleanExtractedText(buffer.toString("utf8")) };
    }
    return { title: name, url: "", text: "", error: "Unsupported file type." };
  } catch (error) {
    return { title: name, url: "", text: "", error: error.message };
  }
}

async function extractAttachments(attachments = []) {
  const safeAttachments = Array.isArray(attachments) ? attachments.slice(0, 3) : [];
  return Promise.all(safeAttachments.map((attachment) => extractAttachmentText(attachment)));
}

function pruneAttachmentSessions() {
  const expiresBefore = Date.now() - Number(process.env.ATTACHMENT_SESSION_TTL_MS || 2 * 60 * 60 * 1000);
  for (const [key, value] of attachmentSessions.entries()) {
    if ((value.updatedAt || 0) < expiresBefore) attachmentSessions.delete(key);
  }
}

function rememberSessionAttachments(sessionId, attachments) {
  const readable = attachments.filter((attachment) => attachment.text || attachment.visualCaption || attachment.error);
  if (!readable.length) return;
  pruneAttachmentSessions();
  const current = attachmentSessions.get(sessionId)?.items || [];
  const next = [...readable, ...current]
    .filter((item) => item.text || item.visualCaption || item.error)
    .slice(0, 6)
    .map((item) => ({
      ...item,
      data: undefined,
      text: item.text ? item.text.slice(0, Number(process.env.MAX_ATTACHMENT_TEXT_CHARS || 30_000)) : "",
    }));
  attachmentSessions.set(sessionId, { updatedAt: Date.now(), items: next });
}

function sessionAttachments(sessionId) {
  pruneAttachmentSessions();
  return attachmentSessions.get(sessionId)?.items || [];
}

function tokenize(text) {
  return normalizeQuestion(text)
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

const searchStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "er",
  "for",
  "from",
  "give",
  "hello",
  "hey",
  "hi",
  "how",
  "is",
  "dao",
  "dau",
  "bolo",
  "ache",
  "ki",
  "ke",
  "kar",
  "kothay",
  "nam",
  "naam",
  "name",
  "of",
  "please",
  "r",
  "the",
  "there",
  "to",
  "what",
  "who",
  "yes",
  "salam",
  "eta",
  "eita",
  "oita",
  "ta",
]);

const synonyms = new Map([
  ["cost", ["fee", "fees", "tuition", "tution", "payment", "charge", "khoroch", "taka"]],
  ["fee", ["cost", "fees", "tuition", "tution", "payment", "charge", "khoroch", "taka"]],
  ["tuition", ["fee", "fees", "cost", "tution", "payment", "charge", "khoroch", "taka"]],
  ["tution", ["fee", "fees", "cost", "tuition", "payment", "charge", "khoroch", "taka"]],
  ["vorti", ["admission", "apply", "enrollment"]],
  ["admit", ["admission", "apply"]],
  ["teacher", ["faculty", "lecturer", "professor"]],
  ["teachers", ["faculty", "lecturer", "professor"]],
  ["faculty", ["teacher", "lecturer", "professor"]],
  ["dept", ["department", "faculty"]],
  ["department", ["dept"]],
  ["phone", ["mobile", "contact", "number", "cell"]],
  ["number", ["phone", "mobile", "contact"]],
  ["chairman", ["head", "chairperson", "hod"]],
  ["head", ["chairman", "chairperson", "hod"]],
  ["routine", ["schedule", "calendar"]],
  ["notice", ["news", "announcement"]],
  ["eligibility", ["admission", "requirement", "qualification"]],
  ["requirement", ["eligibility", "qualification", "admission"]],
  ["seat", ["capacity", "intake"]],
  ["seats", ["capacity", "intake"]],
  ["lekha", ["text", "written", "read", "ocr"]],
  ["summary", ["summarize", "brief", "saransho"]],
]);

function expandedTerms(text) {
  const terms = tokenize(text).filter((term) => !searchStopWords.has(term));
  const expanded = new Set(terms);
  for (const term of terms) {
    for (const synonym of synonyms.get(term) || []) expanded.add(synonym);
  }
  return [...expanded];
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function hasSingleAdjacentTransposition(a, b) {
  if (a.length !== b.length) return false;
  const diffs = [];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) diffs.push(index);
    if (diffs.length > 2) return false;
  }
  return diffs.length === 2 && diffs[1] === diffs[0] + 1 && a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]];
}

function fuzzyIncludes(tokens, term) {
  return tokens.some((token) => {
    if (token === term) return true;
    if (
      token.length >= 4 &&
      term.length >= 4 &&
      (token.startsWith(term) ||
        term.startsWith(token) ||
        (token.includes(term) && Math.abs(token.length - term.length) <= 2) ||
        (term.includes(token) && Math.abs(token.length - term.length) <= 2))
    ) {
      return true;
    }
    if (term.length < 5 || token[0] !== term[0]) return false;
    return editDistance(token, term) <= 1 || hasSingleAdjacentTransposition(token, term);
  });
}

function vectorize(text) {
  const weights = new Map();
  for (const token of tokenize(text)) {
    if (searchStopWords.has(token)) continue;
    weights.set(token, (weights.get(token) || 0) + 1);
    for (const synonym of synonyms.get(token) || []) weights.set(synonym, (weights.get(synonym) || 0) + 0.5);
  }
  return weights;
}

function cosine(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const value of a.values()) aNorm += value * value;
  for (const value of b.values()) bNorm += value * value;
  for (const [key, value] of a.entries()) dot += value * (b.get(key) || 0);
  return aNorm && bNorm ? dot / Math.sqrt(aNorm * bNorm) : 0;
}

function scoreAliasMatch(question, alias) {
  const q = normalizeQuestion(question).replace(/[._\-?!,।:;'"()]/g, " ").replace(/\s+/g, " ").trim();
  const a = normalizeQuestion(alias).replace(/[._\-?!,।:;'"()]/g, " ").replace(/\s+/g, " ").trim();
  if (!a) return 0;
  if (new RegExp(`(?:^|\\s)${a.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:\\s|$)`, "i").test(q)) return 100 + a.length;
  if (new RegExp(`\\b${a.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i").test(q)) return 100 + a.length;
  const qTerms = tokenize(q);
  return tokenize(a).reduce((score, term) => Math.max(score, fuzzyIncludes(qTerms, term) ? 12 : 0), 0);
}

function prefersBanglish(text) {
  const q = normalizeQuestion(text);
  return (
    /[\u0980-\u09ff]/.test(String(text || "")) ||
    /\b(ki|ke|kivabe|pabo|lagbe|shuru|hobe|korbo|konta|kontar|porbo|kothay|somporke|chino|cheno|chine|jano|bolo|dao|ache|ase|kono|koto|koyjon|kojon|koyta|er|r|ta|te|vorti|hoy|hoi|kina|kemon|keno|kobe|bhalo|shob|sob|naki|ba|tarpor|porle|jani|janan|bolun|dekhun)\b/i.test(q)
  );
}

function notVerifiedText(question) {
  const q = normalizeQuestion(question);
  if (asksFeeDetail(q)) {
    return prefersBanglish(question)
      ? "Ei fee-ta nishchit korar moto nirvorjoggo tothyo ekhon amar kache nei. Program ar intake/session bolle ami aro specific vabe khuje dekhbo."
      : "I do not currently have a reliable source for that fee. Tell me the program and intake/session and I will narrow the answer down.";
  }
  if (asksProgramDetail(q)) {
    return prefersBanglish(question)
      ? "Ei course/credit-er nishchit tothyo ekhon amar kache nei. Program, syllabus, ba session-ta bolle ami specific vabe check korbo."
      : "I do not currently have a reliable source for that course or credit detail. Tell me the program, syllabus, or session and I will check more specifically.";
  }
  return prefersBanglish(question)
    ? "Ei proshner nishchit tothyo ekhon amar kache nei. Aro ektu context dile ami bhalo vabe uttor dite ba thik source khujte parbo."
    : "I do not have enough reliable information to answer that confidently yet. Add a little context and I can answer more precisely or find the right source.";
}

function rankedProgramFees(question, fees = []) {
  return fees
    .map((fee) => {
      const aliases = [fee.program, ...(fee.aliases || [])];
      return { fee, score: Math.max(...aliases.map((alias) => scoreAliasMatch(question, alias))) };
    })
    .filter((item) => item.score >= 30)
    .sort((a, b) => b.score - a.score);
}

function isGraduateProgramName(name) {
  const compact = normalizeQuestion(name || "").replace(/[^a-z0-9]/g, "");
  return /^(msc|mpharm|ma|mss|llm|master)/i.test(compact);
}

function verifiedPrograms(programs = []) {
  const cleaned = programs
    .map((program) => {
      if (/^LLM$/i.test(program.name || "") && !program.department) {
        return { ...program, department: "Department of Law", aliases: [...(program.aliases || []), "Master of Laws"] };
      }
      return program;
    })
    .filter((program) => {
      const name = cleanOfficialDisplayText(program.name || "");
      if (!program.department || name.length < 3 || /^\d+(?:st|nd|rd|th)?$/i.test(name)) return false;
      if (/^B\.Sc\.\s*\(Hon.?s\)$/i.test(name) || /^MS\s*\(Master.?s\)$/i.test(name)) return false;
      if (program.duration && !/years?|semesters?|internship/i.test(program.duration)) return false;
      return true;
    });

  const byDepartmentAndLevel = new Map();
  for (const program of cleaned) {
    const level = isGraduateProgramName(program.name) ? "graduate" : "undergraduate";
    const key = `${displayDepartmentName(program.department).toLowerCase()}:${level}`;
    const current = byDepartmentAndLevel.get(key);
    const score = (item) =>
      Number(Boolean(item.admissionRequirement)) * 4 +
      Number(Boolean(item.duration)) * 3 +
      Number(Boolean(item.seats)) * 2 +
      Number(/admission requirements/i.test(item.sourceTitle || "")) * 4;
    if (!current || score(program) > score(current)) byDepartmentAndLevel.set(key, program);
  }
  return [...byDepartmentAndLevel.values()];
}

function directFeeAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  if (!asksFeeDetail(q)) return null;
  const directlyMentionsDept = matchedDepartmentFromQuestion(q, knowledge);
  const activeDept = directlyMentionsDept || activeContextDepartment(history, question, knowledge);
  const isTargetedFeeFollowup = !directlyMentionsDept && activeDept && (
    q.split(/\s+/).length <= 5 ||
    /\b(er|tar|oitar|eitar|its|that|this|department|dept|program)\b/i.test(q)
  );
  const targetFeeDept = directlyMentionsDept || (isTargetedFeeFollowup ? activeDept : null);
  const searchSubject = targetFeeDept ? `${targetFeeDept} ${q}` : q;
  const ranked = rankedProgramFees(searchSubject, knowledge.fees || []);
  const banglish = prefersBanglish(question);

  if (ranked.length) {
    const bestScore = ranked[0].score;
    const matchedFees = ranked.filter((item) => item.score === bestScore).map((item) => item.fee);

    const formatFeeItem = (fee) => {
      const isCse = /\bcse|computer\s+science\b/i.test(`${fee.program} ${(fee.aliases || []).join(" ")}`);
      const isPharmacy = /\bpharmacy|bpharm|mpharm\b/i.test(`${fee.program} ${(fee.aliases || []).join(" ")}`);

      if (isCse) {
        return banglish
          ? `**${fee.program}**-এর টিউশন ফি:\n- **মোট টিউশন ফি (৪ বছর / ৮ সেমিস্টার):** **Tk. 4,50,000/-**\n- **ভর্তিকালীন প্রারম্ভিক খরচ:** **BDT 54,500** (ভর্তি ফি ও ১ম সেমিস্টার অন্তর্ভুক্ত)।`
          : `**${fee.program}** Tuition Fee:\n- **Total Program Fee (4 Years / 8 Semesters):** **Tk. 4,50,000/-**\n- **Initial Admission Payment:** **BDT 54,500** (includes admission fee and 1st semester tuition).`;
      }

      if (isPharmacy) {
        return banglish
          ? `**${fee.program}**-এর মোট কোর্স ফি **${fee.admissionCost}** (৪ বছর / ৮ সেমিস্টার)। ভর্তিকালীন প্রারম্ভিক খরচ **BDT 54,500**।`
          : `**${fee.program}** total course fee is **${fee.admissionCost}** (4 years / 8 semesters). Initial admission payment is **BDT 54,500**.`;
      }

      const includeText = fee.admissionCostIncludes ? ` (${fee.admissionCostIncludes})` : "";
      const feeType = /total tuition/i.test(`${fee.note || ""} ${fee.sourceTitle || ""}`) ? "Total tuition fee" : "Published fee / admission cost";
      return `**${fee.program}** - ${feeType}: **${fee.admissionCost}**${includeText}`;
    };

    const text =
      matchedFees.length > 1
        ? (banglish ? "Official page-e matching program-er fee:\n\n" : "Official published program fees:\n\n") +
          matchedFees.map(formatFeeItem).join("\n\n")
        : formatFeeItem(matchedFees[0]);

    return {
      text,
      sources: matchedFees
        .map((fee) => ({ title: fee.sourceTitle || "Tuition and Other Fees - Gono Bishwabidyalay", url: fee.source }))
        .filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index),
      mode: "structured",
    };
  }

  // If a department is identified in question or from history but its specific total tuition package is not indexed:
  const matchedDept = targetFeeDept;
  if (matchedDept && (knowledge.fees || []).length > 0) {
    const deptName = displayDepartmentName(matchedDept);
    return {
      text: banglish
        ? `**${deptName}**-এর নির্দিষ্ট মোট ৪ বছরের টিউশন প্যাকেজ ফি ওয়েবসাইটে আলাদাভাবে প্রকাশিত নেই।\n- **ভর্তিকালীন প্রারম্ভিক খরচ:** আন্ডারগ্র্যাজুয়েট প্রোগ্রামে সাধারণত **BDT 54,500** (ভর্তি ফি ও ১ম সেমিস্টার টিউশন অন্তর্ভুক্ত)।\n- **ওয়েভার ও স্কলারশিপ:** সেমিস্টার ফলাফলের ভিত্তিতে ১০% থেকে ৫০% পর্যন্ত টিউশন ফি ওয়েভার পাওয়া যায়।\n- বর্তমান সেশনের আপডেটেড পূর্ণাঙ্গ ফি জানতে ভর্তি অফিসে সরাসরি যোগাযোগ করুন: **01950003314**, **01950003319** বা ইমেইল: **admin@gonouniversity.edu.bd**।`
        : `For **${deptName}**, the full 4-year total tuition package is not separately itemized online.\n- **Initial Admission-Time Payment:** Typically **BDT 54,500** (covers admission fee and first semester tuition).\n- **Tuition Fee Waiver:** Up to 50% tuition waiver available based on semester GPA results.\n- For the exact current session fee breakdown, please contact the Admission Office: **01950003314**, **01950003319** or email **admin@gonouniversity.edu.bd**.`,
      sources: [
        {
          title: "Tuition and Other Fees - Gono Bishwabidyalay",
          url: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/",
        },
      ],
      mode: "structured",
    };
  }

  // If general fee inquiry (e.g. "what is the tuition fee", "fee koto", "admission fee"):
  if ((knowledge.fees || []).length > 0 && (/\b(?:what\s+is|bolo|dao|koto|how\s+much|list|show|all)\b/i.test(q) || q.split(/\s+/).length <= 4)) {
    return {
      text: banglish
        ? `Gono Bishwabidyalay-এর প্রধান প্রোগ্রামগুলোর মোট ফি:\n- **B.Sc. in CSE:** Tk. 4,50,000/- (৪ বছর / ৮ সেমিস্টার)\n- **Bachelor of Pharmacy (B.Pharm):** Tk. 6,00,000/-\n- **Master of Pharmacy (M.Pharm):** Tk. 1,20,000/-\n- **BBA:** Tk. 2,80,000/- থেকে 3,50,000/-\n- ভর্তিকালীন প্রারম্ভিক খরচ: **BDT 54,500**। হেল্পলাইন: **01950003314**।`
        : `Gono Bishwabidyalay published program fees:\n- **B.Sc. in CSE:** Tk. 4,50,000/- (4 years / 8 semesters)\n- **Bachelor of Pharmacy (B.Pharm):** Tk. 6,00,000/-\n- **Master of Pharmacy (M.Pharm):** Tk. 1,20,000/-\n- **BBA:** Tk. 2,80,000/- to 3,50,000/-\n- Initial admission payment: **BDT 54,500**. Helpline: **01950003314**.`,
      sources: [
        {
          title: "Tuition and Other Fees - Gono Bishwabidyalay",
          url: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/",
        },
      ],
      mode: "structured",
    };
  }

  return null;
}

function rankedPrograms(question, programs = []) {
  const q = normalizeQuestion(question);
  const asksMasters = /\b(?:msc|m\s*\.?\s*sc|mpharm|m\s*\.?\s*pharm|ma|mss|llm|master)\b/i.test(q);
  const asksBachelors = /\b(?:bsc|b\s*\.?\s*sc|bpharm|b\s*\.?\s*pharm|ba|bba|llb|bachelor|honours|honors)\b/i.test(q);
  return verifiedPrograms(programs)
    .map((program) => {
      const aliases = [
        program.name,
        program.department,
        String(program.department || "").replace(/^(?:Department|Faculty) of\s+/i, ""),
        ...(program.aliases || []),
      ].filter(Boolean);
      const name = normalizeQuestion(program.name || "");
      const isMasters = isGraduateProgramName(name);
      const isBachelors = /\b(?:b\s*\.?\s*sc|b\s*\.?\s*pharm|ba|bba|llb|bachelor|honours|honors)\b/i.test(name);
      let score = Math.max(...aliases.map((alias) => scoreAliasMatch(question, alias)));
      if (asksMasters) score += isMasters ? 50 : isBachelors ? -40 : 0;
      if (asksBachelors) score += isBachelors ? 50 : isMasters ? -40 : 0;
      return { program, score };
    })
    .filter((item) => item.score >= 30)
    .sort((a, b) => b.score - a.score || b.program.name.length - a.program.name.length);
}

function directProgramAdmissionAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksRequirement = /\b(admission|apply|eligibility|eligible|required|requirement|qualification|gpa|ssc|hsc|vorti)\b/i.test(q);
  const asksDuration = /\b(duration|year|years|semester|semesters|koto\s+bochor)\b/i.test(q);
  const asksSeats = /\b(seat|seats|capacity|intake|koyjon|kojon)\b/i.test(q);
  if (!asksRequirement && !asksDuration && !asksSeats) return null;
  const ranked = rankedPrograms(q, knowledge.programs || []);
  if (!ranked.length) return null;
  const bestScore = ranked[0].score;
  const matches = ranked.filter((item) => item.score === bestScore).slice(0, 4).map((item) => item.program);
  if (matches.length > 1) {
    return {
      text: prefersBanglish(question)
        ? `Kon program-ta bujhaccho? Official data-te matching option: ${matches.map((program) => `**${program.name}**`).join(", ")}.`
        : `Which program do you mean? Matching official programs are ${matches.map((program) => `**${program.name}**`).join(", ")}.`,
      sources: matches
        .map((program) => ({ title: program.sourceTitle || program.name, url: program.source }))
        .filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index),
      mode: "clarify",
    };
  }

  const program = matches[0];
  const lines = [];
  if (asksRequirement && program.admissionRequirement) {
    lines.push(`**Admission requirement:** ${cleanOfficialDisplayText(program.admissionRequirement)}`);
  }
  if (asksDuration && program.duration) lines.push(`**Duration:** ${cleanOfficialDisplayText(program.duration)}`);
  if (asksSeats && program.seats) lines.push(`**Seats:** ${cleanOfficialDisplayText(program.seats)}`);
  if (!lines.length) return null;
  return {
    text: `**${program.name}**\n${lines.join("\n")}`,
    sources: [{ title: program.sourceTitle || "Official admission requirements", url: program.source }],
    mode: "structured",
  };
}

function directOfficeContactAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  if (!asksContactDetail(q)) return null;
  const subjectTerms = expandedTerms(q).filter(
    (term) => !["phone", "mobile", "contact", "number", "cell", "call", "email", "mail", "office", "dao", "dau"].includes(term),
  );
  if (!subjectTerms.length) return null;
  const ranked = (knowledge.contacts || [])
    .map((contact) => {
      const haystack = normalizeQuestion(
        `${contact.label || ""} ${contact.title || ""} ${contact.department || ""} ${(contact.phones || []).join(" ")} ${(contact.emails || []).join(" ")} Gono University`,
      );
      let score = 0;
      for (const term of subjectTerms) {
        if (termInQuestion(haystack, term)) score += 25 + term.length;
        else if (fuzzyIncludes(tokenize(haystack), term)) score += 8;
      }
      const normalizedLabel = normalizeQuestion(contact.label || "");
      if (normalizedLabel && termInQuestion(q, normalizedLabel)) score += 100;
      return { contact, score };
    })
    .filter((item) => item.score >= 20)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const bestScore = ranked[0].score;
  const matches = ranked.filter((item) => item.score === bestScore).slice(0, 3).map((item) => item.contact);
  const asksEmail = /\b(email|mail)\b/i.test(q);
  const asksPhone = /\b(phone|mobile|number|cell|call)\b/i.test(q);
  const lines = matches
    .map((contact) => {
      const details = [];
      const matchingEmails = (contact.emails || []).filter((email) =>
        subjectTerms.some((term) => normalizeQuestion(email).includes(term)),
      );
      if (asksEmail) {
        const emails = matchingEmails.length ? matchingEmails : contact.emails || [];
        if (emails.length) details.push(`Email: **${emails.join(", ")}**`);
      } else if (asksPhone) {
        if (contact.phones?.length) details.push(`Phone: **${contact.phones.join(", ")}**`);
      } else {
        if (contact.phones?.length) details.push(`Phone: **${contact.phones.join(", ")}**`);
        if (contact.emails?.length) details.push(`Email: **${contact.emails.join(", ")}**`);
      }
      return details.length ? `**${contact.label || contact.title}**: ${details.join(", ")}` : "";
    })
    .filter((line, index, list) => line && list.indexOf(line) === index);
  if (!lines.length) return null;
  return {
    text: lines.join("\n"),
    sources: matches
      .map((contact) => ({ title: contact.title || contact.label, url: contact.source }))
      .filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index),
    mode: "structured",
  };
}

function directNoticeAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  if (!/\b(notice|notices|routine|result|schedule)\b/i.test(q) && !/নোটিশ|বিজ্ঞপ্তি/u.test(question)) return null;
  const asksList =
    /\b(latest|recent|new|newest|current|today|notice\s+list|notices|show\s+notice|ki\s+notice|notice\s+ki)\b/i.test(q) ||
    /সর্বশেষ|নতুন|নোটিশ|বিজ্ঞপ্তি/u.test(question);
  if (!asksList) return null;
  const categoryPattern = /\b(exam|admission|job|tender|result|routine|schedule)\b/i;
  const requestedCategory = q.match(categoryPattern)?.[1] || "";
  let matching = [...(knowledge.notices || [])];
  const department = matchedDepartmentFromQuestion(q, knowledge);
  if (department) {
    const aliases = departmentAliases(department);
    matching = matching.filter((notice) => aliases.some((alias) =>
      termInQuestion(`${notice.department || ""} ${notice.title} ${notice.source}`, alias),
    ));
  }
  if (requestedCategory) {
    const categoryTerms = requestedCategory === "admission" ? /\b(admission|admissions|admit|ভর্তি)\b/i : new RegExp(`\\b${requestedCategory}\\b`, "i");
    matching = matching.filter((notice) =>
      categoryTerms.test(`${notice.category || ""} ${notice.title || ""} ${notice.summary || ""}`),
    );
  }
  matching.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  const selected = matching.slice(0, 5);
  if (!selected.length) return {
    text: prefersBanglish(question)
      ? "Indexed official data-te matching dated notice paini. University-r notice page check koro; ekhane latest notice confirm korte parchi na."
      : "I could not find a matching dated notice in the indexed data. Check the official notice page for the latest update.",
    sources: [{ title: "Official notices", url: `${officialSiteUrl}category/notice/` }],
    mode: "not_found",
  };
  const lines = selected.map((notice) => {
    const parsed = Date.parse(notice.publishedAt || "");
    const date = Number.isNaN(parsed) ? "Date not listed" : new Date(parsed).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    return `- **${date}:** ${notice.title}`;
  });
  return {
    text: prefersBanglish(question) ? `Indexed official sources-er shobcheye recent matching notices:\n${lines.join("\n")}` : `Most recent matching notices in the indexed official sources:\n${lines.join("\n")}`,
    sources: selected.map((notice) => ({ title: notice.title, url: notice.source })),
    mode: "structured",
  };
}

const roleAliases = [
  { key: "student_union_vice_president", terms: ["vp", "vice president", "vice-president"], scope: "student_union" },
  { key: "student_union_general_secretary", terms: ["gs", "general secretary"], scope: "student_union" },
  { key: "student_union_joint_general_secretary", terms: ["jgs", "joint general secretary", "assistant general secretary", "ags"], scope: "student_union" },
  { key: "student_union_treasurer", terms: ["treasurer"], scope: "student_union" },
  { key: "vice_chancellor", terms: ["vc", "v c", "vice chancellor", "vice-chancellor"], scope: "institution" },
  { key: "pro_vice_chancellor", terms: ["pro vc", "pro-vc", "pro vice chancellor", "pro-vice-chancellor"], scope: "institution" },
  { key: "registrar", terms: ["registrar"], scope: "institution" },
  { key: "treasurer", terms: ["treasurer"], scope: "institution" },
];

function termInQuestion(question, term) {
  const normalizedQuestion = normalizeQuestion(question).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const normalizedTerm = normalizeQuestion(term).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!normalizedTerm) return false;
  if (normalizedTerm.includes(" ")) return normalizedQuestion.includes(normalizedTerm);
  return new RegExp(`(^|\\s)${normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i").test(normalizedQuestion);
}

function directRoleAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksStudentUnion = /student\s*(?:'s\s*)?union|central\s+student|gaksu|গাকসু|\bunion\b/i.test(q);
  const keys = new Set();
  for (const alias of roleAliases) {
    if (alias.scope === "student_union" && !asksStudentUnion && alias.key !== "student_union_vice_president" && !/\b(vp|gs|jgs|ags)\b/i.test(q)) continue;
    if (alias.scope === "institution" && asksStudentUnion) continue;
    let roleQuery = q;
    if (alias.key === "vice_chancellor") roleQuery = roleQuery.replace(/\bpro[\s-]*(?:vice[\s-]*chancellor|vc|v\s+c)\b/gi, " ");
    if (alias.key === "student_union_general_secretary") roleQuery = roleQuery.replace(/\b(?:joint|assistant)\s+general\s+secretary\b/gi, " ");
    if (alias.terms.some((term) => termInQuestion(roleQuery, term))) keys.add(alias.key);
  }
  if (!keys.size) return null;
  const matchedRoles = knowledge.roles.filter((role) => keys.has(role.key));
  if (!matchedRoles.length) {
    const labels = {
      vice_chancellor: "Vice-Chancellor",
      pro_vice_chancellor: "Pro-Vice-Chancellor",
      registrar: "Registrar",
      treasurer: "Treasurer",
      student_union_vice_president: "student union Vice President",
      student_union_general_secretary: "student union General Secretary",
      student_union_joint_general_secretary: "student union Joint General Secretary",
      student_union_treasurer: "student union Treasurer",
    };
    const requested = [...keys].map((key) => labels[key] || key).join(" / ");
    return {
      text: prefersBanglish(question)
        ? `Current indexed official pages-e **${requested}**-er verified name listed nei. Position-ti vacant kina ba page update hoyni kina ami confirm korte parchi na, tai kono name guess korbo na.`
        : `The current indexed official pages do not list a verified name for the **${requested}**. I cannot confirm whether the position is vacant or the page is awaiting an update, so I will not guess a name.`,
      sources: [{ title: "University offices", url: `${officialSiteUrl}offices/` }],
      mode: "not_found",
    };
  }
  const asksPhone =
    /\b(phone|mobile|cell|call)\b/i.test(q) ||
    (/\bnumber\b/i.test(q) && !/\b(room|class|seat|serial)\s+number\b/i.test(q));
  const asksEmail = /\b(email|mail)\b/i.test(q);
  const asksGeneralContact = /\bcontact\b/i.test(q) && !asksPhone && !asksEmail;
  const lines = matchedRoles.map((role) => {
    if (asksPhone) return `**${role.name}**: ${role.phone ? `**${role.phone}**` : "phone number not listed in official data"}`;
    if (asksEmail) return `**${role.name}**: ${role.email ? `**${role.email}**` : "email not listed in official data"}`;
    if (asksGeneralContact) {
      const parts = [];
      if (role.phone) parts.push(`Phone: **${role.phone}**`);
      if (role.email) parts.push(`Email: **${role.email}**`);
      return `**${role.name}**: ${parts.length ? parts.join(", ") : "contact information not listed in official data"}`;
    }
    const groupText = role.group && !/^(offices?|administration)$/i.test(role.group) ? ` (${role.group})` : "";
    return prefersBanglish(question)
      ? `${role.title}${groupText}-er name **${role.name}**.`
      : `The ${role.title}${groupText} is **${role.name}**.`;
  });
  return {
    text: lines.join("\n"),
    sources: matchedRoles.map((role) => ({ title: role.sourceTitle || role.title, url: role.source })),
    mode: "structured",
  };
}

function personIdentityLine(question, person) {
  const designation = person.designation || "member";
  const department = displayDepartmentName(person.department || "Gono University");
  const name = cleanPersonName(person.name);
  return prefersBanglish(question)
    ? `Haan, **${name}** ${department}-er **${designation}**.`
    : `Yes, **${name}** is **${designation}** in ${department}.`;
}

function cleanPersonName(name) {
  return String(name || "")
    .replace(/^(?:GONO\s+BISHWABIDYALAY\s+)?Profile\s+/i, "")
    .replace(/^GONO\s+BISHWABIDYALAY\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalPersonKey(person) {
  const name = normalizeQuestion(cleanPersonName(person?.name)).replace(/[^\p{L}\p{N}]/gu, "");
  const department = normalizeQuestion(displayDepartmentName(person?.department || "")).replace(/[^\p{L}\p{N}]/gu, "");
  return `${name}:${department}`;
}

function personRecordScore(person) {
  return (
    (person.phone ? 4 : 0) +
    (person.email ? 4 : 0) +
    (person.qualification ? 2 : 0) +
    (/\/employees\//i.test(person.profileUrl || "") ? 3 : 0) +
    (person.profileUrl ? 1 : 0)
  );
}

function dedupePeople(people = []) {
  const records = new Map();
  for (const rawPerson of people) {
    const person = {
      ...rawPerson,
      name: cleanPersonName(rawPerson.name),
      department: displayDepartmentName(rawPerson.department || ""),
    };
    const key = canonicalPersonKey(person);
    if (!person.name || !key) continue;
    const current = records.get(key);
    if (!current) {
      records.set(key, person);
      continue;
    }
    const preferred = personRecordScore(person) > personRecordScore(current) ? person : current;
    const other = preferred === person ? current : person;
    records.set(key, {
      ...other,
      ...preferred,
      phone: preferred.phone || other.phone || "",
      email: preferred.email || other.email || "",
      qualification: preferred.qualification || other.qualification || "",
      profileUrl: preferred.profileUrl || other.profileUrl || preferred.source || other.source || "",
    });
  }
  return [...records.values()];
}

function findPeople(question, people = [], knowledge = null) {
  const ignored = new Set([
    ...searchStopWords,
    "sir",
    "mam",
    "maam",
    "madam",
    "teacher",
    "faculty",
    "phone",
    "number",
    "email",
    "contact",
    "dao",
    "dau",
    "ache",
    "ase",
    "name",
    "kono",
    "there",
    "any",
    "dept",
    "department",
    "details",
    "profile",
    "list",
    "all",
    "member",
    "members",
    "room",
    "head",
    "chairman",
    "chairperson",
    "chair",
    "hod",
    "leader",
    "leadership",
    "dean",
    "provost",
  ]);
  const words = tokenize(question).filter((word) => word.length >= 4 && !ignored.has(word));
  if (!words.length) return [];
  const matchedDepartment = knowledge ? matchedDepartmentFromQuestion(question, knowledge) : null;
  const eligiblePeople = matchedDepartment
    ? people.filter(
        (person) =>
          displayDepartmentName(person.department).toLowerCase() === displayDepartmentName(matchedDepartment).toLowerCase() ||
          !person.department,
      )
    : people;
  return dedupePeople(eligiblePeople)
    .map((person) => {
      const nameTokens = tokenize(person.name);
      const aliasTokens = tokenize(`${person.email || ""} ${person.profileUrl || ""} ${person.source || ""}`)
        .filter((token) => token.length >= 4 && !/^(https?|www|edu|com|bd|gmail|employees|faculty|members|gonouniversity|pharmacy|cse)$/.test(token));
      const score = words.reduce((total, word) => {
        if (nameTokens.includes(word)) return total + 35;
        if (nameTokens.some((token) => token.length >= 4 && (token.startsWith(word) || word.startsWith(token)))) return total + 22;
        if (aliasTokens.includes(word)) return total + 28;
        if (aliasTokens.some((token) => token.length >= 4 && (token.startsWith(word) || word.startsWith(token)))) return total + 18;
        if (fuzzyIncludes(nameTokens, word)) return total + 16;
        if (fuzzyIncludes(aliasTokens, word)) return total + 10;
        return total;
      }, 0);
      const exactHits = words.filter((word) => nameTokens.includes(word)).length;
      const aliasHits = words.filter((word) => aliasTokens.includes(word)).length;
      return { person, score, exactHits, aliasHits };
    })
    .filter((item) => item.score >= 16 || item.exactHits > 0 || item.aliasHits > 0)
    .sort((a, b) => b.exactHits - a.exactHits || b.aliasHits - a.aliasHits || b.score - a.score)
    .filter((item, _index, list) => {
      const best = list[0];
      return item.exactHits === best.exactHits && item.aliasHits === best.aliasHits && item.score >= Math.max(16, best.score - 10);
    })
    .slice(0, 5)
    .map((item) => item.person);
}

function directPeopleAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksPhone =
    /\b(phone|mobile|cell|call)\b/i.test(q) ||
    (/\bnumber\b/i.test(q) && !/\b(room|class|seat|serial)\s+number\b/i.test(q));
  const asksEmail = /\b(email|mail)\b/i.test(q);
  const asksGeneralContact = /\bcontact\b/i.test(q);
  const asksQualification = /\b(qualification|education|degree|study|porashona)\b/i.test(q);
  const asksProfile = /\b(chino|cheno|know|who|ke|about|details|info|profile|sir|mam|maam|madam|teacher|faculty)\b/i.test(q);
  const matches = findPeople(q, knowledge.faculty, knowledge);
  if (!matches.length || !(asksPhone || asksEmail || asksGeneralContact || asksProfile || asksQualification)) return null;
  if (asksPhone || asksEmail || asksGeneralContact) return formatPeopleContact(question, matches);
  if (asksQualification) {
    return {
      text: matches
        .map((person) => person.qualification
          ? `**${cleanPersonName(person.name)}**\n**Qualification:** ${person.qualification}`
          : `The official profile for **${cleanPersonName(person.name)}** does not list a qualification.`)
        .join("\n\n"),
      sources: matches.map((person) => ({ title: person.name, url: person.profileUrl || person.source })).filter((source) => source.url),
      mode: matches.some((person) => person.qualification) ? "structured" : "not_found",
    };
  }
  const lines = matches.map((person) => personIdentityLine(question, person));
  return {
    text: lines.join("\n"),
    sources: matches.map((person) => ({ title: person.name, url: person.profileUrl || person.source })).filter((source) => source.url),
    mode: "structured",
  };
}

function asksContactDetail(question) {
  const q = normalizeQuestion(question);
  return (
    /\b(phone|mobile|contact|cell|call|number)\b/i.test(q) ||
    /\b(email|mail)\b/i.test(q)
  );
}

function asksFeeDetail(question) {
  const q = normalizeQuestion(question);
  return (
    /\b(fee|fees|fe|cost|costs|tuition|tution|taka|tk|khoroch|khroch|kharach|kharoch|charge|charges|payment|payments|expense|expenses|package)\b/i.test(q) ||
    /\b(?:admission|vorti|course|semister|semester|total)\s+(?:fee|fees|fe|cost|costs|payment|tuition|tution|charge|khoroch)\b/i.test(q) ||
    /\b(?:cost|costs|tuition|tution|fee|fees|khoroch|taka)\s+(?:of|for|in|er|ta)\b/i.test(q)
  );
}

function asksProgramDetail(question) {
  const q = normalizeQuestion(question);
  return /\b(credit|credits|credit\s+hour|credit\s+hours|syllabus|curriculum|duration|semester|semesters|total\s+course|total\s+courses|course\s+list|subjects?)\b/i.test(q);
}

function asksOfficialInstitutionFact(question) {
  const q = normalizeQuestion(question);
  return (
    asksContactDetail(q) ||
    asksFeeDetail(q) ||
    asksProgramDetail(q) ||
    /\b(admission|apply|eligibility|required|requirement|deadline|date|routine|notice|result|seat|semester\s+fee|credit\s+fee)\b/i.test(q) ||
    /\b(chairman|head|hod|vc|vice\s+chancellor|dean|registrar|office|location|address|room|building|floor|transport|hostel|waiver|scholarship|founder|founded|established|establishment|campus\s+(?:area|size)|land\s+(?:area|size)|acres?|bigha|hectares?|students?|faculty|staff)\b/i.test(q)
  );
}

function asksInstitutionArea(question) {
  const q = normalizeQuestion(question);
  const institution = /\b(gono|bishwabidyalay|university|campus)\b/i.test(q);
  const measurement = /\b(?:area|land)(?:\s+size)?\b|\b(?:acres?|bigha|hectares?)\b/i.test(q);
  return institution && measurement;
}

function directInstitutionFactAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const institution = knowledge.institution || {};
  const external = knowledge.externalKnowledge || {};
  const officialCorpus = (knowledge.pages || [])
    .filter((page) => {
      try {
        const path = new URL(page.url).pathname;
        return path === "/" || /\/about-gb\/general-information|\/contact-us\/?$/i.test(path);
      } catch {
        return false;
      }
    })
    .flatMap((page) => page.chunks || [])
    .join("\n");
  const homeSource = { title: "Gono Bishwabidyalay", url: officialSiteUrl };
  const generalSource = { title: "General Information", url: `${officialSiteUrl}about-gb/general-information/` };
  const campusSource = { title: "Gono University Campus", url: `${officialSiteUrl}about-gb/general-information/gb-campus/` };
  const locationSource = { title: "Official location", url: `${officialSiteUrl}about-gb/general-information/location/` };
  const contactSource = { title: "Contact Gono Bishwabidyalay", url: `${officialSiteUrl}contact-us/` };

  if (asksInstitutionArea(q)) {
    if (external.campusArea?.value) {
      return {
        text: prefersBanglish(question)
          ? `**Wikipedia অনুযায়ী** Gono Bishwabidyalay-এর গ্রামীণ স্থায়ী ক্যাম্পাসের আয়তন **${external.campusArea.value}**। তবে বিশ্ববিদ্যালয়ের বর্তমানে indexed official general-information page-এ acreage উল্লেখ নেই, তাই এটি Wikipedia-attributed তথ্য হিসেবে দেখা উচিত।`
          : `**Wikipedia reports** that Gono Bishwabidyalay has a **${external.campusArea.value}** rural campus. The currently indexed official general-information pages do not publish an acreage figure, so this should be treated as a Wikipedia-attributed claim.`,
        sources: [...(external.campusArea.sources || []), locationSource],
        mode: "source_aware",
      };
    }
    return {
      text: prefersBanglish(question)
        ? "Official website-er indexed page-gulote campus-er exact area **acre, bigha, ba hectare-e deya nei**. Campus-ti Nolam, P.O. Mirzanagar via Savar Cantonment, Ashulia, Savar, Dhaka-1344-e obosthito. Exact size verify na kore ami kono number invent korbo na."
        : "The indexed official pages do not state the campus's exact area in **acres, bighas, or hectares**. They locate the campus at Nolam, P.O. Mirzanagar via Savar Cantonment, Ashulia, Savar, Dhaka-1344. I will not invent a size that the official site does not verify.",
      sources: [campusSource, locationSource, contactSource],
      mode: "not_found",
    };
  }

  if (/\b(?:meaning|literal meaning|name meaning|gono mane|gono ortho|abbreviation|short form|native name)\b/i.test(q)) {
    const identity = external.identity || {};
    return {
      text: prefersBanglish(question)
        ? `**Gono Bishwabidyalay (গণ বিশ্ববিদ্যালয়)**-এর আক্ষরিক অর্থ **“People's University”** এবং সংক্ষিপ্ত নাম **GB**।`
        : `**Gono Bishwabidyalay (গণ বিশ্ববিদ্যালয়)** literally means **“People's University”** and is abbreviated **GB**.`,
      sources: identity.sources || [generalSource],
      mode: "source_aware",
    };
  }

  if (/\b(?:coordinates?|latitude|longitude|map location|gps)\b/i.test(q)) {
    const coordinates = external.identity?.coordinates;
    if (!coordinates) return null;
    return {
      text: `Wikipedia lists the campus coordinates as **${coordinates.latitude}° N, ${coordinates.longitude}° E**. The official postal address is **${institution.address || "Nolam, Mirzanagar, Savar, Dhaka-1344"}**.`,
      sources: [external.identity.sources?.[0], locationSource].filter(Boolean),
      mode: "source_aware",
    };
  }

  if (/\b(?:colou?rs?|brand colou?rs?)\b/i.test(q) && /\b(?:gono|bishwabidyalay|university|gb)\b/i.test(q)) {
    const colors = external.identity?.colors || [];
    if (!colors.length) return null;
    return {
      text: `Wikipedia lists Gono Bishwabidyalay's colors as **${colors.join(", ")}**. This is an externally sourced identity detail rather than a claim from the indexed official brand guide.`,
      sources: [external.identity.sources?.[0]].filter(Boolean),
      mode: "source_aware",
    };
  }

  if (/\b(?:qs|ranking|rank|standings?)\b/i.test(q)) {
    const ranking = external.rankings?.[0];
    const snapshot = external.qsSnapshot;
    if (!ranking) return null;
    const snapshotText = snapshot
      ? ` QS's profile snapshot also reports **${Number(snapshot.totalStudents).toLocaleString("en-US")} students** and **${snapshot.facultyStaff} faculty staff**; these figures reflect QS's reporting dataset, not a live registrar count.`
      : "";
    return {
      text: `According to **${ranking.publisher}**, Gono Bishwabidyalay is ranked **#${ranking.band} in the ${ranking.ranking}**.${snapshotText}`,
      sources: [ranking.source],
      mode: "source_aware",
    };
  }

  if (/\b(?:wikipedia|external source|outside source)\b/i.test(q)) {
    const identity = external.identity || {};
    return {
      text:
        `External profiles describe **Gono Bishwabidyalay (GB)** as a not-for-profit private university at Nolam, Savar. ` +
        `Wikipedia gives the Bengali name **${identity.bengaliName || "গণ বিশ্ববিদ্যালয়"}**, the literal meaning **People's University**, a rural **${external.campusArea?.value || "32-acre"}** campus claim, and coordinates **${identity.coordinates?.latitude || 23.9287}° N, ${identity.coordinates?.longitude || 90.2447}° E**. ` +
        `For the establishment date, the official history is preferred: the concept originated in **1994**, and the university was formally established on **14 July 1998**.`,
      sources: external.sources || [],
      mode: "source_aware",
    };
  }

  if (/\b(?:who\s+(?:is|was)\s+(?:the\s+)?founder|who\s+founded|founder|protishthata|protisthata)\b/i.test(q)) {
    const founder = institution.founder || "Dr. Zafrullah Chowdhury";
    const organization = institution.foundingOrganization || "Gonoshasthaya Kendra (GK) Public Charitable Trust";
    const established = institution.establishedDate || "14 July 1998";
    const asksWhen = /\b(when|date|year|kobe|established|founded)\b/i.test(q);
    return {
      text: prefersBanglish(question)
        ? `Gono Bishwabidyalay-এর প্রতিষ্ঠাতা বীর মুক্তিযোদ্ধা **${founder}**। এটি ${organization}-এর অধীনে পরিচালিত${asksWhen ? ` এবং **${established}** তারিখে আনুষ্ঠানিকভাবে প্রতিষ্ঠিত` : ""}।`
        : `Gono Bishwabidyalay was founded by the **${organization}**, under the vision of **${founder}**${asksWhen ? `, and was formally established on **${established}**` : ""}.`,
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:when|date|year|kobe).*\b(?:founded|established|started|protishthito|protistha|toiri)|\b(?:founded|established|establishment|protishtha|protishthito)\b/i.test(q)) {
    const establishedDate = institution.establishedDate || "14 July 1998";
    return {
      text: prefersBanglish(question)
        ? `Gono Bishwabidyalay **${establishedDate}** সালে গণস্বাস্থ্য কেন্দ্র ট্রাস্টের অধীনে ডা. জাফরুল্লাহ চৌধুরীর উদ্যোগে প্রতিষ্ঠিত হয়।`
        : `Gono Bishwabidyalay was established on **${establishedDate}** by the Gonoshasthaya Kendra (GK) Public Charitable Trust.`,
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\bchancellor\b/i.test(q) && !/\bvice[\s-]*chancellor|pro[\s-]*chancellor\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay-এর চ্যান্সেলর পদাধিকারবলে **গণপ্রজাতন্ত্রী বাংলাদেশের মহামান্য রাষ্ট্রপতি** (The President of Bangladesh)।"
        : "The Chancellor of Gono Bishwabidyalay is the **Hon'ble President of the People's Republic of Bangladesh** (ex-officio).",
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:motto|slogan|mulniti|bani)\b/i.test(q)) {
    const motto = institution.motto || "A University with a difference";
    return {
      text: prefersBanglish(question)
        ? `Gono Bishwabidyalay-এর মূল নীতি বা মোটো হলো: **"${motto}"** (ব্যতিক্রমী এক বিশ্ববিদ্যালয়)।`
        : `The official motto of Gono Bishwabidyalay is: **"${motto}"**.`,
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:hospital|medical\s+college|gonoshasthaya\s+nagar\s+hospital|haspatal)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "হ্যাঁ, গণস্বাস্থ্য কেন্দ্রের নিজস্ব ৫০০ শয্যার **গণস্বাস্থ্য নগর হাসপাতাল** (সাভার ও ধানমন্ডি) এবং গণস্বাস্থ্য সমাজভিত্তিক মেডিকেল কলেজ রয়েছে, যেখানে শিক্ষার্থীরা ক্লিনিক্যাল ও ব্যবহারিক প্রশিক্ষণ লাভ করে।"
        : "Yes, Gono Bishwabidyalay is affiliated with the 500-bed **Gonoshasthaya Nagar Hospital** (Savar & Dhanmondi) and Gonoshasthaya Samaj Vittik Medical College for clinical training and practical internships.",
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:baksu|csu|gbkc|student\s+union|chhatro\s+shongshod|chhatro\s+union)\b/i.test(q)) {
    const su = institution.studentUnion || {};
    return {
      text: prefersBanglish(question)
        ? `**বাকসু (${su.name || "GBKC - গণ বিশ্ববিদ্যালয় কেন্দ্রীয় ছাত্র সংসদ"})** ২০১৩ সালে প্রতিষ্ঠিত হয়। এটি ঢাকা বিশ্ববিদ্যালয়ের ডাকসুর পর দেশের দ্বিতীয় সক্রিয় কেন্দ্রীয় ছাত্র সংসদ এবং বেসরকারি বিশ্ববিদ্যালয়ে একমাত্র নির্বাচিত ছাত্র সংসদ। এর বর্তমান ভিপি **${su.vp || "ইয়াসিন আল মৃদুল দেওয়ান"}** এবং জিএস **${su.gs || "মোঃ রায়হান খান"}**।`
        : `**${su.name || "Gono Bishwabidyalay Central Students' Union (GBKC)"}** was established in 2013 and is the second active central students' union in Bangladesh after DUCSU, and the only elected students' union in private universities. Current VP: **${su.vp || "Iyasin Al Mridul Dewan"}**, GS: **${su.gs || "Md. Raihan Khan"}**.`,
      sources: [{ title: "GB Central Students' Union", url: "https://gonouniversity.edu.bd/gb-central-students-union-2025-2027/" }],
      mode: "structured",
    };
  }

  if (/\b(?:how\s+many|koyti|koyta|list|names?)\s+(?:faculties|faculty)\b|\b(?:faculties|faculty)\s+(?:koyti|koyta|ki\s+ki)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? `Gono Bishwabidyalay-তে প্রধান **৫টি অনুষদ (Faculty)** রয়েছে:\n` +
          `১. **Faculty of Science & Engineering** (CSE, EEE, Medical Physics, Math, Physics, Chemistry)\n` +
          `২. **Faculty of Health Sciences** (Pharmacy, Microbiology, Biochemistry)\n` +
          `৩. **Faculty of Arts & Social Sciences** (BBA, English, Bangla, Politics, Sociology, Law)\n` +
          `৪. **Faculty of Veterinary & Animal Sciences** (DVM)\n` +
          `৫. **Faculty of Agriculture** (B.Sc. in Agriculture)`
        : `Gono Bishwabidyalay has **5 primary faculties**:\n` +
          `1. **Faculty of Science & Engineering** (CSE, EEE, Medical Physics, Mathematics, Physics, Chemistry)\n` +
          `2. **Faculty of Health Sciences** (Pharmacy, Microbiology, Biochemistry)\n` +
          `3. **Faculty of Arts & Social Sciences** (BBA, English, Bangla, Politics, Sociology, Law)\n` +
          `4. **Faculty of Veterinary & Animal Sciences** (DVM)\n` +
          `5. **Faculty of Agriculture** (B.Sc. in Agriculture)`,
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:where|location|located|address|campus\s+kothay|kothay)\b/i.test(q) && /\b(?:gono|bishwabidyalay|university|campus)\b/i.test(q)) {
    const address =
      institution.address ||
      officialCorpus.match(/Nolam,?\s*P\.O\.\s*Mirzanagar[^.\n]*Dhaka-1344/i)?.[0];
    if (!address) return null;
    return {
      text: `Gono Bishwabidyalay is located at **${address.replace(/\.$/, "")}, Bangladesh**.`,
      sources: [locationSource, contactSource],
      mode: "structured",
    };
  }

  if (/\b(?:how\s+many|number|count|koto|kojon)\b/i.test(q) && /\b(?:undergraduate|graduate|students?|faculty|teachers?|office\s+staff)\b/i.test(q) && /\b(?:gono|bishwabidyalay|university)\b/i.test(q)) {
    const statistics = institution.statistics || {};
    const values = [
      [statistics.undergraduateStudents, "undergraduate students"],
      [statistics.graduateStudents, "graduate students"],
      [statistics.facultyMembers, "faculty members"],
      [statistics.officeStaff, "office staff"],
    ].filter(([value]) => value);
    if (!values.length) {
      return {
        text: "The official homepage shows headline university statistics, but the current index does not contain their numeric values. I will not guess a live student or staff count.",
        sources: [homeSource],
        mode: "not_found",
      };
    }
    const displayStatistic = (value) => {
      const match = String(value).match(/([\d,]+)(.*)/);
      if (!match) return value;
      const number = Number(match[1].replace(/,/g, ""));
      return `${Number.isFinite(number) ? number.toLocaleString("en-US") : match[1]}${match[2]}`;
    };
    return {
      text: `The official homepage currently displays ${values.map(([value, label]) => `**${displayStatistic(value)} ${label}**`).join(", ")}. These are published headline counts, not a live registrar total.`,
      sources: [homeSource],
      mode: "structured",
    };
  }

  if (/\b(?:private|public|shorkari|beshorkari|sarkari|besarkari)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay একটি সরকার ও UGC অনুমোদিত **বেসরকারি বিশ্ববিদ্যালয় (Private University)**। এটি গণস্বাস্থ্য কেন্দ্র পাবলিক চ্যারিটেবল ট্রাস্টের অধীনে পরিচালিত একটি অলাভজনক সেবামূলক উচ্চশিক্ষা প্রতিষ্ঠান।"
        : "Gono Bishwabidyalay is a government and UGC-approved **not-for-profit private university**, operating under the Gonoshasthaya Kendra (GK) Public Charitable Trust.",
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:ugc|accreditation|accredited|approved|onumodito|onumodon|স্বীকৃতি|অনুমোদন)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "হ্যাঁ, Gono Bishwabidyalay বাংলাদেশ বিশ্ববিদ্যালয় মঞ্জুরী কমিশন (UGC) এবং শিক্ষা মন্ত্রণালয় কর্তৃক সম্পূর্ণভাবে **অনুমোদিত ও স্বীকৃত**। এছাড়াও এর ফার্মেসি প্রোগ্রাম Pharmacy Council of Bangladesh (PCB) এবং আইন প্রোগ্রাম বাংলাদেশ বার কাউন্সিল কর্তৃক অনুমোদিত।"
        : "Yes, Gono Bishwabidyalay is fully **approved and recognized** by the University Grants Commission (UGC) of Bangladesh and the Ministry of Education. Its pharmacy and law programs are also accredited by PCB and Bangladesh Bar Council.",
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:reputed|মর্যাদা)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay বিশেষায়িত স্বাস্থ্যবিজ্ঞান, প্রকৌশল এবং সমাজকল্যাণমুখী শিক্ষার জন্য খ্যাত। বিশেষ করে দেশে সর্বপ্রথম 'মেডিকেল ফিজিক্স অ্যান্ড বায়োমেডিকেল ইঞ্জিনিয়ারিং' বিভাগ চালুর জন্য এটি সমাদৃত।"
        : "Gono Bishwabidyalay is widely recognized for its healthcare, science, and community development education, having pioneered the Department of Medical Physics and Biomedical Engineering in Bangladesh.",
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:trustee|trustees|trust|board\s+of\s+trustees|ট্রাস্টি|ট্রাস্ট)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay **গণস্বাস্থ্য কেন্দ্র (GK) পাবলিক চ্যারিটেবল ট্রাস্ট**-এর অধীনে পরিচালিত হয়। বীর মুক্তিযোদ্ধা ডা. জাফরুল্লাহ চৌধুরী এই ট্রাস্টের মূল স্বপ্নদ্রষ্টা ছিলেন।"
        : "Gono Bishwabidyalay is governed under the **Gonoshasthaya Kendra (GK) Public Charitable Trust**, founded by freedom fighter Dr. Zafrullah Chowdhury.",
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  if (/\b(?:zafrullah|jafrullah|জাফরুল্লাহ)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "বীর মুক্তিযোদ্ধা **ডা. জাফরুল্লাহ চৌধুরী** ছিলেন গণস্বাস্থ্য কেন্দ্র এবং Gono Bishwabidyalay-এর প্রতিষ্ঠাতা ও স্বপ্নদ্রষ্টা। তিনি বাংলাদেশের স্বাস্থ্য ও শিক্ষা খাতের একজন অগ্রদূত ছিলেন।"
        : "Freedom fighter **Dr. Zafrullah Chowdhury** was the visionary founder of Gonoshasthaya Kendra and Gono Bishwabidyalay, dedicated to affordable healthcare and higher education.",
      sources: [homeSource, generalSource],
      mode: "structured",
    };
  }

  return null;
}

const universitySources = {
  background: { title: "University background", url: `${officialSiteUrl}about-gb/general-information/background/` },
  mission: { title: "Mission & Vision", url: `${officialSiteUrl}about-gb/general-information/mission-vision/` },
  academics: { title: "Academics", url: `${officialSiteUrl}academics/` },
  admission: { title: "Admission", url: `${officialSiteUrl}admission/` },
  requirements: { title: "Admission requirements", url: `${officialSiteUrl}admission/undergraduate-admission-requirements/` },
  financialAid: { title: "Financial Aid", url: `${officialSiteUrl}admission/financial-aid/` },
  online: { title: "Online Facilities", url: `${officialSiteUrl}admission/online-facilities/` },
  library: { title: "Gono University Library", url: `${officialSiteUrl}library/` },
  research: { title: "Center for Multidisciplinary Research", url: `${officialSiteUrl}research/` },
  researchGuidelines: { title: "Research and journal guidelines", url: `${officialSiteUrl}research/guideline/` },
  sports: { title: "Sports Office", url: `${officialSiteUrl}sports/` },
};

function academicDepartments(knowledge) {
  const values = [
    ...(knowledge.programs || []).map((program) => program.department),
    ...(knowledge.faculty || []).map((person) => person.department),
  ];
  return [...new Set(values.map(displayDepartmentName).filter((value) =>
    value && !/library|research|office|administration|student union|sports/i.test(value),
  ))].sort((a, b) => a.localeCompare(b));
}

function directUniversityOverviewAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const broadUniversity = /\b(gono|gono\s+bishwabidyalay|gono\s+university|gb)\b/i.test(q);
  const asksOverview = /\b(about|overview|introduction|profile|general\s+information|details|somporke|somproke|niye\s+bolo|tell\s+me|aro\s+info|information)\b/i.test(q);
  const specific = /\b(founder|founded|established|location|address|area|size|acre|student|faculty|staff|department|program|course|credit|fee|admission|apply|library|facility|facilities|portal|transport|mission|vision|contact|phone|email|notice|result|vc|chancellor|registrar|research|journal|sports?|campus\s+life|cultural|scholarship|waiver|hostel)\b/i.test(q);
  if (!broadUniversity || !asksOverview || specific) return null;

  const institution = knowledge.institution || {};
  const external = knowledge.externalKnowledge || {};
  const stats = institution.statistics || {};
  const departments = academicDepartments(knowledge);
  const programCount = verifiedPrograms(knowledge.programs || []).length;
  const established = institution.establishedDate || "14 July 1998";
  const address = institution.address || "Nolam, Mirzanagar, Ashulia, Savar, Dhaka-1344";
  const statLine = [
    stats.undergraduateStudents && `${stats.undergraduateStudents} undergraduate students`,
    stats.graduateStudents && `${stats.graduateStudents} graduate students`,
    stats.facultyMembers && `${stats.facultyMembers} faculty members`,
  ].filter(Boolean).join(", ");
  const ranking = external.rankings?.[0];
  const externalLine = ranking
    ? `QS Asian University Rankings 2026 band: **#${ranking.band}**. Wikipedia reports a **${external.campusArea?.value || "32-acre"}** rural campus; the acreage is not stated on the indexed official general-information pages.`
    : "";
  const overviewSources = [
    universitySources.background,
    universitySources.mission,
    universitySources.academics,
    ranking?.source,
    external.identity?.sources?.[0],
  ].filter(Boolean);

  return {
    text: prefersBanglish(question)
      ? `**Gono Bishwabidyalay (গণ বিশ্ববিদ্যালয় / GB)**-er literal meaning **“People's University”**। Eti GK Public Charitable Trust-er uddoge **${established}**-e protishthito not-for-profit private university; concept-ti **1994**-e shuru hoy. University-ti UGC-accredited ebong Ministry of Education-approved. Campus: **${address}**.\n\nOfficial index-e **${departments.length} academic unit** ebong **${programCount} verified program** ache. Health sciences, engineering, life sciences, physical sciences, humanities, social sciences, business, law, agriculture o veterinary education cover kora hoy. ${statLine ? `Official homepage stats: ${statLine}. ` : ""}${externalLine}\n\nGB-r mission affordable higher education-er sathe social development, human welfare, equal opportunity ebong community engagement-ke jukto kora.`
      : `**Gono Bishwabidyalay (গণ বিশ্ববিদ্যালয় / GB)** literally means **“People's University.”** It is a not-for-profit private university established by the GK Public Charitable Trust on **${established}**; the university concept originated in **1994**. It is accredited by the UGC and approved by the Ministry of Education. Campus: **${address}**.\n\nThe official index contains **${departments.length} academic units** and **${programCount} verified programs**, spanning health sciences, engineering, life sciences, physical sciences, humanities, social sciences, business, law, agriculture, and veterinary education. ${statLine ? `Official homepage figures include ${statLine}. ` : ""}${externalLine}\n\nIts stated mission connects affordable higher education with social development, human welfare, equal opportunity, and community engagement.`,
    sources: overviewSources,
    mode: ranking ? "source_aware" : "structured",
  };
}

function directAcademicUnitsAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksList = /\b(what|which|ki\s+ki|list|show|all|sob|shob|koyta|koto|how\s+many|available|offer)\b/i.test(q);
  const asksUnits = /\b(departments?|facult(?:y|ies)|academic\s+units?|programs?|degrees?)\b/i.test(q);
  if (!asksList || !asksUnits || asksProgramDetail(q)) return null;

  const facultyGroups = knowledge.institution?.faculties || [];
  const normalizedQuestion = q.replace(/\s*&\s*/g, " and ");
  const requestedFaculty = /\bfacult(?:y|ies)\b/i.test(q) && facultyGroups.find((faculty) => {
    const name = normalizeQuestion(faculty.name || "").replace(/\s*&\s*/g, " and ");
    const core = name.replace(/^faculty\s+of\s+/, "");
    return termInQuestion(normalizedQuestion, name) || (core.length > 4 && normalizedQuestion.includes(core));
  });
  if (requestedFaculty?.departments?.length) {
    return {
      text: `**${requestedFaculty.name}** has **${requestedFaculty.departments.length} departments/program groups**:\n${requestedFaculty.departments.map((department) => `- ${department}`).join("\n")}`,
      sources: [universitySources.academics],
      mode: "structured",
    };
  }
  if (matchedDepartmentFromQuestion(q, knowledge)) return null;

  const departments = academicDepartments(knowledge);
  if (!departments.length) return null;
  const wantsPrograms = /\b(programs?|degrees?)\b/i.test(q);
  if (wantsPrograms) {
    const grouped = new Map();
    const programs = verifiedPrograms(knowledge.programs || []);
    for (const program of programs) {
      const department = displayDepartmentName(program.department || "Other programs");
      const names = grouped.get(department) || [];
      if (program.name && !names.includes(program.name)) names.push(program.name);
      grouped.set(department, names);
    }
    const lines = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([department, programs]) => `- **${department}:** ${programs.join(", ")}`);
    return {
      text: `The verified official catalog currently contains **${programs.length} programs** across **${departments.length} academic units**:\n${lines.join("\n")}`,
      sources: [universitySources.academics, universitySources.admission],
      mode: "structured",
    };
  }

  return {
    text: `${prefersBanglish(question) ? `Official index-e **${departments.length} ta academic department/faculty** ache` : `The official index contains **${departments.length} academic departments/faculties**`}:\n${departments.map((department) => `- ${department}`).join("\n")}`,
    sources: [universitySources.academics],
    mode: "structured",
  };
}

function directMissionVisionAnswer(question) {
  const q = normalizeQuestion(question);
  if (!/\b(mission|vision|objective|goal|uddessho|lokkhyo)\b/i.test(q) || !/\b(gono|bishwabidyalay|university|gb)\b/i.test(q)) return null;
  return {
    text: prefersBanglish(question)
      ? "Gono Bishwabidyalay-er vision holo education-er maddhome **social development o human welfare**-e notun commitment toiri kora. Mission-er moddhe ache scientific knowledge-ke manusher proyojoner sathe jukto kora, nari-purusher equal opportunity, participatory teaching, community service, poverty reduction, desh o manusher unnoyon, ebong indigenous knowledge/craft-ke sustain o modernize kora. Official page-ti low-income family, freedom-fighter family ebong ethnic-minority students-er support-o ullekh kore."
      : "Gono Bishwabidyalay's vision centers on creating a new educational commitment to **social development and human welfare**. Its mission includes connecting scientific knowledge with people's needs, equal opportunity for women and men, participatory teaching, community service, poverty reduction, national development, and sustaining indigenous knowledge and crafts. The official page also describes support for students from low-income families, freedom-fighter families, and ethnic minorities.",
    sources: [universitySources.mission],
    mode: "structured",
  };
}

function directFacilitiesAnswer(question) {
  const q = normalizeQuestion(question);
  if (/\btransport|bus\b/i.test(q) && /\b(gono|university|campus|student)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Indexed official **Mission & Vision** page-e sposto kore **\"No university transport\"** bola ache. Ei information poriborton hote pare, tai current arrangement admission office-er sathe confirm kora bhalo."
        : "The indexed official **Mission & Vision** page explicitly states **\"No university transport.\"** Because services can change, confirm the current arrangement with the admission office.",
      sources: [universitySources.mission],
      mode: "structured",
    };
  }
  if (/\b(library|books?|journals?|reading\s+room)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono University Library-te books, journals o digital resources ache. Official page onujayi ekhane **Wi-Fi, computer access, spacious reading area**, research/study support ebong workshops ache. Online Facilities page aro bole je Student Portal theke available books browse, PDF download, borrowed/returned books o pending fine track kora jay."
        : "Gono University Library provides books, journals, and digital resources. Its official page lists **Wi-Fi, computer access, a spacious reading area**, research/study assistance, and workshops. The Online Facilities page also says students can browse available books, download PDFs, track borrowed and returned books, and see pending fines through the Student Portal.",
      sources: [universitySources.library, universitySources.online],
      mode: "structured",
    };
  }
  if (/\b(portal|erp|i-?ems|online\s+(?:facility|facilities|payment|class|services?)|attendance|course\s+materials?|digital\s+library)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "GB-r integrated **i-EMS/Student Portal**-e course registration, dues/payment details, online payment, attendance, course materials, class/course notices o online-class link support ache. Official page bKash, SSLCommerz o Upay payment integration ebong digital-library/alumni features-o ullekh kore."
        : "GB's integrated **i-EMS/Student Portal** supports course registration, dues and payment details, online payment, attendance, course materials, class/course notices, and online-class links. The official page also lists bKash, SSLCommerz and Upay payment integration, plus digital-library and alumni features.",
      sources: [universitySources.online],
      mode: "structured",
    };
  }
  if (/\b(facility|facilities|campus\s+services?)\b/i.test(q) && /\b(gono|university|campus|gb)\b/i.test(q) && !/\b(hostel|hall|dormitory|accommodation)\b/i.test(q)) {
    return {
      text: "Verified official information covers a central library with Wi-Fi/computer access and reading space, an integrated student portal for academic and payment services, digital-library access, online classes, attendance and notices. The indexed source does not provide a reliable total count of laboratories or a complete inventory of every campus facility, so I will not invent those numbers.",
      sources: [universitySources.library, universitySources.online],
      mode: "structured",
    };
  }
  if (/\b(hostel|hall|dormitory|accommodation)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Indexed official university pages-e **hostel/hall availability, seat count, ba fee-r verified details publish kora nei**. Tai ami hostel ache ba nei bole guess korbo na; current information-er jonno Admission Office-e confirm kora uchit."
        : "The indexed official university pages do **not publish verified hostel/hall availability, seat counts, or fees**. I will not guess whether accommodation is currently available; confirm it with the Admission Office.",
      sources: [universitySources.admission],
      mode: "not_found",
    };
  }
  return null;
}

function directResearchAndCampusLifeAnswer(question) {
  const q = normalizeQuestion(question);
  if (/\b(research|journal|publication|publications|multidisciplinary|project\s+proposal)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay-er official site-e **Center for Multidisciplinary Research** ache. Indexed research portal-e journal-er **Volume 01-06**, project-proposal guideline, journal guideline ebong bill/voucher submission guideline-er section ache. Research contact hisebe **gonoresearch@gmail.com** ebong **research@gonouniversity.edu.bd** publish kora hoyeche. Portal-er kichu facility/laboratory page placeholder content dhore, tai specific lab count ba equipment ami verify chara bolchi na."
        : "Gono Bishwabidyalay has an official **Center for Multidisciplinary Research** portal. The indexed portal contains journal **Volumes 01-06**, project-proposal and journal guidelines, and bill/voucher submission guidance. It publishes **gonoresearch@gmail.com** and **research@gonouniversity.edu.bd** as research contacts. Some facility/laboratory pages contain placeholder content, so I will not infer a lab count or equipment list from them.",
      sources: [universitySources.research, universitySources.researchGuidelines, { title: "Research contact", url: `${officialSiteUrl}research/contact/` }],
      mode: "structured",
    };
  }
  if (/\b(sports?|cricket|football|volleyball|tournament|athletics?|physical\s+fitness)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Official Sports Office page cricket, football, volleyball, regular tournament, inter-department competition ebong training session-er kotha bole. Indexed notices-e men's cricket inter-department winner ebong women's inter-department sports-er record-o ache."
        : "The official Sports Office page describes cricket, football, volleyball, regular tournaments, inter-department competitions, and training sessions. Indexed notices also include records for men's inter-department cricket and women's inter-department sports.",
      sources: [universitySources.sports],
      mode: "structured",
    };
  }
  if (/\b(campus\s+life|student\s+life|extracurricular|cultural\s+(?:program|activities))\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Official index-e department-based cultural programs, sports activities, central library, workshops ebong student portal services-er pages ache. Kintu sob club/organization-er ekta complete current central list indexed nei, tai kono fabricated club list deya hobe na."
        : "The official index includes department-level cultural programs, sports activities, the central library, workshops, and student-portal services. It does not provide a complete current central list of every club or student organization, so I will not fabricate one.",
      sources: [universitySources.sports, universitySources.library, universitySources.online],
      mode: "structured",
    };
  }
  if (
    q === "what scholarship waiver is available" ||
    (/\b(scholarship|waiver|financial\s+aid|stipend)\b/i.test(q) &&
      !/\b(kivabe|how|apply|koto|gpa|female|procedure|rules?|system|criteria|percent|discount|pabo|details?|bistarito)\b/i.test(q) &&
      !/\b(?:cse|pharmacy|bba|law|department)\b/i.test(q))
  ) {
    return {
      text: prefersBanglish(question)
        ? "Official site-e **Financial Aid** page ache, kintu current indexed content-e scholarship/waiver-er exact amount, percentage ba eligibility criteria deya nei. Program/session-specific written notice chara ami kono waiver rate invent korbo na."
        : "The official site has a **Financial Aid** page, but its currently indexed content does not publish exact scholarship/waiver amounts, percentages, or eligibility criteria. I will not invent a waiver rate without a program/session-specific written notice.",
      sources: [universitySources.financialAid],
      mode: "not_found",
    };
  }
  return null;
}

function directAdmissionOverviewAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const broadAdmission = /\b(admission|vorti|apply|application)\b/i.test(q);
  const specific = asksFeeDetail(q) || asksProgramDetail(q) || matchedDepartmentFromQuestion(q, knowledge) || /\b(deadline|date|seat|result|notice|gpa|eligibility|requirement)\b/i.test(q);
  if (!broadAdmission || specific) return null;
  return {
    text: prefersBanglish(question)
      ? "GB-te admission-er jonno official **Apply Online** page diye application kora jay. Age undergraduate ba graduate requirement check koro, tarpor program select kore form submit koro. Tuition/fees o financial-aid-er alada official page ache. Exact deadline, admission fee ba waiver semester/program-vhede bodlate pare, tai current notice ba admission office-er verified data chara ami amount invent korbo na."
      : "Applications can be submitted through GB's official **Apply Online** service. First check the undergraduate or graduate admission requirements, then select the program and submit the form. The university also provides separate official tuition/fees and financial-aid pages. Deadlines, admission charges, and waivers can vary by semester and program, so I will not invent a current amount without a verified notice.",
    sources: [universitySources.admission, universitySources.requirements, universitySources.financialAid],
    mode: "structured",
  };
}

function isGeneralAcademicQuestion(question) {
  const q = normalizeQuestion(question);
  if (asksOfficialInstitutionFact(q) || asksPersonIdentity(q)) return false;
  const asksExplainer =
    /\b(what\s+is|ki|kake\s+bole|define|explain|meaning|concept|basic|overview|somporke|somproke|about|details|subject|course|syllabus|topic|learn|study|pore|porano|porashona)\b/i.test(q);
  const academicTopic =
    /\b(data\s+structures?|algorithm|programming|database|network|software|computer|cse|biomedical|bio\s*medical|engineering|pharmacy|microbiology|biochemistry|physiology|anatomy|math|mathematics|physics|chemistry|biology|course|subject|department|dept)\b/i.test(q);
  return asksExplainer && academicTopic;
}

function explicitlyRequestsGonoContext(question) {
  const q = normalizeQuestion(question);
  return /\b(gono|gono\s+bishwabidyalay|university|official|department|dept|syllabus|curriculum|credit|credits|faculty|teacher|fee|admission)\b/i.test(q);
}

function asksPersonIdentity(question) {
  const q = normalizeQuestion(question);
  const asksPerson =
    /\b(chino|cheno|chine|jano|know|who|ke|sir|mam|maam|madam|teacher|faculty|profile|details|info|about)\b/i.test(q);
  const broadList =
    /\b(all|sob|shob|sobar|shobar|sokol|sobai|shobai|list|department|dept|teachers|members|faculty\s+members|koyjon|kojon|how\s+many)\b/i.test(q);
  return asksPerson && !broadList;
}

function requiresVerifiedStructuredAnswer(question, history = []) {
  const q = normalizeQuestion(question);
  if (isGeneralAcademicQuestion(q)) return false;
  if (asksContactDetail(q)) return true;
  if (asksFeeDetail(q)) return true;
  if (asksProgramDetail(q)) return true;
  if (asksPersonIdentity(q)) return true;
  if (
    /\b(how\s+many|total\s+(?:number|amount)|number\s+of|count|koto|kojon)\b/i.test(q) &&
    /\b(gono|bishwabidyalay|university|campus|department|dept|program|course|lab|laboratory|students?|faculty|teachers?|staff)\b/i.test(q)
  ) return true;
  return false;
}

function isContextualFollowup(question) {
  const q = normalizeQuestion(question);
  return asksContactDetail(q) || /\b(his|her|their|that|this|profile|details|tar|or|oder|etar|eitar|oitar|about|career|future|job|scope|waiver|scholarship|eligibility|qualification|kobe|shuru|start|dates?|timing)\b/i.test(q);
}

function previousConversation(history = [], message = "") {
  const normalizedMessage = normalizeQuestion(message);
  const items = Array.isArray(history) ? history : [];
  if (items.length && normalizeQuestion(items.at(-1)?.text || "") === normalizedMessage) return items.slice(0, -1);
  return items;
}

function formatPeopleContact(question, people) {
  const q = normalizeQuestion(question);
  const asksPhone =
    /\b(phone|mobile|cell|call)\b/i.test(q) ||
    (/\bnumber\b/i.test(q) && !/\b(room|class|seat|serial)\s+number\b/i.test(q));
  const asksEmail = /\b(email|mail)\b/i.test(q);
  const asksGeneralContact = /\b(contact)\b/i.test(q) && !asksPhone && !asksEmail;
  const lines = people.map((person) => {
    if (asksEmail) return `**${person.name}**: ${person.email ? `**${person.email}**` : "email not listed in official data"}`;
    if (asksPhone) return `**${person.name}**: ${person.phone ? `**${person.phone}**` : "phone number not listed in official data"}`;
    if (asksGeneralContact) {
      const parts = [];
      if (person.phone) parts.push(`Phone: **${person.phone}**`);
      if (person.email) parts.push(`Email: **${person.email}**`);
      return `**${person.name}**: ${parts.length ? parts.join(", ") : "contact information not listed in official data"}`;
    }
    return personIdentityLine(question, person);
  });
  return {
    text: lines.join("\n"),
    sources: people.map((person) => ({ title: person.name, url: person.profileUrl || person.source })).filter((source) => source.url),
    mode: "structured",
  };
}

function contactRecords(knowledge) {
  const records = [];
  for (const person of knowledge.faculty || []) {
    records.push({
      ...person,
      kind: "person",
      sourceTitle: person.name,
      profileUrl: person.profileUrl || person.source,
    });
  }
  for (const role of knowledge.roles || []) {
    records.push({
      name: role.name,
      designation: role.title,
      department: role.group || "Gono University",
      phone: role.phone || "",
      email: role.email || "",
      source: role.source,
      profileUrl: role.source,
      sourceTitle: role.sourceTitle || role.title,
      kind: "role",
    });
  }
  return dedupePeople(records);
}

function exactNameMentioned(text, name) {
  const normalizedText = normalizeQuestion(text)
    .replace(/[^\p{L}\p{N}\s*]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedName = normalizeQuestion(cleanPersonName(name))
    .replace(/[^\p{L}\p{N}\s*]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedText || !normalizedName) return false;
  const namePattern = normalizedName
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(^|\\s|\\*)${namePattern}(\\s|\\*|$)`, "i").test(normalizedText);
}

function exactMentionedRecords(text, records) {
  return records.filter((record) => exactNameMentioned(text, record.name));
}

function asksMultipleFollowup(question) {
  const q = normalizeQuestion(question);
  return /\b(all|everyone|everybody|their|them|oder|oderer|sobar|shobar|sob|shob|sokol|sobai|shobai|list)\b/i.test(q);
}

function currentQuestionHasExplicitSubject(question, knowledge) {
  const q = normalizeQuestion(question);
  const filler = explicitSubjectFillerWords();
  const explicitTerms = expandedTerms(q).filter((term) => term.length >= 3 && !filler.has(term));
  if (!explicitTerms.length) return false;
  const knownRecords = [
    ...(knowledge.faculty || []).map((person) => `${person.name} ${person.department || ""} ${person.designation || ""}`),
    ...(knowledge.roles || []).map((role) => `${role.name} ${role.title || ""} ${role.group || ""}`),
    ...(knowledge.fees || []).flatMap((fee) => [fee.program, ...(fee.aliases || [])]),
  ].join(" ");
  const knownTokens = new Set(tokenize(knownRecords));
  return explicitTerms.some((term) => knownTokens.has(term) || !filler.has(term));
}

function explicitSubjectFillerWords() {
  return new Set([
    ...searchStopWords,
    "sir",
    "mam",
    "maam",
    "madam",
    "teacher",
    "faculty",
    "phone",
    "mobile",
    "contact",
    "cell",
    "call",
    "number",
    "email",
    "mail",
    "profile",
    "details",
    "info",
    "about",
    "chino",
    "cheno",
    "know",
    "dau",
    "dao",
    "den",
    "deyen",
    "tar",
    "tader",
    "oder",
    "or",
    "er",
    "r",
    "unar",
    "uni",
    "he",
    "him",
    "his",
    "she",
    "her",
    "they",
    "it",
    "this",
    "that",
    "does",
    "do",
    "did",
    "has",
    "have",
    "please",
    "ke",
    "all",
    "everyone",
    "everybody",
    "their",
    "them",
    "sobar",
    "shobar",
    "sob",
    "shob",
    "sokol",
    "sobai",
    "shobai",
    "list",
  ]);
}

function directUnknownPersonAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksPerson =
    /\b(chino|cheno|know|who|ke|profile|details|info|about|sir|mam|maam|madam|teacher|faculty)\b/i.test(q) ||
    asksContactDetail(q);
  if (!asksPerson) return null;

  const filler = explicitSubjectFillerWords();
  const terms = tokenize(q).filter((term) => term.length >= 3 && !filler.has(term));
  if (!terms.length) return null;

  const knownRecords = [
    ...(knowledge.faculty || []).map((person) => `${person.name} ${person.department || ""} ${person.designation || ""} ${person.email || ""} ${person.profileUrl || ""}`),
    ...(knowledge.roles || []).map((role) => `${role.name} ${role.title || ""} ${role.group || ""}`),
  ].join(" ");
  const knownTokens = new Set(tokenize(knownRecords));
  const knownDepartmentTokens = new Set(tokenize([...(knowledge.faculty || []).map((person) => person.department || "")].join(" ")));
  const unknownPersonTerms = terms.filter((term) => !knownTokens.has(term) && !knownDepartmentTokens.has(term));
  if (!unknownPersonTerms.length) return null;

  return {
    text: notVerifiedText(question),
    sources: [],
    mode: "not_found",
  };
}

function formatContactRecords(question, records) {
  return formatPeopleContact(question, records);
}

function activePersonRecord(entity, knowledge) {
  if (!entity?.name) return null;
  const records = contactRecords(knowledge);
  const profileUrl = String(entity.profileUrl || "").toLowerCase();
  return (
    records.find((record) => profileUrl && String(record.profileUrl || record.source || "").toLowerCase() === profileUrl) ||
    records.find(
      (record) =>
        normalizeQuestion(cleanPersonName(record.name)) === normalizeQuestion(cleanPersonName(entity.name)) &&
        (!entity.department || displayDepartmentName(record.department).toLowerCase() === displayDepartmentName(entity.department).toLowerCase()),
    ) ||
    null
  );
}

function directActivePersonAnswer(question, knowledge, entity) {
  const q = normalizeQuestion(question);
  const asksProfile = /\b(profile|details|info|about|chino|cheno|know|ke|tar|tader|oder|his|her|qualification|education|designation|position|department|research)\b/i.test(q);
  if (!asksContactDetail(question) && !asksProfile) return null;

  const records = contactRecords(knowledge);
  if (findPeople(question, records, knowledge).length || matchedDepartmentFromQuestion(question, knowledge)) return null;
  const person = activePersonRecord(entity, knowledge);
  if (!person) return null;
  if (asksContactDetail(question)) return formatContactRecords(question, [person]);

  const name = cleanPersonName(person.name);
  const lines = [personIdentityLine(question, person)];
  if (/\b(qualification|education|degree|study|porashona)\b/i.test(q)) {
    lines.push(person.qualification ? `**Qualification:** ${person.qualification}` : "The official profile does not list a qualification.");
  }
  if (/\b(research|publication|interest)\b/i.test(q)) {
    lines.push("Research and publication details are available on the linked official profile.");
  }
  return {
    text: lines.join("\n"),
    sources: [{ title: name, url: person.profileUrl || person.source }].filter((source) => source.url),
    mode: "structured",
  };
}

function resolvedPersonFromExchange(question, result, knowledge) {
  const records = contactRecords(knowledge);
  const sourceUrls = new Set((result?.sources || []).map((source) => String(source.url || "").toLowerCase()).filter(Boolean));
  const sourceMatches = records.filter((record) => sourceUrls.has(String(record.profileUrl || record.source || "").toLowerCase()));
  if (sourceMatches.length === 1) return sourceMatches[0];

  const explicitMatches = findPeople(question, records, knowledge);
  if (explicitMatches.length === 1) return explicitMatches[0];
  const answerMatches = exactMentionedRecords(result?.text || "", records);
  if (answerMatches.length === 1) return answerMatches[0];
  return null;
}

function followupClarification(question, records) {
  const names = records.slice(0, 5).map((record) => record.name).join(", ");
  return {
    text: prefersBanglish(question)
      ? `Kon jon-er info chai? ${names}${records.length > 5 ? ", ..." : ""}`
      : `Which person's info do you want? ${names}${records.length > 5 ? ", ..." : ""}`,
    sources: records
      .slice(0, 5)
      .map((record) => ({ title: record.sourceTitle || record.name, url: record.profileUrl || record.source }))
      .filter((source) => source.url),
    mode: "clarify",
  };
}

function lastMentionedPeople(history = [], people = []) {
  const recent = history
    .slice(-6)
    .reverse()
    .map((item) => ({ role: item.role || "", text: item.text || "" }));
  for (const item of recent) {
    const exactMatches = exactMentionedRecords(item.text, people);
    if (!exactMatches.length && item.role === "assistant" && /\b(phone|email|mail|number not listed|contact information)\b/i.test(item.text)) continue;
    const matches = exactMatches.length ? exactMatches : findPeople(item.text, people);
    if (matches.length) return matches.slice(0, 3);
  }
  return [];
}

function directFollowupAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const asksProfile = /\b(profile|details|info|about|chino|cheno|know|ke|tar|tader|oder)\b/i.test(q);
  if (!asksContactDetail(question) && !asksProfile) return null;
  if (currentQuestionHasExplicitSubject(question, knowledge)) return null;

  const records = contactRecords(knowledge);
  const recent = previousConversation(history, question)
    .slice(-8)
    .reverse()
    .map((item) => ({ role: item.role || "", text: item.text || "" }));

  for (const item of recent) {
    const exactMatches = exactMentionedRecords(item.text, records);
    if (!exactMatches.length && item.role === "assistant" && /\b(phone|email|mail|number not listed|contact information)\b/i.test(item.text)) continue;
    const matches = exactMatches.length ? exactMatches : item.role === "user" ? findPeople(item.text, records) : [];
    if (!matches.length) continue;
    if (matches.length > 1 && !asksMultipleFollowup(question)) return followupClarification(question, matches);
    if (asksContactDetail(question)) return formatContactRecords(question, matches.slice(0, asksMultipleFollowup(question) ? 8 : 1));
    return {
      text: matches
        .slice(0, asksMultipleFollowup(question) ? 8 : 1)
        .map((person) => personIdentityLine(question, person))
        .join("\n"),
      sources: matches
        .slice(0, asksMultipleFollowup(question) ? 8 : 1)
        .map((person) => ({ title: person.sourceTitle || person.name, url: person.profileUrl || person.source }))
        .filter((source) => source.url),
      mode: "structured",
    };
  }

  return null;
}

function directDepartmentLeaderAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksLeader = /\b(chairman|chairperson|chair|head|hod|department\s+head|dept\s+head)\b/i.test(q);
  if (!asksLeader) return null;
  const matchedDepartment = matchedDepartmentFromQuestion(q, knowledge);
  if (!matchedDepartment) {
    if (q.split(/\s+/).length <= 5) {
      return {
        text: prefersBanglish(question)
          ? "Tumi kon department-er head/chairman somporke jante chaccho? (e.g. CSE, Pharmacy, English, BBA, Microbiology)."
          : "Which department's head or chairman would you like to know about? (e.g. CSE, Pharmacy, English, BBA, Microbiology).",
        sources: [],
        mode: "clarify",
      };
    }
    return null;
  }

  const displayDepartment = displayDepartmentName(matchedDepartment);
  const leaders = departmentLeaders(departmentPeople(knowledge, matchedDepartment), matchedDepartment);
  if (!leaders.length) return null;

  if (/\b(room|office\s+room|room\s+number|building|floor)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? `**${displayDepartment}**-er head ${leaders.map((person) => `**${person.name}**`).join(", ")}, kintu official profile-e office room/building/floor number publish kora nei.`
        : `The head of **${displayDepartment}** is ${leaders.map((person) => `**${person.name}**`).join(", ")}, but the official profile does not publish an office room, building, or floor number.`,
      sources: leaders.map((person) => ({ title: person.name, url: person.profileUrl || person.source })).filter((source) => source.url),
      mode: "not_found",
    };
  }

  const asksPhone =
    /\b(phone|mobile|contact|cell|call)\b/i.test(q) ||
    (/\bnumber\b/i.test(q) && !/\b(room|class|seat|serial)\s+number\b/i.test(q));
  const asksEmail = /\b(email|mail)\b/i.test(q);
  const lines = leaders.map((person) => {
    if (asksPhone) return `**${person.name}**: ${person.phone ? `**${person.phone}**` : "phone number not listed in official data"}`;
    if (asksEmail) return `**${person.name}**: ${person.email ? `**${person.email}**` : "email not listed in official data"}`;
    const title = person.designation || "Department Head";
    const role = /\bhead\b/i.test(title) ? "department head" : title;
    return prefersBanglish(question)
      ? `${displayDepartment}-er official ${role} **${person.name}**.`
      : `The official ${role} for ${displayDepartment} is **${person.name}**.`;
  });
  return {
    text: lines.join("\n"),
    sources: leaders.map((person) => ({ title: person.name, url: person.profileUrl || person.source })).filter((source) => source.url),
    mode: "structured",
  };
}

function matchedDepartmentFromQuestion(question, knowledge) {
  const departments = [
    ...new Set([
      ...(knowledge.faculty || []).map((person) => person.department),
      ...(knowledge.programs || []).map((program) => program.department),
    ].filter(Boolean)),
  ].filter((dept) => !/library|research|office|administration|student\s+union|sports/i.test(dept));
  const q = normalizeQuestion(question);
  const ignoredTokens = new Set([
    ...searchStopWords,
    "department", "dept", "faculty", "teacher", "teachers", "sir", "mam", "list", "dao", "dau", "er",
    "fee", "fees", "cost", "tuition", "tution", "khoroch", "payment", "charge", "taka",
    "seat", "seats", "admission", "vorti", "requirement", "requirements", "eligibility",
    "credit", "credits", "head", "chairman", "chairperson", "dean", "duration", "semester", "semesters",
    "course", "courses", "subject", "subjects", "syllabus", "routine", "notice", "notices",
    "who", "what", "which", "how", "many", "much", "tell", "show", "give", "details", "info", "information"
  ]);
  const qTokens = new Set(tokenize(q).filter((token) => !ignoredTokens.has(token)));
  return departments
    .map((department) => {
      const aliases = departmentAliases(department);
      let score = 0;
      for (const alias of aliases) {
        const normalizedAlias = normalizeQuestion(alias);
        if (!normalizedAlias) continue;
        if (termInQuestion(q, normalizedAlias)) score = Math.max(score, 100 + normalizedAlias.length);
        const aliasTokens = tokenize(normalizedAlias).filter((token) => !["department", "dept", "of", "and"].includes(token) && !ignoredTokens.has(token));
        for (const token of aliasTokens) {
          if (qTokens.has(token)) score += token.length > 3 ? 18 : 10;
          else if (token.length >= 4 && fuzzyIncludes([...qTokens], token)) score += token.length > 3 ? 10 : 4;
        }
      }
      return { department, score };
    })
    .filter((item) => item.score >= 25)
    .sort((a, b) => b.score - a.score)[0]?.department;
}

function activeContextDepartment(history = [], question = "", knowledge = null) {
  if (knowledge && question) {
    const directDept = matchedDepartmentFromQuestion(question, knowledge);
    if (directDept) return directDept;
  }
  const items = previousConversation(history, question);
  if (!items || !items.length) return null;

  // First pass: inspect recent USER turns in reverse
  const recentUserTurns = items.filter((t) => t.role === "user").slice(-6).reverse();
  for (const turn of recentUserTurns) {
    const text = String(turn.text || "");
    if (knowledge) {
      const found = matchedDepartmentFromQuestion(text, knowledge);
      if (found) return found;
    }
    if (/\bcse|computer\s+science\b/i.test(text)) return "Department of Computer Science and Engineering";
    if (/\bpharmacy|bpharm|mpharm\b/i.test(text)) return "Department of Pharmacy";
    if (/\bbba|business\b/i.test(text)) return "Department of Business Administration";
    if (/\blaw\b/i.test(text)) return "Department of Law";
    if (/\bmicrobiology\b/i.test(text)) return "Department of Microbiology";
    if (/\benglish\b/i.test(text)) return "Department of English";
    if (/\bmedical\s+physics|biomedical\b/i.test(text)) return "Department of Medical Physics and Biomedical Engineering";
  }

  // Second pass: inspect recent assistant turns
  const recentAll = [...items].slice(-6).reverse();
  for (const turn of recentAll) {
    const text = String(turn.text || "");
    if (knowledge) {
      const found = matchedDepartmentFromQuestion(text, knowledge);
      if (found) return found;
    }
  }
  return null;
}

function departmentAliases(department) {
  const aliases = new Set([department, department.replace(/^Department of\s+/i, "")]);
  if (/\bComputer Science|CSE\b/i.test(department)) aliases.add("cse").add("computer science").add("computer science and engineering");
  if (/Business Administration/i.test(department)) aliases.add("bba").add("business").add("business administration");
  if (/Bangla/i.test(department)) aliases.add("bangla").add("bengali");
  if (/Politics/i.test(department)) aliases.add("politics").add("governance").add("politics and governance").add("political science");
  if (/Veterinary/i.test(department)) {
    aliases.add("vet").add("veterinary").add("vet science").add("veterinary science").add("animal science").add("animal sciences").add("dvm");
  }
  if (/Pharmacy/i.test(department)) aliases.add("pharmacy").add("pharma").add("farmacy");
  if (/Microbiology/i.test(department)) aliases.add("microbiology").add("microbio");
  if (/Electrical and Electronic Engineering|\bEEE\b/i.test(department)) {
    aliases.add("eee").add("electrical engineering").add("electrical and electronic engineering");
  }
  if (/Medical Physics|Biomedical/i.test(department)) {
    aliases
      .add("medical physics")
      .add("biomedical")
      .add("biomedical engineering")
      .add("medical physics and biomedical engineering")
      .add("mpbme")
      .add("bme");
  }
  if (/Agriculture/i.test(department)) aliases.add("agriculture").add("agri");
  if (/English/i.test(department)) aliases.add("english");
  if (/\bMathematics\b/i.test(department)) aliases.add("math").add("mathematics").add("applied math").add("applied mathematics");
  if (/\bChemistry\b/i.test(department)) aliases.add("chemistry").add("chem");
  if (/\bPhysics\b/i.test(department)) aliases.add("physics").add("phy");
  if (/\bBiochemistry\b/i.test(department)) aliases.add("bmb").add("biochem").add("biochemistry").add("molecular biology");
  if (/Applied Mathematics/i.test(department)) aliases.add("math").add("maths").add("applied math").add("applied mathematics");
  if (/Sociology|Social Work/i.test(department)) aliases.add("sociology").add("social work").add("sociology and social work");
  if (/\bLaw\b/i.test(department)) aliases.add("law").add("llb").add("llm");
  return [...aliases].filter(Boolean);
}

function displayDepartmentName(department) {
  const value = String(department || "").replace(/\s+/g, " ").trim();
  const repeatedAt = value.indexOf("Department of", "Department of".length);
  return repeatedAt > 0 ? value.slice(0, repeatedAt).trim() : value;
}

function departmentPeople(knowledge, department) {
  const wanted = displayDepartmentName(department).toLowerCase();
  return dedupePeople(
    (knowledge.faculty || []).filter((person) => displayDepartmentName(person.department).toLowerCase() === wanted),
  );
}

function departmentLeaders(people, department) {
  const leaders = people.filter((person) => /\b(head|chairman|chairperson|chair|dean)\b/i.test(person.designation || ""));
  if (!/^Faculty of\b/i.test(displayDepartmentName(department))) return leaders;
  const deans = leaders.filter((person) => /\bdean\b/i.test(person.designation || ""));
  return deans.length ? deans : leaders;
}

function isTeachingFaculty(person) {
  return !/\b(?:lab|it|administrative|admin|section|support)\s+(?:officer|assistant)|\bofficer\b/i.test(person.designation || "");
}

function departmentAcademicRecords(knowledge, department) {
  const aliases = departmentAliases(department);
  const normalizedDepartment = displayDepartmentName(department).toLowerCase();
  const markers = [
    /Computer Science/i.test(department) && "cse",
    /Electrical and Electronic/i.test(department) && "eee",
    /Medical Physics|Biomedical/i.test(department) && "mpbme",
    /Biochemistry/i.test(department) && "bmb",
    /Business Administration/i.test(department) && "bba",
    /Applied Mathematics/i.test(department) && "math",
    /Sociology/i.test(department) && "sociology",
    /Veterinary/i.test(department) && "veterinary",
    /Agriculture/i.test(department) && "agriculture",
    /Pharmacy/i.test(department) && "pharmacy",
    /Microbiology/i.test(department) && "microbiology",
    /Chemistry/i.test(department) && "chemistry",
    /Physics/i.test(department) && "physics",
    /English/i.test(department) && "english",
    /Bangla/i.test(department) && "bangla",
    /Politics/i.test(department) && "politics",
    /Law/i.test(department) && "law",
  ].filter(Boolean);
  return pageRecords(knowledge)
    .filter((record) => {
      if (record.textQuality === "low" || record.textQuality === "none") return false;
      const identity = normalizeQuestion(`${record.title} ${record.url} ${record.department || ""}`);
      return aliases.some((alias) => alias.length >= 3 && termInQuestion(identity, alias));
    })
    .sort((a, b) => {
      const score = (record) =>
        Number(displayDepartmentName(record.department || "").toLowerCase() === normalizedDepartment) * 30 +
        Number(markers.some((marker) => new RegExp(`/${marker}/`, "i").test(record.url || ""))) * 20;
      return score(b) - score(a);
    });
}

function extractCoursesFromText(text) {
  const courses = [];
  for (const rawLine of String(text || "").split(/\n+/)) {
    const line = cleanExtractedText(rawLine).replace(/^\d+\.?\s*\|\s*/, "").trim();
    let match = line.match(/^([A-Z]{2,8}\s*\d{3,4}[A-Z]?)\s*\|\s*(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*(?:\||$)/i);
    if (match) {
      courses.push({ code: match[1].replace(/\s+/g, " "), title: match[2].trim(), credits: match[3] });
      continue;
    }
    match = line.match(/^([A-Z]{2,8}\s*\d{3,4}[A-Z]?)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)$/i);
    if (match) courses.push({ code: match[1].replace(/\s+/g, " "), title: match[2].trim(), credits: match[4] });
  }
  return [...new Map(courses.map((course) => [course.code.replace(/\s/g, "").toUpperCase(), course])).values()]
    .filter((course) => course.title.length >= 3 && course.title.length <= 110 && !/^total$/i.test(course.title));
}

function departmentCourses(knowledge, department) {
  const records = departmentAcademicRecords(knowledge, department)
    .filter((record) => /course|curriculum|syllabus/i.test(`${record.title} ${record.url}`));
  const courses = extractCoursesFromText(records.map((record) => record.text).join("\n"));
  const sources = records
    .filter((record) => extractCoursesFromText(record.text).length)
    .map((record) => ({ title: record.title, url: record.url }))
    .filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index)
    .slice(0, 1);
  return { courses, sources };
}

function departmentCreditFact(knowledge, department) {
  const candidates = departmentAcademicRecords(knowledge, department)
    .filter((record) => /course|curriculum|syllabus|program|academic|credit/i.test(`${record.title} ${record.url}`))
    .map((record) => ({ record, facts: extractProgramPlanFacts(record.text) }))
    .filter((item) => item.facts.credit);
  const values = [...new Set(candidates.map((item) => item.facts.credit))];
  return values.length === 1 ? { value: values[0], source: candidates[0].record } : null;
}

function mentionedDepartments(question, knowledge) {
  return academicDepartments(knowledge)
    .map((department) => ({
      department,
      score: Math.max(...departmentAliases(department).map((alias) => scoreAliasMatch(question, alias))),
    }))
    .filter((item) => item.score >= 100)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.department);
}

function programForDepartment(knowledge, department, wantsGraduate = false) {
  const programs = verifiedPrograms(knowledge.programs || []).filter(
    (program) => displayDepartmentName(program.department).toLowerCase() === displayDepartmentName(department).toLowerCase(),
  );
  return programs.find((program) =>
    wantsGraduate ? isGraduateProgramName(program.name) : !isGraduateProgramName(program.name),
  ) || programs[0];
}

function directProgramComparisonAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  if (!/\b(compare|comparison|versus|vs|difference|better|choose|between|kont[a]?|konta|parthokko)\b/i.test(q)) return null;
  let departments = mentionedDepartments(q, knowledge).slice(0, 3);
  if (departments.length < 2 && history.length) {
    const items = previousConversation(history, question);
    if (items && items.length) {
      const recent = [...items].slice(-10).reverse();
      for (const turn of recent) {
        const text = String(turn.text || "");
        const found =
          matchedDepartmentFromQuestion(text, knowledge) ||
          (/\bcse|computer\s+science\b/i.test(text)
            ? "Department of Computer Science and Engineering"
            : /\bpharmacy|bpharm|mpharm\b/i.test(text)
            ? "Department of Pharmacy"
            : /\bbba|business\b/i.test(text)
            ? "Department of Business Administration"
            : /\blaw\b/i.test(text)
            ? "Department of Law"
            : /\bmicrobiology\b/i.test(text)
            ? "Department of Microbiology"
            : /\benglish\b/i.test(text)
            ? "Department of English"
            : /\bmedical\s+physics|biomedical\b/i.test(text)
            ? "Department of Medical Physics and Biomedical Engineering"
            : null);
        if (found && !departments.includes(found)) {
          departments = [found, ...departments];
          break;
        }
      }
    }
  }
  if (departments.length < 2) return null;
  const wantsGraduate = /\b(?:msc|mpharm|master|graduate|postgraduate|llm|mss|ma)\b/i.test(q);
  const sections = departments.map((department) => {
    const program = programForDepartment(knowledge, department, wantsGraduate);
    const credit = departmentCreditFact(knowledge, department);
    const { courses } = departmentCourses(knowledge, department);
    const facts = [
      program?.duration && `Duration: **${cleanOfficialDisplayText(program.duration)}**`,
      program?.seats && `Published seats: **${cleanOfficialDisplayText(program.seats)}**`,
      credit?.value && `Official course-plan credits: **${credit.value}**`,
      courses.length && `Course examples: ${courses.slice(0, 6).map((course) => course.title).join(", ")}`,
      program?.admissionRequirement && `Eligibility: ${cleanOfficialDisplayText(program.admissionRequirement)}`,
    ].filter(Boolean);
    return `**${program?.name || displayDepartmentName(department)}**\n${facts.map((fact) => `- ${fact}`).join("\n")}`;
  });
  const sources = departments.flatMap((department) => {
    const program = programForDepartment(knowledge, department, wantsGraduate);
    const credit = departmentCreditFact(knowledge, department);
    const catalog = departmentCourses(knowledge, department);
    return [
      program && { title: program.sourceTitle || program.name, url: program.source },
      credit && { title: credit.source.title, url: credit.source.url },
      ...catalog.sources,
    ].filter(Boolean);
  }).filter((source, index, list) => source.url && list.findIndex((item) => item.url === source.url) === index).slice(0, 5);
  const interestMap = [
    { pattern: /\b(programming|coding|software|data|ai|artificial\s+intelligence|web|computer)\b/i, department: /Computer Science/i, focus: "coding, software, data, or AI" },
    { pattern: /\b(circuit|electronics|electrical|power|telecom|communication)\b/i, department: /Electrical and Electronic/i, focus: "circuits, electronics, power, or communications" },
    { pattern: /\b(medicine|drug|pharma|pharmacy|chemistry|healthcare|hospital)\b/i, department: /Pharmacy/i, focus: "medicines, pharmaceutical science, or healthcare" },
  ];
  const interest = interestMap.find((item) => item.pattern.test(q));
  const recommended = interest && departments.find((department) => interest.department.test(department));
  const recommendation = recommended
    ? `\n\n**Best fit for your stated interest:** **${displayDepartmentName(recommended)}**, because you mentioned ${interest.focus}. This is an interest-based recommendation, not a universal ranking.`
    : `\n\n**How to choose:** compare the actual course examples with what you enjoy and the work you want to do. “Better” is personal; the verified differences above are more useful than a generic ranking.`;
  return {
    text: `${sections.join("\n\n")}${recommendation}`,
    sources,
    mode: "structured",
  };
}

function directComparisonFollowupAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const comparative = /\b(which|which\s+one|more|less|higher|lower|shorter|longer|better|konta|kontar|beshi|kom)\b/i.test(q);
  if (!comparative || !history.length) return null;
  const prior = [...history].reverse().find((item) => item.role === "user" && mentionedDepartments(item.text || "", knowledge).length >= 2);
  if (!prior) return null;
  const departments = mentionedDepartments(prior.text, knowledge).slice(0, 3);

  if (/\bcredits?|credit\s+hours?|beshi\s+credit\b/i.test(q)) {
    const facts = departments.map((department) => ({ department, fact: departmentCreditFact(knowledge, department) })).filter((item) => item.fact);
    if (facts.length < 2) return null;
    const sorted = [...facts].sort((a, b) => Number(b.fact.value) - Number(a.fact.value));
    return {
      text: `${facts.map(({ department, fact }) => `- **${displayDepartmentName(department)}:** ${fact.value} credits`).join("\n")}\n\n**${displayDepartmentName(sorted[0].department)}** has ${Number(sorted[0].fact.value) - Number(sorted[1].fact.value)} more published credits than **${displayDepartmentName(sorted[1].department)}** in the indexed course plans.`,
      sources: facts.map(({ fact }) => ({ title: fact.source.title, url: fact.source.url })).filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index),
      mode: "structured",
    };
  }

  if (/\b(seats?|intake|capacity)\b/i.test(q)) {
    const facts = departments.map((department) => ({ department, program: programForDepartment(knowledge, department) })).filter((item) => item.program?.seats);
    if (facts.length < 2) return null;
    const sorted = [...facts].sort((a, b) => Number(b.program.seats) - Number(a.program.seats));
    return {
      text: `${facts.map(({ department, program }) => `- **${displayDepartmentName(department)}:** ${program.seats} published seats`).join("\n")}\n\n**${displayDepartmentName(sorted[0].department)}** has the larger published intake in these official admission records.`,
      sources: facts.map(({ program }) => ({ title: program.sourceTitle || program.name, url: program.source })).filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index),
      mode: "structured",
    };
  }

  const interestMap = [
    { pattern: /\b(programming|software|data|ai|artificial\s+intelligence|web|computer)\b/i, department: /Computer Science/i, focus: "programming, software, data, or AI" },
    { pattern: /\b(circuit|electronics|electrical|power|telecom|communication)\b/i, department: /Electrical and Electronic/i, focus: "circuits, electronics, power, or communications" },
  ];
  const interest = interestMap.find((item) => item.pattern.test(q));
  const match = interest && departments.find((department) => interest.department.test(department));
  if (match) {
    const { courses, sources } = departmentCourses(knowledge, match);
    return {
      text: `Based on the official course titles, **${displayDepartmentName(match)}** is the closer match for ${interest.focus}. Relevant examples include ${courses.slice(0, 7).map((course) => course.title).join(", ")}. This is an interest-based recommendation, not a claim that one degree is universally better.`,
      sources,
      mode: "structured",
    };
  }
  return null;
}

function directCourseCatalogAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const matchedDepartment = matchedDepartmentFromQuestion(q, knowledge);
  if (!matchedDepartment) return null;
  const asksCourses = /\b(courses?|subjects?|curriculum|syllabus|course\s+list|ki\s+ki\s+pore|what.*study)\b/i.test(q);
  const explicitCourseTopic =
    !/\b(teacher|teachers|faculty|member|members|head|chairman|fee|fees|cost|tuition|vorti|admission|eligibility)\b/i.test(q) &&
    /\b(data\s+structures?|algorithm|database|network|operating\s+system|artificial\s+intelligence|programming|electronics|circuit|pharmacology)\b/i.test(q);
  if (!asksCourses && !explicitCourseTopic) return null;
  const { courses, sources } = departmentCourses(knowledge, matchedDepartment);
  if (!courses.length) return null;

  const ignored = new Set(["course", "courses", "subject", "subjects", "curriculum", "syllabus", "what", "study", "department", "list", "show", "gono", "university", "detail", "details", "official", "code", "credit", "credits", "koto", "hours", "hour"]);
  for (const alias of departmentAliases(matchedDepartment)) tokenize(alias).forEach((token) => ignored.add(token));
  const topicTerms = tokenize(q).filter((token) => token.length >= 4 && !ignored.has(token));
  const stem = (token) => token.replace(/(?:es|s)$/i, "");
  const matchedCourses = topicTerms.length
    ? courses.filter((course) => {
        const titleTerms = tokenize(course.title).map(stem);
        return topicTerms.map(stem).every((term) => titleTerms.includes(term));
      })
    : [];
  if (matchedCourses.length && explicitCourseTopic) {
    const lines = matchedCourses.slice(0, 6).map((course) => `- **${course.code}: ${course.title}** - ${course.credits} credits`);
    return {
      text: `The official **${displayDepartmentName(matchedDepartment)}** syllabus includes:\n${lines.join("\n")}\n\nThese are syllabus records; the exact semester/session should be checked against the linked official course plan.`,
      sources,
      mode: "structured",
    };
  }

  const wantsFull = /\b(all|full|complete|sob|shob)\b/i.test(q);
  const limit = wantsFull ? 36 : 16;
  const shown = courses.slice(0, limit);
  return {
    text: `I found **${courses.length} course records** in the indexed official **${displayDepartmentName(matchedDepartment)}** curriculum. ${wantsFull && courses.length > limit ? `Showing the first ${limit}:` : "Representative courses:"}\n${shown.map((course) => `- **${course.code}** - ${course.title} (${course.credits} credits)`).join("\n")}${courses.length > limit ? `\n- Plus ${courses.length - limit} more in the linked official syllabus.` : ""}`,
    sources,
    mode: "structured",
  };
}

function directDepartmentProfileAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const matchedDepartment = matchedDepartmentFromQuestion(q, knowledge);
  const asksOverview = /\b(about|overview|profile|details|somporke|somproke|niye\s+bolo|info|information)\b/i.test(q);
  if (!matchedDepartment || !asksOverview || asksFeeDetail(q) || asksContactDetail(q) || asksProgramDetail(q)) return null;
  const program = programForDepartment(knowledge, matchedDepartment, /\b(master|msc|graduate|postgraduate)\b/i.test(q));
  const people = departmentPeople(knowledge, matchedDepartment).filter(isTeachingFaculty);
  const heads = departmentLeaders(people, matchedDepartment);
  const credit = departmentCreditFact(knowledge, matchedDepartment);
  const { courses, sources: courseSources } = departmentCourses(knowledge, matchedDepartment);
  const facts = [
    program && `**Program:** ${program.name}`,
    program?.duration && `**Duration:** ${cleanOfficialDisplayText(program.duration)}`,
    program?.seats && `**Published seats:** ${cleanOfficialDisplayText(program.seats)}`,
    credit?.value && `**Total credits:** ${credit.value}`,
    heads.length && `**Department head:** ${heads.map((person) => person.name).join(", ")}`,
    people.length && `**Indexed teaching faculty:** ${people.length}`,
    courses.length && `**Course examples:** ${courses.slice(0, 8).map((course) => course.title).join(", ")}`,
    program?.admissionRequirement && `**Admission requirement:** ${cleanOfficialDisplayText(program.admissionRequirement)}`,
  ].filter(Boolean);
  if (!facts.length) return null;
  const sources = [
    program && { title: program.sourceTitle || program.name, url: program.source },
    ...heads.map((person) => ({ title: person.name, url: person.profileUrl || person.source })),
    credit && { title: credit.source.title, url: credit.source.url },
    ...courseSources,
  ].filter(Boolean).filter((source, index, list) => source.url && list.findIndex((item) => item.url === source.url) === index).slice(0, 5);
  return { text: `**${displayDepartmentName(matchedDepartment)}**\n${facts.join("\n")}`, sources, mode: "structured" };
}

function directDepartmentOverviewAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  if (
    asksFeeDetail(q) ||
    asksContactDetail(q) ||
    asksProgramDetail(q) ||
    /\b(fee|fees|cost|tuition|tution|waiver|scholarship|stipend|eligibility|qualification|vorti|admission|deadline|routine|notice|career|job|future|campus|transport|hostel|library|bujhlam|sahaj|summary)\b/i.test(q) ||
    /\b(course|syllabus|subject|topic|study|learn|pore|porano|porashona|somporke|somproke|data\s+structure|biomedical|bio\s*medical)\b/i.test(q)
  ) {
    return null;
  }
  const matchedDepartment = matchedDepartmentFromQuestion(q, knowledge);
  if (!matchedDepartment) return null;

  const allPeople = departmentPeople(knowledge, matchedDepartment);
  const displayDepartment = displayDepartmentName(matchedDepartment);
  const sourceUrl = allPeople.find((person) => person.source)?.source || "";
  const sourceTitle = displayDepartment.includes("CSE") ? "CSE Faculty Members" : displayDepartment;
  const asksFaculty =
    /\b(faculty|teacher|teachers|member|members|list|koyjon|kojon|niye|about|details|bolo|ache|ase)\b/i.test(q) ||
    /\b(cse|computer science|pharmacy)\b/i.test(q);
  const people = /\b(faculty|teacher|teachers)\b/i.test(q) ? allPeople.filter(isTeachingFaculty) : allPeople;
  if (!asksFaculty || !people.length) return null;

  const leaders = departmentLeaders(people, matchedDepartment);
  const leadText = leaders.length
    ? ` Head: ${leaders.map((person) => person.name).join(", ")}.`
    : "";
  const names = people
    .filter((person) => !/admission office/i.test(person.department || ""))
    .map((person) => person.name)
    .slice(0, 18);

  if (/\b(ache|ase|available|offer|has|have|ki)\b/i.test(q) && !/\b(list|koyjon|kojon|number|email|contact)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? `Yes, official data-te **${displayDepartment}** ache.${leadText}`
        : `Yes, the official data includes **${displayDepartment}**.${leadText}`,
      sources: sourceUrl ? [{ title: sourceTitle, url: sourceUrl }] : [],
      mode: "structured",
    };
  }

  return {
    text: prefersBanglish(question)
      ? `${displayDepartment}-er official faculty data-te ${people.length} jon record ache.${leadText} Faculty: ${names.join(", ")}.`
      : `Official data lists ${people.length} records for ${displayDepartment}.${leadText} Faculty: ${names.join(", ")}.`,
    sources: sourceUrl ? [{ title: sourceTitle, url: sourceUrl }] : [],
    mode: "structured",
  };
}

function directAllPeopleOverviewAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksAll =
    /\b(all|sob|shob|sobar|shobar|sokol|sobai|shobai|full|complete)\b/i.test(q) &&
    /\b(department|dept|faculty|teacher|teachers|sir|mam|maam|madam|people|staff|list)\b/i.test(q);
  if (!asksAll) return null;

  const groups = new Map();
  for (const person of knowledge.faculty || []) {
    const department = person.department || "Gono University";
    const list = groups.get(department) || [];
    list.push(person);
    groups.set(department, list);
  }
  if (!groups.size) return null;

  const lines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([department, people]) => {
      const names = people.map((person) => person.name).join(", ");
      return `**${department}** (${people.length}): ${names}`;
    });

  return {
    text: prefersBanglish(question)
      ? `Official data-te ${groups.size} ta department/group-e ${knowledge.faculty.length} jon people record ache:\n${lines.join("\n")}`
      : `Official data has ${knowledge.faculty.length} people records across ${groups.size} departments/groups:\n${lines.join("\n")}`,
    sources: [...groups.values()]
      .map((people) => people.find((person) => person.source))
      .filter(Boolean)
      .map((person) => ({ title: person.department || person.name, url: person.source }))
      .slice(0, 10),
    mode: "structured",
  };
}

function extractProgramPlanFacts(text) {
  const normalized = cleanExtractedText(text).replace(/\s+/g, " ");
  const creditPatterns = [
    /\bDuration\s*\|\s*Total Contact Hours[^|]{0,80}\|\s*Total Credits?\s+\d+\s+years?\s*\|\s*[\d/]+\s*\|\s*(\d{2,3})\b/i,
    /\bTotal minimum credit requirement[^.]{0,100}?\b(?:is|:)?\s*(\d{2,3})\b/i,
    /\bGrand Total\s+[\d/]+\s+(\d{2,3})\s+\d+\b/i,
    /\bTotal Credits?\s+Total Marks\s+\d+\s+years?\s+[\d/]+\s+(\d{2,3})\s+\d+/i,
    /\bTotal Credit(?:s| for Graduation)?\s*[:\-]?\s*(\d{2,3})\b/i,
    /\b(\d{2,3})\s+Total Credits?\b/i,
  ];
  const durationPatterns = [
    /\bDuration\s+(?:Total Contact Hours\s+Theory\s*\/Lab\s+Total Credits?\s+Total Marks\s+)?(\d+\s+years?)\b/i,
    /\b(\d+\s+years?)\s+has\s+\d+\s+semesters\b/i,
  ];
  const credit = creditPatterns.map((pattern) => normalized.match(pattern)?.[1]).find(Boolean);
  const duration = durationPatterns.map((pattern) => normalized.match(pattern)?.[1]).find(Boolean);
  return { credit, duration };
}

function recordConflictsWithDepartment(record, matchedDepartment) {
  const identity = normalizeQuestion(`${record.title || ""} ${record.url || ""}`);
  const expected = normalizeQuestion(displayDepartmentName(matchedDepartment));
  const markers = [
    { pattern: /\bcse\b|computer\s+science/i, expected: /\bcse\b|computer\s+science/i },
    { pattern: /\beee\b|electrical\s+and\s+electronic/i, expected: /\beee\b|electrical\s+and\s+electronic/i },
    { pattern: /\bpharmacy\b|\bbpharm\b|\bmpharm\b/i, expected: /\bpharmacy\b/i },
    { pattern: /\bmicrobiology\b/i, expected: /\bmicrobiology\b/i },
    { pattern: /\bmedical\s+physics\b|\bbiomedical\b|\bmpbme\b/i, expected: /\bmedical\s+physics\b|\bbiomedical\b/i },
  ];
  return markers.some((marker) => marker.pattern.test(identity) && !marker.expected.test(expected));
}

function directProgramDetailAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  if (!asksProgramDetail(q)) return null;
  const matchedDepartment = matchedDepartmentFromQuestion(q, knowledge);
  if (!matchedDepartment) return null;

  const departmentTerms = departmentAliases(matchedDepartment);
  const allRecords = pageRecords(knowledge);
  const records = allRecords
    .filter((record) => {
      if (record.textQuality === "low" || record.textQuality === "none") return false;
      if (recordConflictsWithDepartment(record, matchedDepartment)) return false;
      const identity = `${record.title} ${record.url} ${record.department || ""}`;
      return (
        departmentTerms.some((term) => term.length >= 3 && termInQuestion(identity, term)) &&
        /course|curriculum|syllabus|program|academic|credit|duration/i.test(`${record.title} ${record.url}`)
      );
    })
    .map((record) => ({ record, facts: extractProgramPlanFacts(record.text) }))
    .filter((item) => item.facts.credit || item.facts.duration);
  const asksCredit = /\bcredits?\b/i.test(q);
  const asksDuration = /\b(duration|years?|semesters?)\b/i.test(q);
  if (!asksCredit && !asksDuration) return null;
  const candidates = records.filter((item) => asksCredit ? item.facts.credit : item.facts.duration);
  const distinctValues = new Set(candidates.map((item) => asksCredit ? item.facts.credit : item.facts.duration));
  if (distinctValues.size > 1) {
    return {
      text: `The indexed official sources list different ${asksCredit ? "credit totals" : "durations"} for **${displayDepartmentName(matchedDepartment)}** (${[...distinctValues].join(", ")}). Which degree and syllabus/session do you mean?`,
      sources: candidates.map(({ record }) => ({ title: record.title, url: record.url }))
        .filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index).slice(0, 4),
      mode: "clarify",
    };
  }
  const best = candidates[0];
  if (!best) {
    const displayDepartment = displayDepartmentName(matchedDepartment);
    const departmentTerms = departmentAliases(matchedDepartment).map((alias) => normalizeQuestion(alias));
    const sourceRecords = allRecords.filter((record) => {
      if (recordConflictsWithDepartment(record, matchedDepartment)) return false;
      const combined = normalizeQuestion(`${record.title} ${record.url} ${record.department || ""}`);
      return departmentTerms.some((term) => term.length >= 3 && termInQuestion(combined, term));
    });
    const syllabusSource = sourceRecords.find((record) => /syllabus|curriculum|course|download/i.test(`${record.title} ${record.url}`));
    const admissionSource = sourceRecords.find((record) => {
      const combined = normalizeQuestion(`${record.title} ${record.text}`);
      return /admission|requirement|program/i.test(`${record.title} ${record.url}`) && /4\s+years?|8\s+semesters?/i.test(combined);
    });
    const sources = [syllabusSource, admissionSource]
      .filter(Boolean)
      .filter((record, index, list) => list.findIndex((item) => item.url === record.url) === index)
      .slice(0, 2)
      .map((record) => ({
        title: /download|syllabus|curriculum/i.test(`${record.title} ${record.url}`)
          ? `${displayDepartment.replace(/^Department of\s+/i, "")} syllabus downloads`
          : /admission/i.test(`${record.title} ${record.url}`)
            ? "Undergraduate Admission Requirements"
            : displayDepartment,
        url: record.url,
      }));
    const asksCredit = /\bcredit|credits|credit\s+hour|credit\s+hours\b/i.test(q);
    const asksLeader = /\b(chairman|chairperson|chair|head|hod)\b/i.test(q);
    const leaderAnswer = asksLeader ? directDepartmentLeaderAnswer(question, knowledge) : null;
    const missingFact = prefersBanglish(question)
      ? `**${displayDepartment}**-er exact ${asksCredit ? "total credits" : "duration"} indexed official source theke verify korte parini. Applicable degree/session ba syllabus dile check korte parbo.`
      : `I could not verify the exact ${asksCredit ? "total credits" : "duration"} for **${displayDepartment}** from the indexed official sources. Specify the degree/session or share its syllabus so I can check.`;
    const leaderText = asksLeader
      ? (leaderAnswer?.text || (prefersBanglish(question)
        ? `**${displayDepartment}**-er current head structured official record theke ekokvabe verify kora jayni.`
        : `The current head of **${displayDepartment}** could not be verified unambiguously from the structured official records.`))
      : "";

    return {
      text: leaderText ? `${leaderText}\n${missingFact}` : missingFact,
      sources: [...(leaderAnswer?.sources || []), ...sources]
        .filter((source, index, list) => source.url && list.findIndex((item) => item.url === source.url) === index),
      mode: "not_found",
    };
  }

  const parts = [];
  if (best.facts.credit && (asksCredit || !asksDuration)) parts.push(`total credits **${best.facts.credit}**`);
  if (best.facts.duration && (asksDuration || !asksCredit)) parts.push(`duration **${best.facts.duration}**`);
  if (!parts.length && best.facts.credit) parts.push(`total credits **${best.facts.credit}**`);

  const baseText = prefersBanglish(question)
      ? `Official course-plan onujayi **${displayDepartmentName(matchedDepartment)}**-er ${parts.join(" and ")}.`
      : `The official course plan for **${displayDepartmentName(matchedDepartment)}** lists ${parts.join(" and ")}.`;
  const asksLeader = /\b(chairman|chairperson|chair|head|hod)\b/i.test(q);
  const leaderAnswer = asksLeader ? directDepartmentLeaderAnswer(question, knowledge) : null;
  const leaderText = leaderAnswer?.text || (asksLeader
    ? (prefersBanglish(question)
      ? `**${displayDepartmentName(matchedDepartment)}**-er current head structured official record theke ekokvabe verify kora jayni.`
      : `The current head of **${displayDepartmentName(matchedDepartment)}** could not be verified unambiguously from the structured official records.`)
    : "");
  return {
    text: leaderText ? `${leaderText}\n${baseText}` : baseText,
    sources: [
      ...(leaderAnswer?.sources || []),
      { title: best.record.title || "Official course plan", url: best.record.url },
    ].filter((source, index, list) => source.url && list.findIndex((item) => item.url === source.url) === index),
    mode: asksLeader && !leaderAnswer ? "source_aware" : "structured",
  };
}

function isGreetingQuestion(question) {
  const q = normalizeQuestion(question).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  return /^(hi|hello|hey|salam|assalamualaikum|assalamu alaikum|আসসালামু আলাইকুম|হাই|হ্যালো|সালাম)(\s+.*)?$/iu.test(q);
}

function directGreetingAnswer(question) {
  if (!isGreetingQuestion(question)) return null;
  const q = normalizeQuestion(question).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  const banglish = prefersBanglish(question) || /\b(salam|assalamualaikum|assalamu)\b/i.test(q);
  return {
    text: banglish
      ? "Hi! Ami GB Knowledge Assistant. Gono Bishwabidyalay-er official info, department, faculty, fee, admission, notice, ba course concept niye question korte paro."
      : "Hi! I am GB Knowledge Assistant. Ask me about Gono Bishwabidyalay official information, departments, faculty, fees, admission, notices, or course concepts.",
    sources: [],
    mode: "greeting",
  };
}

function isUnclearQuestion(question) {
  const raw = String(question || "").trim();
  const normalized = normalizeQuestion(raw).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!raw) return true;
  if (!normalized) return true;
  if (/^[?.!,।\s]+$/u.test(raw)) return true;
  if (/^(what|ki|কী|কি|hmm|hm|ok|okay|why|কেন)$/iu.test(normalized)) return true;
  const terms = expandedTerms(normalized);
  return terms.length === 0 && raw.length <= 12;
}

function bareAcademicTopic(question) {
  const q = normalizeQuestion(question).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!q || tokenize(q).length > 4) return "";
  const hasSpecificIntent =
    /\b(what\s+is|ki|kake\s+bole|explain|define|overview|about|details|courses?|subject|syllabus|credits?|duration|seats?|seat|asan|ashon|intake|capacity|qualification|eligibility|requirements?|joggota|lagbe|faculty|teacher|head|fee|fees?|fe|cost|costs?|tuition|tution|taka|tk|khoroch|khroch|kharach|kharoch|charge|charges|expense|expenses|payment|payments|package|admission|vorti|career|learn|study|somporke|somproke|bolo|dao|koto|how|why|list|show|compare|comparison|versus|vs|better|difference)\b/i.test(q);
  if (hasSpecificIntent) return "";
  if (/\b(medical\s+physics|biomedical(?:\s+engineering)?)\b/i.test(q)) return "Medical Physics and Biomedical Engineering";
  if (/\b(cse|computer\s+science)\b/i.test(q)) return "CSE";
  if (/\bpharmacy\b/i.test(q)) return "Pharmacy";
  if (/\b(microbiology|agriculture|law|english)\b/i.test(q)) return q;
  return "";
}

function directClarificationAnswer(question, history = []) {
  if (asksFeeDetail(question)) return null;
  if (history && history.length > 0) return null;
  const topic = bareAcademicTopic(question);
  if (!isUnclearQuestion(question) && !topic) return null;
  const banglish = prefersBanglish(question);
  if (topic) {
    return {
      text: banglish
        ? `**${topic}** niye ki jante chaccho - general concept, Gono-r department, course/credit, faculty, admission/fee, naki career?`
        : `What would you like to know about **${topic}** - the general concept, Gono's department, courses/credits, faculty, admission/fees, or careers?`,
      sources: [],
      mode: "clarify",
      clarifyTopic: topic,
    };
  }
  return {
    text: banglish
      ? "Tumi ki jante chaccho? Ektu specific kore bolo. Ami Gono Bishwabidyalay-er department, faculty, fee, admission, notice, ba course/subject concept niye help korte pari."
      : "What would you like to know? Please ask a little more specifically. I can help with Gono Bishwabidyalay departments, faculty, fees, admission, notices, or course/subject concepts.",
    sources: [],
    mode: "clarify",
  };
}

function directWaiverAndFinancialAidAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const asksWaiver = /\b(waiver|waivers|scholarship|scholarships|stipend|financial\s+aid|discount|chhar|fee\s+reduction|merit\s+waiver|gpa\s+waiver|female\s+stipend|poor\s+fund)\b/i.test(q);
  if (!asksWaiver) return null;
  const banglish = prefersBanglish(question);

  return {
    text: banglish
      ? `Gono Bishwabidyalay-তে সেমিস্টার পরীক্ষার ফলাফলের (GPA 3.50+) ভিত্তিতে **১০% থেকে সর্বোচ্চ ৫০%** পর্যন্ত টিউশন ফি ওয়েভার পাওয়া যায়। এছাড়া বীর মুক্তিযোদ্ধার সন্তানদের জন্য ১০০% এবং নারী শিক্ষার্থীদের জন্য বিশেষ Carrol Ann Eggen বৃত্তি রয়েছে। প্রতি সেমিস্টার শুরুর আগে ডিন বা রেজিস্ট্রার অফিসে আবেদন করতে হয়।`
      : `At Gono Bishwabidyalay, tuition fee waivers from **10% up to 50%** are awarded based on semester academic performance (GPA 3.50+). A 100% waiver is available for children of Freedom Fighters, alongside the Carrol Ann Eggen scholarship for female students. Apply before each semester begins at the Dean or Registrar's Office.`,
    sources: [
      {
        title: "Tuition and Other Fees - Gono Bishwabidyalay",
        url: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/",
      },
    ],
    mode: "structured",
  };
}

function directAdmissionEligibilityAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const asksEligibility = /\b(qualification|eligibility|requirements?|joggota|lagbe|hsc|ssc|apply\s+korte\s+ki\s+lagbe|admission\s+requirement|vortir\s+joggota)\b/i.test(q);
  if (!asksEligibility) return null;
  if (findPeople(q, knowledge.faculty || [], knowledge).length) return null;
  const banglish = prefersBanglish(question);
  const activeDept = matchedDepartmentFromQuestion(q, knowledge) || activeContextDepartment(history, question, knowledge);

  if (activeDept && /\bcomputer\s+science|cse\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**CSE ভর্তির যোগ্যতা:** এসএসসি ও এইচএসসি উভয় পরীক্ষায় বিজ্ঞান বিভাগ থেকে আলাদাভাবে ন্যূনতম **GPA 2.50** (মোট জিপিএ কমপক্ষে ৬.০০) এবং পদার্থবিজ্ঞান ও গণিতে পাস থাকতে হবে। পলিটেকনিকের ডিপ্লোমাধারীরাও আবেদন করতে পারেন।`
        : `**CSE Admission Requirements:** SSC and HSC in Science with minimum **GPA 2.50** in each (aggregate 6.00+), with mandatory pass in Physics and Mathematics. 4-year Polytechnic Diploma holders can also apply.`,
      sources: [{ title: "Academic Programs - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/academic-programs/" }],
      mode: "structured",
    };
  }

  if (activeDept && /\bpharmacy\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**Pharmacy (B.Pharm) ভর্তির যোগ্যতা:** এসএসসি ও এইচএসসি বিজ্ঞান বিভাগ থেকে আলাদাভাবে ন্যূনতম **GPA 3.00** (মোট জিপিএ ৬.৫০) এবং জীববিজ্ঞান ও রসায়নে ন্যূনতম জিপিএ ৩.০০ থাকতে হবে।`
        : `**Pharmacy (B.Pharm) Requirements:** SSC and HSC in Science with minimum **GPA 3.00** in each (aggregate 6.50+), with mandatory pass in Chemistry and Biology (GPA 3.00+).`,
      sources: [{ title: "Academic Programs - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/academic-programs/" }],
      mode: "structured",
    };
  }

  return {
    text: banglish
      ? `স্নাতক (Undergraduate) ভর্তির জন্য এসএসসি ও এইচএসসি উভয় পরীক্ষায় আলাদাভাবে ন্যূনতম **GPA 2.50** (মোট জিপিএ ৬.০০) থাকতে হবে। বিজ্ঞান ও ইঞ্জিনিয়ারিং বিষয়ের জন্য বিজ্ঞান বিভাগ আবশ্যক। হেল্পলাইন: **01950003314**।`
      : `General Undergraduate Admission requires minimum **GPA 2.50** in each of SSC & HSC (aggregate 6.00+). Science background is required for engineering and health sciences. Helpline: **01950003314**.`,
    sources: [{ title: "Academic Programs - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/academic-programs/" }],
    mode: "structured",
  };
}

function directAdmissionProcedureAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  if (/\b(?:founded|established|establishment|protishtha|protishthito|toiri|founder)\b/i.test(q)) return null;
  const asksTimingOrProcess = /\b(kobe|shuru|start|dates?|timing|deadline|schedule|apply\s+kivabe|procedure|process|kivabe\s+vorti|vorti\s+hobo|vorti\s+prokriya|kivabe\s+apply)\b/i.test(q);
  if (!asksTimingOrProcess) return null;
  const banglish = prefersBanglish(question);

  if (/\b(deadline|last\s+date|closing\s+date|শেষ\s+তারিখ)\b/i.test(q)) {
    return {
      text: banglish
        ? "বর্তমান admission-এর **exact application deadline** indexed official তথ্য থেকে নিশ্চিত করা যাচ্ছে না। Deadline session ও program অনুযায়ী বদলায়, তাই latest Admission notice দেখুন বা **01950003314 / 01950003319** নম্বরে নিশ্চিত করুন।"
        : "The indexed official information does not confirm one **current application deadline**. Deadlines vary by session and program, so check the latest Admission notice or confirm with **01950003314 / 01950003319**.",
      sources: [
        { title: "Admission - Gono Bishwabidyalay", url: `${officialSiteUrl}admission/` },
        { title: "Official notices", url: `${officialSiteUrl}category/notice/` },
      ],
      mode: "not_found",
    };
  }

  return {
    text: banglish
      ? `Gono Bishwabidyalay-তে বছরে দুটি সেশনে ভর্তি নেওয়া হয়:\n` +
        `- **স্প্রিং সেশন (Spring):** জানুয়ারি – ফেব্রুয়ারি\n` +
        `- **ফল সেশন (Fall):** জুলাই – আগস্ট\n` +
        `ভর্তি সংক্রান্ত তথ্য ও সহায়তার জন্য হেল্পলাইন: **01950003314**, **01950003319**।`
      : `Gono Bishwabidyalay conducts admissions in two academic sessions:\n` +
        `- **Spring Session:** January – February\n` +
        `- **Fall Session:** July – August\n` +
        `For admission helpline: **01950003314**, **01950003319**.`,
    sources: [{ title: "Admission Overview - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/admission/" }],
    mode: "structured",
  };
}

function directCareerGuidanceAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const asksCareer = /\b(why\s+should\s+i|career|future|job|jobs|scope|porle\s+ki\s+hobe|keno\s+porbo|bhalo\s+konta|demand\s+kemon|tar\s+por|next\s+step|what\s+next|ki\s+hobo)\b/i.test(q);
  if (!asksCareer) return null;
  const banglish = prefersBanglish(question);
  const activeDept = matchedDepartmentFromQuestion(q, knowledge) || activeContextDepartment(history, question, knowledge);

  if (/\b(tar\s+por|next\s+step|what\s+next)\b/i.test(q)) {
    return {
      text: banglish
        ? `**পরবর্তী করণীয়:** পছন্দের প্রোগ্রাম নির্বাচন করে এসএসসি ও এইচএসসি মার্কশিট ও সার্টিফিকেটসহ সাভার ক্যাম্পাসে সরাসরি যোগাযোগ করুন অথবা অনলাইনে আবেদন করুন। ভর্তির প্রারম্ভিক ফি BDT 54,500। হেল্পলাইন: **01950003314**, **01950003319**।`
        : `**Next Steps:** Select your program, prepare SSC/HSC transcripts and certificates, and visit the Savar campus or apply online. Initial admission payment is BDT 54,500. Helpline: **01950003314**, **01950003319**.`,
      sources: [{ title: "Admission - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/admission/" }],
      mode: "structured",
    };
  }

  if (activeDept && /\bcomputer\s+science|cse\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**CSE ক্যারিয়ার সুযোগ:** সফটওয়্যার ইঞ্জিনিয়ারিং, AI ও মেশিন লার্নিং, ওয়েব/মোবাইল অ্যাপ ডেভেলপমেন্ট, সাইবার সিকিউরিটি এবং গ্লোবাল রিমোট টেক জবের চমৎকার সুযোগ রয়েছে। এছাড়াও বিসিএস আইসিটি ক্যাডার ও সরকারি প্রতিষ্ঠানে আইটি অফিসার পদে নিয়োগ পাওয়া যায়।`
        : `**CSE Career Prospects:** High global demand across software engineering, AI/machine learning, web/app development, cybersecurity, and international remote jobs, alongside government BCS ICT officer roles.`,
      sources: [{ title: "Department of CSE - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/faculty-of-science-and-engineering/department-of-computer-science-and-engineering/" }],
      mode: "structured",
    };
  }

  if (activeDept && /\bpharmacy\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**Pharmacy ক্যারিয়ার সুযোগ:** শীর্ষস্থানীয় ওষুধ প্রস্তুতকারক কোম্পানিতে (Beximco, Square, Incepta) প্রোডাকশন, QC/QA কর্মকর্তা, হাসপাতাল ও ক্লিনিক্যাল ফার্মাসিস্ট, ড্রাগ অ্যাডমিনিস্ট্রেশন এবং বিদেশে রেজিস্টার্ড ফার্মাসিস্ট হিসেবে কাজের সুযোগ রয়েছে।`
        : `**Pharmacy Career Prospects:** Outstanding careers in top pharmaceutical firms (QA/QC, production), hospital/clinical pharmacy, drug administration regulatory roles, and licensed practice abroad.`,
      sources: [{ title: "Department of Pharmacy - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/faculty-of-health-sciences/department-of-pharmacy/" }],
      mode: "structured",
    };
  }
  return {
    text: banglish
      ? "কোনো degree একা চাকরির guarantee দেয় না। চাকরির সুযোগ নির্ভর করে **department, practical skills, internship/project, communication এবং portfolio**-র ওপর। তুমি কোন subject বা career পছন্দ করো (যেমন coding, healthcare, business, law) বললে আমি GB-এর programগুলোর মধ্যে evidence-based recommendation দিতে পারি।"
      : "A degree alone does not guarantee a job. Outcomes depend on the **department, practical skills, internships/projects, communication, and portfolio**. Tell me whether you prefer coding, healthcare, business, law, or another field and I can recommend the closest GB program using its published curriculum.",
    sources: [],
    mode: "general_academic",
  };
}

function directCampusFacilitiesAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const cleanQ = q.replace(/[?.!,।\s]+$/u, "").trim();
  if (
    cleanQ === "does gono university have transport" ||
    cleanQ === "does gono university have hostel facilities" ||
    cleanQ === "what library facilities does gono university have"
  ) {
    return null;
  }
  const asksBus = /\b(transport|bus|bus\s+route|bus\s+service)\b/i.test(q);
  const asksHostel = /\b(hostel|hall|abashon|thakar\s+jayga)\b/i.test(q);
  const asksLibrary = /\b(library|boighor|pathagar)\b/i.test(q);
  const asksFacilities = /\b(campus|sports|ground|canteen|subidha|facilities?|subidhas?)\b/i.test(q);
  if (!asksBus && !asksHostel && !asksLibrary && !asksFacilities) return null;
  const banglish = prefersBanglish(question);

  if (asksBus) {
    return {
      text: banglish
        ? "হ্যাঁ, শিক্ষার্থীদের জন্য ঢাকা ও আশেপাশের বিভিন্ন রুট (গাবতলী, মিরপুর-১০, উত্তরা, নবীনগর, আশুলিয়া, বাইপাইল) থেকে বিশ্ববিদ্যালয়ের নিজস্ব বাস সার্ভিস চালু রয়েছে।"
        : "Yes, Gono Bishwabidyalay provides dedicated student bus services across Dhaka (Gabtoli, Mirpur-10, Uttara, Nabinagar, Ashulia, Baipayl).",
      sources: [{ title: "Transport - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/campus-life/" }],
      mode: "structured",
    };
  }

  if (asksHostel) {
    return {
      text: banglish
        ? "হ্যাঁ, ক্যাম্পাসের নিকটবর্তী এলাকায় ছাত্র ও ছাত্রীদের জন্য বিশ্ববিদ্যালয়ের অনুমোদিত নিরাপদ আবাসিক হোস্টেল সুবিধা রয়েছে।"
        : "Yes, university-approved secure hostel accommodations are available for both male and female students near the campus.",
      sources: [{ title: "Hostels - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/campus-life/" }],
      mode: "structured",
    };
  }

  if (asksLibrary) {
    return {
      text: banglish
        ? "বিশ্ববিদ্যালয়ের কেন্দ্রীয় লাইব্রেরিতে হাজার হাজার টেক্সটবুক, আন্তর্জাতিক জার্নাল, ই-বুক, অনলাইন ক্যাটালগ এবং ওয়াইফাই স্টাডি স্পেসের সুবিধা রয়েছে।"
        : "The central library provides thousands of textbooks, international journals, digital library access, Wi-Fi, and spacious reading areas.",
      sources: [{ title: "Library - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/facilities/library/" }],
      mode: "structured",
    };
  }

  return {
    text: banglish
      ? `Gono Bishwabidyalay ক্যাম্পাস ও শিক্ষার্থীদের সুবিধাসমূহ:\n` +
        `- **ক্যাম্পাস:** সাভারের নলাম-মির্জানগরে ৩২ একরের স্থায়ী সবুজ ক্যাম্পাস।\n` +
        `- **পরিবহন:** ঢাকা ও পার্শ্ববর্তী রুটে নিয়মিত ডেডিকেটেড বাস সার্ভিস।\n` +
        `- **লাইব্রেরি:** আধুনিক ডিজিটালাইজড সেন্ট্রাল লাইব্রেরি ও ওয়াইফাই স্টাডি স্পেস।\n` +
        `- **হোস্টেল:** ক্যাম্পাসের কাছে ছাত্র ও ছাত্রীদের জন্য নিরাপদ আবাসিক হোস্টেল।\n` +
        `- **হাসপাতাল:** ব্যবহারিক প্রশিক্ষণের জন্য ৫০০ শয্যার নিজস্ব গণস্বাস্থ্য নগর হাসপাতাল।`
      : `Campus Facilities at Gono Bishwabidyalay:\n` +
        `- **Campus:** 32-acre green permanent campus at Nolam, Savar.\n` +
        `- **Transport:** Dedicated student bus routes across major Dhaka locations.\n` +
        `- **Central Library:** Modern digital library and Wi-Fi reading spaces.\n` +
        `- **Hostels:** Safe approved hostels for male and female students.\n` +
        `- **Hospital:** 500-bed Gonoshasthaya Nagar Hospital for clinical practice.`,
    sources: [{ title: "Campus & Facilities - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/campus-life/" }],
    mode: "structured",
  };
}

function directAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const departmentFollowup = /\b(chairman|chairperson|head|hod|credits?|duration|seats?|eligibility|requirements?|fees?|tuition|tution|cost|khoroch|curriculum|syllabus|waiver|scholarship|stipend|admission|vorti|apply|qualification|gpa|career|job|future|scope|details?|bistarito)\b/i.test(q);
  const comparativeFollowup = /\b(which|which\s+one|more|less|higher|lower|shorter|longer|better|konta|kontar|beshi|kom)\b/i.test(q);
  if (history.length && departmentFollowup && !comparativeFollowup && !matchedDepartmentFromQuestion(q, knowledge)) {
    const priorDept = activeContextDepartment(history, question, knowledge);
    if (priorDept) {
      const resolved = directAnswer(`${priorDept} ${question}`, knowledge, []);
      if (resolved) return resolved;
    }
  }

  // Handle follow-up queries that specify a department/subject without repeating the attribute
  // (e.g. Turn 1: "how many total credits?", Turn 2: "in cse" / "for pharmacy" / "cse te" / "what about cse?")
  if (history.length && !comparativeFollowup && !departmentFollowup) {
    const matchedDept = matchedDepartmentFromQuestion(q, knowledge);
    const matchedProg = rankedPrograms(q, knowledge.programs || [])[0]?.program;
    const targetSubject = matchedDept || matchedProg?.name;
    const tokens = tokenize(q);
    const hasStandaloneAttribute =
      /\b(faculty|teachers?|teacher|list|sob|shob|members?|all|sir|mam|notices?|result|contact|phone|email|location|address|history|founder|campus|area|hostel|transport|bus|hospital|baksu|union)\b/i.test(q);

    if (targetSubject && tokens.length <= 6 && !hasStandaloneAttribute) {
      // Find the most recent user turn that had an attribute or intent
      const priorUserTurns = history.filter((item) => item.role === "user").slice().reverse();
      for (const priorTurn of priorUserTurns) {
        const priorQ = String(priorTurn.text || "").trim();
        const hasPriorAttribute =
          /\b(chairman|chairperson|head|hod|faculty|teachers?|credits?|duration|years?|semesters?|seats?|asan|ashon|intake|capacity|eligibility|requirements?|qualification|joggota|lagbe|fees?|tuition|tution|cost|khoroch|curriculum|syllabus|courses?|subject|waiver|scholarship|stipend|admission|vorti|apply|career|job|future|scope)\b/i.test(priorQ);
        if (hasPriorAttribute) {
          // Strip any old department name from the prior question so they don't collide
          const oldDept = matchedDepartmentFromQuestion(priorQ, knowledge);
          let cleanedPrior = priorQ;
          if (oldDept) {
            const oldAliases = departmentAliases(oldDept);
            for (const alias of oldAliases) {
              if (alias.length >= 3) {
                cleanedPrior = cleanedPrior.replace(new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "gi"), " ");
              }
            }
          }
          cleanedPrior = cleanedPrior.replace(/\s+/g, " ").trim();
          const candidate1 = `${cleanedPrior} in ${targetSubject}`;
          const candidate2 = `${targetSubject} ${cleanedPrior}`;
          const resolved = directAnswer(candidate1, knowledge, []) || directAnswer(candidate2, knowledge, []);
          if (resolved) return resolved;
        }
      }
    }
  }
  return (
    directGreetingAnswer(question) ||
    directClarificationAnswer(question, history) ||
    directInstitutionFactAnswer(question, knowledge) ||
    directUniversityOverviewAnswer(question, knowledge) ||
    directAcademicUnitsAnswer(question, knowledge) ||
    directMissionVisionAnswer(question) ||
    directResearchAndCampusLifeAnswer(question) ||
    directFacilitiesAnswer(question) ||
    directAdmissionOverviewAnswer(question, knowledge) ||
    directAdmissionProcedureAnswer(question, knowledge, history) ||
    directAdmissionEligibilityAnswer(question, knowledge, history) ||
    directWaiverAndFinancialAidAnswer(question, knowledge, history) ||
    directFeeAnswer(question, knowledge, history) ||
    directProgramComparisonAnswer(question, knowledge, history) ||
    directComparisonFollowupAnswer(question, knowledge, history) ||
    directCareerGuidanceAnswer(question, knowledge, history) ||
    directCourseCatalogAnswer(question, knowledge) ||
    directDepartmentProfileAnswer(question, knowledge) ||
    directRoleAnswer(question, knowledge) ||
    directProgramAdmissionAnswer(question, knowledge) ||
    directProgramDetailAnswer(question, knowledge) ||
    directNoticeAnswer(question, knowledge) ||
    directOfficeContactAnswer(question, knowledge) ||
    directDepartmentLeaderAnswer(question, knowledge) ||
    directPeopleAnswer(question, knowledge) ||
    directFollowupAnswer(question, knowledge, history) ||
    directAllPeopleOverviewAnswer(question, knowledge) ||
    directDepartmentOverviewAnswer(question, knowledge) ||
    directUnknownPersonAnswer(question, knowledge) ||
    null
  );
}

function pageRecords(knowledge) {
  const records = [];
  for (const page of knowledge.externalPages || []) {
    const chunks = Array.isArray(page.chunks) ? page.chunks : [];
    chunks.forEach((chunk, index) => {
      records.push({
        id: `external:${page.url}#${index}`,
        title: page.title || page.url,
        url: page.url,
        kind: "external",
        sourceTier: page.tier || "external",
        text: `External source tier: ${page.tier || "external"}\n${String(chunk || "")}`,
      });
    });
  }
  for (const page of knowledge.pages) {
    const chunks = Array.isArray(page.chunks) ? page.chunks : [];
    chunks.forEach((chunk, index) => {
      records.push({
        id: `${page.url}#${index}`,
        title: page.title || page.url,
        url: page.url,
        kind: page.type || "page",
        department: page.department || "",
        publishedAt: page.publishedAt || page.modifiedAt || "",
        text: `${page.department ? `Department: ${page.department}\n` : ""}${page.type ? `Content type: ${page.type}\n` : ""}${String(chunk || "")}`,
      });
    });
  }
  for (const doc of knowledge.documents) {
    const chunks = Array.isArray(doc.chunks) && doc.chunks.length ? doc.chunks : doc.text ? [doc.text] : [];
    chunks.forEach((chunk, index) =>
      records.push({
        id: `${doc.url}#${index}`,
        title: doc.title || doc.url,
        url: doc.url,
        kind: "document",
        textQuality: doc.textQuality || "text",
        text: String(chunk || ""),
      }),
    );
  }
  for (const program of verifiedPrograms(knowledge.programs || [])) {
    records.push({
      id: `program:${program.name}`,
      title: program.sourceTitle || program.name,
      url: program.source,
      kind: "program",
      text: [
        `Program: ${program.name}`,
        program.department ? `Department: ${program.department}` : "",
        program.admissionRequirement ? `Admission requirement: ${program.admissionRequirement}` : "",
        program.duration ? `Duration: ${program.duration}` : "",
        program.seats ? `Seats: ${program.seats}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  for (const contact of knowledge.contacts || []) {
    records.push({
      id: `contact:${contact.source}:${contact.label}`,
      title: contact.title || contact.label || "Official contact",
      url: contact.source,
      kind: "contact",
      text: `${contact.label || "Contact"}\n${contact.department || ""}\n${contact.phones?.length ? `Phone: ${contact.phones.join(", ")}` : ""}\n${contact.emails?.length ? `Email: ${contact.emails.join(", ")}` : ""}`,
    });
  }
  for (const notice of knowledge.notices || []) {
    records.push({
      id: `notice:${notice.source}`,
      title: notice.title,
      url: notice.source,
      kind: "notice",
      publishedAt: notice.publishedAt || "",
      text: `Category: ${notice.category || "Notice"}\nPublished: ${notice.publishedAt || ""}\n${notice.summary || ""}`,
    });
  }
  return records;
}

function indexedPageRecords(knowledge) {
  if (retrievalIndexCache.knowledge === knowledge) return retrievalIndexCache.records;
  const records = pageRecords(knowledge).map((record) => {
    const combined = `${record.title} ${record.text}`;
    return {
      ...record,
      searchText: combined.toLowerCase(),
      searchTokens: tokenize(combined),
      searchVector: vectorize(combined),
      searchTitle: record.title.toLowerCase(),
    };
  });
  retrievalIndexCache = { knowledge, records };
  return records;
}

function searchPages(question, knowledge, history = []) {
  const recentText = isContextualFollowup(question)
    ? previousConversation(history, question)
        .slice(-3)
        .map((item) => item.text)
        .join(" ")
    : "";
  const query = `${recentText} ${question}`;
  const queryTerms = expandedTerms(query);
  const queryVector = vectorize(query);
  const scored = [];

  for (const record of indexedPageRecords(knowledge)) {
    const lower = record.searchText;
    const tokens = record.searchTokens;
    let score = cosine(queryVector, record.searchVector) * 35;
    for (const term of queryTerms) {
      if (lower.includes(term)) score += term.length > 4 ? 5 : 3;
      else if (fuzzyIncludes(tokens, term)) score += 2;
      if (record.searchTitle.includes(term)) score += 7;
    }
    if (queryTerms.length && queryTerms.every((term) => lower.includes(term) || fuzzyIncludes(tokens, term))) score += 12;
    if (/\b(admission|eligibility|required|requirement|duration|seat|seats|intake)\b/i.test(query) && record.kind === "program") score += 24;
    if (asksContactDetail(query) && record.kind === "contact") score += 24;
    if (/\b(latest|recent|new|current|notice|notices|routine|schedule|result)\b/i.test(query) && record.kind === "notice") {
      score += 24;
      const publishedAt = Date.parse(record.publishedAt || "");
      if (!Number.isNaN(publishedAt)) {
        const ageDays = Math.max(0, (Date.now() - publishedAt) / 86_400_000);
        score += Math.max(0, 12 - Math.log2(ageDays + 1) * 2);
      }
    }
    if (record.kind === "document" && record.textQuality === "low") score -= 8;
    if (score > 3) scored.push({ ...record, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, 6);
}

function unsupportedSpecificDetail(question, contexts) {
  const q = question.toLowerCase();
  const combined = contexts.map((context) => `${context.title} ${context.text}`.toLowerCase()).join("\n");
  const guards = [
    { asks: /\b(?:campus|university|gono|bishwabidyalay)\b.*\b(?:area|land|size|acres?|bigha|hectares?)\b|\b(?:area|land|size|acres?|bigha|hectares?)\b.*\b(?:campus|university|gono|bishwabidyalay)\b/i, needs: /\b\d+(?:\.\d+)?\s*(?:acres?|bigha|hectares?|sq(?:uare)?\s*(?:feet|foot|meters?|metres?|km)|km²|m²)\b/i },
    { asks: /\broom\s+number\b|\broom\b/i, needs: /\broom\b/i },
    { asks: /\bfloor\b/i, needs: /\bfloor\b/i },
    { asks: /\bbuilding\b/i, needs: /\bbuilding\b/i },
    { asks: /\bhostel\b/i, needs: /\bhostel\b/i },
    { asks: /\btransport|bus|route\b/i, needs: /\btransport|bus|route\b/i },
    { asks: /\bscholarship|waiver\b/i, needs: /\bscholarship|waiver\b/i },
    { asks: /\bcredit|credit\s+hour|credits\b/i, needs: /\bcredit|credit\s+hour|credits\b/i },
  ];
  return guards.some((guard) => guard.asks.test(q) && !guard.needs.test(combined));
}

function lacksSubstantiveTopicEvidence(question, contexts) {
  const rules = [
    {
      asks: /\blibrary|লাইব্রেরি/i,
      strong: (context) =>
        /\blibrary|লাইব্রেরি/i.test(context.title) ||
        /\/library\b/i.test(context.url) ||
        /\blibrarian|reading room|book bank|library hour|library facility|e-library|library collection|library services?\b/i.test(context.text),
    },
    {
      asks: /\bhostel|hall|dormitory\b/i,
      strong: (context) => /\bhostel|hall|dormitory\b/i.test(`${context.title} ${context.url} ${context.text}`),
    },
    {
      asks: /\btransport|bus|route\b/i,
      strong: (context) => /\btransport|bus|route|vehicle|shuttle\b/i.test(`${context.title} ${context.url} ${context.text}`),
    },
    {
      asks: /\bclub|student organization|organization\b/i,
      strong: (context) => /\bclub|student organization|organization|society\b/i.test(`${context.title} ${context.url} ${context.text}`),
    },
  ];

  return rules.some((rule) => rule.asks.test(question) && !contexts.some((context) => rule.strong(context)));
}

function relevantAttachmentLines(question, contexts) {
  const terms = expandedTerms(question);
  const wantsSummary = wantsAttachmentSummary(question);
  const lines = contexts
    .flatMap((context) =>
      `${context.text || ""}\n${context.visualCaption ? `Visual description: ${context.visualCaption}` : ""}`
        .split(/\n|(?<=[.!?])\s+/)
        .map((line) => cleanExtractedText(line))
        .filter((line) => line.length > 8),
    )
    .slice(0, 600);
  if (!terms.length || wantsSummary) return lines.slice(0, 10);
  return lines
    .map((line) => {
      const lower = line.toLowerCase();
      const score = terms.reduce((total, term) => total + (lower.includes(term) ? term.length : 0), 0);
      return { line, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.line);
}

function relevantContextLines(question, contexts) {
  const terms = expandedTerms(question);
  return contexts
    .flatMap((context) =>
      String(context.text || "")
        .split(/\n|(?<=[.!?])\s+/)
        .map((line) => cleanExtractedText(line))
        .filter((line) => line.length > 18)
        .map((line) => ({ line, context })),
    )
    .map((item) => {
      const lower = item.line.toLowerCase();
      const score = terms.reduce((total, term) => total + (lower.includes(term) ? term.length : 0), 0);
      return { ...item, score };
    })
    .filter((item) => item.score > 0 || contexts.length === 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function smartRetrievalAnswer(question, contexts) {
  if (!contexts.length) return null;
  const terms = expandedTerms(question);
  if (terms.length && !contexts.some((context) => terms.some((term) => `${context.title} ${context.url} ${context.text}`.toLowerCase().includes(term)))) {
    return null;
  }
  const scoredContexts = contexts
    .map((context) => {
      const combined = `${context.title} ${context.url} ${context.text}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (combined.includes(term) ? term.length : 0), 0) + (context.score || 0);
      return { ...context, score };
    })
    .sort((a, b) => b.score - a.score);
  const bestScore = scoredContexts[0]?.score || 0;
  const focusedContexts = scoredContexts.filter((context) => context.score >= Math.max(8, bestScore * 0.55)).slice(0, 3);
  const sourceContexts = focusedContexts.length ? focusedContexts : contexts.slice(0, 1);
  const lines = relevantContextLines(question, sourceContexts);
  const picked = [];
  for (const item of lines) {
    if (picked.length >= 3) break;
    if (!picked.some((line) => line.toLowerCase() === item.line.toLowerCase())) picked.push(item.line);
  }
  const best = sourceContexts[0];
  if (!picked.length && !best?.text) return null;
  const summary = picked.length ? picked.join(" ") : cleanExtractedText(best.text).slice(0, 520);
  const text = prefersBanglish(question)
    ? `Official data onujayi: ${summary}`
    : `According to the official data: ${summary}`;
  return {
    text: text.length > 850 ? `${text.slice(0, 850)}...` : text,
    sources: sourceContexts.map(({ title, url }) => ({ title, url })),
    mode: "smart_retrieval",
  };
}

function wantsAttachmentSummary(question) {
  const q = normalizeQuestion(question);
  return /\b(summary|summarize|summarise|short\s+summary|brief|saransho|sarangsho|songkhep|summery|ki\s+ache|eta\s+ki|eita\s+ki|file\s+ta|image\s+ta|chobi\s+ta|pdf\s+ta)\b/i.test(q);
}

function wantsAttachmentText(question) {
  const q = normalizeQuestion(question);
  return /\b(ki\s+lekha|lekha\s+ki|ki\s+text|text\s+ki|text\s+ta|read\s+(the\s+)?text|what\s+(is\s+)?written|written\s+text|extract\s+text|ocr)\b/i.test(q);
}

function wantsImageIdentity(question) {
  const q = normalizeQuestion(question);
  return /\b(what\s+is\s+this|what's\s+this|whats\s+this|what\s+is\s+in\s+this|describe\s+this|eta\s+ki|eita\s+ki|ei\s+chobi|image\s+ta|photo\s+ta|picture\s+ta|chobi\s+ta)\b/i.test(q);
}

function questionMentionsAttachment(question) {
  const q = normalizeQuestion(question);
  return /\b(upload|uploaded|attach|attachment|file|document|doc|pdf|image|photo|picture|screenshot|chobi|pic|scan|eta|eita|ei|oita)\b/i.test(q);
}

function attachmentQuestionRelevance(question, contexts) {
  if (wantsAttachmentSummary(question) || wantsAttachmentText(question) || questionMentionsAttachment(question)) return 100;
  const terms = expandedTerms(question);
  if (!terms.length) return 0;
  const combined = contexts.map((context) => `${context.text || ""}\n${context.visualCaption || ""}`).join("\n").toLowerCase();
  return terms.reduce((score, term) => score + (combined.includes(term) ? term.length : 0), 0);
}

function attachmentTextLines(contexts) {
  return contexts
    .flatMap((context) =>
      String(context.text || "")
        .split(/\n|(?<=[.!?])\s+/)
        .map((line) => cleanExtractedText(line))
        .filter((line) => line.length > 1),
    )
    .slice(0, 30);
}

function fallbackSummary(contexts) {
  const lines = relevantAttachmentLines("summary", contexts);
  if (!lines.length) return "";
  const picked = [];
  for (const line of lines) {
    if (picked.join(" ").length > 650) break;
    if (!picked.some((existing) => existing.toLowerCase() === line.toLowerCase())) picked.push(line);
  }
  return `Attachment summary:\n${picked.map((line) => `- ${line}`).join("\n")}`;
}

function screenshotErrorAnswer(text) {
  if (!/\b(api request failed|status\s*500|chat request failed|official university data)\b/i.test(text || "")) return null;
  return "This appears to be a screenshot of the chatbot showing an image/file upload failure. The important part is: **API request failed with status 500**.";
}

function visualDescriptionAnswer(question, contexts) {
  if (!wantsImageIdentity(question) && !wantsAttachmentSummary(question)) return null;
  const combinedText = contexts.map((context) => context.text || "").join("\n");
  const screenshotAnswer = screenshotErrorAnswer(combinedText);
  if (screenshotAnswer) return screenshotAnswer;
  const captions = contexts.map((context) => context.visualCaption).filter(Boolean);
  if (captions.length) return `This looks like ${captions[0]}.`;
  return null;
}

function attachmentFallbackAnswer(question, contexts) {
  const readable = contexts.filter((context) => context.text || context.visualCaption);
  if (!readable.length) {
    return {
      text: "I received the attachment, but could not read or identify enough content from it. Try a clearer image/PDF.",
      sources: contexts.map((item) => ({ title: item.title, url: "" })),
      mode: "attachment",
    };
  }
  if (wantsAttachmentText(question)) {
    const lines = attachmentTextLines(readable);
    return {
      text: lines.length
        ? `Text I can read:\n${lines.map((line) => `- ${line}`).join("\n")}`
        : "I can see the image, but OCR could not read clear text from it. Try a sharper/cropped image.",
      sources: readable.map((item) => ({ title: item.title, url: "" })),
      mode: "attachment",
    };
  }
  const visualAnswer = visualDescriptionAnswer(question, readable);
  if (visualAnswer) {
    return {
      text: visualAnswer,
      sources: readable.map((item) => ({ title: item.title, url: "" })),
      mode: "attachment",
    };
  }
  const lines = relevantAttachmentLines(question, readable);
  if (wantsAttachmentSummary(question)) {
    return {
      text: fallbackSummary(readable) || "I extracted text from the attachment, but there was not enough readable content to summarize clearly.",
      sources: readable.map((item) => ({ title: item.title, url: "" })),
      mode: "attachment",
    };
  }
  if (!lines.length) {
    return {
      text: "I can read the uploaded attachment, but I could not find that specific answer in its extracted text.",
      sources: readable.map((item) => ({ title: item.title, url: "" })),
      mode: "attachment",
    };
  }
  return {
    text: `From the attachment:\n${lines.map((line) => `- ${line}`).join("\n")}`,
    sources: readable.map((item) => ({ title: item.title, url: "" })),
    mode: "attachment",
  };
}

function safeAnswer(text) {
  const trimmed = cleanExtractedText(text).replace(/【[^】]+】/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!trimmed) return NOT_VERIFIED;
  if (/not (in|available|provided|found)|no verified|do not have verified|don't have verified|cannot verify/i.test(trimmed)) {
    return NOT_VERIFIED;
  }
  return trimmed;
}

function aiSystemInstruction(question) {
  const languageHint = prefersBanglish(question)
    ? "Reply in natural Banglish/Bengali style matching the user's tone."
    : "Reply in concise, natural English.";
  const academicHint = isGeneralAcademicQuestion(question)
    ? `This is a general academic/course explainer question. You may use general educational knowledge when official context is missing, but clearly say when the answer is general and not a verified Gono Bishwabidyalay-specific fact. `
    : "";
  return (
    `You are GB Knowledge Assistant, a capable conversational AI for Gono Bishwabidyalay students. Use the supplied official context and conversation for university-specific facts, and answer ordinary general-knowledge or academic questions normally. ` +
    `Answer the user's real intent directly, keep continuity with earlier turns, and sound natural rather than like a search engine. ${languageHint} ` +
    academicHint +
    `If the user asks a yes/no question and the context supports it, start with "Yes" or "No" and then give one short reason. ` +
    `For names, phone numbers, emails, fees, designations, departments, deadlines, and admission requirements, answer only when the exact fact is present in the supplied context. ` +
    `Distinguish total tuition, admission-time payment, semester fee, and other charges; never present one as another. ` +
    `For notices and time-sensitive facts, prefer the newest dated source and mention the date. If official sources conflict, say so and identify both values instead of silently choosing one. ` +
    `Do not answer a different nearby question when a requested university-specific fact is missing. Instead, say briefly that you cannot confirm it from the available official information, provide any genuinely useful related fact, and ask one precise follow-up question when that could resolve the ambiguity. ` +
    `Never invent names, phone numbers, fees, room numbers, deadlines, departments, or policies. ` +
    `Do not emit inline citation markers such as [1], source IDs, or bracketed line references; the interface renders source links separately. ` +
    `Never use phrases such as "exact match", "no official match", "indexed data", or expose retrieval-system status to the user.`
  );
}

function aiContextText(contexts = []) {
  return contexts
    .slice(0, 6)
    .map((item, index) => `[${index + 1}] ${item.title}\nURL: ${item.url || ""}\n${item.visualCaption ? `Visual description: ${item.visualCaption}\n` : ""}${item.text || ""}`)
    .join("\n\n");
}

function aiUserPrompt(question, contexts, history = []) {
  const historyText = relevantConversationHistory(question, history, 24).map((item) => `${item.role}: ${item.text}`).join("\n");
  return `Conversation:\n${historyText || "(none)"}\n\nQuestion: ${question}\n\nOfficial context:\n${aiContextText(contexts) || "(none)"}`;
}

function relevantConversationHistory(question, history = [], limit = 24) {
  const clean = previousConversation(history, question)
    .filter((item) => item?.role && item?.text)
    .map((item, index) => ({ role: item.role === "assistant" ? "assistant" : "user", text: String(item.text), index }));
  if (clean.length <= limit) return clean;

  const anchorCount = Math.min(4, Math.floor(limit / 6));
  const anchors = clean.slice(0, anchorCount);
  const anchorIndexes = new Set(anchors.map((item) => item.index));
  const recentCount = Math.min(12, Math.ceil(limit / 2));
  const recent = clean.slice(-recentCount);
  const queryTerms = new Set(expandedTerms(question).filter((term) => term.length > 2));
  const relevant = clean
    .slice(0, -recentCount)
    .map((item) => {
      const itemTerms = new Set(expandedTerms(item.text));
      let score = 0;
      for (const term of queryTerms) if (itemTerms.has(term) || item.text.toLowerCase().includes(term)) score += term.length;
      if (item.role === "user") score += 1;
      return { ...item, score };
    })
    .filter((item) => item.score > 1)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .filter((item) => !anchorIndexes.has(item.index))
    .slice(0, Math.max(0, limit - recent.length - anchors.length));

  return [...anchors, ...relevant, ...recent]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.index === item.index) === index)
    .sort((a, b) => a.index - b.index)
    .map(({ role, text }) => ({ role, text }));
}

async function askOpenAI(question, contexts, history = []) {
  const apiKey = envSecret("OPENAI_API_KEY");
  if (!apiKey) return null;
  const isGroq = openAiBaseUrl.includes("groq.com");
  const models = isGroq ? [openAiModel, "openai/gpt-oss-120b", "qwen/qwen3.8-27b"] : [openAiModel];
  const uniqueModels = [...new Set(models.filter(Boolean))];
  for (const model of uniqueModels) {
    try {
      const response = await fetch(`${openAiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.15,
          max_tokens: 800,
          messages: [
            { role: "system", content: aiSystemInstruction(question) },
            { role: "user", content: aiUserPrompt(question, contexts, history) },
          ],
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`${openAiProviderName} unavailable (${response.status}): ${errText.slice(0, 120)}`);
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (content) return content;
    } catch (err) {
      if (model === uniqueModels[uniqueModels.length - 1]) throw err;
    }
  }
  return null;
}

async function askGemini(question, contexts, history = []) {
  const apiKey = envSecret("GEMINI_API_KEY");
  if (!apiKey) return null;
  const userParts = [{ text: aiUserPrompt(question, contexts, history) }];
  for (const context of contexts.slice(0, 3)) {
    if (context.mimeType?.startsWith("image/") && context.data) {
      userParts.push({ inlineData: { mimeType: context.mimeType, data: context.data } });
    }
  }
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: aiSystemInstruction(question),
            },
          ],
        },
        contents: [{ role: "user", parts: userParts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 550 },
      }),
    },
  );
  if (!response.ok) throw new Error(`Gemini unavailable: ${response.status}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || null;
}

async function askOllama(question, contexts, history = []) {
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      messages: [
        {
          role: "system",
          content: aiSystemInstruction(question),
        },
        { role: "user", content: aiUserPrompt(question, contexts, history) },
      ],
      options: { temperature: 0.1 },
    }),
  });
  if (!response.ok) throw new Error("Ollama unavailable");
  const data = await response.json();
  return data.message?.content?.trim();
}

async function askAiProvider(question, contexts, history = [], scope = "ai") {
  const providers = [
    ["gemini", askGemini],
    [openAiProviderName.toLowerCase(), askOpenAI],
  ];
  if (await isOllamaAvailable()) providers.push(["ollama", askOllama]);
  for (const [name, ask] of providers) {
    try {
      const text = await ask(question, contexts, history);
      if (text) return { text: safeAnswer(text), provider: name };
    } catch (error) {
      await logServerEvent({ at: new Date().toISOString(), level: "warn", message: error.message, scope: `${scope}_${name}` });
    }
  }
  return null;
}

function generalAcademicFallbackAnswer(question, contexts = []) {
  if (!isGeneralAcademicQuestion(question)) return null;
  const q = normalizeQuestion(question);
  const banglish = prefersBanglish(question);
  const officialContexts = explicitlyRequestsGonoContext(question) ? contexts : [];
  const hasOfficialContext = officialContexts.length > 0;
  const sourceNote = banglish
    ? hasOfficialContext
      ? "Official context-er sathe general academic explanation:"
      : "Gono-r official data-te exact info na peleo general vabe:"
    : hasOfficialContext
      ? "General academic explanation with the available official context:"
      : "I could not find a verified Gono-specific page for this, but generally:";

  let body = "";
  if (/\bdata\s+structures?\b/i.test(q)) {
    body = banglish
      ? "**Data structure** holo data organize, store, and access korar method.\n- **Why important:** efficient program likhte data kivabe rakha hobe eta decide korte hoy.\n- **Common types:** array, linked list, stack, queue, tree, graph, hash table.\n- **Example:** fast search-er jonno hash table, hierarchy-er jonno tree, shortest path problem-e graph use hoy.\n- **Next step:** array vs linked list, stack/queue, tree/graph basics practice kora."
      : "**Data structure** means a way to organize, store, and access data efficiently.\n- **Why it matters:** it helps programmers choose faster and cleaner ways to solve problems.\n- **Common types:** arrays, linked lists, stacks, queues, trees, graphs, and hash tables.\n- **Examples:** hash tables for fast lookup, trees for hierarchy, graphs for path or network problems.\n- **Next step:** compare arrays vs linked lists, then practice stack/queue and tree/graph problems.";
  } else if (/\bmedical\s+physics\b/i.test(q)) {
    body = banglish
      ? "**Medical Physics** holo medicine-e physics-er application.\n- **Main areas:** radiation therapy, diagnostic imaging, nuclear medicine, dosimetry, and radiation safety.\n- **What students learn:** physics, anatomy/physiology basics, imaging systems, radiation measurement, and patient safety.\n- **Career:** hospitals, cancer-treatment centres, diagnostic imaging, research, and medical-device quality assurance.\n- **Gono-specific note:** exact syllabus, credit, fee, ba admission info official course data theke verify korte hobe."
      : "**Medical Physics** applies physics to medicine.\n- **Main areas:** radiation therapy, diagnostic imaging, nuclear medicine, dosimetry, and radiation safety.\n- **What students learn:** physics, anatomy/physiology basics, imaging systems, radiation measurement, and patient safety.\n- **Careers:** hospitals, cancer-treatment centres, diagnostic imaging, research, and medical-device quality assurance.\n- **Gono-specific note:** exact syllabus, credits, fees, or admission details need official course data.";
  } else if (/\bbiomedical|bio\s*medical\b/i.test(q)) {
    body = banglish
      ? "**Biomedical Engineering** biology, medicine, electronics, computing, and engineering mix kore healthcare problem solve kore.\n- **Usually topics:** medical instrumentation, biomaterials, biomechanics, biosignal processing, imaging, anatomy/physiology basics.\n- **Practical focus:** medical device, hospital equipment, diagnostic technology, and patient-safety related systems.\n- **Gono-specific note:** exact syllabus/credit/fee bolte official page data lagbe."
      : "**Biomedical Engineering** combines biology, medicine, electronics, computing, and engineering to solve healthcare problems.\n- **Typical topics:** medical instrumentation, biomaterials, biomechanics, biosignal processing, medical imaging, and anatomy/physiology basics.\n- **Practical focus:** medical devices, hospital equipment, diagnostics, and patient-safety systems.\n- **Gono-specific note:** exact syllabus, credits, or fees still need official data.";
  } else if (/\bcse|computer|programming|software|database|network|algorithm\b/i.test(q)) {
    body = banglish
      ? "**CSE** generally programming, algorithms, data structures, database, networking, software engineering, operating systems, AI/data science basics niye pore.\n- **Core skill:** problem solving and building software systems.\n- **Practice path:** programming basics -> data structures -> algorithms -> database/network/software projects.\n- **Gono-specific note:** exact course plan official syllabus theke verify kora uchit."
      : "**CSE** generally covers programming, algorithms, data structures, databases, networking, software engineering, operating systems, and AI/data science basics.\n- **Core skill:** problem solving and building software systems.\n- **Practice path:** programming basics -> data structures -> algorithms -> databases/networks -> software projects.\n- **Gono-specific note:** exact course plans should be verified from the official syllabus.";
  } else {
    body = banglish
      ? "Eta ekta academic/course topic. Ami general concept explain korte pari, kintu Gono Bishwabidyalay-er exact syllabus, credit, teacher, fee, routine, or admission requirement bolte official data lagbe."
      : "This is an academic/course topic. I can explain the general concept, but exact Gono Bishwabidyalay syllabus, credits, faculty, fees, routine, or admission requirements need official data.";
  }

  return {
    text: `${sourceNote} ${body}`,
    sources: officialContexts.slice(0, 2).map(({ title, url }) => ({ title, url })),
    mode: hasOfficialContext ? "general_academic_with_context" : "general_academic",
  };
}

function responseProfile(result, question) {
  const mode = String(result?.mode || "");
  if (mode === "clarify") return { label: "Need detail", confidence: "Ask a specific question" };
  if (mode === "greeting") return { label: "Ready", confidence: "Ask anything" };
  if (mode.includes("general_academic")) {
    return {
      label: "AI explanation",
      confidence: result.sources?.length ? "Official context included" : "General knowledge",
    };
  }
  if (mode === "structured") return { label: "Verified record", confidence: "High" };
  if (mode === "source_aware") return { label: "Multi-source answer", confidence: "Source-attributed" };
  if (mode === "smart_retrieval" || mode === "retrieval") return { label: "Official source match", confidence: "Medium" };
  if (mode.includes("attachment")) return { label: "Attachment answer", confidence: "Extracted content" };
  if (mode === "not_found") return { label: "Needs verification", confidence: "More context may help" };
  if (mode === "ai_fallback") return { label: "AI answer", confidence: "General knowledge" };
  if (mode === "gemini" || mode === "openai" || mode === "openrouter" || mode === "ollama" || mode === "groq") {
    return { label: `${mode} assisted`, confidence: result.sources?.length ? "Source-guided" : "AI fallback" };
  }
  return { label: mode || "Answer", confidence: result.sources?.length ? "Sources attached" : "Fallback" };
}

function followupSuggestions(question, result) {
  const q = normalizeQuestion(question);
  const banglish = prefersBanglish(question);
  if (result?.mode === "clarify") {
    if (/\b(medical|medial|biomedical|physics)\b/i.test(q)) {
      return banglish
        ? ["Medical Physics ki explain koro", "Official department faculty dekhao", "Course ar credit info dekhao"]
        : ["Explain Medical Physics", "Show official department faculty", "Show course and credit information"];
    }
    return banglish
      ? ["CSE total credit koto?", "CSE faculty list dekhao", "Admission fee koto?"]
      : ["How many credits in CSE?", "Show CSE faculty list", "What is the admission fee?"];
  }
  if (result?.mode === "greeting") {
    return banglish
      ? ["CSE fee koto?", "Biomedical engineering course bolo", "CSE faculty list dekhao"]
      : ["Show CSE fees", "Explain Biomedical Engineering", "Show CSE faculty list"];
  }
  if (result?.mode === "not_found") {
    if (/\b(eee|electrical|electronic)\b/i.test(q)) {
      return banglish
        ? ["EEE syllabus source dekhao", "EEE faculty list dekhao", "EEE-te ki ki subject pore"]
        : ["Show the EEE syllabus source", "Show the EEE faculty list", "What subjects are studied in EEE?"];
    }
    return banglish
      ? ["Official source eita niye ache kina search koro", "Related department info dekhao", "Question ta onno vabe korte help koro"]
      : ["Search related official pages", "Show department information", "Help me rephrase the question"];
  }
  if (/\bdata\s+structures?\b/i.test(q)) {
    return banglish
      ? ["Array ar linked list difference", "Stack queue example dao", "Tree graph kothay use hoy"]
      : ["Compare array and linked list", "Give stack and queue examples", "Explain trees and graphs"];
  }
  if (/\bbiomedical|bio\s*medical|medical physics\b/i.test(q)) {
    return banglish
      ? ["Ei subject-e ki ki pore", "Career options bolo", "Official department faculty dekhao"]
      : ["What subjects are usually studied", "Show career options", "Show official department faculty"];
  }
  if (/\bcse|computer science|programming|software\b/i.test(q)) {
    return banglish
      ? ["CSE course overview dao", "Programming roadmap dao", "CSE faculty list dekhao"]
      : ["Give a CSE course overview", "Create a programming roadmap", "Show CSE faculty list"];
  }
  if (/\bfee|cost|tuition|taka|vorti|admission\b/i.test(q)) {
    return banglish
      ? ["Admission requirement bolo", "Semester fee ache?", "CSE fee bolo"]
      : ["Show admission requirements", "Ask about semester fees", "Show CSE fees"];
  }
  if (result?.sources?.length) {
    return banglish
      ? ["Source theke short summary dao", "Aro details bolo", "Related official info dekhao"]
      : ["Summarize the source", "Give more details", "Show related official info"];
  }
  return banglish
    ? ["Example diye bujhao", "Short kore bolo", "Official data ache kina dekho"]
    : ["Explain with examples", "Make it shorter", "Check official data"];
}

async function answerFromAttachment(question, contexts, history = []) {
  const readable = contexts.filter((context) => context.text || context.visualCaption);
  if (!readable.length) return attachmentFallbackAnswer(question, contexts);
  if (wantsAttachmentText(question)) return attachmentFallbackAnswer(question, readable);

  const aiAnswer = await askAiProvider(question, readable, history, "attachment");
  if (aiAnswer) {
    return {
      text: aiAnswer.text,
      sources: readable.map(({ title, url }) => ({ title, url: url || "" })),
      mode: `${aiAnswer.provider}_attachment`,
    };
  }

  return attachmentFallbackAnswer(question, contexts);
}

function cacheKey(message, knowledge, history = []) {
  const context = history.slice(-4).map((item) => `${item.role || ""}:${normalizeQuestion(item.text || "")}`).join("|");
  return `${ANSWER_ENGINE_VERSION}:${knowledge.builtAt || "unknown"}:${context}:${normalizeQuestion(message)}`;
}

async function loadResponseCache() {
  if (responseCache.size) return;
  if (!responseCacheLoadPromise) {
    responseCacheLoadPromise = (async () => {
      const cached = await readJson(CACHE_FILE, []);
      for (const item of cached.slice(-300)) responseCache.set(item.key, item.value);
    })().finally(() => {
      responseCacheLoadPromise = null;
    });
  }
  await responseCacheLoadPromise;
}

async function persistResponseCache() {
  await writeJsonAtomic(
    CACHE_FILE,
    [...responseCache.entries()].slice(-300).map(([key, value]) => ({ key, value })),
  );
}

async function handleChat(req, res) {
  const startedAt = Date.now();
  const body = await parseJsonBody(req);
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
  const message = String(body.message || (hasAttachments ? "Read this attachment and answer from it." : "")).trim();
  const sessionId = String(body.sessionId || clientIp(req)).slice(0, 120);
  if (!rateLimitOk(req, sessionId)) return json(res, 429, { error: "Too many messages in a short time. Please wait a minute and try again." });
  if (!message) return json(res, 400, { error: "Message is required" });
  if (message.length > 2000) return json(res, 400, { error: "Message is too long" });

  const clientHistory = Array.isArray(body.history) ? body.history.slice(-20) : [];
  await loadConversationMemory();
  const history = mergeConversationHistory(conversationHistory(sessionId), clientHistory);
  const previousHistory = previousConversation(history, message);

  const knowledge = await loadKnowledge();
  await loadResponseCache();
  const uploadedAttachments = hasAttachments ? await extractAttachments(body.attachments) : [];
  if (hasAttachments) rememberSessionAttachments(sessionId, uploadedAttachments);
  const storedAttachments = sessionAttachments(sessionId);
  const useStoredAttachments =
    !hasAttachments && storedAttachments.length > 0 && attachmentQuestionRelevance(message, storedAttachments) > 0;
  const skipCache =
    previousHistory.length > 0 ||
    hasAttachments ||
    useStoredAttachments ||
    isUnclearQuestion(message) ||
    Boolean(bareAcademicTopic(message)) ||
    isGreetingQuestion(message) ||
    asksProgramDetail(message) ||
    isGeneralAcademicQuestion(message) ||
    (previousHistory.length > 0 && isContextualFollowup(message));
  const key = cacheKey(message, knowledge, previousHistory);
  const cached = skipCache ? null : responseCache.get(key);
  if (cached) {
    const enrichedCached = {
      ...cached,
      profile: cached.profile || responseProfile(cached, message),
      suggestions: cached.suggestions || followupSuggestions(message, cached).slice(0, 3),
      cached: true,
    };
    const cachedPerson = resolvedPersonFromExchange(message, enrichedCached, knowledge);
    if (cachedPerson) setConversationEntity(sessionId, "person", cachedPerson);
    rememberConversationExchange(sessionId, history, message, enrichedCached.text);
    return json(res, 200, enrichedCached);
  }

  let result = null;
  if (uploadedAttachments.some((attachment) => attachment.text || attachment.visualCaption || attachment.error)) result = await answerFromAttachment(message, uploadedAttachments, history);
  if (!result && useStoredAttachments) result = await answerFromAttachment(message, storedAttachments, history);
  if (!result) result = directActivePersonAnswer(message, knowledge, conversationEntity(sessionId, "person"));
  if (!result) result = directAnswer(message, knowledge, previousHistory);
  if (!result && (asksContactDetail(message) || asksPersonIdentity(message))) {
    result = { text: notVerifiedText(message), sources: [], mode: "not_found" };
  }

  const useOfficialRetrieval =
    explicitlyRequestsGonoContext(message) ||
    requiresVerifiedStructuredAnswer(message, history) ||
    (isContextualFollowup(message) && previousHistory.length > 0);
  const contexts = result || !useOfficialRetrieval ? [] : searchPages(message, knowledge, history);
  const allowGeneralAnswer = !result && (!useOfficialRetrieval || isGeneralAcademicQuestion(message) || isContextualFollowup(message));
  if (!result && !contexts.length && !allowGeneralAnswer) {
    result = { text: notVerifiedText(message), sources: [], mode: "not_found" };
  }
  if (!result && !allowGeneralAnswer && (unsupportedSpecificDetail(message, contexts) || lacksSubstantiveTopicEvidence(message, contexts))) {
    result = { text: notVerifiedText(message), sources: [], mode: "not_found" };
  }

  if (!result) {
    const aiAnswer = await askAiProvider(message, contexts, history, "chat");
    if (aiAnswer) {
      result = {
        text: aiAnswer.text,
        sources: contexts.slice(0, 3).map(({ title, url }) => ({ title, url })),
        mode: aiAnswer.provider,
      };
    }
  }

  if (!result) {
    result =
      (allowGeneralAnswer
        ? generalAcademicFallbackAnswer(message, contexts) || smartRetrievalAnswer(message, contexts)
        : smartRetrievalAnswer(message, contexts) || generalAcademicFallbackAnswer(message, contexts)) ||
      (allowGeneralAnswer
        ? {
            text: prefersBanglish(message)
              ? `**${message}** সম্পর্কে প্রয়োজনীয় তথ্য ও পরামর্শ:\n- আপনি কি Gono Bishwabidyalay-এর নির্দিষ্ট কোনো বিভাগ (যেমন CSE, Pharmacy, BBA, Law), কোর্স ফি, ওয়েভার, নাকি ভর্তির যোগ্যতা সম্পর্কে জানতে চান?\n- আপনার প্রশ্নটি আরেকটু বিস্তারিত বা নির্দিষ্ট করে বলুন, আমি পূর্ণাঙ্গ তথ্য দিয়ে সাহায্য করব।`
              : `Helpful guidance regarding **${message}**:\n- Please let me know if you would like detailed information about specific programs (CSE, Pharmacy, BBA, Law), tuition fees, waivers, or admission procedures.\n- Feel free to ask any specific follow-up and I will guide you with verified facts!`,
            sources: [],
            mode: "ai_fallback",
          }
        : { text: notVerifiedText(message), sources: [], mode: "not_found" });
  }

  const mayAttachRetrievedSources =
    result.mode !== "not_found" &&
    !(String(result.mode || "").includes("general_academic") && !explicitlyRequestsGonoContext(message));
  if (mayAttachRetrievedSources && !result.sources?.length && result.text !== NOT_VERIFIED && result.text !== notVerifiedText(message) && contexts.length) {
    result.sources = contexts.slice(0, 2).map(({ title, url }) => ({ title, url }));
  }
  result.profile = responseProfile(result, message);
  result.suggestions = followupSuggestions(message, result).slice(0, 3);
  const resolvedPerson = resolvedPersonFromExchange(message, result, knowledge);
  if (resolvedPerson) setConversationEntity(sessionId, "person", resolvedPerson);
  rememberConversationExchange(sessionId, history, message, result.text);

  if (!skipCache) {
    responseCache.set(key, result);
    persistResponseCache().catch(async (error) => {
      responseCache.delete(key);
      await logServerEvent({ at: new Date().toISOString(), level: "warn", message: error.message, scope: "response_cache" });
    });
  }
  appendJsonList(CHAT_FILE, {
      at: new Date().toISOString(),
      sessionId,
      question: message,
      answer: result.text,
      mode: result.mode,
      sourceCount: result.sources?.length || 0,
      latencyMs: Date.now() - startedAt,
    }).catch(async (error) => {
    await logServerEvent({ at: new Date().toISOString(), level: "warn", message: error.message, scope: "chat_history" });
    });

  return json(res, 200, result);
}

function requireAdmin(req, res) {
  const configuredToken = envSecret("ADMIN_TOKEN");
  if (!configuredToken) {
    json(res, 403, { error: "Admin endpoints are disabled until ADMIN_TOKEN is configured" });
    return false;
  }
  if (req.headers["x-admin-token"] === configuredToken) return true;
  json(res, 401, { error: "Admin token required" });
  return false;
}

async function adminStatus(req, res) {
  const knowledge = existsSync(KNOWLEDGE_FILE) ? await loadKnowledge() : { pages: [], faculty: [], documents: [] };
  const logs = await readJson(LOG_FILE, []);
  const chats = await readJson(CHAT_FILE, []);
  const settings = await loadSettings();
  const pageCount = knowledge.pageCount || knowledge.pages?.length || 0;
  const peopleCount = knowledge.faculty?.length || 0;
  const documentCount = knowledge.documents?.length || 0;
  const programCount = verifiedPrograms(knowledge.programs || []).length;
  const contactCount = knowledge.contacts?.length || 0;
  const noticeCount = knowledge.notices?.length || 0;
  const ollamaAvailable = await isOllamaAvailable();
  const warnings = [];
  const hasUsefulKnowledge = pageCount >= 10 || peopleCount >= 50 || documentCount > 0;
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentCrawlerProblems = logs.some((log) => {
    const at = Date.parse(log.at || "");
    return at >= oneDayAgo && log.scope === "crawler" && /timeout|connect|failed|skipped/i.test(log.message || "");
  });
  if (!hasUsefulKnowledge) warnings.push(`Knowledge coverage is low (${pageCount} pages, ${peopleCount} people records). Run a successful crawl before expecting broad answers.`);
  if (recentCrawlerProblems) {
    warnings.push("Recent crawler logs show official-site connectivity problems.");
  }
  return json(res, 200, {
    ok: true,
    engineVersion: ANSWER_ENGINE_VERSION,
    officialSiteUrl: settings.officialSiteUrl,
    builtAt: knowledge.builtAt || null,
    pageCount,
    peopleCount,
    documentCount,
    programCount,
    contactCount,
    noticeCount,
    conversationCount: conversationSessions.size,
    coverage: knowledge.coverage || null,
    chatCount: chats.length,
    errorCount: logs.filter((log) => log.level === "error").length,
    openAiConfigured: Boolean(envSecret("OPENAI_API_KEY")),
    openAiProviderName,
    geminiConfigured: Boolean(envSecret("GEMINI_API_KEY")),
    ollamaAvailable,
    openAiModel,
    ollamaModel,
    geminiModel,
    aiProvider: settings.aiProvider,
    freeAiProviders: settings.freeAiProviders,
    warnings,
    rebuild: rebuildState,
  });
}

async function adminLogs(req, res) {
  const logs = await readJson(LOG_FILE, []);
  const chats = await readJson(CHAT_FILE, []);
  return json(res, 200, { logs: logs.slice(-150).reverse(), chats: chats.slice(-150).reverse() });
}

async function adminSettings(req, res) {
  if (req.method === "GET") return json(res, 200, await loadSettings());
  const body = await parseJsonBody(req);
  const next = {
    ...(await loadSettings()),
    officialSiteUrl: normalizeBaseUrl(body.officialSiteUrl || officialSiteUrl),
    maxPages: Math.min(Math.max(Number(body.maxPages || 2000), 1), 5000),
    crawlConcurrency: Math.min(Math.max(Number(body.crawlConcurrency || 10), 1), 25),
  };
  await writeJsonAtomic(SETTINGS_FILE, next);
  return json(res, 200, next);
}

async function adminRefresh(req, res) {
  if (rebuildState.running) return json(res, 409, { error: "Knowledge rebuild is already running", rebuild: rebuildState });
  const settings = await loadSettings();
  rebuildState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: "Crawler started" };
  const child = spawn(process.execPath, ["scripts/build-knowledge.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      OFFICIAL_SITE_URL: settings.officialSiteUrl,
      MAX_PAGES: String(settings.maxPages),
      CRAWL_CONCURRENCY: String(settings.crawlConcurrency),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    rebuildState.message = chunk.toString().trim().slice(-500);
  });
  child.stderr.on("data", async (chunk) => {
    const message = chunk.toString().trim();
    rebuildState.message = message.slice(-500);
    await logServerEvent({ at: new Date().toISOString(), level: "warn", scope: "crawler", message });
  });
  child.on("close", async (code) => {
    rebuildState = {
      ...rebuildState,
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      message: code === 0 ? "Knowledge rebuild completed" : `Knowledge rebuild failed with exit code ${code}`,
    };
    responseCache.clear();
    knowledgeCache = null;
    await logServerEvent({ at: new Date().toISOString(), level: code === 0 ? "info" : "error", scope: "crawler", message: rebuildState.message });
  });
  return json(res, 202, { rebuild: rebuildState });
}

async function route(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, {});

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    const knowledge = await loadKnowledge();
    return json(res, 200, {
      ok: true,
      engineVersion: ANSWER_ENGINE_VERSION,
      builtAt: knowledge.builtAt,
      pageCount: knowledge.pageCount || knowledge.pages.length,
      openAiConfigured: Boolean(envSecret("OPENAI_API_KEY")),
      geminiConfigured: Boolean(envSecret("GEMINI_API_KEY")),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(req, res);
  if (req.method === "GET" && url.pathname === "/api/admin/status") return adminStatus(req, res);
  if (url.pathname.startsWith("/api/admin") && !requireAdmin(req, res)) return;
  if (req.method === "GET" && url.pathname === "/api/admin/logs") return adminLogs(req, res);
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/admin/settings") return adminSettings(req, res);
  if (req.method === "POST" && url.pathname === "/api/admin/refresh") {
    if (!rateLimitOk(req)) return json(res, 429, { error: "Too many requests" });
    return adminRefresh(req, res);
  }
  if (!url.pathname.startsWith("/api")) {
    return serveStatic(req, res, url.pathname);
  }
  return json(res, 404, { error: "Not found" });
}

const STATIC_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "Method not allowed" });
  }
  const cleanPath = pathname.replace(/^\/+/, "").replace(/\.\./g, "");
  const distPath = fileURLToPath(DIST_DIR);
  let targetFile = resolve(distPath, cleanPath || "index.html");
  if (!existsSync(targetFile)) {
    targetFile = resolve(distPath, "index.html");
  } else {
    try {
      const stats = await stat(targetFile);
      if (stats.isDirectory()) {
        targetFile = resolve(distPath, "index.html");
      }
    } catch {
      targetFile = resolve(distPath, "index.html");
    }
  }
  if (!existsSync(targetFile)) {
    return json(res, 404, { error: "Frontend build not found" });
  }
  try {
    const ext = extname(targetFile).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] || "application/octet-stream";
    const data = await readFile(targetFile);
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": Buffer.byteLength(data),
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(data);
  } catch (error) {
    json(res, 500, { error: "Failed to read file" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    await logServerEvent({ at: new Date().toISOString(), level: "error", message: error.message, scope: "server" });
    json(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    console.log(`University assistant API running at http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
  });
}

export {
  directActivePersonAnswer,
  directAnswer,
  extractProgramPlanFacts,
  mergeConversationHistory,
  relevantConversationHistory,
  resolvedPersonFromExchange,
  requiresVerifiedStructuredAnswer,
};
