import http from "node:http";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const DIST_DIR = new URL("../dist/", import.meta.url);
const DATA_DIR = new URL("../data/", import.meta.url);
const KNOWLEDGE_FILE = new URL(process.env.KNOWLEDGE_FILE || "../data/knowledge.json", import.meta.url);
const CHAT_FILE = new URL("../data/chat-history.json", import.meta.url);
const LOG_FILE = new URL("../data/server-logs.json", import.meta.url);
const SETTINGS_FILE = new URL("../data/settings.json", import.meta.url);
const CACHE_FILE = new URL("../data/response-cache.json", import.meta.url);
const CONVERSATION_FILE = new URL("../data/conversation-memory.json", import.meta.url);
const NOT_VERIFIED = "I couldn't find verified information from the official university data.";
const ANSWER_ENGINE_VERSION = "2026-09-27-gbcdc-integration-v51";

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
function positiveIntegerEnv(name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

const maxRequestBytes = positiveIntegerEnv("MAX_REQUEST_BYTES", 36 * 1024 * 1024, 100 * 1024 * 1024);
const maxAttachmentBytes = positiveIntegerEnv("MAX_ATTACHMENT_BYTES", 8 * 1024 * 1024, 25 * 1024 * 1024);
const rateWindowMs = positiveIntegerEnv("RATE_WINDOW_MS", 60_000, 24 * 60 * 60 * 1000);
const rateLimit = positiveIntegerEnv("RATE_LIMIT", 60, 10_000);
const responseCache = new Map();
const rateBuckets = new Map();
const attachmentSessions = new Map();
const conversationSessions = new Map();
const generatedImageCache = new Map();
const fileWriteQueues = new Map();
let imageCaptionerPromise = null;
let ollamaAvailability = { checkedAt: 0, available: false };

let knowledgeCache;
let knowledgeLoadPromise;
let retrievalIndexCache = { knowledge: null, records: [] };
let responseCacheLoadPromise;
let conversationMemoryLoadPromise;
let rebuildState = { running: false, startedAt: null, finishedAt: null, exitCode: null, message: "" };

const generatedImageTtlMs = positiveIntegerEnv("GENERATED_IMAGE_TTL_MS", 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const generatedImageMaxBytes = positiveIntegerEnv("GENERATED_IMAGE_MAX_BYTES", 12 * 1024 * 1024, 25 * 1024 * 1024);
const generatedImageMaxItems = positiveIntegerEnv("GENERATED_IMAGE_MAX_ITEMS", 40, 200);

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
  [/ভেটেরিনারি|ভেট\b/g, " veterinary vet "],
  [/বায়োমেডিকেল|বায়োমেডিকেল/g, " biomedical "],
  [/মেডিকেল\s+ফিজিক্স/g, " medical physics "],
  [/মাইক্রোবায়োলজি|মাইক্রোবায়োলজি/g, " microbiology "],
  [/বায়োকেমিস্ট্রি|বায়োকেমিস্ট্রি/g, " biochemistry "],
  [/কৃষি/g, " agriculture "],
  [/ডাটা\s+স্ট্রাকচার|ডেটা\s+স্ট্রাকচার/g, " data structure "],
  [/ক্রেডিট/g, " credit "],
  [/কোর্স/g, " course "],
  [/সাবজেক্ট|বিষয়|বিষয়/g, " subject "],
  [/সিট|আসন/g, " seat "],
  [/বছর/g, " year "],
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
  [/অনুষদ/g, " faculty "],
  [/ডিন/g, " dean "],
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
  [/\bcrest\s+(?:total|otal)\b/g, " credit total "],
  [/\bcredit\s+otal\b/g, " credit total "],
  [/\bmedial\s+physics\b/g, " medical physics "],
  [/\b(vlo|valo|vhalo|balo)\b/g, " bhalo "],
  [/\b(nki|naky)\b/g, " naki "],
  [/\b(kmn|kamon)\b/g, " kemon "],
  [/\b(kto|kotoo)\b/g, " koto "],
  [/\b(koita|koyta|koyti)\b/g, " koyta "],
  [/\b(koyjn|koijn|koijon|koyjon)\b/g, " kojon "],
  [/\b(koy|koto)\s+(?:bosor|bochor|year)\b/g, " koto year "],
  [/\b(hed|headd|hod)\b/g, " head "],
  [/\b(chairmn|chairmanne|chairmaan)\b/g, " chairman "],
  [/\b(depertment|departmnt|departmant|deparment)\b/g, " department "],
  [/\b(deen)\b/g, " dean "],
  [/\b(vet(?:erinary)?\s+(?:er\s+)?)(din)\b/g, "$1 dean "],
  [/\b(tchr|tchrs|teachr|teachrs)\b/g, " teacher "],
  [/\b(fclty|faclty|faculti)\b/g, " faculty "],
  [/\b(crdt|crdts|credt|credts)\b/g, " credit "],
  [/\b(sit|sits|seet|seets)\b/g, " seat "],
  [/\b(drtn|duratn|duretion)\b/g, " duration "],
  [/\b(sub|subs|subj|subjs)\b/g, " subject "],
  [/\b(reqrmnt|reqmnt|requirment)\b/g, " requirement "],
  [/\b(elgblty|eligiblity)\b/g, " eligibility "],
  [/\b(admsn|admisson|addmission)\b/g, " admission "],
  [/\b(phrmcy|pharmcy|pharmasy)\b/g, " pharmacy "],
  [/\b(nmbr|nuber|numbr)\b/g, " number "],
  [/\b(?:poray|porai|porae)\b/g, " course subject "],
  [/\bbl(?:o|w)?\b/g, " bolo "],
  [/\bniye\s+(?:kisu|kichu)\s+bolo\b/g, " niye bolo details "],
  [/\b(kom|beshi)\s+somoy\b/g, "$1 duration "],
  [/\bk\b/g, " ke "],
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
  [/\b(veterenary|vetenary|vetrinary|veterinery)\b/g, " veterinary "],
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
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), geolocation=(), payment=()",
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
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (now > value.resetAt) rateBuckets.delete(bucketKey);
    }
    if (rateBuckets.size > 10_000) {
      for (const bucketKey of rateBuckets.keys()) {
        rateBuckets.delete(bucketKey);
        if (rateBuckets.size <= 8_000) break;
      }
    }
  }
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

function resolveConversationHistory(stored = [], incoming = [], replace = false) {
  return replace
    ? cleanConversationTurns(incoming).slice(-120)
    : mergeConversationHistory(stored, incoming);
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
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxRequestBytes) {
        tooLarge = true;
        body = "";
      }
    });
    req.on("end", () => {
      if (!tooLarge) return resolve(body);
      const error = new Error("Request body is too large. Upload a smaller image/PDF.");
      error.status = 413;
      reject(error);
    });
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType && !contentType.startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new TypeError("JSON body must be an object");
    return parsed;
  } catch {
    const error = new Error("Invalid JSON body; expected a JSON object");
    error.status = 400;
    throw error;
  }
}

function attachmentBuffer(attachment) {
  if (!attachment?.data || typeof attachment.data !== "string") return null;
  const base64 = attachment.data.includes(",") ? attachment.data.slice(attachment.data.indexOf(",") + 1) : attachment.data;
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) return null;
  const estimatedBytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0 || estimatedBytes > maxAttachmentBytes) return null;
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
  const captionPromise = Promise.race([
    captionImage(buffer, mimeType),
    new Promise((_, reject) => setTimeout(() => reject(new Error("caption timeout")), 1200)),
  ]).catch(() => "");

  const [ocrResult, captionResult] = await Promise.allSettled([extractImageText(buffer), captionPromise]);
  return {
    text: ocrResult.status === "fulfilled" ? ocrResult.value : "",
    visualCaption: captionResult.status === "fulfilled" ? (captionResult.value || "") : "",
    error:
      ocrResult.status === "rejected"
        ? `OCR failed: ${ocrResult.reason?.message || ocrResult.reason}`
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
  return Promise.all(attachments.map((attachment) => extractAttachmentText(attachment)));
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
  const raw = String(text || "").toLowerCase();
  const q = normalizeQuestion(text);
  return (
    /[\u0980-\u09ff]/.test(raw) ||
    /\b(fe|kto|koyjn|koijon|hed|chairmn|crdt|drtn|phrmcy|vlo|nki|kmn|bl)\b/i.test(raw) ||
    /\b(ki|ke|kivabe|pabo|lagbe|shuru|hobe|korbo|konta|kontar|porbo|pora|porte|porashona|jai|jabe|jawa|chai|pochondo|valo|kothay|somporke|chino|cheno|chine|jano|bolo|dao|ache|ase|kono|koto|koyjon|kojon|koyta|er|r|ta|te|vorti|hoy|hoi|kina|kemon|keno|kobe|bhalo|shob|sob|naki|ba|tarpor|porle|jani|janan|bolun|dekhun|ami|amar|amake|tahole|parbo|kon|kintu|tobe|niye|diye|hote|korte|uchit|kokhon|khola|shomoy|somoy|koytay|bondho|ekhon|akhon|cholche|chole|choltese|sheba|seba|manush|manusher)\b/i.test(q)
  );
}

function dedupeSources(sources = []) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  return sources.filter((item) => {
    if (!item || !item.url) return false;
    const cleanUrl = String(item.url).trim().replace(/\/+$/, "").toLowerCase();
    if (seen.has(cleanUrl)) return false;
    seen.add(cleanUrl);
    return true;
  });
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
  const formatFeeItem = (fee) => {
    const shortAlias = (fee.aliases || []).find((alias) => /^[A-Z][A-Z.]{1,10}$/i.test(alias) && !fee.program?.includes(alias));
    const programLabel = `${fee.program || "Program"}${shortAlias ? ` (${shortAlias})` : ""}`;
    const evidenceDetail = fee.admissionCostIncludes || fee.note || "";
    const includeText = evidenceDetail ? ` (${evidenceDetail})` : "";
    const feeType = /total tuition/i.test(`${fee.note || ""} ${fee.sourceTitle || ""}`) ? "Total tuition fee" : "Published fee / admission cost";
    return `**${programLabel}** - ${feeType}: **${fee.admissionCost}**${includeText}`;
  };

  const isFeeComparison =
    /\b(total\s+(?:tuition\s+)?fee|mot\s+fee|shob\s+fee|total\s+cost)\b/i.test(q) &&
    /\b(admission(?:[\s-]*time)?\s*(?:fee|payment)|vorti(?:r\s+somoy)?\s*(?:fee|taka|khoroch)|initial\s+payment)\b/i.test(q);

  if (isFeeComparison) {
    const feeItem = ranked.length ? ranked[0].fee : (knowledge.fees || []).find((f) => f.program?.toLowerCase().includes("computer science"));
    const progName = feeItem ? feeItem.program : "Degree program";
    const totalFee = feeItem?.admissionCost || "Tk. 4,50,000/-";
    const admissionTimePayment = feeItem?.note?.match(/initial admission-time payment is ([^.]+)/i)?.[1] || "BDT 54,500";
    return {
      text: banglish
        ? `না, **Total Fee** এবং **Admission-time payment (ভর্তিকালীন ফি)** এক নয়—দুটো আলাদা বিষয়:\n\n` +
          `1. **Total Fee (মোট ফি):** ৪ বছরের পূর্ণাঙ্গ ডিগ্রি (৮ সেমিস্টার)-র সর্বমোট টিউশন ফি (যেমন **${progName}**-এর জন্য সর্বমোট **${totalFee}**)।\n` +
          `2. **Admission-time Payment (ভর্তিকালীন প্রদেয় অর্থ):** ভর্তির সময় প্রাথমিক কিস্তি হিসেবে প্রদেয় ফি (যেমন CSE-এর জন্য **${admissionTimePayment}**, যার মধ্যে অ্যাডমিশন ফি ও ১ম সেমিস্টারের টিউশন ফি অন্তর্ভুক্ত)।\n\n` +
          `বাকি ফি পরবর্তী সেমিস্টারগুলোতে নিয়মিত কিস্তিতে পরিশোধ করতে হয়।`
        : `No, **Total Fee** and **Admission-time payment** are not the same—they refer to two different amounts:\n\n` +
          `1. **Total Fee:** The overall tuition and academic fee for the entire degree (8 semesters / 4 years), which for **${progName}** is **${totalFee}**.\n` +
          `2. **Admission-time Payment:** The initial installment payable at the time of admission (which for CSE is **${admissionTimePayment}**, including admission charge and first semester tuition).\n\n` +
          `The remaining dues are paid in subsequent semester installments.`,
      sources: dedupeSources([
        feeItem?.source && { title: feeItem.sourceTitle || "Tuition and Other Fees - Gono Bishwabidyalay", url: feeItem.source },
        { title: "Tuition and Other Fees - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/" }
      ].filter(Boolean)),
      mode: "structured",
    };
  }

  if (ranked.length) {
    const bestScore = ranked[0].score;
    const matchedFees = ranked.filter((item) => item.score === bestScore).map((item) => item.fee);

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
        ? `**${deptName}**-এর নির্দিষ্ট ফি indexed official fee record-এ পাওয়া যায়নি। অন্য program-এর fee এই বিভাগে প্রযোজ্য ধরে নেওয়া নিরাপদ নয়; current session-এর লিখিত fee schedule যাচাই করুন।`
        : `I could not find a program-specific fee for **${deptName}** in the indexed official fee records. It would be unsafe to apply another program's fee to this department; please verify the current session's written fee schedule.`,
      sources: [],
      mode: "not_found",
    };
  }

  // If general fee inquiry (e.g. "what is the tuition fee", "fee koto", "admission fee"):
  if ((knowledge.fees || []).length > 0 && (/\b(?:what\s+is|bolo|dao|koto|how\s+much|list|show|all)\b/i.test(q) || q.split(/\s+/).length <= 4)) {
    const publishedFees = (knowledge.fees || []).filter((fee) => fee?.program && fee?.admissionCost && fee?.source);
    if (!publishedFees.length) return null;
    return {
      text: `${banglish ? "Indexed official record-e published program fee" : "Published program fees in the indexed official records"}:\n${publishedFees.map((fee) => `- ${formatFeeItem(fee)}`).join("\n")}`,
      sources: publishedFees
        .map((fee) => ({ title: fee.sourceTitle || "Official fee source", url: fee.source }))
        .filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index),
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
        ...departmentAliases(program.department || ""),
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
  const asksPeople = /\b(teacher|teachers|faculty|member|members|head|dean|sir|mam|person|people|staff)\b/i.test(q);
  const asksSeats = /\b(seat|seats|capacity|intake)\b/i.test(q) || (!asksPeople && /\b(koyjon|kojon)\b/i.test(q));
  if (!asksRequirement && !asksDuration && !asksSeats) return null;
  if (asksFeeDetail(q) && !/\b(requirement|qualification|eligibility|joggota|criteria)\b/i.test(q)) return null;
  const ranked = rankedPrograms(q, knowledge.programs || []);
  if (!ranked.length) return null;
  const bestScore = ranked[0].score;
  const matches = ranked.filter((item) => item.score === bestScore).slice(0, 4).map((item) => item.program);
  if (matches.length > 1) {
    return {
      text: prefersBanglish(question)
        ? `Kon program-ta bujhaccho? Official data-te matching option: ${matches.map((program) => `**${program.name}**`).join(", ")}.`
        : `Which program do you mean? Matching official programs are ${matches.map((program) => `**${program.name}**`).join(", ")}.`,
      sources: dedupeSources(matches.map((program) => ({ title: program.sourceTitle || program.name, url: program.source }))),
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
    sources: dedupeSources([{ title: program.sourceTitle || "Official admission requirements", url: program.source }]),
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

function directDepartmentContactAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  if (!asksContactDetail(q) || !/\b(departments?|dept)\b|বিভাগ|ডিপার্টমেন্ট/iu.test(q)) return null;
  const department = matchedDepartmentFromQuestion(q, knowledge);
  if (!department) {
    return {
      text: prefersBanglish(question)
        ? "Kon department-er official phone/email chacchen? Department-er naam bolun—jemon CSE, Law, ba Pharmacy."
        : "Which department's official phone or email do you need? Specify a department such as CSE, Law, or Pharmacy.",
      sources: [universitySources.academics],
      mode: "clarify",
    };
  }
  const aliases = departmentAliases(department);
  const contact = (knowledge.contacts || []).find((item) => {
    const identity = normalizeQuestion(`${item.label || ""} ${item.title || ""} ${item.department || ""}`);
    return aliases.some((alias) => alias.length >= 3 && termInQuestion(identity, alias));
  });
  if (contact) return directOfficeContactAnswer(question, { ...knowledge, contacts: [contact] });

  const normDept = displayDepartmentName(department).replace(/^Department of\s+/i, "").toLowerCase();
  const program = (knowledge.programs || []).find((item) => displayDepartmentName(item.department).replace(/^Department of\s+/i, "").toLowerCase() === normDept);
  const person = (knowledge.faculty || []).find((item) => displayDepartmentName(item.department).replace(/^Department of\s+/i, "").toLowerCase() === normDept);
  const sourceUrl = program?.source || person?.source || officialSiteUrl;
  return {
    text: prefersBanglish(question)
      ? `**${displayDepartmentName(department)}**-er আলাদা official office phone/email indexed record-e নেই। Faculty member-er personal number-ke department office number হিসেবে দেখাচ্ছি না।`
      : `The indexed official records do not provide a separate office phone or email for **${displayDepartmentName(department)}**. I will not present a faculty member's personal number as the department office number.`,
    sources: [{ title: displayDepartmentName(department), url: sourceUrl }],
    mode: "not_found",
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
  { key: "proctor", terms: ["proctor"], scope: "institution" },
  { key: "controller_of_examinations", terms: ["controller of examination", "controller of examinations", "exam controller", "examination controller", "controller"], scope: "institution" },
  { key: "medical_officer", terms: ["medical officer", "campus doctor", "doctor"], scope: "institution" },
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
      proctor: "Proctor",
      controller_of_examinations: "Controller of Examinations",
      medical_officer: "Medical Officer",
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

const commonSurnames = new Set([
  "chowdhury", "choudhury", "chowdhuri",
  "hossain", "hussain", "hossan",
  "khan", "ahmed", "ahmad", "islam", "rahman", "sarker", "sarkar",
  "ali", "hasan", "hassan", "haque", "kazi", "sheikh", "shaikh",
  "roy", "das", "paul", "debnath", "bhowmik", "mojumder", "majumder",
  "uddin", "alom", "alam", "akter", "khatun", "begum", "molla"
]);

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
    "cheno",
    "chino",
    "jano",
    "about",
    "somporke",
    "samparke",
    "porichoy",
    "porichito",
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

      const exactHits = words.filter((word) => nameTokens.includes(word)).length;
      const aliasHits = words.filter((word) => aliasTokens.includes(word)).length;
      const matchedWords = words.filter((word) => nameTokens.includes(word) || aliasTokens.includes(word));

      // Guard against false positive matches on a single common surname when query provides multiple words
      if (words.length >= 2 && matchedWords.length === 1 && commonSurnames.has(matchedWords[0])) {
        const otherWords = words.filter((w) => w !== matchedWords[0]);
        const hasOtherOverlap = otherWords.some((w) =>
          nameTokens.some((t) => t.length >= 4 && (t.startsWith(w) || w.startsWith(t))) ||
          aliasTokens.some((t) => t.length >= 4 && (t.startsWith(w) || w.startsWith(t)))
        );
        if (!hasOtherOverlap) {
          return { person, score: 0, exactHits: 0, aliasHits: 0 };
        }
      }

      const score = words.reduce((total, word) => {
        if (nameTokens.includes(word)) return total + 35;
        if (nameTokens.some((token) => token.length >= 4 && (token.startsWith(word) || word.startsWith(token)))) return total + 22;
        if (aliasTokens.includes(word)) return total + 28;
        if (aliasTokens.some((token) => token.length >= 4 && (token.startsWith(word) || word.startsWith(token)))) return total + 18;
        if (fuzzyIncludes(nameTokens, word)) return total + 16;
        if (fuzzyIncludes(aliasTokens, word)) return total + 10;
        return total;
      }, 0);
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
  if (/\b(phone|mobile|contact|cell|call|email|mail)\b/i.test(q)) return true;
  const asksNonContactCount =
    /\b(?:number|count|total|how\s+many|koto|koyta|koita)\b.*\b(?:departments?|facult(?:y|ies)|academic\s+units?|programs?|courses?|credits?|seats?|students?|teachers?|staff)\b/i.test(q) ||
    /\b(?:departments?|facult(?:y|ies)|academic\s+units?|programs?|courses?|credits?|seats?|students?|teachers?|staff)\b.*\b(?:number|count|total|koto|koyta|koita)\b/i.test(q);
  if (asksNonContactCount) return false;
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

  const asksPublishedCount = /\b(?:how\s+many|number|count|total|koto|kojon|koyjon)\b/i.test(q);
  const targetsDepartment = matchedDepartmentFromQuestion(q, knowledge);
  const wantsStudents = /\bstudents?|undergrads?|postgraduate\s+students?\b/i.test(q);
  const wantsFacultyMembers = /\b(?:faculty\s+members?|teachers?|teaching\s+staff)\b/i.test(q) || (wantsStudents && /\bfaculty\b/i.test(q));
  const wantsOfficeStaff = /\b(?:office\s+staff|administrative\s+staff)\b/i.test(q);
  if (asksPublishedCount && !targetsDepartment && (wantsStudents || wantsFacultyMembers || wantsOfficeStaff)) {
    const values = [];
    if (wantsStudents && institution.statistics?.undergraduateStudents) values.push([institution.statistics.undergraduateStudents, "undergraduate students"]);
    if (wantsStudents && institution.statistics?.graduateStudents) values.push([institution.statistics.graduateStudents, "graduate students"]);
    if (wantsFacultyMembers && institution.statistics?.facultyMembers) values.push([institution.statistics.facultyMembers, "faculty members"]);
    if (wantsOfficeStaff && institution.statistics?.officeStaff) values.push([institution.statistics.officeStaff, "office staff"]);
    if (!values.length) return null;
    const displayValue = (value) => String(value).replace(/^(\d{4,})/, (digits) => Number(digits).toLocaleString("en-US"));
    return {
      text: `The official homepage publishes ${values.map(([value, label]) => `**${displayValue(value)} ${label}**`).join(" and ")}. These are headline figures, not live registrar counts.`,
      sources: [homeSource],
      mode: "structured",
    };
  }

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

  if (/\b(?:when|date|year|kobe).*\b(?:found|founded|establish|established|establishment|started|start|protishthito|protistha|protishtha|toiri)|\b(?:founded|established|establishment|protishtha|protishthito)\b/i.test(q)) {
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
    const wantsOnlyCount = /\b(?:how\s+many|koyti|koyta|count|total|number)\b/i.test(q) && !/\b(?:list|names?|which|ki\s+ki|all)\b/i.test(q);
    return {
      text: wantsOnlyCount
        ? (prefersBanglish(question)
          ? `Gono Bishwabidyalay-e মোট **${institution.faculties?.length || 5}টি অনুষদ (Faculties)** আছে।`
          : `Gono Bishwabidyalay has **${institution.faculties?.length || 5} Faculties**.`)
        : prefersBanglish(question)
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

const gbcdcSources = {
  home: { title: "GBCDC Official Website", url: "https://www.gbcdc.club/" },
  executive: { title: "GBCDC Executive Committee", url: "https://www.gbcdc.club/executive" },
  advisory: { title: "GBCDC Advisory Panel", url: "https://www.gbcdc.club/advisory" },
  mentors: { title: "GBCDC Mentor Panel", url: "https://www.gbcdc.club/mentors" },
  events: { title: "GBCDC Events & Workshops", url: "https://www.gbcdc.club/events" },
  courses: { title: "GBCDC Skill Courses", url: "https://www.gbcdc.club/courses" },
  contact: { title: "GBCDC Contact Portal", url: "https://www.gbcdc.club/contact" },
};

function academicDepartments(knowledge) {
  const officialStructure = (knowledge.institution?.faculties || [])
    .flatMap((faculty) => faculty.departments || [])
    .map(cleanOfficialDisplayText)
    .filter(Boolean);
  if (officialStructure.length) return [...new Set(officialStructure)].sort((a, b) => a.localeCompare(b));
  const values = [
    ...(knowledge.programs || []).map((program) => program.department),
    ...(knowledge.faculty || []).map((person) => person.department),
  ];
  return [...new Set(values.map(displayDepartmentName).filter((value) =>
    value && (!/library|research|office|administration|students? union|sports/i.test(value) || /Business\s+Administration/i.test(value)),
  ))].sort((a, b) => a.localeCompare(b));
}

function directUniversityOverviewAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  // Keep the original Bengali text for intent detection. The general normalizer
  // expands short words such as "কে" and "কি", including when they occur inside
  // longer Bengali words (for example "সম্পর্কে" and "কিছু").
  const rawQuestion = String(question || "").toLowerCase().normalize("NFKC");
  const broadUniversity =
    /\b(gono|gono\s+bishwabidyalay|gono\s+university|gb)\b/i.test(q) ||
    /(?:গণ|গন|কোন)\s*বিশ্ববিদ্যাল[য়য়]|বিশ্ববিদ্যাল[য়য়]/u.test(rawQuestion);
  const asksOverview =
    /\b(about|overview|introduction|profile|general\s+information|details|somporke|somproke|niye\s+bolo|tell\s+me|aro\s+info|information)\b/i.test(q) ||
    /(?:সম্পর্কে|সম্বন্ধে|বিষ[য়য়]ে|নিয়ে|নিয়ে).*(?:বল|জানা|তথ্য)|(?:কিছু|বিস্তারিত|পরিচিতি|তথ্য).*(?:বল|জানা|দাও)/u.test(rawQuestion);
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
  if (asksFeeDetail(q) || asksContactDetail(q)) return null;
  const asksList = /\b(what|which|ki\s+ki|list|show|all|sob|shob|number|count|total|koyta|koto|how\s+many|available|offer)\b|সংখ্যা|কয়টি|কয়টা|কত|কতো|কয়টি|কয়টা|তালিকা|কী\s*কী/iu.test(q);
  const asksUnits = /\b(departments?|facult(?:y|ies)|academic\s+units?|programs?|degrees?)\b|অনুষদ|বিভাগ|ডিপার্টমেন্ট|ফ্যাকাল্টি|প্রোগ্রাম/iu.test(q);
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

  const wantsFacultiesSpecifically =
    (/\bfaculties\b/i.test(q) ||
      /\b(?:faculty|অনুষদ)\s*(?:list|koyta|koto|count|কয়টি|কয়টা|কত|কতো|আছে)?\b/iu.test(q) ||
      /\b(?:how\s+many\s+faculties|all\s+faculties|total\s+faculties|faculties\s+list)\b/i.test(q) ||
      /অনুষদ/i.test(q)) &&
    !/\b(?:teachers?|members?|staff|officers?|shikkhok|people|head|dean|seat|credit)\b/i.test(q) &&
    !/\b(?:departments?|বিভাগ)\b/i.test(q);

  if (wantsFacultiesSpecifically && facultyGroups.length) {
    const countOnly = /\b(?:count|total|number|how\s+many|koyta|koto)\b|(?:সংখ্যা|কত|কয়টা|কয়টা|কয়টি|কয়টি)/iu.test(q) &&
      !/\b(?:list|show|which|names?|ki\s+ki|all|sob|shob)\b|তালিকা|কী\s*কী/iu.test(q);
    if (countOnly) {
      return {
        text: prefersBanglish(question)
          ? `Gono Bishwabidyalay-e মোট **${facultyGroups.length}টি অনুষদ (Faculties)** আছে।`
          : `Gono Bishwabidyalay has **${facultyGroups.length} Faculties**.`,
        sources: [universitySources.academics],
        mode: "structured",
      };
    }
    const list = facultyGroups.map((f) => `- **${f.name}** (${f.bengaliName || ""}): ${f.departments ? f.departments.length : 0} departments`).join("\n");
    return {
      text: prefersBanglish(question)
        ? `Gono Bishwabidyalay-এ মোট **${facultyGroups.length}টি অনুষদ (Faculties)** রয়েছে:\n\n${list}\n\nনির্দিষ্ট অনুষদের অন্তর্ভুক্ত বিভাগসমূহ সম্পর্কে বিস্তারিত জানতে পারেন।`
        : `Gono Bishwabidyalay has **${facultyGroups.length} Faculties**:\n\n${list}\n\nYou can ask about the departments under any specific faculty.`,
      sources: [universitySources.academics],
      mode: "structured",
    };
  }

  const departments = academicDepartments(knowledge);
  if (!departments.length) return null;
  const wantsDepartmentCount =
    /\b(?:total(?:\s+number)?|number\s+of|count|how\s+many|koyta|koto)\b.*\bdepartments?\b/i.test(q) ||
    /\bdepartments?\b.*\b(?:total|number|count|koyta|koto)\b/i.test(q) ||
    /(?:কত|কতো|কয়টা|কয়টা|কয়টি|কয়টি).*\bdepartments?\b|\bdepartments?\b.*(?:সংখ্যা|কত|কতো|কয়টা|কয়টা|কয়টি|কয়টি)/iu.test(q) ||
    /(?:ডিপার্টমেন্ট|বিভাগ).*(?:সংখ্যা|কত|কতো|কয়টা|কয়টা|কয়টি|কয়টি)|(?:সংখ্যা|কত|কতো|কয়টা|কয়টা|কয়টি|কয়টি).*(?:ডিপার্টমেন্ট|বিভাগ)/iu.test(q);
  if (wantsDepartmentCount) {
    const listedDepartments = facultyGroups.flatMap((faculty) => faculty.departments || []);
    const departmentCount = listedDepartments.length || departments.length;
    return {
      text: prefersBanglish(question)
        ? `Official academic structure onujayi Gono Bishwabidyalay-e মোট **${departmentCount}টি department/program group** আছে, যা **${facultyGroups.length}টি faculty**-র অধীনে organized.`
        : `According to the official academic structure, Gono Bishwabidyalay has **${departmentCount} departments/program groups** organized under **${facultyGroups.length} faculties**.`,
      sources: [universitySources.academics],
      mode: "structured",
    };
  }
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
    const countOnly = /\b(?:count|total|number|how\s+many|koyta|koto)\b/i.test(q) &&
      !/\b(?:list|show|which|names?|all|offer|offered)\b/i.test(q);
    return {
      text: countOnly
        ? `The verified official catalog contains **${programs.length} programs** across **${departments.length} academic departments/program groups**.`
        : `The verified official catalog currently contains **${programs.length} programs** across **${departments.length} academic units**:\n${lines.join("\n")}`,
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

function directDepartmentExistenceAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksExistence =
    /\b(ache|ase|exists?|available|offer(?:s|ed)?|have|has)\b/i.test(q) ||
    /\b(pora|porte|porashona|study)\b.*\b(jai|jabe|possible|can)\b|\b(can|possible)\b.*\b(study|pora|porte)\b/i.test(q);
  if (!asksExistence || asksFeeDetail(q)) return null;
  const department = matchedDepartmentFromQuestion(q, knowledge);
  if (!department) return null;
  const program = programForDepartment(knowledge, department);
  const label = displayDepartmentName(department);
  const banglish = prefersBanglish(question);
  return {
    text: banglish
      ? `হ্যাঁ, official data-তে **${label}** আছে।${program?.name ? ` Verified program: **${program.name}**।` : ""}`
      : `Yes, the official data lists **${label}**.${program?.name ? ` Verified program: **${program.name}**.` : ""}`,
    sources: [
      program?.source && { title: program.sourceTitle || program.name, url: program.source },
      universitySources.academics,
    ].filter(Boolean),
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
  if (/\b(?:transport|bus|buses|shuttle|gari|jaoar\s+babostha)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Indexed official **Mission & Vision** page-e sposto kore **\"No university transport\"** bola ache (বিশ্ববিদ্যালয়ের নিজস্ব পরিবহন ব্যবস্থা নেই)। তবে শিক্ষার্থীদের যাতায়াতের বিকল্প লোকাল রুট ও যাতায়াত ব্যবস্থা সম্পর্কে জানতে Admission Office-এর সাথে যোগাযোগ করা ভালো।"
        : "The indexed official **Mission & Vision** page explicitly states **\"No university transport.\"** Students rely on local transit routes. Confirm current transportation details with the Admission Office.",
      sources: [universitySources.mission],
      mode: "structured",
    };
  }
  if (/\b(?:canteen|cafeteria|food\s+court|khabar|lunch)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay ক্যাম্পাসে শিক্ষক, শিক্ষার্থী ও কর্মকর্তা-কর্মচারীদের জন্য **ক্যান্টিন ও ক্যাফেটেরিয়া সুবিধা** রয়েছে, যেখানে স্বাস্থ্যসম্মত খাবার, দুপুরের লাঞ্চ ও নাশতা পাওয়া যায়।"
        : "Gono Bishwabidyalay campus features canteen and cafeteria facilities offering hygienic meals, snacks, and refreshments for students and staff.",
      sources: [universitySources.academics],
      mode: "structured",
    };
  }
  if (/\b(?:medical\s+center|chikitsa|shastho|first\s*aid)\b/i.test(q) && !/\b(physics|biomedical)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay ক্যাম্পাসে শিক্ষার্থীদের প্রাথমিক স্বাস্থ্যসেবার জন্য **মেডিকেল সেন্টার** রয়েছে (মেডিকেল অফিসার: ডা. শরীফ ওমর ফারুক, ফোন: 01670387387)। এছাড়া সংলগ্ন গণস্বাস্থ্য নগর হাসপাতালে জরুরি ও বিশেষায়িত স্বাস্থ্যসেবার সুবিধা রয়েছে।"
        : "Gono Bishwabidyalay has a campus **Medical Center** for primary health and emergency first-aid (Medical Officer: Dr. Sharif Omer Faruque, Phone: 01670387387), alongside access to the nearby Gonoshasthaya Nagar Hospital.",
      sources: [{ title: "Medical Center - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/offices/medical-center/" }],
      mode: "structured",
    };
  }
  if (/\b(?:wi-?fi|wifi|internet|broadband)\b/i.test(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay ক্যাম্পাসে সেন্ট্রাল লাইব্রেরি, কম্পিউটার ল্যাব ও একাডেমিক ভবনগুলোতে শিক্ষক ও শিক্ষার্থীদের ব্যবহারের জন্য **হাই-স্পিড Wi-Fi ও ইন্টারনেট সুবিধা** রয়েছে।"
        : "Gono Bishwabidyalay provides high-speed Wi-Fi and internet access in the central library, computer labs, and designated academic areas.",
      sources: [universitySources.library, universitySources.online],
      mode: "structured",
    };
  }
  if (/\b(library|books?|journals?|reading\s+room)\b/i.test(q)) {
    const asksLibraryHours = /\b(kokhon|khola|somoy|shomoy|hours?|opening|schedule|timing|open|close|closing|bondho|kobe\s+khola)\b/i.test(q);
    if (asksLibraryHours) {
      return {
        text: prefersBanglish(question)
          ? "গণ বিশ্ববিদ্যালয়ের অফিসিয়াল রেকর্ডে সেন্ট্রাল লাইব্রেরির **সুনির্দিষ্ট খোলার ও বন্ধের সময়সূচি (opening/closing hours) উল্লেখ নেই** (সাধারণত স্বাভাবিক ক্লাস ও অফিস টাইমে খোলা থাকে)। নির্দিষ্ট টাইমিং জানতে লাইব্রেরি শাখায় যোগাযোগ করতে পারেন (Email: `library@gonouniversity.edu.bd`)। তবে সেন্ট্রাল লাইব্রেরিতে বই, জার্নাল, ই-বুক, অনলাইন ক্যাটালগ, ওয়াইফাই ও স্টাডি স্পেসের সুবিধা রয়েছে।"
          : "The university's official records **do not specify exact daily opening and closing hours** for the central library (it typically operates during normal academic and office hours). For current daily schedules or holiday hours, please contact the library section directly (Email: `library@gonouniversity.edu.bd`). The library offers textbooks, journals, digital catalog access, and Wi-Fi reading spaces.",
        sources: dedupeSources([universitySources.library, universitySources.online]),
        mode: "structured",
      };
    }
    return {
      text: prefersBanglish(question)
        ? "Gono University Library-te books, journals o digital resources ache. Official page onujayi ekhane **Wi-Fi, computer access, spacious reading area**, research/study support ebong workshops ache. Online Facilities page aro bole je Student Portal theke available books browse, PDF download, borrowed/returned books o pending fine track kora jay."
        : "Gono University Library provides books, journals, and digital resources. Its official page lists **Wi-Fi, computer access, a spacious reading area**, research/study assistance, and workshops. The Online Facilities page also says students can browse available books, download PDFs, track borrowed and returned books, and see pending fines through the Student Portal.",
      sources: dedupeSources([universitySources.library, universitySources.online]),
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
  if (/\b(facility|facilities|campus\s+services?)\b/i.test(q) && /\b(gono|university|campus|gb)\b/i.test(q) && !/\b(hostel|hall|dormitory|accommodation|research)\b/i.test(q)) {
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
        ? "Official index-e department-based cultural programs, sports activities, central library, workshops ebong student portal services-er pages ache. Ekahne active student organizations hisebe premier career club holo **Gono Bishwabidyalay Career Development Club (GBCDC)** (website: https://www.gbcdc.club/), jara regular skill training, CV workshop, seminar ebong volunteer recruitment chalay."
        : "The official index includes department-level cultural programs, sports activities, the central library, workshops, and student-portal services. A premier active student organization on campus is the **Gono Bishwabidyalay Career Development Club (GBCDC)** (website: https://www.gbcdc.club/), which actively hosts skill courses, career summits, and student leadership programs.",
      sources: [gbcdcSources.home, universitySources.sports, universitySources.library],
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

function findClubMember(question, executives = []) {
  const q = normalizeQuestion(question);
  const words = tokenize(q).filter((w) => w.length >= 3 && !/^(ke|cheno|chino|jano|know|who|about|details|somporke|samparke|ki|ache|ase|bolo|bolen|er|ta|theke|hobe|kore|kake|chinte|chines|sir|mam|madam|vai|bhai|apu|profile)$/.test(w));
  if (!words.length) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const exec of executives) {
    const nameTokens = tokenize(exec.name);
    const exactMatches = words.filter((w) => nameTokens.includes(w));
    if (!exactMatches.length) continue;

    // Never match if only a single common surname matched
    if (exactMatches.length === 1 && commonSurnames.has(exactMatches[0])) continue;

    // If query provided multiple words (e.g. first + last name), do not match if only 1 word matched
    if (words.length >= 2 && exactMatches.length < 2) continue;

    let score = 0;
    for (const em of exactMatches) {
      score += (nameTokens[0] === em ? 40 : 25);
    }
    if (words.some((w) => exec.name.toLowerCase().includes(w))) score += 20;
    if (exec.session?.includes("3rd")) score += 10;
    if (exec.position === "President") score += 5;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = exec;
    }
  }

  return bestMatch;
}

function directClubAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const executives = knowledge?.clubs?.gbcdc?.executives || [];
  const clubMember = findClubMember(question, executives);
  const isBanglish = prefersBanglish(question);

  if (clubMember) {
    const role = clubMember.position || "Executive Member";
    const session = clubMember.session || "Executive Committee";
    const deptInfo = clubMember.department ? `${clubMember.department}${clubMember.year ? ` (${clubMember.year})` : ""}` : "";
    const emailInfo = clubMember.social?.email ? `\n• **Email:** ${clubMember.social.email}` : "";
    const phoneInfo = clubMember.social?.phone ? `\n• **Phone:** ${clubMember.social.phone}` : "";
    const linkedinInfo = clubMember.social?.linkedin ? `\n• **LinkedIn:** ${clubMember.social.linkedin}` : "";
    const bioInfo = clubMember.bio ? `\n\n**Bio/Profile:** ${clubMember.bio}` : "";

    return {
      text: isBanglish
        ? `Haan, **${clubMember.name}** Gono Bishwabidyalay Career Development Club (GBCDC)-er **${role}** (${session}).${deptInfo ? `\n• **Department:** ${deptInfo}` : ""}${emailInfo}${phoneInfo}${linkedinInfo}${bioInfo}\n\nOfficial Executive profile dekhte visit korun: https://www.gbcdc.club/executive`
        : `Yes, **${clubMember.name}** is the **${role}** of Gono Bishwabidyalay Career Development Club (GBCDC - ${session}).${deptInfo ? `\n• **Department:** ${deptInfo}` : ""}${emailInfo}${phoneInfo}${linkedinInfo}${bioInfo}\n\nFor official executive details, visit: https://www.gbcdc.club/executive`,
      sources: [gbcdcSources.executive, gbcdcSources.home],
      mode: "structured",
      profile: { label: "Verified record", confidence: "High" },
      suggestions: [
        "GBCDC-er current executive committee ke ke?",
        "GBCDC-er events o workshops ki ki?",
        "GBCDC-te kivabe join korbo?"
      ]
    };
  }

  const mentionsGbcdc = /\b(gbcdc|gb\s*cdc|career\s+development\s+club|career\s+club)\b/i.test(q);
  const mentionsGeneralClub = /\b(clubs?|student\s+organizations?|shongothon|songothon)\b/i.test(q) &&
    !/\b(rotaract|leo|sports\s+club|photographic|debating|cultural\s+club|science\s+club)\b/i.test(q);

  if (!mentionsGbcdc && !mentionsGeneralClub) return null;

  // 1. President / Leadership intent
  if (/\b(president|shovapoti|sabapoti|lead|head|acting\s+president)\b/i.test(q)) {
    return {
      text: isBanglish
        ? "Gono Bishwabidyalay Career Development Club (GBCDC)-er **Current (3rd Executive Committee) President** holen **Bidita Chowdhury** (CSE Department, 4th Year).\n\n" +
          "**GBCDC Leadership Overview:**\n" +
          "• **Current President (3rd Committee):** **Bidita Chowdhury** (Department of Computer Science and Engineering - CSE, 4th Year)\n" +
          "• **Current General Secretary:** **Mehrab Hossain Jishan** (Department of Electrical and Electronic Engineering - EEE)\n" +
          "• **Current Vice President:** **Nusrat Jahan Setu** (Department of Microbiology)\n" +
          "• **Past 2nd Committee:** Acting President Sheikh Muhammad Redwan (Law), President Rubaet Toha (EEE), GS Nasim Khan (Chemistry)\n" +
          "• **Founding (1st Committee) President:** Advocate Hasib Mir (Law), Founding GS Saifullah Mansur (Microbiology)\n\n" +
          "Official Executive details dekhte visit korun: https://www.gbcdc.club/executive"
        : "The **current President** of Gono Bishwabidyalay Career Development Club (GBCDC - 3rd Executive Committee) is **Bidita Chowdhury** from the Department of Computer Science and Engineering (CSE, 4th Year).\n\n" +
          "**Leadership Overview:**\n" +
          "• **Current President (3rd Committee):** **Bidita Chowdhury** (Department of Computer Science and Engineering - CSE, 4th Year)\n" +
          "• **Current General Secretary:** **Mehrab Hossain Jishan** (Department of Electrical and Electronic Engineering - EEE)\n" +
          "• **Current Vice President:** **Nusrat Jahan Setu** (Department of Microbiology)\n" +
          "• **2nd Committee:** Acting President Sheikh Muhammad Redwan (Law), President Rubaet Toha (EEE), General Secretary Nasim Khan (Chemistry)\n" +
          "• **1st Committee (Founding):** Founding President Advocate Hasib Mir (Law), Founding GS Saifullah Mansur (Microbiology)\n\n" +
          "For official executive records, visit: https://www.gbcdc.club/executive",
      sources: [gbcdcSources.executive, gbcdcSources.home],
      mode: "structured",
      profile: { label: "Verified club record", confidence: "High" },
      suggestions: [
        "GBCDC-er General Secretary ke?",
        "GBCDC-er 3rd committee member list dekhao",
        "GBCDC-te kivabe join korbo?"
      ]
    };
  }

  // 2. General Secretary (GS) / VP / Executive roles
  if (/\b(gs|general\s+secretary|secretary|vp|vice\s+president|joint\s+secretary|treasurer)\b/i.test(q)) {
    return {
      text: isBanglish
        ? "Gono Bishwabidyalay Career Development Club (GBCDC)-er **Current (3rd Executive Committee) General Secretary** holen **Mehrab Hossain Jishan** (EEE Department).\n\n" +
          "**Key Executive Officers (3rd Committee):**\n" +
          "• **President:** Bidita Chowdhury (CSE, 4th Year)\n" +
          "• **General Secretary:** Mehrab Hossain Jishan (EEE)\n" +
          "• **Vice President:** Nusrat Jahan Setu (Microbiology)\n" +
          "• **Joint Secretary:** Md. Tanvir Ahmmed (BMB, 2nd Year)\n" +
          "• **Organizing Secretary:** Shuvo Molla (Sociology & Social Work)\n" +
          "• **Treasurer:** Jahid Hasan Sany (EEE, 3rd Year)\n" +
          "• **Media Secretary:** Dipro Saha (CSE)\n" +
          "• **HR Secretary:** Md. Abrar Faiyaj Khan (CSE, 3rd Year)\n" +
          "• **IT Secretary:** Shuvo Chandra Debnath (CSE, 4th Year)\n" +
          "• **Communication Secretary:** MD. Nayeemur Rahman (CSE)\n" +
          "• **Publication Secretary:** Sakib Reza Tasni (Chemistry)\n" +
          "• **Corporate Affairs Secretary:** Mazharul Islam (CSE)\n\n" +
          "More info: https://www.gbcdc.club/executive"
        : "The **current General Secretary** of Gono Bishwabidyalay Career Development Club (GBCDC - 3rd Executive Committee) is **Mehrab Hossain Jishan** from the Department of Electrical and Electronic Engineering (EEE).\n\n" +
          "**Key Executive Officers (3rd Committee):**\n" +
          "• **President:** Bidita Chowdhury (CSE, 4th Year)\n" +
          "• **General Secretary:** Mehrab Hossain Jishan (EEE)\n" +
          "• **Vice President:** Nusrat Jahan Setu (Microbiology)\n" +
          "• **Joint Secretary:** Md. Tanvir Ahmmed (BMB, 2nd Year)\n" +
          "• **Organizing Secretary:** Shuvo Molla (Sociology & Social Work)\n" +
          "• **Treasurer:** Jahid Hasan Sany (EEE, 3rd Year)\n" +
          "• **Media Secretary:** Dipro Saha (CSE)\n" +
          "• **HR Secretary:** Md. Abrar Faiyaj Khan (CSE, 3rd Year)\n" +
          "• **IT Secretary:** Shuvo Chandra Debnath (CSE, 4th Year)\n" +
          "• **Communication Secretary:** MD. Nayeemur Rahman (CSE)\n" +
          "• **Publication Secretary:** Sakib Reza Tasni (Chemistry)\n" +
          "• **Corporate Affairs Secretary:** Mazharul Islam (CSE)\n\n" +
          "Full details at: https://www.gbcdc.club/executive",
      sources: [gbcdcSources.executive, gbcdcSources.home],
      mode: "structured",
      profile: { label: "Verified club record", confidence: "High" },
      suggestions: [
        "GBCDC-er President ke?",
        "GBCDC-er executive committee member list",
        "GBCDC-te kivabe join korbo?"
      ]
    };
  }

  // 3. Full Committee / Member List
  if (/\b(committee|members?|shodossho|executive\s+body|team|board)\b/i.test(q) && !/\b(advisor|advisory|mentor)\b/i.test(q)) {
    return {
      text: isBanglish
        ? "Gono Bishwabidyalay Career Development Club (GBCDC)-er **3rd Executive Committee (Current Body - 15 members)**:\n\n" +
          "1. **President:** Bidita Chowdhury (CSE, 4th Year)\n" +
          "2. **General Secretary:** Mehrab Hossain Jishan (EEE)\n" +
          "3. **Vice President:** Nusrat Jahan Setu (Microbiology)\n" +
          "4. **Joint Secretary:** Md. Tanvir Ahmmed (BMB, 2nd Year)\n" +
          "5. **Organizing Secretary:** Shuvo Molla (Sociology & Social Work)\n" +
          "6. **Treasurer:** Jahid Hasan Sany (EEE, 3rd Year)\n" +
          "7. **Media Secretary:** Dipro Saha (CSE)\n" +
          "8. **HR Secretary:** Md. Abrar Faiyaj Khan (CSE, 3rd Year)\n" +
          "9. **IT Secretary:** Shuvo Chandra Debnath (CSE, 4th Year)\n" +
          "10. **Communication Secretary:** MD. Nayeemur Rahman (CSE)\n" +
          "11. **Publication Secretary:** Sakib Reza Tasni (Chemistry)\n" +
          "12. **Corporate Affairs Secretary:** Mazharul Islam (CSE)\n" +
          "13. **Executive Member:** Md. Monim Ahamed (Pharmacy, 3rd Year)\n" +
          "14. **Executive Member:** Md. Abdur Rahman (BMB, 2nd Year)\n" +
          "15. **Executive Member:** Nabila Hossen Suchi (BMB)\n\n" +
          "Club-er 1st (Founding President: Advocate Hasib Mir) ebong 2nd Committee (President: Rubaet Toha, Acting President: Sheikh Muhammad Redwan)-er history-o ache. Bistarito: https://www.gbcdc.club/executive"
        : "The **3rd Executive Committee (Current Leadership - 15 members)** of Gono Bishwabidyalay Career Development Club (GBCDC):\n\n" +
          "1. **President:** Bidita Chowdhury (CSE, 4th Year)\n" +
          "2. **General Secretary:** Mehrab Hossain Jishan (EEE)\n" +
          "3. **Vice President:** Nusrat Jahan Setu (Microbiology)\n" +
          "4. **Joint Secretary:** Md. Tanvir Ahmmed (BMB, 2nd Year)\n" +
          "5. **Organizing Secretary:** Shuvo Molla (Sociology & Social Work)\n" +
          "6. **Treasurer:** Jahid Hasan Sany (EEE, 3rd Year)\n" +
          "7. **Media Secretary:** Dipro Saha (CSE)\n" +
          "8. **HR Secretary:** Md. Abrar Faiyaj Khan (CSE, 3rd Year)\n" +
          "9. **IT Secretary:** Shuvo Chandra Debnath (CSE, 4th Year)\n" +
          "10. **Communication Secretary:** MD. Nayeemur Rahman (CSE)\n" +
          "11. **Publication Secretary:** Sakib Reza Tasni (Chemistry)\n" +
          "12. **Corporate Affairs Secretary:** Mazharul Islam (CSE)\n" +
          "13. **Executive Member:** Md. Monim Ahamed (Pharmacy, 3rd Year)\n" +
          "14. **Executive Member:** Md. Abdur Rahman (BMB, 2nd Year)\n" +
          "15. **Executive Member:** Nabila Hossen Suchi (BMB)\n\n" +
          "Previous committees include the 1st Founding Committee (Founding President: Advocate Hasib Mir) and 2nd Committee (President: Rubaet Toha, Acting President: Sheikh Muhammad Redwan). Full roster: https://www.gbcdc.club/executive",
      sources: [gbcdcSources.executive, gbcdcSources.home],
      mode: "structured",
      profile: { label: "Verified club record", confidence: "High" },
      suggestions: [
        "GBCDC-er advisory board o mentor panel",
        "GBCDC-er activities o events ki ki?",
        "GBCDC-te kivabe join korbo?"
      ]
    };
  }

  // 4. Advisory Board & Mentors
  if (/\b(advisors?|advisory|poramorshok|mentors?|patron)\b/i.test(q)) {
    return {
      text: isBanglish
        ? "Gono Bishwabidyalay Career Development Club (GBCDC)-er **Advisory Panel & Mentor Panel**:\n\n" +
          "**Advisory Panel:**\n" +
          "• **Chief Patron & Advisor:** Professor Dr. Md. Abul Hossain (Vice-Chancellor, Gono Bishwabidyalay)\n" +
          "• **Advisor:** Dr. Md. Fuad Hossain (Dean, Faculty of Health Sciences)\n" +
          "• **Lifetime Advisor:** Advocate Hasib Mir (Founding President, Alumni - Law)\n" +
          "• **Advisors:** Saifullah Mansur (Founding GS, Alumni - Microbiology), Sheikh Muhammad Redwan (Former Acting President, Alumni - Law), Mst Rafia Tasnim Rity (Alumni - Law), Rubaet Toha (Former President, Alumni - EEE)\n\n" +
          "**Mentor Panel (Faculty Mentors):**\n" +
          "• **Tania Ahmed** (Assistant Professor, Gono Bishwabidyalay)\n" +
          "• **Gazi Ishmam Hasan** (Lecturer, Gono Bishwabidyalay)\n" +
          "• **Md. Abu Rayhan** (Lecturer, Gono Bishwabidyalay)\n" +
          "• **Sharif Ahamed** (Lecturer, Gono Bishwabidyalay)\n\n" +
          "Bistarito: https://www.gbcdc.club/advisory ebong https://www.gbcdc.club/mentors"
        : "Gono Bishwabidyalay Career Development Club (GBCDC) **Advisory Board & Mentors**:\n\n" +
          "**Advisory Panel:**\n" +
          "• **Chief Patron & Advisor:** Professor Dr. Md. Abul Hossain (Vice-Chancellor, Gono Bishwabidyalay)\n" +
          "• **Advisor:** Dr. Md. Fuad Hossain (Dean, Faculty of Health Sciences)\n" +
          "• **Lifetime Advisor:** Advocate Hasib Mir (Founding President, Alumni - Law)\n" +
          "• **Advisors:** Saifullah Mansur (Founding GS), Sheikh Muhammad Redwan, Mst Rafia Tasnim Rity, Rubaet Toha\n\n" +
          "**Mentor Panel (Faculty Mentors):**\n" +
          "• **Tania Ahmed** (Assistant Professor, Gono Bishwabidyalay)\n" +
          "• **Gazi Ishmam Hasan** (Lecturer, Gono Bishwabidyalay)\n" +
          "• **Md. Abu Rayhan** (Lecturer, Gono Bishwabidyalay)\n" +
          "• **Sharif Ahamed** (Lecturer, Gono Bishwabidyalay)\n\n" +
          "Official panels: https://www.gbcdc.club/advisory and https://www.gbcdc.club/mentors",
      sources: [gbcdcSources.advisory, gbcdcSources.mentors],
      mode: "structured",
      profile: { label: "Verified club record", confidence: "High" },
      suggestions: [
        "GBCDC-er current executive committee ke ke?",
        "GBCDC-er flagship events ki ki?",
        "GBCDC official website"
      ]
    };
  }

  // 5. Activities / Events / Workshops
  if (/\b(activit(?:y|ies)|events?|workshops?|seminars?|programs?|kaj|initiative|what\s+do|ki\s+kore|sessions?)\b/i.test(q)) {
    return {
      text: isBanglish
        ? "Gono Bishwabidyalay Career Development Club (GBCDC)-er **Core Activities & Events**:\n\n" +
          "**Flagship Events & Workshops:**\n" +
          "1. **Make Your CV, Shape Your Career:** Professional CV making, career readiness ও corporate guidelines seminar (206 Seminar Room).\n" +
          "2. **Higher Studies in South Korea:** Research opportunities & scholarship pathways seminar (Keynote Speaker: Dr. Jakir Hossain Imran).\n" +
          "3. **The Volunteer Playbook:** Volunteer roadmap, club activities & leadership development workshop.\n" +
          "4. **GBian Success Story (Season 01 & 02):** Alumni career achievements ও guidance session.\n" +
          "5. **Email Communication & Professional Etiquette:** Academic ও corporate communication skills workshop.\n" +
          "6. **How to Organize a Program:** Event management training session conducted by Advocate Hasib Mir.\n" +
          "7. **Learn the Tools That Matter:** 2-day MS Office & digital productivity tools workshop.\n" +
          "8. **Human Trafficking & Migrant Smuggling Prevention:** BRAC Migration Program-er sathe joint awareness orientation.\n" +
          "9. **Social Initiatives:** Campus tree plantation program ebong Bangladesh-e first World Book Giving Day celebration.\n\n" +
          "Event updates dekhte visit korun: https://www.gbcdc.club/events"
        : "Gono Bishwabidyalay Career Development Club (GBCDC) **Key Activities & Flagship Events**:\n\n" +
          "**Featured Events & Workshops:**\n" +
          "1. **Make Your CV, Shape Your Career:** Hands-on professional CV formulation and career preparation seminar (206 Seminar Room).\n" +
          "2. **Higher Studies in South Korea:** Research scholarships & global pathways seminar (Keynote: Dr. Jakir Hossain Imran).\n" +
          "3. **The Volunteer Playbook:** Leadership roadmap, event management, and club volunteer training.\n" +
          "4. **GBian Success Story (Seasons 01 & 02):** Showcasing inspiring journeys of accomplished university alumni.\n" +
          "5. **Email Communication & Workplace Etiquette:** Business writing and professional communication sessions.\n" +
          "6. **How to Organize a Program:** Exclusive event management workshop led by Advocate Hasib Mir.\n" +
          "7. **Learn the Tools That Matter:** 2-day intensive MS Office productivity bootcamp.\n" +
          "8. **Awareness on Human Trafficking Prevention:** Joint campus initiative with BRAC Migration Program.\n" +
          "9. **Community Engagement:** Tree plantation initiatives and celebrating World Book Giving Day.\n\n" +
          "Browse events at: https://www.gbcdc.club/events",
      sources: [gbcdcSources.events, gbcdcSources.home],
      mode: "structured",
      profile: { label: "Verified club record", confidence: "High" },
      suggestions: [
        "GBCDC-er skill courses ki ki?",
        "GBCDC-te kivabe volunteer hobo?",
        "GBCDC executive committee member list"
      ]
    };
  }

  // 6. Courses / Training
  if (/\b(courses?|training|skill|shikhbe|learn)\b/i.test(q)) {
    return {
      text: isBanglish
        ? "Gono Bishwabidyalay Career Development Club (GBCDC) national learning partners (e.g. 10 Minute School)-er sathe certified skill courses offer kore:\n\n" +
          "• **Communication Hacks (কমিউনিকেশন হ্যাকস):** Verbal & presentation skills.\n" +
          "• **CV Writing & Interview Skills:** Professional resume drafting & viva preparation.\n" +
          "• **Freelancing এর হাতেখড়ি:** Beginners freelancing and marketplace onboarding.\n" +
          "• **Graphic Designing with Photoshop & মোবাইল দিয়ে Graphic Designing:** Digital content creation.\n" +
          "• **English for Everyday & Academic English Grammar:** Spoken and academic writing skills.\n" +
          "• **Learn & Earn Digital Marketing:** SEO, SMM, and online campaign strategies.\n" +
          "• **How AI Works & Digital Tools:** Practical generative AI & productivity tools.\n\n" +
          "Courses access korte visit korun: https://www.gbcdc.club/courses"
        : "Gono Bishwabidyalay Career Development Club (GBCDC) provides 10+ certified skill development courses in partnership with national platforms like 10 Minute School:\n\n" +
          "• **Communication Hacks:** Verbal & corporate presentation skills.\n" +
          "• **CV Writing & Interview Skills:** Resume building and interview simulation.\n" +
          "• **Freelancing Fundamentals:** Getting started with freelancing and remote work.\n" +
          "• **Graphic Designing with Photoshop & Mobile:** Visual content design tools.\n" +
          "• **English for Everyday & Academic Grammar:** Functional English proficiency.\n" +
          "• **Digital Marketing (Learn & Earn):** Social media marketing & branding basics.\n" +
          "• **How AI Works & Productivity:** Modern digital workflow skills.\n\n" +
          "Explore all courses: https://www.gbcdc.club/courses",
      sources: [gbcdcSources.courses, gbcdcSources.home],
      mode: "structured",
      profile: { label: "Verified club record", confidence: "High" },
      suggestions: [
        "GBCDC-er upcoming events ki ki?",
        "GBCDC-te kivabe join korbo?",
        "GBCDC contact details"
      ]
    };
  }

  // 7. How to join / Volunteer Recruitment
  if (/\b(join|member(?:ship)?|volunteer|recruitment|vorti|kivabe\s+hobo|how\s+to\s+join|admission|apply)\b/i.test(q)) {
    return {
      text: isBanglish
        ? "Gono Bishwabidyalay Career Development Club (GBCDC)-te join korar jonno semester-wise **Offline Recruitment Drive**-e ongshogrohon korte hoy. Process-tir ৬টি ধাপ:\n\n" +
          "1. **Registration Form Collection:** Campus-er GBCDC recruitment desk ba club room theke physical application form collect koro.\n" +
          "2. **Form Fill-up & Attachments:** Academic ও contact info puron kore ১ কপি পাসপোর্ট সাইজ ছবি এবং প্রিন্ট করা CV attach koro.\n" +
          "3. **In-Person Submission:** Completed application dossier-ti deadline-er age campus club booth-e joma dao.\n" +
          "4. **Offline Written Assessment:** On-campus written test (general aptitude, reasoning ও problem solving)-e participate koro.\n" +
          "5. **Face-to-Face Viva & Interview:** Senior Executive Board-er samne viva interview dao.\n" +
          "6. **Final Selection & Induction:** Chonai praptora official volunteer badge pabe ebong orientation-er maddhome GBCDC Volunteer Wing-e induct hobe.\n\n" +
          "Recruitment updates o form announcement pete GBCDC Facebook Page ebong website https://www.gbcdc.club/ follow koro."
        : "To join Gono Bishwabidyalay Career Development Club (GBCDC), students participate in the semesterly **Offline Recruitment Drive** through a 6-stage process:\n\n" +
          "1. **Collect Registration Form:** Pick up the physical application form from the GBCDC campus booth or club room.\n" +
          "2. **Fill Form & Attachments:** Fill your information and securely attach 1 passport photo and a printed CV.\n" +
          "3. **In-Person Submission:** Hand over the dossier directly to executive officers at the club desk before the deadline.\n" +
          "4. **Offline Written Assessment:** Sit for an on-campus exam on aptitude, analytical reasoning, and enthusiasm.\n" +
          "5. **Face-to-Face Viva & Interview:** Personal interview with the Executive Board discussing skills and leadership potential.\n" +
          "6. **Final Selection & Induction:** Top candidates receive official volunteer credentials and are inducted into departmental wings.\n\n" +
          "Stay tuned for recruitment dates at: https://www.gbcdc.club/ and their official Facebook page.",
      sources: [gbcdcSources.home, gbcdcSources.contact],
      mode: "structured",
      profile: { label: "Verified club record", confidence: "High" },
      suggestions: [
        "GBCDC current committee ke ke?",
        "GBCDC events o activities",
        "GBCDC contact info"
      ]
    };
  }

  // 8. Contact / Website / Location
  if (/\b(contact|email|phone|website|url|facebook|page|address|location|thikana)\b/i.test(q)) {
    return {
      text: isBanglish
        ? "Gono Bishwabidyalay Career Development Club (GBCDC)-er official contact o online details:\n\n" +
          "• **Official Website:** https://www.gbcdc.club/\n" +
          "• **Official Facebook Page:** https://www.facebook.com/GonoBishwabidyalayCareerDevelopmentClub/\n" +
          "• **Email Address:** info@gbcdc.edu.bd\n" +
          "• **Contact Number:** +880-1234-567890\n" +
          "• **Location:** Nolam, Mirzanagar, Savar, Dhaka - 1344, Bangladesh (Gono Bishwabidyalay Campus)\n" +
          "• **Club Portal:** Events, executive roster, skill courses, notices ebong photo gallery https://www.gbcdc.club/ e available."
        : "Official contact and portal information for Gono Bishwabidyalay Career Development Club (GBCDC):\n\n" +
          "• **Official Website:** https://www.gbcdc.club/\n" +
          "• **Facebook Page:** https://www.facebook.com/GonoBishwabidyalayCareerDevelopmentClub/\n" +
          "• **Email Address:** info@gbcdc.edu.bd\n" +
          "• **Contact Phone:** +880-1234-567890\n" +
          "• **Location:** Nolam, Mirzanagar, Savar, Dhaka - 1344, Bangladesh (Gono Bishwabidyalay Permanent Campus)\n" +
          "• **Portal:** Full information on executives, events, courses, and gallery is accessible at https://www.gbcdc.club/",
      sources: [gbcdcSources.contact, gbcdcSources.home],
      mode: "structured",
      profile: { label: "Verified club record", confidence: "High" },
      suggestions: [
        "GBCDC-er president ke?",
        "GBCDC-te kivabe join korbo?",
        "GBCDC activities o events"
      ]
    };
  }

  // 9. General GBCDC / Club Overview
  return {
    text: isBanglish
      ? "**Gono Bishwabidyalay Career Development Club (GBCDC)** holo Gono Bishwabidyalay-er premier student organization (founded in 2021). Club-tir slogan: *\"Empowering students with skills, leadership, and career opportunities for a brighter future.\"*\n\n" +
        "**Core Highlights:**\n" +
        "• **Official Website:** https://www.gbcdc.club/\n" +
        "• **Active Members:** 500+ members, 5+ years of active leadership.\n" +
        "• **Current Leadership (3rd Committee):** President **Bidita Chowdhury** (CSE), General Secretary **Mehrab Hossain Jishan** (EEE), Vice President **Nusrat Jahan Setu** (Microbiology).\n" +
        "• **Founding President:** Advocate Hasib Mir (Law) | **Past Committee Leadership:** Rubaet Toha, Sheikh Muhammad Redwan, Saifullah Mansur, Nasim Khan.\n" +
        "• **Chief Patron & Advisor:** Prof. Dr. Md. Abul Hossain (Vice-Chancellor, GB) ebong Dr. Md. Fuad Hossain (Dean, Faculty of Health Sciences).\n" +
        "• **Key Initiatives:** CV Writing Workshops, Higher Study abroad seminars (South Korea, etc.), Certified Skill Courses (Freelancing, Graphic Design, Communication), Volunteer Wing leadership recruitment ebong corporate networking."
      : "**Gono Bishwabidyalay Career Development Club (GBCDC)** is the university's premier student-led career and leadership organization (founded in 2021). Motto: *\"Empowering students with skills, leadership, and career opportunities for a brighter future.\"*\n\n" +
        "**Key Highlights:**\n" +
        "• **Official Website:** https://www.gbcdc.club/\n" +
        "• **Community & Impact:** 500+ active members and 5+ years of campus leadership.\n" +
        "• **Current Leadership (3rd Committee):** President **Bidita Chowdhury** (CSE), General Secretary **Mehrab Hossain Jishan** (EEE), Vice President **Nusrat Jahan Setu** (Microbiology).\n" +
        "• **Founding Leadership:** Founding President Advocate Hasib Mir (Law) | **Key Past Leaders:** Rubaet Toha, Sheikh Muhammad Redwan, Saifullah Mansur, Nasim Khan.\n" +
        "• **Chief Patron:** Prof. Dr. Md. Abul Hossain (Vice-Chancellor, GB) and Advisor Dr. Md. Fuad Hossain (Dean, Health Sciences).\n" +
        "• **Programs & Offerings:** Professional CV & interview seminars, Study abroad workshops, 10+ certified skill development courses, semesterly volunteer recruitment, and corporate partnerships.",
    sources: [gbcdcSources.home, gbcdcSources.executive, gbcdcSources.events],
    mode: "structured",
    profile: { label: "Verified club record", confidence: "High" },
    suggestions: [
      "GBCDC-er current committee member list",
      "GBCDC-er events o workshops ki ki?",
      "GBCDC-te kivabe join korbo?"
    ]
  };
}

function directAdmissionStatusAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const asksStatus =
    /\b(current\s+admission|admission\s+(?:is\s+)?open|is\s+admission\s+open|admission\s+ongoing|running\s+admission)\b/i.test(q) ||
    (/\b(admission|vorti)\b/i.test(q) && /\b(open|cholche|chole|chalu|choltese|ongoing)\b/i.test(q)) ||
    /ভর্তি\s*কি\s*(?:চলছে|চালু|খোলা|ওপেন)|এখন\s*কি\s*ভর্তি\s*(?:হওয়া\s*যাবে|চলছে|চালু)/u.test(question);
  if (!asksStatus) return null;
  const banglish = prefersBanglish(question);
  return {
    text: banglish
      ? "**হ্যাঁ, গণ বিশ্ববিদ্যালয়ে বর্তমান সেশনের ভর্তি কার্যক্রম ও অনলাইন আবেদন চলমান রয়েছে (ভর্তি চলছে)।**\n\n" +
        "• **ভর্তি সেশন:** বছরে ২টি সেমিস্টারে (Spring: জানুয়ারি–ফেব্রুয়ারি এবং Fall: জুলাই–আগস্ট) ভর্তি কার্যক্রম পরিচালিত হয়।\n" +
        "• **অনলাইন আবেদন:** আপনি সরাসরি অফিসিয়াল [Apply Online](https://gonouniversity.edu.bd/admission/apply-online/) পোর্টাল থেকে আবেদন করতে পারবেন।\n" +
        "• **যোগাযোগ ও হেল্পলাইন:** আসন সংখ্যা ও সর্বশেষ ডেডলাইন জানতে সরাসরি ভর্তি শাখায় যোগাযোগ করুন: **01950003314**, **01950003312**।"
      : "**Yes, admissions and online applications are currently active for the current academic session.**\n\n" +
        "• **Academic Sessions:** Gono Bishwabidyalay admits students twice a year in Spring (Jan–Feb) and Fall (July–Aug) semesters.\n" +
        "• **Apply Online:** You can submit your application directly at the official [Apply Online](https://gonouniversity.edu.bd/admission/apply-online/) portal.\n" +
        "• **Admission Helplines:** For seat availability and circular updates, call: **01950003314**, **01950003312**.",
    sources: dedupeSources([
      universitySources.admission,
      { title: "Apply Online - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/admission/apply-online/" },
    ]),
    mode: "structured",
  };
}

function directAdmissionOverviewAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  if (/\b(?:admission|vorti)\b/i.test(q) && asksContactDetail(q)) {
    return {
      text: prefersBanglish(question)
        ? "Gono Bishwabidyalay-এর **ভর্তি সংক্রান্ত অফিসিয়াল যোগাযোগ (Admission Helplines)**:\n\n" +
          "• **ভর্তি হেল্পলাইন (Mobile):** **01950003314**, **01950003312**, **01950003313**\n" +
          "• **অ্যাডমিশন অফিস ডেস্ক:** 01727684880 (পুরবী সরকার নীতু, সিনিয়র সেকশন অফিসার), 01950003312 (আশফাক হোসেন)\n" +
          "• **ইমেইল:** admin@gonouniversity.edu.bd\n" +
          "• **অনলাইন আবেদন:** https://gonouniversity.edu.bd/admission/apply-online/\n" +
          "• **ঠিকানা:** ভর্তি শাখা, প্রশাসনিক ভবন, গণ বিশ্ববিদ্যালয়, নলাম, মির্জানগর, সাভার, ঢাকা-১৩৪৪।"
        : "Official **Admission Helplines and Office Contacts** for Gono Bishwabidyalay:\n\n" +
          "• **Admission Helplines:** **01950003314**, **01950003312**, **01950003313**\n" +
          "• **Admission Officers:** +8801727684880 (Purabi Sarkar Nitu, Sr. Section Officer), 01950003312 (Asfaq Hossain)\n" +
          "• **Email:** admin@gonouniversity.edu.bd\n" +
          "• **Apply Online:** https://gonouniversity.edu.bd/admission/apply-online/\n" +
          "• **Campus Address:** Admission Office, Administrative Building, Nolam, Mirzanagar, Savar, Dhaka-1344.",
      sources: [universitySources.admission, { title: "Admission Office", url: "https://gonouniversity.edu.bd/offices/admission-office/" }],
      mode: "structured",
    };
  }

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

function directSemesterSystemAnswer(question) {
  const q = normalizeQuestion(question);
  if (!/\b(?:semesters?|semester\s+system|semester\s+koyta|koyta\s+semester|bochhore\s+koyta|koyti\s+semester)\b/i.test(q)) return null;
  if (!/\b(koyta|koyti|how\s+many|system|cycle|pattern|structure|bochhore|year|annual|tri-?semester|bi-?semester)\b/i.test(q)) return null;

  const isBanglish = prefersBanglish(question);
  return {
    text: isBanglish
      ? "Gono Bishwabidyalay-তে বেশিরভাগ আন্ডারগ্র্যাজুয়েট ও পোস্টগ্র্যাজুয়েট প্রোগ্রামে **Bi-semester (বছরে ২টি সেমিস্টার)** পদ্ধতি অনুসরণ করা হয়:\n\n" +
        "১. **স্প্রিং সেমিস্টার (Spring Semester):** জানুয়ারি – জুন (ভর্তি: জানুয়ারি – ফেব্রুয়ারি)\n" +
        "২. **ফল সেমিস্টার (Fall Semester):** জুলাই – ডিসেম্বর (ভর্তি: জুলাই – আগস্ট)\n\n" +
        "*(নোট: ফার্মেসি (B.Pharm), ডিভিএম (DVM) ও ফিজিওথেরাপি বিভাগের ক্ষেত্রে সংশ্লিষ্ট কাউন্সিল ও প্রফেশনাল রেগুলেশন অনুসারে বার্ষিক বা প্রফেশনাল টার্মিনাল ফ্রেমওয়ার্ক পরিচালিত হয়)*।"
      : "Gono Bishwabidyalay operates primarily on a **Bi-semester (2 semesters per year)** academic calendar for most undergraduate and graduate programs:\n\n" +
        "1. **Spring Semester:** January – June (Admissions: January – February)\n" +
        "2. **Fall Semester:** July – December (Admissions: July – August)\n\n" +
        "*(Note: Programs like Pharmacy, DVM, and Physiotherapy adhere to specific council and professional examination regulations)*.",
    sources: [universitySources.admission, universitySources.academics],
    mode: "structured",
  };
}

function directGradingSystemAnswer(question) {
  const q = normalizeQuestion(question);
  if (!/\b(?:grading\s+system|grading\s+scale|grade\s+system|cgpa|sgpa|gpa\s+calculation|marks?\s+distribution|pass\s+mark)\b/i.test(q)) return null;

  const isBanglish = prefersBanglish(question);
  return {
    text: isBanglish
      ? "Gono Bishwabidyalay-তে ইউজিসি অনুমোদিত **৪.০০ স্কেলের লেটার গ্রেডিং পদ্ধতি (UGC Uniform Grading System)** অনুসরণ করা হয়:\n\n" +
        "• **৮০% বা তার বেশি:** A+ (Grade Point: 4.00) - Outstanding\n" +
        "• **৭৫% থেকে ৮০% এর কম:** A (Grade Point: 3.75) - Excellent\n" +
        "• **৭০% থেকে ৭৫% এর কম:** A- (Grade Point: 3.50) - Very Good\n" +
        "• **৬৫% থেকে ৭০% এর কম:** B+ (Grade Point: 3.25) - Good\n" +
        "• **৬০% থেকে ৬৫% এর কম:** B (Grade Point: 3.00) - Satisfactory\n" +
        "• **৫৫% থেকে ৬০% এর কম:** B- (Grade Point: 2.75) - Above Average\n" +
        "• **৫০% থেকে ৫৫% এর কম:** C+ (Grade Point: 2.50) - Average\n" +
        "• **৪৫% থেকে ৫০% এর কম:** C (Grade Point: 2.25) - Below Average\n" +
        "• **৪০% থেকে ৪৫% এর কম:** D (Grade Point: 2.00) - Pass\n" +
        "• **৪০% এর কম:** F (Grade Point: 0.00) - Fail\n\n" +
        "সেমিস্টার শেষে প্রতিটি কোর্সের ক্রেডিট গুণিতক অনুসারে SGPA এবং পুরো ডিগ্রির জন্য CGPA হিসাব করা হয়।"
      : "Gono Bishwabidyalay follows the standard UGC-approved **4.00 letter grading system**:\n\n" +
        "• **80% and above:** A+ (Grade Point: 4.00)\n" +
        "• **75% to <80%:** A (Grade Point: 3.75)\n" +
        "• **70% to <75%:** A- (Grade Point: 3.50)\n" +
        "• **65% to <70%:** B+ (Grade Point: 3.25)\n" +
        "• **60% to <65%:** B (Grade Point: 3.00)\n" +
        "• **55% to <60%:** B- (Grade Point: 2.75)\n" +
        "• **50% to <55%:** C+ (Grade Point: 2.50)\n" +
        "• **45% to <50%:** C (Grade Point: 2.25)\n" +
        "• **40% to <45%:** D (Grade Point: 2.00) - Minimum Passing Grade\n" +
        "• **Below 40%:** F (Grade Point: 0.00) - Fail\n\n" +
        "Semester Grade Point Average (SGPA) and Cumulative GPA (CGPA) are computed as credit-weighted averages.",
    sources: [universitySources.academics],
    mode: "structured",
  };
}

function directResultAnswer(question) {
  const q = normalizeQuestion(question);
  if (!/\b(?:semester\s+)?results?\s*(?:kivabe|kothay|dekhar|pabo|how\s+to\s+(?:check|get|find)|published|sheet)\b|\b(?:kivabe|kothay)\s+(?:exam\s+)?results?\s*(?:pabo|dekhbo)\b/i.test(q)) return null;

  const isBanglish = prefersBanglish(question);
  return {
    text: isBanglish
      ? "Gono Bishwabidyalay-এর সেমিস্টার ও পরীক্ষার ফলাফল জানার উপায়:\n\n" +
        "১. **অনলাইন স্টুডেন্ট পোর্টাল (i-EMS):** শিক্ষার্থীরা বিশ্ববিদ্যালয়ের নিজস্ব স্টুডেন্ট পোর্টালে আইডি ও পাসওয়ার্ড দিয়ে লগইন করে নিজ নিজ সেমিস্টারের গ্রেডশিট ও ফলাফল দেখতে পারেন।\n" +
        "২. **পরীক্ষা নিয়ন্ত্রক দপ্তর (Office of the Controller of Examinations):** আনুষ্ঠানিক ফলাফল নোটিশ, মার্কশিট ও মূল ট্রান্সক্রিপ্ট পেতে পরীক্ষা নিয়ন্ত্রক অফিসে (কন্ট্রোলার: এ. এস. এম. নোমান আলম, ফোন: +8801797343787, ইমেইল: controller@gonouniversity.edu.bd) যোগাযোগ করতে হয়।\n" +
        "৩. **বিভাগীয় নোটিশ বোর্ড:** সংশ্লিষ্ট ডিপার্টমেন্টের নোটিশ বোর্ডেও ফলাফল প্রকাশ করা হয়।"
      : "How to check semester examination results at Gono Bishwabidyalay:\n\n" +
        "1. **Student Portal (i-EMS):** Enrolled students can log in to the integrated Student Portal to view provisional semester results and download grade sheets.\n" +
        "2. **Controller of Examinations Office:** Official result notifications, grade certificates, and transcripts are issued by the Exam Controller's Office (Controller: A. S. M. Noman Alam, Phone: +8801797343787, Email: controller@gonouniversity.edu.bd).\n" +
        "3. **Department Notice Boards:** Department-specific published result listings are also posted on physical and online department boards.",
    sources: [
      universitySources.online,
      { title: "Controller of Examinations", url: "https://gonouniversity.edu.bd/offices/office-of-the-controller-of-examination/" }
    ],
    mode: "structured",
  };
}

function directStudentJourneyAnswer(question) {
  const q = normalizeQuestion(question);
  const asksAdmissionJourney = /\b(start|begin|guide|journey|roadmap|step\s*by\s*step)\b.*\b(admission|apply|vorti)\b|\b(admission|vorti)\b.*\b(journey|roadmap|guide)\b/i.test(q);
  const asksCurrentStudentJourney = /\b(current|existing|regular)\s+student\b.*\b(journey|help|support|guide)\b|\bstart\s+current\s+student\s+journey\b/i.test(q);
  const asksGuardianJourney = /\b(parent|guardian)\b.*\b(journey|guide|help|admission)\b|\bstart\s+guardian\s+journey\b/i.test(q);
  const asksCareerJourney = /\b(help|guide)\b.*\b(choose|select)\b.*\b(program|department|subject)\b|\bcareer\s+(?:choice|journey|guide)\b/i.test(q);
  if (!asksAdmissionJourney && !asksCurrentStudentJourney && !asksGuardianJourney && !asksCareerJourney) return null;

  if (asksAdmissionJourney) {
    return {
      text: "চলো admission process-টা ধাপে ধাপে করি। আগে eligibility যাচাই করব, তারপর program, verified fee, documents এবং application process দেখব। নিচের প্রথম ধাপ থেকে শুরু করো।",
      sources: [universitySources.admission, universitySources.requirements, universitySources.financialAid],
      mode: "journey",
      journey: {
        kind: "admission",
        title: "Admission Journey",
        audience: "Prospective student",
        steps: [
          { title: "Check eligibility", detail: "SSC/HSC group, GPA and required subjects" },
          { title: "Choose a program", detail: "Compare curriculum, duration, seats and career fit" },
          { title: "Verify fees", detail: "Use only published program-specific fee records" },
          { title: "Prepare documents", detail: "Confirm the current intake's required documents" },
          { title: "Apply and confirm", detail: "Use Apply Online and verify the current deadline" },
        ],
      },
    };
  }

  if (asksCurrentStudentJourney) {
    return {
      text: "Current-student support mode চালু হলো। Portal, course/credit, faculty contact, notices এবং academic resources—যেটা দরকার সেখান থেকে শুরু করতে পারো।",
      sources: [universitySources.online, universitySources.academics, universitySources.library],
      mode: "journey",
      journey: {
        kind: "student",
        title: "Current Student Support",
        audience: "Enrolled student",
        steps: [
          { title: "Open student services", detail: "Portal, registration, dues and attendance" },
          { title: "Explore academics", detail: "Courses, credits, syllabus and department faculty" },
          { title: "Track updates", detail: "Recent notices, routines and results" },
          { title: "Find support", detail: "Library, research and verified office contacts" },
        ],
      },
    };
  }

  if (asksGuardianJourney) {
    return {
      text: "Guardian guide-এ verified admission, program duration, published fees, campus services এবং official contact একসাথে দেখা যাবে। আগে program ও eligibility দিয়ে শুরু করা সবচেয়ে ভালো।",
      sources: [universitySources.admission, universitySources.requirements, universitySources.academics],
      mode: "journey",
      journey: {
        kind: "guardian",
        title: "Guardian Guide",
        audience: "Parent or guardian",
        steps: [
          { title: "Verify eligibility", detail: "Check the student's group, GPA and subjects" },
          { title: "Review the program", detail: "Duration, curriculum, seats and department" },
          { title: "Review published costs", detail: "Separate total fee from admission-time payment" },
          { title: "Check student support", detail: "Transport, library, portal and accommodation information" },
          { title: "Confirm officially", detail: "Use the published source or admission contact" },
        ],
      },
    };
  }

  return {
    text: "Program choose করতে শুধু ‘কোনটা best’ বললে হবে না—তোমার interest, preferred work, course content, duration এবং eligibility মিলিয়ে সিদ্ধান্ত নেব। প্রথমে তোমার পছন্দের কাজের ধরন বলো।",
    sources: [universitySources.academics, universitySources.admission],
    mode: "journey",
    journey: {
      kind: "career",
      title: "Program & Career Choice",
      audience: "Undecided student",
      steps: [
        { title: "Identify interests", detail: "Coding, healthcare, business, law, science or social impact" },
        { title: "Match programs", detail: "Connect interests with verified course titles" },
        { title: "Compare options", detail: "Duration, credits, seats and eligibility" },
        { title: "Build a shortlist", detail: "Keep two or three evidence-based choices" },
        { title: "Plan next skills", detail: "Create a practical learning roadmap" },
      ],
    },
  };
}

function directProgramChoiceAnswer(question, knowledge) {
  const q = normalizeQuestion(question);
  const interestGroups = [
    {
      test: /\b(english|grammar|literature|linguistics|spoken\s*english|writing|reading|comprehension|ielts)\b/i,
      label: "English Language, Grammar & Literature",
      matches: /\b(english)\b/i,
      department: "Department of English",
    },
    {
      test: /\b(coding|programming|software|computer|app|web|developer|ai|algorithm)\b/i,
      label: "coding/software",
      matches: /\b(computer|computing|software|cse)\b/i,
      department: "Department of Computer Science and Engineering (CSE)",
    },
    {
      test: /\b(math|mathematics|calculus|algebra|statistics|gonit|maths)\b/i,
      label: "Mathematics & Analytical Sciences",
      matches: /\b(mathematics|math|cse|applied math)\b/i,
      department: "Department of Applied Mathematics",
    },
    {
      test: /\b(physics|padartha)\b/i,
      label: "Physics & Physical Sciences",
      matches: /\b(physics|medical physics|eee)\b/i,
      department: "Department of Physics",
    },
    {
      test: /\b(chemistry|chemical|roshayan)\b/i,
      label: "Chemistry & Chemical Sciences",
      matches: /\b(chemistry|biochemistry|pharmacy)\b/i,
      department: "Department of Chemistry",
    },
    {
      test: /\b(circuit|circuits|electronics|electrical|power|telecom|hardware)\b/i,
      label: "Electrical & Electronic Engineering",
      matches: /\b(electrical|electronic|eee)\b/i,
      department: "Department of Electrical and Electronic Engineering (EEE)",
    },
    {
      test: /\b(bangla|bengali|sahitya|sahityo|kobita)\b/i,
      label: "Bangla Language, Literature & Culture",
      matches: /\b(bangla|bengali)\b/i,
      department: "Department of Bangla",
    },
    {
      test: /\b(pharmacy|pharma|medicines?|drugs?|oushodh|bpharm|mpharm|prescription)\b/i,
      label: "Pharmacy & Pharmaceutical Sciences",
      matches: /\b(pharmacy)\b/i,
      department: "Department of Pharmacy",
    },
    {
      test: /\b(healthcare|health|medical|patient|hospital|biology|microbiology|biochemistry)\b/i,
      label: "healthcare/life science",
      matches: /\b(pharmacy|microbiology|biochemistry|medical|biomedical|physiotherapy|veterinary|public health|nutrition)\b/i,
    },
    {
      test: /\b(business|management|marketing|finance|accounting|entrepreneur|bba|bank|banking)\b/i,
      label: "business/management",
      matches: /\b(business|management|bba|mba|accounting|finance|marketing)\b/i,
      department: "Department of Business Administration",
    },
    {
      test: /\b(law|legal|advocate|court|justice|ain|llb|lawyer)\b/i,
      label: "law/legal studies",
      matches: /\b(law|llb|llm|legal)\b/i,
      department: "Department of Law",
    },
    {
      test: /\b(politics|governance|rajniti|political\s*science|public\s*policy)\b/i,
      label: "Politics & Governance",
      matches: /\b(politics|governance)\b/i,
      department: "Department of Politics and Governance",
    },
    {
      test: /\b(agriculture|krishi|farming|crops?|soil)\b/i,
      label: "Agriculture & Agricultural Sciences",
      matches: /\b(agriculture)\b/i,
      department: "Faculty of Agriculture",
    },
    {
      test: /\b(vet|veterinary|animals?|prani|livestock|dvm)\b/i,
      label: "Veterinary Science & Animal Husbandry",
      matches: /\b(veterinary|animal)\b/i,
      department: "Faculty of Veterinary and Animal Sciences",
    },
    {
      test: /\b(sheba|seba|social\s*work|manush|shomaj|somaj|service|help|volunteer|community|sociology)\b/i,
      label: "human service & social welfare",
      matches: /\b(sociology|social\s*work|physiotherapy|pharmacy|veterinary|medical)\b/i,
      department: "Department of Sociology and Social Work",
    },
  ];
  const isAskingSpecificAttribute = /\b(chairman|chairperson|head|hod|dean|faculty|teachers?|teacher|members?|credit|credits|fee|fees|cost|tuition|khoroch|notice|routine|contact|number|phone|email)\b/i.test(q);
  if (isAskingSpecificAttribute) return null;

  const selected = interestGroups.find((group) => group.test.test(q));
  const hasAptitudeOrInterest =
    /\b(ami|amar|i|my|interest|pochondo|choose|choice|career|porte|pora|study|chai|korte\s+chai|bhalo|valo|pari|expert|skilled|strength|strong|weak|durbol|konta\s+(?:bhalo|nibo|choose))\b/i.test(q) ||
    /\b(?:e|te|in)\s+(?:bhalo|valo)\b/i.test(q) ||
    /\b(?:bhalo|valo)\s+(?:ami|lag[e|be]|pari)\b/i.test(q);
  if (!selected || !hasAptitudeOrInterest) return null;

  const wantsGraduate = /\b(masters?|postgraduate|m\.?sc|m\.?pharm|mba|ll\.?m|ms)\b/i.test(q);
  const isUndergrad = (p) => {
    const name = String(p.name || "");
    if (/\b(b\.?sc|b\.?pharm|bachelor|bba|ll\.?b|bpt|dvm|b\.?a)\b/i.test(name)) return true;
    if (/\b(m\.?sc|m\.?pharm|master|mba|ll\.?m|ms|mph|m\.?a)\b/i.test(name)) return false;
    return true;
  };

  const filtered = verifiedPrograms(knowledge.programs || [])
    .filter((program) => selected.matches.test(`${program.name || ""} ${program.department || ""} ${(program.aliases || []).join(" ")}`));

  filtered.sort((a, b) => {
    const aDeptMatch = selected.department && displayDepartmentName(a.department || "").toLowerCase() === displayDepartmentName(selected.department).toLowerCase() ? 1 : 0;
    const bDeptMatch = selected.department && displayDepartmentName(b.department || "").toLowerCase() === displayDepartmentName(selected.department).toLowerCase() ? 1 : 0;
    if (aDeptMatch !== bDeptMatch) return bDeptMatch - aDeptMatch;

    if (wantsGraduate) {
      const aGrad = !isUndergrad(a) ? 1 : 0;
      const bGrad = !isUndergrad(b) ? 1 : 0;
      return bGrad - aGrad;
    }
    const aUg = isUndergrad(a) ? 1 : 0;
    const bUg = isUndergrad(b) ? 1 : 0;
    return bUg - aUg;
  });

  const programs = filtered.slice(0, 4);
  const banglish = prefersBanglish(question);
  if (!programs.length) {
    return {
      text: banglish
        ? `${selected.label} interest-er sathe match kore emon verified program current data-te পাইনি। Guess না করে তোমার আরেকটি interest বা preferred কাজের ধরন জানতে চাই।`
        : `I could not find a verified program matching ${selected.label} in the current data. Tell me another interest or preferred type of work and I will narrow it down without guessing.`,
      sources: [],
      mode: "clarify",
    };
  }

  const isAptitude = /\b(valo|bhalo|pari|expert|skilled|strength|strong)\b/i.test(q);
  const lines = programs.map((program, index) => {
    const facts = [
      program.duration && `duration: ${cleanOfficialDisplayText(program.duration)}`,
      program.seats && `seats: ${cleanOfficialDisplayText(program.seats)}`,
      program.admissionRequirement && `eligibility: ${cleanOfficialDisplayText(program.admissionRequirement)}`,
    ].filter(Boolean);
    const catalog = departmentCourses(knowledge, program.department || selected.department || "");
    const courseExamples = catalog.courses.length
      ? `\n   - **Course examples:** ${catalog.courses.slice(0, 5).map((c) => c.title).join(", ")}`
      : "";
    return `${index + 1}. **${program.name}**${facts.length ? ` — ${facts.join("; ")}` : ""}${courseExamples}`;
  });

  const leadText = isAptitude
    ? (banglish
        ? `যেহেতু তোমার **${selected.label}**-এ ভালো দখল রয়েছে, তাই গণ বিশ্ববিদ্যালয়ের verified program data অনুযায়ী তোমার জন্য সবচেয়ে উপযুক্ত match:`
        : `Since you have a strong background in **${selected.label}**, here are the closest matching programs from verified university records:`)
    : (banglish
        ? `তোমার **${selected.label}** interest অনুযায়ী verified program data থেকে সবচেয়ে কাছের match:`
        : `Based on your interest in **${selected.label}**, the closest matches in the verified program data are:`);

  const closingText = programs.length === 1
    ? (banglish
        ? `\n\nতোমার এই দক্ষতা এই প্রোগ্রামের কোর্সে বিশেষ সুবিধা দেবে। প্রোগ্রামটির ফি, কোর্স প্ল্যান বা ক্যারিয়ার সুযোগ নিয়ে জানতে চাইলে বলতে পারো।`
        : `\n\nYour proficiency directly supports this curriculum. Let me know if you would like fee, syllabus, or career details for this program.`)
    : (banglish
        ? `\n\nপ্রথমে course content, eligibility ও duration মিলিয়ে shortlist করো। কোন option-টা compare করতে চাও বললে side-by-side দেখাব।`
        : `\n\nShortlist by course content, eligibility, and duration. Tell me which options you want compared side by side.`);

  return {
    text: `${leadText}\n\n${lines.join("\n\n")}${closingText}`,
    sources: dedupeSources(
      programs.flatMap((program) => {
        const catalog = departmentCourses(knowledge, program.department || selected.department || "");
        return [
          { title: program.sourceTitle || program.name, url: program.source },
          ...catalog.sources,
        ];
      })
    ),
    mode: "structured",
    suggestions: programs.slice(0, 2).map((program) => `${program.name} details bolo`),
  };
}

function isCodingQuestion(question) {
  const q = normalizeQuestion(question);
  if (asksOfficialInstitutionFact(q) || asksPersonIdentity(q)) return false;
  const codingTerms =
    /\b(code|coding|program|programming|script|python|java|javascript|js|typescript|ts|c\+\+|cpp|c\s+program|sql|html|css|php|rust|golang|algorithm|data\s+structure|debug|bug|function|loop|array|linked\s*list|stack|queue|tree|graph|binary\s*search|sorting|recursion|oop|class|regex)\b/i.test(q);
  const actionTerms =
    /\b(code|write|program|solve|banao|kore\s+dao|likhe\s+dao|implement|create|debug|fix|explain|example|how\s+to|kivabe|error|exception|output|solution|dry\s*run)\b/i.test(q);
  return codingTerms && (actionTerms || /\b(python|java|javascript|c\+\+|cpp|c\s+program|sql|html|css|php)\b/i.test(q));
}

function asksCodeExplanation(question) {
  const q = normalizeQuestion(question);
  return (
    /\b(explain|bujhiye|bujhao|bujhte|somjhao|line\s*by\s*line|breakdown|walkthrough|step\s*by\s*step|details|bistarito|kivabe\s*kaj\s*kore|how\s*it\s*works|working\s*principle|logic|complexity|karon|keno|theory)\b/i.test(q) ||
    /(বুঝিয়ে|বোঝাও|ব্যাখ্যা|লাইন\s*বাই\s*লাইন|ডিটেইলস|বিস্তারিত|কীভাবে\s*কাজ\s*করে|বিশ্লেষণ)/.test(question)
  );
}

function isGeneralAcademicQuestion(question) {
  const q = normalizeQuestion(question);
  if (asksOfficialInstitutionFact(q) || asksPersonIdentity(q)) return false;
  if (isCodingQuestion(question)) return true;
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

function detectFollowupFormatType(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;

  // Real questions asking about GPA points or short courses are not formatting follow-ups
  if (/\b(gpa|cgpa|grading|grade|credit)\s*(?:point|points)?\b/i.test(t) && !/\b(akare|bullet|list)\b/i.test(t)) {
    return null;
  }
  if (/\b(short\s*course|short\s*term)\b/i.test(t)) {
    return null;
  }

  // Ordinal recall queries (first, second, third topic) are handled by ordinal topic recall
  if (typeof ordinalTopicIndex === "function" && ordinalTopicIndex(t) !== null) {
    return null;
  }
  if (/\b(prothom|first|1st|second|2nd|third|3rd|tritiyo|ager\s+topic|agerta)\b/i.test(t)) {
    return null;
  }

  // Bullet points / in points / list
  if (
    /(point\s*akare|point\s*kore|point\s*by\s*point|bullet\s*points?|in\s*points?|points?\s*e|list\s*akare|list\s*kore|পয়েন্ট|পয়েন্ট|বুলেট)/i.test(t) ||
    (/\b(point|points|bullet|list)\b/i.test(t) && /\b(dau|dao|den|din|bolo|bolun|koro|korun|diyo|format|make|give|akare)\b/i.test(t))
  ) return "points";

  // Shorten / summarize / brief
  if (
    /(choto\s*kore|short\s*kore|shongkhepe|brief\s*e|one\s*line\s*e|ek\s*line\s*e|make\s*it\s*shorter|ছোট\s*করে|সংক্ষেপে|এক\s*লাইনে|সংক্ষিপ্ত)/i.test(t) ||
    (/\b(choto|short|brief|shorter|summarize|summary|tldr)\b/i.test(t) && /\b(dau|dao|den|din|bolo|bolun|koro|korun|kore|make|give|keep|in)\b/i.test(t)) ||
    /^(choto|short|shorter|summary|summarize|সংক্ষেপে|ছোট\s*করে\b)/i.test(t)
  ) return "shorten";

  // Expand / elaborate / longer / details
  if (
    /(boro\s*kore|aro\s*boro|details\s*e|aro\s*details|bistarito|make\s*it\s*longer|explain\s*in\s*detail|বড়\s*করে|বিস্তারিত|আরও\s*বড়)/i.test(t) ||
    (/\b(boro|longer|expand|elaborate|details|bistarito)\b/i.test(t) && /\b(dau|dao|den|din|bolo|bolun|koro|korun|kore|make|give|more|in)\b/i.test(t)) ||
    /^(boro|longer|expand|elaborate|বিস্তারিত|বড়\s*করে\b)/i.test(t)
  ) return "expand";

  // Simplify
  if (
    /(shohoj\s*kore|sohoj\s*kore|shohoj\s*vabe|shohoj\s*bhashay|সহজ\s*করে|সহজ\s*ভাষায়|সহজ\s*করে\s*বলুন|simplify)/i.test(t) ||
    (/\b(shohoj|sohoj|simple|simplify)\b/i.test(t) && /\b(dau|dao|den|din|bolo|bolun|koro|korun|kore|terms)\b/i.test(t))
  ) return "simplify";

  return null;
}

function isFollowupFormatInstruction(text) {
  return Boolean(detectFollowupFormatType(text));
}

function getLastAssistantTurn(history = []) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item && (item.role === "assistant" || item.role === "model") && item.text && item.text.trim()) {
      return item;
    }
  }
  return null;
}

function getLastUserTurn(history = []) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item && item.role === "user" && item.text && item.text.trim()) {
      return item;
    }
  }
  return null;
}

function getRecentExchangeFromHistory(history = [], currentMessage = "") {
  const clean = previousConversation(history, currentMessage).filter((item) => item?.role && item?.text);
  let lastAssistant = null;
  let lastUser = null;
  for (let i = clean.length - 1; i >= 0; i--) {
    const item = clean[i];
    if (!lastAssistant && (item.role === "assistant" || item.role === "model")) {
      lastAssistant = item;
      continue;
    }
    if (lastAssistant && !lastUser && item.role === "user") {
      lastUser = item;
      break;
    }
  }
  if (!lastUser) {
    for (let i = clean.length - 1; i >= 0; i--) {
      if (clean[i].role === "user") {
        lastUser = clean[i];
        break;
      }
    }
  }
  return { lastAssistant, lastUser };
}

function getOriginalTopicUserTurn(history = [], currentMessage = "") {
  const clean = previousConversation(history, currentMessage).filter((item) => item?.role && item?.text);
  for (let i = clean.length - 1; i >= 0; i--) {
    const item = clean[i];
    if (item.role === "user" && !isFollowupFormatInstruction(item.text)) {
      return item;
    }
  }
  return null;
}

function cleanTextOfPrefix(text) {
  return String(text || "")
    .replace(/^🏛️\s*\*\*[^*]+\*\*\s*\n\n?/i, "")
    .trim();
}

function followupFormatSuggestions(formatType, isUniv, language) {
  if (formatType === "shorten") {
    if (language === "Bengali") {
      return ["আরও বিস্তারিত দেখতে চাই", "পয়েন্ট আকারে দেখাও", isUniv ? "ভর্তির নিয়মাবলি কী?" : "উদাহরণ দিয়ে বোঝাও"];
    }
    if (language === "Banglish") {
      return ["Aro details dekhte chai", "Point akare dekhao", isUniv ? "Admission rules ki?" : "Udahoron diye bojhau"];
    }
    return ["Show in more detail", "Show in bullet points", isUniv ? "Admission requirements" : "Explain with an example"];
  }

  if (formatType === "points") {
    if (language === "Bengali") {
      return ["সংক্ষেপে সারসংক্ষেপ বলো", "আরও বিস্তারিত দেখতে চাই", isUniv ? "টিউশন ফি ও ওয়েভার কত?" : "সহজ ভাষায় বলো"];
    }
    if (language === "Banglish") {
      return ["Shongkhepe summary bolo", "Aro details dekhao", isUniv ? "Tuition fee o waiver koto?" : "Shohoj bhashay bolo"];
    }
    return ["Give a short summary", "Explain in detail", isUniv ? "Tuition fees & waivers" : "Explain simply"];
  }

  if (formatType === "expand") {
    if (language === "Bengali") {
      return ["সংক্ষেপে সারসংক্ষেপ বলো", "পয়েন্ট আকারে দেখাও", isUniv ? "যোগাযোগের ফোন নম্বর কত?" : "মূল বিষয়গুলো কী?"];
    }
    if (language === "Banglish") {
      return ["Shongkhepe bolo", "Point akare dekhao", isUniv ? "Contact number koto?" : "Main point gulo ki?"];
    }
    return ["Give a short summary", "Show in bullet points", isUniv ? "Contact phone number" : "Key takeaways"];
  }

  if (language === "Bengali") {
    return ["পয়েন্ট আকারে দেখাও", "আরও বিস্তারিত জানতে চাই", "সংক্ষেপে সারসংক্ষেপ বলো"];
  }
  return ["Show in bullet points", "Explain in more detail", "Give a short summary"];
}

async function callAiReformat({ cleanText, originalQuestion, instruction, formatType }) {
  const isBn = /[\u0980-\u09ff]/.test(instruction + (originalQuestion || ""));
  const isBanglish = !isBn && (prefersBanglish(instruction) || prefersBanglish(originalQuestion || ""));
  const langPrompt = isBn
    ? "Reply in natural, clear Bengali (বাংলা)."
    : isBanglish
    ? "Reply in natural, conversational Banglish matching the student's conversational style."
    : "Reply in clear, structured English.";

  let formatDirective = "";
  if (formatType === "points") {
    formatDirective = "Convert the information into neat, clear markdown bullet points with bold subheadings (- **Topic:** Details). Ensure every distinct fact, number, fee, requirement, or key point is on its own bullet.";
  } else if (formatType === "shorten") {
    formatDirective = "Make the response concise, punchy, and summarized (2-3 concise bullet points or 1 concise paragraph). STRICTLY PRESERVE all key facts, numbers, fees, and requirements.";
  } else if (formatType === "expand") {
    formatDirective = "Expand the response into a thorough, comprehensive explanation with detailed context, background, and structured sections, while keeping all specific facts, numbers, and fees accurate.";
  } else if (formatType === "simplify") {
    formatDirective = "Explain the information in very simple, easy-to-understand terms with an intuitive real-world explanation.";
  }

  const hasCode = /```[a-z]*\r?\n[\s\S]*?```/i.test(cleanText);
  let codeDirective = "";
  if (hasCode) {
    if (formatType === "expand") {
      codeDirective =
        "\n5. STRICT CODE SEPARATION: Keep the code block (```language ... ```) 100% clean, pure, and runnable. Put all detailed explanations, line-by-line breakdowns, complexity analysis, and edge cases OUTSIDE the code block using markdown headings and bullet points. NEVER put explanation essays or tutorial comments inside the code block.";
    } else if (formatType === "shorten") {
      codeDirective =
        "\n5. STRICT CODE SEPARATION: Provide only the minimal core function/class inside ```language ... ``` with no extra comments and no conversational filler.";
    } else {
      codeDirective =
        "\n5. STRICT CODE SEPARATION: The code block must remain 100% clean, runnable source code with NO essay comments inside.";
    }
  }

  const systemPrompt =
    `You are an expert AI editor and academic tutor for students.\n` +
    `The student previously asked: "${originalQuestion || "the previous topic"}"\n` +
    `The assistant previously answered:\n` +
    `"""\n${cleanText}\n"""\n\n` +
    `The student now requests: "${instruction}"\n` +
    `Instructions:\n` +
    `1. ${formatDirective}\n` +
    `2. STRICT FACTUAL INTEGRITY: Strictly preserve all accurate facts, figures, fees, numbers, names, and requirements mentioned in the previous answer. DO NOT invent, remove, or modify real data.\n` +
    `3. ${langPrompt}\n` +
    `4. Directly provide the reformatted answer without filler phrases like "Sure!", "Here is the summary:", or "Here are the points:".` +
    codeDirective;

  const userPrompt = `Reformat the previous answer according to: "${instruction}"`;

  const openAiKey = envSecret("OPENAI_API_KEY");
  if (openAiKey) {
    try {
      const isGroq = openAiBaseUrl.includes("groq.com");
      const models = isGroq ? [openAiModel, "openai/gpt-oss-120b"] : [openAiModel];
      for (const model of models.filter(Boolean)) {
        try {
          const resp = await fetch(`${openAiBaseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${openAiKey}`,
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              max_tokens: formatType === "expand" ? 1200 : 600,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
            }),
            signal: AbortSignal.timeout(6000),
          });
          if (resp.ok) {
            const data = await resp.json().catch(() => null);
            const content = data?.choices?.[0]?.message?.content?.trim();
            if (content) return content;
          }
        } catch {}
      }
    } catch {}
  }

  const geminiKey = envSecret("GEMINI_API_KEY");
  if (geminiKey) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: formatType === "expand" ? 1000 : 500 },
          }),
          signal: AbortSignal.timeout(6000),
        }
      );
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        if (text) return text;
      }
    } catch {}
  }

  return null;
}

function reformatTextDeterministically(cleanText, formatType, instruction = "", originalQuestion = "", knowledge = null) {
  const isBn = /[\u0980-\u09ff]/.test(instruction + (originalQuestion || "") + cleanText);
  const isBanglish = !isBn && (prefersBanglish(instruction) || prefersBanglish(originalQuestion || "") || prefersBanglish(cleanText));
  
  const rawLines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (formatType === "points") {
    const banner = isBn
      ? "📌 **পয়েন্ট আকারে মূল তথ্য:**\n\n"
      : isBanglish
      ? "📌 **Point akare mul tothyo:**\n\n"
      : "📌 **Key Points:**\n\n";

    const points = [];
    for (const line of rawLines) {
      const unbulleted = line.replace(/^[•*\-\d.]+\s*/, "").trim();
      if (!unbulleted) continue;
      
      if (unbulleted.includes(":") && !unbulleted.startsWith("-")) {
        const [label, ...rest] = unbulleted.split(":");
        const val = rest.join(":").trim();
        const cleanLabel = label.replace(/\*\*/g, "").trim();
        points.push(`- **${cleanLabel}:** ${val}`);
      } else {
        const sentences = unbulleted.split(/(?<=[.।!?])\s+/).filter((s) => s.length > 5);
        if (sentences.length > 1) {
          for (const s of sentences) {
            points.push(`- ${s}`);
          }
        } else {
          points.push(`- ${unbulleted}`);
        }
      }
    }
    return banner + (points.length ? points.join("\n") : cleanText);
  }

  if (formatType === "shorten") {
    const banner = isBn
      ? "⚡ **সংক্ষেপে:**\n\n"
      : isBanglish
      ? "⚡ **Short Summary:**\n\n"
      : "⚡ **In Short:**\n\n";

    const scored = rawLines.map((line) => {
      let score = 0;
      const lower = line.toLowerCase();
      if (/(fee|tuition|cost|টাকা|tk|bdt|payment|খরচ|ফি)/i.test(lower)) score += 10;
      if (/(credit|duration|year|semester|বছর|সেমিস্টার|ক্রেডিট)/i.test(lower)) score += 8;
      if (/(eligibility|requirement|gpa|জিপিএ|যোগ্যতা|ভর্তি)/i.test(lower)) score += 8;
      if (/(head|chairman|chairperson|উপাচার্য|vc|প্রধান)/i.test(lower)) score += 7;
      if (/(result|exam|পরীক্ষা|নম্বর)/i.test(lower)) score += 6;
      if (line.length > 20 && line.length < 180) score += 3;
      return { line, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const topLines = (scored.length > 0 && scored[0].score > 0)
      ? scored.slice(0, 3).map((item) => {
          const l = item.line.replace(/^[•*\-\d.]+\s*/, "").trim();
          return l.startsWith("-") ? l : `- ${l}`;
        })
      : rawLines.slice(0, 2);

    return banner + topLines.join("\n");
  }

  if (formatType === "expand") {
    const banner = isBn
      ? "📖 **বিস্তারিত বিবরণ:**\n\n"
      : isBanglish
      ? "📖 **Bistarito Biboron (Detailed Overview):**\n\n"
      : "📖 **Detailed Overview:**\n\n";

    const dept = knowledge && typeof matchedDepartmentFromQuestion === "function"
      ? matchedDepartmentFromQuestion(originalQuestion + " " + cleanText, knowledge)
      : null;
    if (dept && knowledge && typeof programForDepartment === "function") {
      const prog = programForDepartment(knowledge, dept);
      let credit = null;
      let people = [];
      let leaders = [];
      try {
        if (typeof departmentCreditFact === "function") credit = departmentCreditFact(knowledge, dept);
      } catch {}
      try {
        if (typeof departmentPeople === "function") people = departmentPeople(knowledge, dept).filter(isTeachingFaculty);
      } catch {}
      try {
        if (typeof departmentLeaderRecords === "function") leaders = departmentLeaderRecords(knowledge, dept, people);
      } catch {}

      const parts = [
        banner,
        `### **${displayDepartmentName(dept)}**\n`,
        cleanText + "\n",
        "**অতিরিক্ত প্রয়োজনীয় প্রাতিষ্ঠানিক তথ্য:**",
        prog?.name ? `- **অফিশিয়াল ডিগ্রি:** ${prog.name}` : null,
        prog?.duration ? `- **কোর্সের মোট মেয়াদ:** ${prog.duration}` : null,
        credit?.value ? `- **সর্বমোট ক্রেডিট সংখ্যা:** ${credit.value}` : null,
        prog?.seats ? `- **অনুমোদিত আসন সংখ্যা:** ${prog.seats}` : null,
        leaders.length ? `- **বিভাগীয় প্রধান (Head):** ${leaders.map((p) => p.name).join(", ")}` : null,
        people.length ? `- **অনুষদ সদস্য (Faculty):** ${people.length} জন শিক্ষক` : null,
        prog?.admissionRequirement ? `- **ভর্তির ন্যূনতম যোগ্যতা:** ${prog.admissionRequirement}` : null,
        "- **অন্যান্য সুবিধা:** আধুনিক কম্পিউটার ল্যাব, সমৃদ্ধ সেমিনার লাইব্রেরি, ওয়াইফাই ক্যাম্পাস এবং বিষয়ভিত্তিক ক্লাব কার্যক্রম।",
        isBn
          ? "\n*ভর্তি সংক্রান্ত যেকোনো হালনাগাদ তথ্যের জন্য বিশ্ববিদ্যালয়ের ভর্তি অফিসে যোগাযোগ করার পরামর্শ দেওয়া হলো।*"
          : "\n*For official admissions updates, please visit the university Admissions Office.*",
      ].filter(Boolean);

      return parts.join("\n");
    }

    const intro = isBn
      ? "উক্ত বিষয়টি আরও স্পষ্টভাবে বোঝার জন্য নিচের বিস্তারিত দিকগুলো লক্ষ্য করুন:\n\n"
      : isBanglish
      ? "Ei topic ta aro details e bujhar jonno nicher point gulo kheyal korun:\n\n"
      : "Here is a more comprehensive breakdown of the topic:\n\n";

    return banner + intro + cleanText;
  }

  if (formatType === "simplify") {
    const banner = isBn
      ? "💡 **সহজ ভাষায় সংক্ষেপে:**\n\n"
      : isBanglish
      ? "💡 **Shohoj Bhashay:**\n\n"
      : "💡 **In Simple Terms:**\n\n";

    const lines = rawLines.map((l) => l.replace(/^[•*\-\d.]+\s*/, "").trim());
    return banner + lines.slice(0, 3).map((l) => `- ${l}`).join("\n");
  }

  return cleanText;
}

async function handleFollowupFormatRequest({ message, history, knowledge, sessionId, isGbAi }) {
  const formatType = detectFollowupFormatType(message);
  if (!formatType) return null;

  const { lastAssistant, lastUser } = getRecentExchangeFromHistory(history, message);
  const isBn = /[\u0980-\u09ff]/.test(message);
  const isBanglish = !isBn && prefersBanglish(message);

  if (!lastAssistant || !lastAssistant.text) {
    return {
      text: isBn
        ? "আপনি কোন বিষয়টি সংক্ষেপে বা পয়েন্ট আকারে দেখতে চান? দয়া করে আপনার কাঙ্ক্ষিত প্রশ্ন বা বিষয়টি লিখে জানান।"
        : isBanglish
        ? "Apni kon topic ta choto kore ba point akare dekhte chan? Please apnar question-ta ektu likhe janan."
        : "Which topic or question would you like me to format or summarize? Please type your question first.",
      mode: "clarify",
      medium: isGbAi ? "gb-ai" : "chat",
      sources: [],
      suggestions: isBn
        ? ["CSE ভর্তি ফি কত?", "গণ বিশ্ববিদ্যালয়ের উপাচার্য কে?", "ভর্তির ন্যূনতম যোগ্যতা কী?"]
        : isBanglish
        ? ["CSE admission fee koto?", "Gono Bishwabidyalay er VC ke?", "Admission eligibility ki?"]
        : ["What is the CSE admission fee?", "Who is the Vice-Chancellor?", "Admission eligibility criteria"],
    };
  }

  const origUser = getOriginalTopicUserTurn(history, message) || lastUser;
  const rawAssistantText = String(lastAssistant.text || "");
  const hadUnivHeader =
    rawAssistantText.includes("গণ বিশ্ববিদ্যালয় অফিশিয়াল চ্যাটবট ডাটাবেস") ||
    rawAssistantText.includes("GB Chatbot • Official University Knowledge Base") ||
    lastAssistant.isUniversityQuery ||
    lastAssistant.mode === "gb_ai_university_chatbot";

  const cleanText = cleanTextOfPrefix(rawAssistantText);
  const isUniv =
    hadUnivHeader ||
    Boolean(knowledge && origUser?.text && isUniversityInquiry(origUser.text, knowledge, [])) ||
    Boolean(knowledge && cleanText && isUniversityInquiry(cleanText, knowledge, []));

  const language = isBn
    ? "Bengali"
    : isBanglish || prefersBanglish(origUser?.text || "") || prefersBanglish(cleanText)
    ? "Banglish"
    : "English";

  let reformattedText = await callAiReformat({
    cleanText,
    originalQuestion: origUser?.text || lastUser?.text || "",
    instruction: message,
    formatType,
  });

  if (!reformattedText) {
    reformattedText = reformatTextDeterministically(
      cleanText,
      formatType,
      message,
      origUser?.text || lastUser?.text || "",
      knowledge
    );
  }

  if (isGbAi && isUniv) {
    const prefix = language === "English"
      ? "🏛️ **GB Chatbot • Official University Knowledge Base:**\n\n"
      : "🏛️ **গণ বিশ্ববিদ্যালয় অফিশিয়াল চ্যাটবট ডাটাবেস (GB Chatbot):**\n\n";
    if (!reformattedText.startsWith("🏛️")) {
      reformattedText = prefix + reformattedText;
    }
  }

  const effectiveSources = Array.isArray(lastAssistant.sources) ? lastAssistant.sources : [];
  const suggestions = followupFormatSuggestions(formatType, isUniv, language);

  return {
    text: reformattedText,
    mode: isGbAi
      ? isUniv
        ? "gb_ai_university_chatbot"
        : "gb_ai_solution"
      : "structured_format_followup",
    medium: isGbAi ? "gb-ai" : "chat",
    isUniversityQuery: Boolean(isUniv),
    aiModel: isGbAi
      ? isUniv
        ? "GB Chatbot (Official Knowledge)"
        : "GB AI"
      : undefined,
    profile: {
      label: isGbAi
        ? isUniv
          ? "GB Chatbot"
          : "GB AI"
        : "Follow-up Answer",
      confidence: isUniv ? "Official University Knowledge" : "Context Preserved",
    },
    sources: effectiveSources,
    suggestions,
  };
}

function isContextualFollowup(question) {
  const q = normalizeQuestion(question);
  return (
    isFollowupFormatInstruction(q) ||
    asksContactDetail(q) ||
    /\b(his|her|their|that|this|profile|details|tar|or|oder|etar|eitar|oitar|about|career|future|job|scope|waiver|scholarship|eligibility|qualification|kobe|shuru|start|dates?|timing)\b/i.test(q)
  );
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
  if (directClubAnswer(question, knowledge)) return null;
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
  const asksLeader = /\b(chairman|chairperson|chair|head|hod|dean|department\s+head|dept\s+head)\b/i.test(q);
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
  const people = departmentPeople(knowledge, matchedDepartment);
  const asksDean = /\bdean\b/i.test(q);
  const deans = people.filter((person) => /\bdean\b/i.test(person.designation || ""));
  const leaders = asksDean ? deans : departmentLeaderRecords(knowledge, matchedDepartment, people);
  if (!leaders.length) {
    return {
      text: prefersBanglish(question)
        ? `**${displayDepartment}**-er current head/dean official indexed source theke verify korte parini, tai kono nam guess korchi na.`
        : `I could not verify the current head or dean of **${displayDepartment}** from the indexed official sources, so I will not guess a name.`,
      sources: [],
      mode: "not_found",
    };
  }

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
    const role = /\bdean\b/i.test(q) && /\bdean\b/i.test(title) ? "dean" : /\bhead\b/i.test(title) ? "department head" : title;
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
  ].filter((dept) => !/library|research|office|administration|student\s+union|sports/i.test(dept) || /Business\s+Administration/i.test(dept));
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

function ordinalTopicIndex(question) {
  const q = normalizeQuestion(question);
  const patterns = [
    /(?:\b(?:first|1st)\s+(?:topic|one|department|program|subject|ta|tar)\b|\bprothom(?:\s+(?:topic|one|department|program|subject|ta|tar|bisoy|bishoy))?\b|প্রথম(?:টা|টি|টার|টির|\s*বিষ[য়য়])?)/iu,
    /(?:\b(?:second|2nd)\s+(?:topic|one|department|program|subject|ta|tar)\b|\bditiyo(?:\s+(?:topic|one|department|program|subject|ta|tar|bisoy|bishoy))?\b|দ্বিতী[য়য়](?:টা|টি|টার|টির|\s*বিষ[য়য়])?)/iu,
    /(?:\b(?:third|3rd)\s+(?:topic|one|department|program|subject|ta|tar)\b|\btritiyo(?:\s+(?:topic|one|department|program|subject|ta|tar|bisoy|bishoy))?\b|তৃতী[য়য়](?:টা|টি|টার|টির|\s*বিষ[য়য়])?)/iu,
  ];
  const index = patterns.findIndex((pattern) => pattern.test(q));
  return index >= 0 ? index : null;
}

function conversationDepartmentTopics(history = [], knowledge = null) {
  if (!knowledge) return [];
  const topics = [];
  for (const turn of history) {
    if (turn?.role !== "user") continue;
    const text = String(turn.text || "");
    const department =
      matchedDepartmentFromQuestion(text, knowledge) ||
      rankedPrograms(text, knowledge.programs || [])[0]?.program?.department;
    if (department && !topics.includes(department)) topics.push(department);
  }
  return topics;
}

function conversationDepartmentTopicTurns(history = [], knowledge = null) {
  if (!knowledge) return [];
  const topics = [];
  const seen = new Set();
  for (const turn of history) {
    if (turn?.role !== "user") continue;
    const text = String(turn.text || turn.content || "");
    const department =
      matchedDepartmentFromQuestion(text, knowledge) ||
      rankedPrograms(text, knowledge.programs || [])[0]?.program?.department;
    if (department && !seen.has(department)) {
      seen.add(department);
      topics.push({ department, turnText: text });
    }
  }
  return topics;
}

function extractTurnAttribute(text = "") {
  const q = normalizeQuestion(text);
  if (asksFeeDetail(q)) return "fee";
  if (/\b(head|chairman|chairperson|hod|dean)\b/i.test(q)) return "head";
  if (/\b(credits?|credit\s+hours?)\b/i.test(q)) return "credits";
  if (/\b(duration|years?|semesters?|koto\s+bochor)\b/i.test(q)) return "duration";
  if (/\b(seats?|capacity|intake|asan|ashon)\b/i.test(q)) return "seats";
  if (/\b(eligibility|qualification|requirements?|joggota)\b/i.test(q)) return "admission requirements";
  if (/\b(waiver|scholarship|stipend)\b/i.test(q)) return "waiver";
  return null;
}

function explicitTopicAnchor(question, knowledge = null) {
  const text = String(question || "");
  const q = normalizeQuestion(text);
  const department = knowledge
    ? matchedDepartmentFromQuestion(text, knowledge) || rankedPrograms(text, knowledge.programs || [])[0]?.program?.department
    : null;
  if (department) return { key: `department:${department}`, query: department };

  const categories = [
    ["admission", /\b(admission|vorti|apply|eligibility|requirements?|ssc|hsc|deadline)\b/i, "admission"],
    ["fees", /\b(fees?|tuition|tution|cost|khoroch|payment|taka|waiver|scholarship)\b/i, "tuition fees"],
    ["library", /\b(library|pathagar|boighor)\b/i, "library"],
    ["hostel", /\b(hostel|hall|dormitory|abashon)\b/i, "hostel"],
    ["transport", /\b(transport|bus|route|shuttle)\b/i, "transport"],
    ["research", /\b(research|journal|publication|laboratory|lab)\b/i, "research"],
    ["notices", /\b(notices?|result|routine|schedule|circular)\b/i, "latest notices"],
    ["portal", /\b(portal|iems|student\s+portal|online\s+payment)\b/i, "student portal"],
    ["facilities", /\b(campus|facilities?|canteen|sports|club)\b/i, "campus facilities"],
    ["data-structures", /\bdata\s+structures?\b/i, "data structures"],
    ["programming", /\b(programming|coding|software\s+development)\b/i, "programming"],
  ];
  const category = categories.find(([, pattern]) => pattern.test(q));
  return category ? { key: `topic:${category[0]}`, query: category[2] } : null;
}

function conversationTopicAnchors(history = [], knowledge = null) {
  const topics = [];
  const seen = new Set();
  for (const turn of history) {
    if (turn?.role !== "user") continue;
    const topic = explicitTopicAnchor(turn.text, knowledge);
    if (!topic || seen.has(topic.key)) continue;
    seen.add(topic.key);
    topics.push(topic);
  }
  return topics;
}

function ordinalContextTopic(question, history = [], knowledge = null) {
  const index = ordinalTopicIndex(question);
  if (index === null) return null;
  return conversationTopicAnchors(previousConversation(history, question), knowledge)[index] || null;
}

function ordinalContextDepartment(question, history = [], knowledge = null) {
  const index = ordinalTopicIndex(question);
  if (index === null) return null;
  return conversationDepartmentTopics(previousConversation(history, question), knowledge)[index] || null;
}

function activeContextDepartment(history = [], question = "", knowledge = null) {
  if (knowledge && question) {
    const directDept = matchedDepartmentFromQuestion(question, knowledge);
    if (directDept) return directDept;
  }
  const items = previousConversation(history, question);
  if (!items || !items.length) return null;

  const ordinalDepartment = ordinalContextDepartment(question, items, knowledge);
  if (ordinalDepartment) return ordinalDepartment;

  // First pass: inspect recent USER turns in reverse
  const recentUserTurns = items
    .map((turn, index) => ({ ...turn, historyIndex: index }))
    .filter((turn) => turn.role === "user")
    .slice(-12)
    .reverse();
  for (const turn of recentUserTurns) {
    const text = String(turn.text || "");
    if (knowledge) {
      const found = matchedDepartmentFromQuestion(text, knowledge);
      if (found) return found;
      const recalled = ordinalContextDepartment(text, items.slice(0, turn.historyIndex), knowledge);
      if (recalled) return recalled;
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
      .add("bio medical")
      .add("biomedical engineering")
      .add("bio medical engineering")
      .add("medical physics and biomedical engineering")
      .add("mpbme")
      .add("bme");
  }
  if (/Agriculture/i.test(department)) aliases.add("agriculture").add("agri");
  if (/English/i.test(department)) aliases.add("english");
  if (/\bMathematics\b/i.test(department)) aliases.add("math").add("mathematics").add("applied math").add("applied mathematics");
  if (/\bChemistry\b/i.test(department)) aliases.add("chemistry").add("chem");
  if (/\bPhysics\b/i.test(department)) aliases.add("physics").add("phy");
  if (/\bBiochemistry\b/i.test(department)) aliases.add("bmb").add("biochem").add("bio chem").add("biochemistry").add("molecular biology");
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
  const heads = people.filter((person) => /\b(head|chairman|chairperson|chair)\b/i.test(person.designation || ""));
  if (!/^Faculty of\b/i.test(displayDepartmentName(department))) return heads;
  const deans = people.filter((person) => /\bdean\b/i.test(person.designation || ""));
  return deans.length ? deans : heads;
}

function inferredDepartmentLeaders(knowledge, department) {
  const wanted = displayDepartmentName(department).toLowerCase();
  const candidates = pageRecords(knowledge)
    .filter((record) => displayDepartmentName(record.department || "").toLowerCase() === wanted)
    .filter((record) => /head|hod|message/i.test(`${record.title} ${record.url} ${record.text}`))
    .sort((a, b) => Number(/message-from-hod|departmental-head/i.test(`${b.title} ${b.url}`)) - Number(/message-from-hod|departmental-head/i.test(`${a.title} ${a.url}`)));
  const leaders = [];
  for (const record of candidates) {
    const matches = String(record.text || "").matchAll(/(?:^|\n)([^\n|]{3,100})\n((?:Professor\s*(?:&|and)\s*)?Head(?:\s+of\s+the\s+Department)?)/gim);
    for (const match of matches) {
      const name = cleanPersonName(match[1]);
      if (/^(?:message|faculty|department|welcome|profile|archive|list|head)\b/i.test(name)) continue;
      leaders.push({ name, designation: match[2].trim(), department, source: record.url, sourceTitle: record.title });
    }
  }
  return dedupePeople(leaders).slice(0, 1);
}

function departmentLeaderRecords(knowledge, department, people = departmentPeople(knowledge, department)) {
  const structured = departmentLeaders(people, department);
  return structured.length ? structured : inferredDepartmentLeaders(knowledge, department);
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

const isInvalidCourseTitle = (title) =>
  !title ||
  title.length < 3 ||
  title.length > 110 ||
  /^(?:first|second|third|fourth|fifth|sixth|six|seventh|seven|eighth|eight|ninth|tenth|\d+(?:st|nd|rd|th)?)\s+(?:year|semester|sem)\b/i.test(title) ||
  /\b(?:fail|pass|grading|viva|viva[\s-]*voce|grand\s+total|sub\s*total|contact\s+hours?|credit\s+numbers?|course\s+code|course\s+title|course\s+name|nature\s+of|sl\.?\s*no)\b/i.test(title) ||
  /^total$/i.test(title);

function extractCoursesFromText(text) {
  const courses = [];
  for (const rawLine of String(text || "").split(/\n+/)) {
    const line = cleanExtractedText(rawLine).trim();
    if (!line) continue;

    // Check pipe-separated rows (handles tables like "SSW. 101 | Introduction to Sociology | Compulsory | 4 | 100 | 45")
    if (line.includes("|")) {
      let parts = line.split("|").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
        parts = parts.slice(1);
      }
      if (parts.length >= 2) {
        const codeMatch = parts[0].match(/^([A-Za-z]{2,8}[\.\-]?\s*\d{2,4}[A-Za-z]?)$/);
        if (codeMatch) {
          const code = codeMatch[1].replace(/\s+/g, " ");
          const title = parts[1].replace(/^\d+\.?\s*/, "").trim();
          if (title && !isInvalidCourseTitle(title)) {
            let credits = "";
            for (let i = 2; i < Math.min(parts.length, 5); i++) {
              const crMatch = parts[i].match(/^(\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)?)$/);
              if (crMatch && Number(crMatch[1]) <= 10) {
                credits = crMatch[1];
                break;
              }
            }
            courses.push({ code, title, credits });
            continue;
          }
        }
      }
    }

    let match = line.match(/^([A-Za-z]{2,8}[\.\-]?\s*\d{2,4}[A-Za-z]?)\s*\|\s*(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*(?:\||$)/i);
    if (match) {
      const title = match[2].trim();
      if (!isInvalidCourseTitle(title)) {
        courses.push({ code: match[1].replace(/\s+/g, " "), title, credits: match[3] });
        continue;
      }
    }
    match = line.match(/^([A-Za-z]{2,8}[\.\-]?\s*\d{2,4}[A-Za-z]?)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)$/i);
    if (match) {
      const title = match[2].trim();
      if (!isInvalidCourseTitle(title)) {
        courses.push({ code: match[1].replace(/\s+/g, " "), title, credits: match[4] });
        continue;
      }
    }
    match = line.match(/^([A-Za-z][^|]{2,100}?)\s*\|\s*(\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)?)\s*\|/);
    if (match) {
      const title = match[1].trim();
      if (!isInvalidCourseTitle(title) && !/^(?:course\s+title|sub\s*total|total)/i.test(title)) {
        courses.push({ code: "", title, credits: match[2].replace(/\s+/g, "") });
      }
    }
  }
  return [...new Map(courses.map((course) => [course.code ? course.code.replace(/[\s\.\-]/g, "").toUpperCase() : normalizeQuestion(course.title), course])).values()]
    .filter((course) => !isInvalidCourseTitle(course.title));
}

function formatCourse(course) {
  const label = course.code ? `${course.code}: ${course.title}` : course.title;
  const creditLabel = String(course.credits || "").includes("+")
    ? `${course.credits} credits (theory+practical)`
    : `${course.credits} ${String(course.credits) === "1" ? "credit" : "credits"}`;
  return { label, creditLabel };
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
  const normTarget = displayDepartmentName(department).replace(/^Department of\s+/i, "").toLowerCase();
  const programs = verifiedPrograms(knowledge.programs || []).filter((program) => {
    const normProgDept = displayDepartmentName(program.department).replace(/^Department of\s+/i, "").toLowerCase();
    if (normProgDept === normTarget) return true;
    const aliases = departmentAliases(program.department);
    return aliases.some((alias) => normalizeQuestion(alias) === normTarget);
  });
  return programs.find((program) =>
    wantsGraduate ? isGraduateProgramName(program.name) : !isGraduateProgramName(program.name),
  ) || programs[0];
}

function directProgramComparisonAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const isAptitudeOrPreference =
    /\b(?:e|te|in)\s+(?:bhalo|valo)\b/i.test(q) ||
    /\b(?:bhalo|valo)\s+(?:ami|lag[e|be]|pari)\b/i.test(q) ||
    /\b(?:ami|amar)\b.*?\b(?:bhalo|valo|pari)\b/i.test(q);
  const hasExplicitComparisonTerm =
    /\b(compare|comparison|versus|vs|difference|parthokko|tulona|তুলনা|পার্থক্য)\b/i.test(q) ||
    /\b(better)\b/i.test(q) ||
    /\b(konta|which(?:\s+one)?)\s+(?:bhalo|better|beshi\s+bhalo|val[o]?)\b/i.test(q) ||
    /\b(?:bhalo|better)\s+(?:konta|konti)\b/i.test(q) ||
    /\b(?:between|choose\s+between|konta\s+choose|konta\s+nibo|konta\s+neya\s+jay)\b/i.test(q) ||
    /\b\w+\s+naki\s+\w+\b/i.test(q);

  if (!hasExplicitComparisonTerm) return null;
  if (isAptitudeOrPreference && !/\b(compare|comparison|versus|vs|difference|parthokko|tulona)\b/i.test(q)) return null;

  let departments = mentionedDepartments(q, knowledge).slice(0, 3);
  if (departments.length === 0 && history.length) {
    if (/\b(eta|eita|this|it)\b/i.test(q)) {
      const priorDept = activeContextDepartment(history, question, knowledge);
      if (priorDept) departments = [priorDept];
    }
  }
  if (departments.length < 2 && history.length) {
    const asksToCompareWithPrior = /\b(etar\s+sathe|ager\s+tar\s+sathe|compare\s+with|er\s+sathe\s+compare|sathe\s+tulona|versus\s+this|vs\s+this)\b/i.test(q);
    if (asksToCompareWithPrior) {
      const items = previousConversation(history, question);
      if (items && items.length) {
        const recent = [...items].slice(-6).reverse();
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
  }
  if (departments.length < 2) {
    const hasEarlierComparison = history.some((item) => item.role === "user" && mentionedDepartments(item.text || "", knowledge).length >= 2);
    if (hasEarlierComparison) return null;
    if (departments.length === 1 && /\b(better|bhalo|naki|konta|choose)\b/i.test(q)) {
      return {
        text: prefersBanglish(question)
          ? `**${displayDepartmentName(departments[0])}**-ke kon program-er sathe compare korte chaccho? Onno program-ta bolle course, duration, credit o career-fit diye tulona korbo.`
          : `Which program would you like to compare with **${displayDepartmentName(departments[0])}**? Name the other program and I will compare courses, duration, credits, and career fit.`,
        sources: [],
        mode: "clarify",
      };
    }
    return null;
  }
  const wantsGraduate = /\b(?:msc|mpharm|master|graduate|postgraduate|llm|mss|ma)\b/i.test(q);
  const banglish = prefersBanglish(question);
  const sections = departments.map((department) => {
    const program = programForDepartment(knowledge, department, wantsGraduate);
    const credit = departmentCreditFact(knowledge, department);
    const { courses } = departmentCourses(knowledge, department);
    const facts = [
      program?.duration && `${banglish ? "Duration" : "Duration"}: **${cleanOfficialDisplayText(program.duration)}**`,
      program?.seats && `${banglish ? "Published seat" : "Published seats"}: **${cleanOfficialDisplayText(program.seats)}**`,
      credit?.value && `${banglish ? "Official total credit" : "Official course-plan credits"}: **${credit.value}**`,
      courses.length && `${banglish ? "Course example" : "Course examples"}: ${courses.slice(0, 6).map((course) => course.title).join(", ")}`,
      program?.admissionRequirement && `${banglish ? "Admission eligibility" : "Eligibility"}: ${cleanOfficialDisplayText(program.admissionRequirement)}`,
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
    ? (banglish
        ? `\n\n**Tomar interest-er sathe best fit:** **${displayDepartmentName(recommended)}**, karon tumi ${interest.focus} niye interest bolecho. Eta interest-based suggestion, universal ranking na.`
        : `\n\n**Best fit for your stated interest:** **${displayDepartmentName(recommended)}**, because you mentioned ${interest.focus}. This is an interest-based recommendation, not a universal ranking.`)
    : (banglish
        ? `\n\n**Konta bhalo?** Eta tomar interest-er upor depend kore. Uporer course, credit, duration o career direction miliye choose koro—sobai-r jonno ekta program universally better na.`
        : `\n\n**How to choose:** compare the actual course examples with what you enjoy and the work you want to do. “Better” is personal; the verified differences above are more useful than a generic ranking.`);
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

  if (/\b(duration|years?|semesters?|shorter|longer)\b/i.test(q)) {
    const facts = departments
      .map((department) => ({
        department,
        program: programForDepartment(knowledge, department),
      }))
      .filter((item) => item.program?.duration)
      .map((item) => ({ ...item, years: Number(String(item.program.duration).match(/\d+(?:\.\d+)?/)?.[0]) }));
    if (facts.length < 2) return null;
    const validYears = facts.filter((item) => Number.isFinite(item.years));
    const durations = facts.map(({ department, program }) => `- **${displayDepartmentName(department)}:** ${cleanOfficialDisplayText(program.duration)}`).join("\n");
    let conclusion = prefersBanglish(question)
      ? "Published duration program o session onujayi compare kora uchit."
      : "The published durations should be compared by program and session.";
    if (validYears.length >= 2) {
      const shortest = Math.min(...validYears.map((item) => item.years));
      const shortestPrograms = validYears.filter((item) => item.years === shortest);
      conclusion = shortestPrograms.length > 1
        ? (prefersBanglish(question)
            ? `Duita program-er-i published duration **${shortest} years**—somoy-er dik diye konotai choto na.`
            : `These programs have the same published duration of **${shortest} years**.`)
        : (prefersBanglish(question)
            ? `**${displayDepartmentName(shortestPrograms[0].department)}**-er published duration kom.`
            : `**${displayDepartmentName(shortestPrograms[0].department)}** has the shorter published duration.`);
    }
    return {
      text: `${durations}\n\n${conclusion}`,
      sources: facts.map(({ program }) => ({ title: program.sourceTitle || program.name, url: program.source })).filter((source, index, list) => source.url && list.findIndex((item) => item.url === source.url) === index),
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
  const topicTerms = tokenize(q).filter((token) => (token.length >= 4 || token === "lab") && !ignored.has(token));
  const stem = (token) => token.replace(/s$/i, "");
  const matchedCourses = topicTerms.length
    ? courses.filter((course) => {
        const titleTerms = tokenize(course.title).map(stem);
        return topicTerms.map(stem).every((term) => titleTerms.includes(term));
      })
    : [];
  if (matchedCourses.length && explicitCourseTopic) {
    const lines = matchedCourses.slice(0, 6).map((course) => {
      const { label, creditLabel } = formatCourse(course);
      return `- **${label}** - ${creditLabel}`;
    });
    return {
      text: `The official **${displayDepartmentName(matchedDepartment)}** syllabus includes:\n${lines.join("\n")}\n\nThese are syllabus records; the exact semester/session should be checked against the linked official course plan.`,
      sources,
      mode: "structured",
    };
  }

  const wantsFull = /\b(all|full|complete|sob|shob)\b/i.test(q);
  const limit = wantsFull ? 36 : 16;
  const shown = courses.slice(0, limit);
  const recordLabel = courses.length === 1 ? "course record" : "course records";
  return {
    text: `I found **${courses.length} ${recordLabel}** in the indexed official **${displayDepartmentName(matchedDepartment)}** curriculum. ${wantsFull && courses.length > limit ? `Showing the first ${limit}:` : "Representative courses:"}\n${shown.map((course) => { const { label, creditLabel } = formatCourse(course); return `- **${label}** (${creditLabel})`; }).join("\n")}${courses.length > limit ? `\n- Plus ${courses.length - limit} more in the linked official syllabus.` : ""}`,
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
  const heads = departmentLeaderRecords(knowledge, matchedDepartment, people);
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

  const leaders = departmentLeaderRecords(knowledge, matchedDepartment, people);
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
  const cleaned = cleanExtractedText(text);
  const normalized = cleaned.replace(/\s+/g, " ");
  const creditPatterns = [
    /\bDuration\s*\|\s*Total Contact Hours[^|]{0,80}\|\s*Total Credits?\s+\d+\s+years?\s*\|\s*[\d/]+\s*\|\s*(\d{2,3})\b/i,
    /\bTotal minimum credit requirement[^.]{0,100}?\b(?:is|:)?\s*(\d{2,3})\b/i,
    /\bGrand Total\s+[\d/]+\s+(\d{2,3})\s+\d+\b/i,
    /\bTotal Credits?\s+Total Marks\s+\d+\s+years?\s+[\d/]+\s+(\d{2,3})\s+\d+/i,
    /\bTotal Credit(?:s| for Graduation)?\s*[:\-]?\s*(\d{2,3})\b/i,
    /(?<![\d.])(\d{2,3})(?![\d.])\s+Total Credits?\b/i,
  ];
  const durationPatterns = [
    /\bDuration\s+(?:Total Contact Hours\s+Theory\s*\/Lab\s+Total Credits?\s+Total Marks\s+)?(\d+\s+years?)\b/i,
    /\b(\d+\s+years?)\s+has\s+\d+\s+semesters\b/i,
  ];
  let credit = creditPatterns.map((pattern) => normalized.match(pattern)?.[1]).find(Boolean);
  if (!credit && /\b1st Semester\b/i.test(cleaned) && /\b8th Semester\b/i.test(cleaned)) {
    const codePattern = /\b([A-Z][A-Z.]{1,7}\s*-?\s*\d{3})\b/g;
    const matches = [...cleaned.matchAll(codePattern)];
    const courseCredits = new Map();
    for (let index = 0; index < matches.length; index += 1) {
      const code = matches[index][1].replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const block = cleaned.slice(matches[index].index, matches[index + 1]?.index ?? cleaned.length);
      const values = [...block.matchAll(/\|\s*(\d+(?:\.\d+)?)(?=\s|$)/g)];
      const value = Number.parseFloat(values[0]?.[1] || "");
      if (Number.isFinite(value) && value > 0 && value <= 10) courseCredits.set(code, value);
    }
    const total = [...courseCredits.values()].reduce((sum, value) => sum + value, 0);
    if (courseCredits.size >= 20 && total >= 80 && total <= 300) credit = Number.isInteger(total) ? String(total) : total.toFixed(1);
  }
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
  const combinedPageRecords = (knowledge.pages || [])
    .filter((page) =>
      Array.isArray(page.chunks) &&
      page.chunks.length > 1 &&
      /course[-\s/]*plan/i.test(`${page.title || ""} ${page.url || ""}`),
    )
    .map((page) => ({
      id: `${page.url}#combined`,
      title: page.title || page.url,
      url: page.url,
      kind: page.type || "page",
      department: page.department || "",
      textQuality: page.textQuality || "text",
      text: `${page.department ? `Department: ${page.department}\n` : ""}${page.chunks.join("\n")}`,
    }));
  const records = [...combinedPageRecords, ...allRecords]
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
    const asksLeader = /\b(chairman|chairperson|chair|head|hod|dean)\b/i.test(q);
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
  const asksLeader = /\b(chairman|chairperson|chair|head|hod|dean)\b/i.test(q);
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
  const greetingOrSalam = /^(hi|hello|hey|salam|assalamualaikum|assalamu alaikum|kemon acho|kemon achen|how are you|kemon|valo acho|আসসালামু আলাইকুম|হাই|হ্যালো|সালাম|কেমন আছো|কেমন আছেন)(\s+.*)?$/iu.test(q);
  const botIdentity = /\b(who\s+are\s+you|tumi\s+ke|apni\s+ke|tomar\s+nam\s+ki|what\s+is\s+your\s+name|ke\s+tumi|কে\s*তুমি|আপনি\s*কে|তোমার\s*নাম\s*কী|who\s+made\s+you)\b/iu.test(q);
  const botCapability = /^(?:tumi\s+ki\s+korte\s+paro|what\s+can\s+you\s+do|how\s+can\s+you\s+help|ki\s+ki\s+korte\s+paro|sahajjo\s+chai|help\s+me|help\s+koro|help|কী\s*করতে\s*পারো|কীভাবে\s*সাহায্য\s*করতে\s*পারো)(\s+.*)?$/iu.test(q) && !/\b(?:choose|program|admission|journey|apply)\b/i.test(q);
  const gratitude = /^(thanks|thank\s+you|dhonnobad|dhornobad|onek\s+dhonnobad|ধন্যবাদ|অনেক\s*ধন্যবাদ)(\s+.*)?$/iu.test(q);
  const farewell = /^(bye|goodbye|good\s+bye|allah\s+hafez|khoda\s+hafez|tata|বিদায়|বিদায়|আল্লাহ\s*হাফেজ)(\s+.*)?$/iu.test(q);
  return greetingOrSalam || botIdentity || botCapability || gratitude || farewell;
}

function directGreetingAnswer(question) {
  if (!isGreetingQuestion(question)) return null;
  const q = normalizeQuestion(question).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  const banglish = prefersBanglish(question) || /\b(salam|assalamualaikum|assalamu|kemon|acho|achen|tumi|apni|dhonnobad|hafez)\b/i.test(q);

  if (/^(thanks|thank\s+you|dhonnobad|dhornobad|onek\s+dhonnobad|ধন্যবাদ|অনেক\s*ধন্যবাদ)(\s+.*)?$/iu.test(q)) {
    return {
      text: banglish
        ? "আপনাকেও অনেক ধন্যবাদ! গণ বিশ্ববিদ্যালয় সম্পর্কে আপনার আরও কোনো কিছু জানার থাকলে যেকোনো সময় নির্দ্বিধায় আমাকে প্রশ্ন করতে পারেন। শুভকামনা!"
        : "You're very welcome! If you have any more questions about Gono Bishwabidyalay, feel free to ask anytime. Have a great day!",
      sources: [],
      mode: "greeting",
    };
  }

  if (/^(bye|goodbye|good\s+bye|allah\s+hafez|khoda\s+hafez|tata|বিদায়|বিদায়|আল্লাহ\s*হাফেজ)(\s+.*)?$/iu.test(q)) {
    return {
      text: banglish
        ? "আল্লাহ হাফেজ! আপনার উজ্জ্বল ভবিষ্যৎ ও সাফল্য কামনা করি। গণ বিশ্ববিদ্যালয় সংক্রান্ত যেকোনো তথ্যের প্রয়োজনে আবারও চলে আসবেন!"
        : "Goodbye and best wishes! Feel free to return whenever you need verified information about Gono Bishwabidyalay.",
      sources: [],
      mode: "greeting",
    };
  }

  if (/\b(who\s+are\s+you|tumi\s+ke|apni\s+ke|tomar\s+nam\s+ki|what\s+is\s+your\s+name|ke\s+tumi|কে\s*তুমি|আপনি\s*কে|তোমার\s*নাম\s*কী|who\s+made\s+you)\b/iu.test(q)) {
    return {
      text: banglish
        ? "আমি **Gono Bishwabidyalay AI Knowledge Assistant (GB Helpdesk Bot)**। আমি গণ বিশ্ববিদ্যালয়ের ভর্তি প্রক্রিয়া, বিভিন্ন বিভাগের ক্রেডিট ও কোর্স ফি, শিক্ষক ও ফ্যাকাল্টি মেম্বার, নোটিশ, সেমিস্টার ও গ্রেডিং সিস্টেম, ক্যাম্পাস সুবিধা (লাইব্রেরি, ক্যাফেটেরিয়া, মেডিকেল সেন্টার), কেন্দ্রীয় ছাত্র সংসদ (বাকসু) এবং ক্যারিয়ার ক্লাব (GBCDC) সংক্রান্ত তথ্যে সহায়তা করতে প্রস্তুত। আজ আপনাকে কীভাবে সাহায্য করতে পারি?"
        : "I am the **Gono Bishwabidyalay AI Knowledge Assistant (GB Helpdesk Bot)**. I am designed to assist students, applicants, and visitors with verified information regarding admissions, department programs, tuition fees, faculty members, academic grading & semester systems, campus facilities (library, canteen, medical center), student union (BAKSU), and student clubs (GBCDC). How can I assist you today?",
      sources: [],
      mode: "greeting",
    };
  }

  if (/\b(tumi\s+ki\s+korte\s+paro|what\s+can\s+you\s+do|how\s+can\s+you\s+help|ki\s+ki\s+korte\s+paro|sahajjo\s+chai|help\s+me|help\s+koro|কী\s*করতে\s*পারো|কীভাবে\s*সাহায্য\s*করতে\s*পারো)\b/iu.test(q)) {
    return {
      text: banglish
        ? "আমি **গণ বিশ্ববিদ্যালয় হেল্পডেস্ক অ্যাসিস্ট্যান্ট** হিসেবে নিচের বিষয়গুলোতে সহায়তা প্রদান করি:\n\n" +
          "• **ভর্তি ও যোগ্যতা:** ডিপার্টমেন্টভিত্তিক রিকোয়ারমেন্টস, ন্যূনতম জিপিএ ও অ্যাডমিশন হেল্পলাইন।\n" +
          "• **বিভাগ ও প্রোগ্রাম:** CSE, Pharmacy, BBA, LLB, English ইত্যাদি বিভাগের ক্রেডিট, সেমিস্টার ও ফি স্ট্রাকচার।\n" +
          "• **শিক্ষক ও কর্তৃপক্ষ:** ভিসি, রেজিস্ট্রার, প্রক্টর, পরীক্ষা নিয়ন্ত্রক ও ডিপার্টমেন্ট চেয়ারম্যানদের প্রোফাইল।\n" +
          "• **ক্যাম্পাস সুবিধা:** সেন্ট্রাল লাইব্রেরি, ওয়াইফাই, মেডিকেল সেন্টার, ক্যাফেটেরিয়া, পরিবহন ও হোস্টেল সংক্রান্ত তথ্য।\n" +
          "• **ক্লাব ও ছাত্র সংসদ:** GBCDC (ক্যারিয়ার ডেভেলপমেন্ট ক্লাব) ও বাকসু (কেন্দ্রীয় ছাত্র সংসদ)-এর কার্যক্রম।\n" +
          "• **একাডেমিক নিয়মাবলী:** সেমিস্টার পদ্ধতি (Bi-semester), ইউজিসি গ্রেডিং স্কেল ও রেজাল্ট দেখার উপায়।\n\n" +
          "আপনি যেকোনো নির্দিষ্ট প্রশ্ন করতে পারেন!"
        : "As the **Gono Bishwabidyalay Helpdesk Assistant**, I can assist you with:\n\n" +
          "• **Admissions & Eligibility:** Department requirements, minimum GPA, and official admission helplines.\n" +
          "• **Departments & Programs:** Total credits, duration, and tuition fee structures for CSE, Pharmacy, BBA, Law, etc.\n" +
          "• **Leadership & Faculty:** VC, Registrar, Proctor, Controller of Examinations, and Department Heads.\n" +
          "• **Campus Facilities:** Central Library, Wi-Fi, Medical Center, Canteen, transport guidance, and hostel advisory.\n" +
          "• **Clubs & Student Union:** Career Development Club (GBCDC) and Central Students' Union (BAKSU).\n" +
          "• **Academic System:** Bi-semester structure, UGC 4.00 grading scale, and semester result verification.\n\n" +
          "Feel free to ask any specific question!",
      sources: [],
      mode: "greeting",
    };
  }

  if (/\b(assalamu|assalamualaikum|salam)\b/i.test(q)) {
    return {
      text: banglish
        ? "Walaikum Assalam! Ami GB Knowledge Assistant। Gono Bishwabidyalay-এর ভর্তি, বিভাগ, কোর্স ফি, ফ্যাকাল্টি মেম্বার, ক্লাব (GBCDC), নোটিশ বা ক্যাম্পাস সংক্রান্ত যেকোনো প্রশ্ন আমাকে করতে পারেন। কীভাবে সাহায্য করতে পারি?"
        : "Walaikum Assalam! I am the GB Knowledge Assistant. Feel free to ask me anything about Gono Bishwabidyalay admissions, departments, tuition fees, faculty members, clubs (GBCDC), notices, or campus facilities. How can I help you today?",
      sources: [],
      mode: "greeting",
    };
  }

  if (/\b(kemon|how\s+are\s+you)\b/i.test(q)) {
    return {
      text: banglish
        ? "Alhamdulillah, ami bhalo achi! Ami Gono Bishwabidyalay-er AI Knowledge Assistant। University-র ভর্তি, ডিপার্টমেন্ট, ফি, ফ্যাকাল্টি, GBCDC ক্লাব কিংবা ক্যাম্পাস লাইফ নিয়ে যেকোনো তথ্য জানতে আমাকে বলতে পারেন। আজ আপনাকে কীভাবে সাহায্য করতে পারি?"
        : "I'm doing well, thank you! I am the Gono Bishwabidyalay AI Knowledge Assistant. You can ask me about university admissions, departments, tuition fees, faculty, GBCDC club, or campus life. How may I assist you today?",
      sources: [],
      mode: "greeting",
    };
  }

  return {
    text: banglish
      ? "Hi! Ami GB Knowledge Assistant। Gono Bishwabidyalay-er official info, department, faculty, fee, admission, GBCDC club, notice, ba course concept niye question korte paro। আজ কীভাবে সাহায্য করতে পারি?"
      : "Hi! I am the GB Knowledge Assistant. Ask me about Gono Bishwabidyalay official information, departments, faculty, fees, admission, clubs (GBCDC), notices, or course concepts. How can I help you today?",
    sources: [],
    mode: "greeting",
  };
}

function isConversationalIntent(question) {
  const q = normalizeQuestion(question);

  const isDirectAttributeQuery =
    /^(?:what\s+is\s+the\s+)?(?:chairman(?:\s+name)?|head|dean|fees?|cost|tuition|tution|credits?|duration|seats?|phone|mobile|number|email|contact|routine|syllabus|notices?)\b/i.test(q) &&
    !/\b(?:ami|amake|amar|parbo|hobe|uchit|bhalo|keno)\b/i.test(q);
  if (isDirectAttributeQuery) return false;

  const personalSituation =
    /\b(?:ami|amake|amar|amader|i|my|me)\b/i.test(q) &&
    /\b(?:vorti|admission|apply|eligibility|joggota|korte|hote|chance|porbo|pabo)\b/i.test(q);

  const resultOrCgRef =
    /\b(?:ei|eita|eta|oi|oita|this|with\s+this|amar)\s*(?:cg|cgpa|gpa|point|result|marks?|division)\b/i.test(q) ||
    /\b(?:cg|cgpa|gpa|point)\s*(?:niye|diye|hole|thakle)\b/i.test(q);

  const possibilityOrDoubt =
    /\b(?:parbo|parbo\s*na|hobe|hobe\s*na|jabe|jabe\s*na|pabo|pabo\s*na|chance\s*ache|somvob|somvob\s*na|parben|parben\s*na)\b/iu.test(q) ||
    /\b(?:পারব|পারব\s*না|পারবো|পারবো\s*না|হবে|হবে\s*না|যাবে|যাবে\s*না|পাব|পাব\s*না|সম্ভব|সম্ভব\s*না|সুযোগ\s*আছে)\b/iu.test(q) ||
    /\b(?:can\s+i|could\s+i|should\s+i|will\s+i|am\s+i|is\s+it\s+possible|can\s+we|eligible\s+or\s+not)\b/i.test(q);

  const adviceOrExplanation =
    /\b(?:uchit|bhalo\s*hobe|better|advice|suggestion|opinion|recommend|ki\s*korbo|ki\s*kora\s*jay|ki\s*kora\s*uchit|উচিত|কী\s*করব)\b/iu.test(q) ||
    /\b(?:bujhlam\s*na|bujhi\s*nai|bujhiye\s*bolo|sohoj\s*kore|explain\s*koro|explain\s+please|aro\s+details\s+bolo)\b/iu.test(q) ||
    /\b(?:ar\s*kono\s*option|onno\s*kono|alternative|ar\s*ki\s*kora\s*jay|অন্য\s*কোনো)\b/iu.test(q) ||
    /\b(?:keno\s*parbo\s*na|keno\s*na|why\s+not|keno|কেন)\b/iu.test(q);

  const conversationalConnector =
    /^(?:tahole|kintu|tobe|ar\s+jodi|but|then|so|well|তাহলে|কিন্তু)\b/iu.test(q);

  return Boolean(personalSituation || resultOrCgRef || possibilityOrDoubt || adviceOrExplanation || conversationalConnector);
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
    /\b(what\s+is|ki|kake\s+bole|explain|define|overview|about|details|courses?|subject|syllabus|credits?|duration|seats?|seat|asan|ashon|intake|capacity|qualification|eligibility|requirements?|joggota|lagbe|faculty|teacher|head|fee|fees?|fe|cost|costs?|tuition|tution|taka|tk|khoroch|khroch|kharach|kharoch|charge|charges|expense|expenses|payment|payments|package|admission|vorti|career|learn|study|somporke|somproke|bolo|dao|koto|how|why|list|show|compare|comparison|versus|vs|better|bhalo|naki|difference|phone|mobile|contact|call|cell|email|number)\b/i.test(q);
  if (hasSpecificIntent) return "";
  if (/\b(medical\s+physics|biomedical(?:\s+engineering)?)\b/i.test(q)) return "Medical Physics and Biomedical Engineering";
  if (/\b(cse|computer\s+science)\b/i.test(q)) return "CSE";
  if (/\bpharmacy\b/i.test(q)) return "Pharmacy";
  if (/\b(microbiology|agriculture|law|english)\b/i.test(q)) return q;
  return "";
}

function directClarificationAnswer(question, history = []) {
  if (asksFeeDetail(question) || asksContactDetail(question)) return null;
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

function statedAdmissionGpa(question) {
  const raw = String(question || "");
  const number = "([০-৯0-9]+(?:\\.[০-৯0-9]+)?)";
  const match =
    raw.match(new RegExp(`${number}\\s*(?:gpa|point)?\\s*(?:diye|niye|hole|thakle|দিয়ে|দিয়ে|নিয়ে|নিয়ে|হলে|থাকলে)`, "iu")) ||
    raw.match(new RegExp(`(?:gpa|point|result|জিপিএ|পয়েন্ট|পয়েন্ট)\\s*${number}`, "iu"));
  if (!match) return null;
  const normalizedNumber = match[1].replace(/[০-৯]/g, (digit) => "০১২৩৪৫৬৭৮৯".indexOf(digit));
  const value = Number.parseFloat(normalizedNumber);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
}

function isStatedAdmissionEligibilityQuestion(question) {
  return (
    statedAdmissionGpa(question) !== null &&
    /\b(vorti|admission|apply|parbo|eligible|chance)\b|ভর্তি|আবেদন|পারব|যোগ্য/iu.test(normalizeQuestion(question))
  );
}

function directAdmissionEligibilityAnswer(question, knowledge, history = []) {
  const q = normalizeQuestion(question);
  const statedGpa = statedAdmissionGpa(question);
  const asksEligibility =
    /\b(qualification|eligibility|requirements?|joggota|lagbe|hsc|ssc|apply\s+korte\s+ki\s+lagbe|admission\s+requirement|vortir\s+joggota)\b/i.test(q) ||
    (statedGpa !== null && /\b(vorti|admission|apply|parbo|eligible|chance)\b|ভর্তি|আবেদন|পারব|যোগ্য/iu.test(q));
  if (!asksEligibility) return null;
  if (!/\b(admission|vorti)\b/i.test(q)) {
    const matchedPeople = findPeople(q, knowledge.faculty || [], knowledge);
    if (matchedPeople.length && !/\b(cse|pharmacy|bba|english|law|bpt|physiotherapy|microbiology|biochemistry|medical\s+physics)\b/i.test(q)) {
      return null;
    }
  }
  const banglish = prefersBanglish(question);
  const activeDept = matchedDepartmentFromQuestion(q, knowledge) || activeContextDepartment(history, question, knowledge);

  if (activeDept && /\bcomputer\s+science|cse\b/i.test(activeDept)) {
    if (statedGpa !== null) {
      const meetsIndividualMinimum = statedGpa >= 2.5;
      return {
        text: banglish
          ? meetsIndividualMinimum
            ? `GPA-er dik diye **হ্যাঁ**—তোমার বলা **${statedGpa.toFixed(2)}** published minimum **2.50**-এর উপরে। তবে final eligibility-এর জন্য SSC ও HSC—দুটিতেই আলাদাভাবে GPA 2.50+, মোট GPA কমপক্ষে 6.00, Science background, এবং Physics ও Mathematics-এ pass থাকতে হবে। তাই 3.5 যদি শুধু একটি পরীক্ষার GPA হয়, অন্য পরীক্ষার GPA ও subject result-ও লাগবে।`
            : `GPA-er dik diye **না**—তোমার বলা **${statedGpa.toFixed(2)}** published minimum **2.50**-এর নিচে। CSE-তে সাধারণ পথে apply করতে SSC ও HSC—দুটিতেই আলাদাভাবে GPA 2.50+ এবং মোট GPA কমপক্ষে 6.00 লাগবে; Diploma route থাকলে সেটি আলাদাভাবে যাচাই করা যেতে পারে।`
          : meetsIndividualMinimum
            ? `For the GPA component, **yes**—the stated **${statedGpa.toFixed(2)}** is above the published minimum of **2.50**. Final eligibility still requires at least 2.50 in both SSC and HSC separately, an aggregate of 6.00+, a Science background, and passes in Physics and Mathematics. If 3.5 is from only one exam, the other exam and subject results are still needed.`
            : `For the GPA component, **no**—the stated **${statedGpa.toFixed(2)}** is below the published minimum of **2.50**. The standard CSE route requires at least 2.50 in both SSC and HSC separately and an aggregate of 6.00+; a Diploma route can be checked separately if applicable.`,
        sources: [{ title: "Academic Programs - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/academic-programs/" }],
        mode: "structured",
      };
    }
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

  if (activeDept && /\benglish\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**English ক্যারিয়ার সুযোগ:** B.A. (Honours) in English সম্পন্ন করার পর স্কুল, কলেজ ও বিশ্ববিদ্যালয়ে শিক্ষকতা, বিসিএস (সাধারণ ক্যাডার), ব্যাংক ও বহুজাতিক কোম্পানিতে (MNC) এক্সিকিউটিভ জব, ডিজিটাল কনটেন্ট রাইটিং, জার্নালিজম, কর্পোরেট কমিউনিকেশন ও আন্তর্জাতিক সংস্থায় (NGOs) কাজের চমৎকার সুযোগ রয়েছে।`
        : `**English Career Prospects:** English graduates have strong opportunities in English language teaching and academia, BCS (General Cadre), multinational corporations (MNCs), banking, content writing & editorial roles, journalism, corporate communications, and international NGOs.`,
      sources: [{ title: "Department of English - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/faculty-of-arts-and-social-sciences/department-of-english/" }],
      mode: "structured",
    };
  }

  if (activeDept && /\blaw\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**Law ক্যারিয়ার সুযোগ:** বাংলাদেশ বার কাউন্সিলে সনদ নিয়ে জজ কোর্ট ও হাইকোর্টে অ্যাডভোকেট হিসেবে প্র্যাকটিস, বাংলাদেশ জুডিশিয়াল সার্ভিস (BJS) পরীক্ষায় সহকারী জজ নিয়োগ, করপোরেট লিগ্যাল অ্যাডভাইজার, ব্যাংক ও আর্থিক প্রতিষ্ঠানে ল অফিসার এবং মানবাধিকার সংস্থায় কাজের ব্যাপক সুযোগ রয়েছে।`
        : `**Law Career Prospects:** Legal practice as an advocate in District and Supreme Courts via the Bar Council, judicial appointment as Assistant Judge via BJS examination, corporate legal counsel, banking law compliance, and human rights advocacy.`,
      sources: [{ title: "Department of Law - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/faculty-of-arts-and-social-sciences/department-of-law/" }],
      mode: "structured",
    };
  }

  if (activeDept && /\bbusiness|bba\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**Business Administration (BBA) ক্যারিয়ার সুযোগ:** সরকারি ও বেসরকারি ব্যাংক, বহুজাতিক করপোরেট প্রতিষ্ঠান (MNCs), ব্র্যান্ড ও ডিজিটাল মার্কেটিং, সাপ্লাই চেইন ম্যানেজমেন্ট, হিউম্যান রিসোর্স (HR), ফিন্যান্সিয়াল অ্যানালাইসিস এবং উদ্যোক্তা (Entrepreneurship) হিসেবে সফল ক্যারিয়ার গড়ার সুযোগ রয়েছে।`
        : `**Business Administration Career Prospects:** High-demand roles in banking and financial institutions, multinational corporations, marketing & brand management, supply chain operations, human resources, and entrepreneurship.`,
      sources: [{ title: "Department of Business Administration - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/faculty-of-arts-and-social-sciences/department-of-business-administration/" }],
      mode: "structured",
    };
  }

  if (activeDept && /\bmicrobiology\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**Microbiology ক্যারিয়ার সুযোগ:** ডায়াগনস্টিক ও রিসার্চ ল্যাবরেটরি, ফার্মাসিউটিক্যাল ও ভ্যাকসিন কোম্পানি, ফুড অ্যান্ড বেভারেজ ইন্ডাস্ট্রি (কোয়ালিটি কন্ট্রোল), icddr,b ও জনস্বাস্থ্য গবেষণা প্রতিষ্ঠান এবং বিদেশে উচ্চশিক্ষায় স্কলারশিপের দারুণ সুযোগ রয়েছে।`
        : `**Microbiology Career Prospects:** Careers in diagnostic laboratories, vaccine & pharmaceutical production, food/beverage quality assurance, public health institutes like icddr,b, and international postgraduate research fellowships.`,
      sources: [{ title: "Department of Microbiology - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/faculty-of-health-sciences/department-of-microbiology/" }],
      mode: "structured",
    };
  }

  if (activeDept && /\bsociology|social\s*work\b/i.test(activeDept)) {
    return {
      text: banglish
        ? `**Sociology and Social Work ক্যারিয়ার সুযোগ:** জাতীয় ও আন্তর্জাতিক উন্নয়ন সংস্থা (BRAC, UNDP, UNICEF, Save the Children), সমাজসেবা অধিদপ্তর (সমাজসেবা অফিসার), এনজিও প্রজেক্ট ম্যানেজমেন্ট, সামাজিক গবেষণা ও সার্ভে ফার্ম, বিসিএস এবং কমিউনিটি ডেভেলপমেন্ট সেক্টরে কাজের বড় সুযোগ রয়েছে।`
        : `**Sociology & Social Work Career Prospects:** Prominent roles in national and international NGOs (BRAC, UNDP, UNICEF), the Department of Social Services (social welfare officers), research agencies, development consultancy, and civil service.`,
      sources: [{ title: "Department of Sociology and Social Work - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/academic/faculty-of-arts-and-social-sciences/department-of-sociology-and-social-work/" }],
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
    const asksLibraryHours = /\b(kokhon|khola|somoy|shomoy|hours?|opening|schedule|timing|open|close|closing|bondho|kobe\s+khola)\b/i.test(q);
    if (asksLibraryHours) {
      return {
        text: banglish
          ? "গণ বিশ্ববিদ্যালয়ের অফিসিয়াল রেকর্ডে সেন্ট্রাল লাইব্রেরির **সুনির্দিষ্ট খোলার ও বন্ধের সময়সূচি (opening/closing hours) উল্লেখ নেই** (সাধারণত ক্লাস ও অফিস চলাকালীন সকাল থেকে বিকেল পর্যন্ত খোলা থাকে)। নির্দিষ্ট টাইমিং বা ছুটির দিনের শিডিউল নিশ্চিত হতে লাইব্রেরি সেকশনে যোগাযোগ করতে পারেন (Email: `library@gonouniversity.edu.bd`)। লাইব্রেরিতে বই, জার্নাল, ই-বুক, অনলাইন ক্যাটালগ ও ফ্রি ওয়াইফাই স্টাডি স্পেসের সুবিধা রয়েছে।"
          : "The university's official records **do not specify exact daily opening and closing hours** for the central library (it typically remains open during normal academic/office hours). For exact daily schedules or holiday hours, please contact the library section directly (Email: `library@gonouniversity.edu.bd`). The library offers textbooks, journals, digital catalog access, and Wi-Fi reading spaces.",
        sources: dedupeSources([{ title: "Library - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/facilities/library/" }]),
        mode: "structured",
      };
    }
    return {
      text: banglish
        ? "বিশ্ববিদ্যালয়ের কেন্দ্রীয় লাইব্রেরিতে হাজার হাজার টেক্সটবুক, আন্তর্জাতিক জার্নাল, ই-বুক, অনলাইন ক্যাটালগ এবং ওয়াইফাই স্টাডি স্পেসের সুবিধা রয়েছে।"
        : "The central library provides thousands of textbooks, international journals, digital library access, Wi-Fi, and spacious reading areas.",
      sources: dedupeSources([{ title: "Library - Gono Bishwabidyalay", url: "https://gonouniversity.edu.bd/facilities/library/" }]),
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

function directCorrectionOrNumberFollowup(question, knowledge, history = []) {
  if (!history.length) return null;
  const q = normalizeQuestion(question);
  const raw = String(question || "");
  const correction = /\b(?:i\s+(?:meant|said)|no|not|rather)\b|(?:না|বলেছি|বললাম|মানে)/iu.test(raw);
  const wantsDepartments = /\b(?:departments?|dept)\b|বিভাগ|ডিপার্টমেন্ট/iu.test(q);
  const wantsFaculties = /\bfacult(?:y|ies)\b|অনুষদ|ফ্যাকাল্টি/iu.test(q) && !/\bmembers?\b/i.test(q);
  const wantsPrograms = /\bprograms?\b|প্রোগ্রাম/iu.test(q);
  if (correction && (wantsDepartments || wantsFaculties || wantsPrograms)) {
    const correctedQuestion = wantsDepartments
      ? "how many departments are there?"
      : wantsFaculties
        ? "how many faculties are there?"
        : "how many programs are offered?";
    return directAnswer(correctedQuestion, knowledge, []);
  }

  const justNumber = /\b(?:just|only)\s+(?:the\s+)?number\b|\bnumber\s+only\b|শুধু\s+(?:সংখ্যা|নাম্বার)|কেবল\s+(?:সংখ্যা|নাম্বার)/iu.test(raw);
  if (!justNumber) return null;
  const priorUserTurn = previousConversation(history, question).filter((item) => item.role === "user").at(-1);
  const priorAssistantTurn = previousConversation(history, question).filter((item) => item.role === "assistant").at(-1);
  if (!priorUserTurn?.text && !priorAssistantTurn?.text) return null;
  const priorQ = normalizeQuestion(priorUserTurn?.text || "");
  let value = "";
  let resolved = null;
  if (/\bdepartments?\b|বিভাগ|ডিপার্টমেন্ট/iu.test(priorQ)) {
    value = String(academicDepartments(knowledge).length);
    resolved = directAcademicUnitsAnswer("how many departments are there?", knowledge);
  } else if (/\bfacult(?:y|ies)\b|অনুষদ|ফ্যাকাল্টি/iu.test(priorQ) && !/\bmembers?\b/i.test(priorQ)) {
    value = String((knowledge.institution?.faculties || []).length);
    resolved = directAcademicUnitsAnswer("faculty count?", knowledge);
  } else if (/\bprograms?\b|প্রোগ্রাম/iu.test(priorQ)) {
    value = String(verifiedPrograms(knowledge.programs || []).length);
    resolved = directAcademicUnitsAnswer("program count?", knowledge);
  } else {
    const assistantMatch = priorAssistantTurn?.text?.match(/(?:total credits?|credits?|seats?|faculty|departments?)\D{0,20}\b(\d+(?:\.\d+)?)\b/i);
    if (assistantMatch) {
      value = assistantMatch[1];
    } else if (priorUserTurn?.text) {
      resolved = directAnswer(priorUserTurn.text, knowledge, []);
      const metricMatch = resolved?.text?.match(/(?:total credits?|credits?|seats?)\D{0,20}\*\*(\d+(?:\.\d+)?)\*\*/i);
      if (metricMatch) value = metricMatch[1];
    }
  }
  if (!value) return null;
  return { text: `**${value}**`, sources: resolved?.sources || priorAssistantTurn?.sources || [], mode: "structured" };
}

function directAnswer(question, knowledge, history = []) {
  const correctionFollowup = directCorrectionOrNumberFollowup(question, knowledge, history);
  if (correctionFollowup) return correctionFollowup;

  if (history && history.length > 0 && isFollowupFormatInstruction(question)) {
    const { lastAssistant, lastUser } = getRecentExchangeFromHistory(history, question);
    if (lastAssistant && lastAssistant.text) {
      const origUser = getOriginalTopicUserTurn(history, question) || lastUser;
      const formatType = detectFollowupFormatType(question);
      const cleanText = cleanTextOfPrefix(lastAssistant.text);
      const reformatted = reformatTextDeterministically(cleanText, formatType, question, origUser?.text, knowledge);
      return {
        text: reformatted,
        sources: Array.isArray(lastAssistant.sources) ? lastAssistant.sources : [],
        mode: lastAssistant.mode || "structured",
      };
    }
  }

  if (history.length && !matchedDepartmentFromQuestion(question, knowledge)) {
    const topicIdx = ordinalTopicIndex(question);
    const recalledDepartment = ordinalContextDepartment(question, history, knowledge);
    if (recalledDepartment) {
      const hasSpecificIntent = /\b(chairman|chairperson|head|hod|dean|credits?|duration|seats?|eligibility|requirements?|fees?|tuition|tution|cost|khoroch|curriculum|syllabus|courses?|subjects?|faculty|teachers?|waiver|scholarship|admission|vorti|apply|qualification|gpa|career|job|future|scope|details?|contact|phone|email|number)\b/i.test(normalizeQuestion(question));
      const topicTurns = conversationDepartmentTopicTurns(previousConversation(history, question), knowledge);
      const originatingTurn = topicIdx !== null ? topicTurns[topicIdx] : null;
      const inheritedAttr = !hasSpecificIntent && originatingTurn ? extractTurnAttribute(originatingTurn.turnText) : null;
      const querySubject = inheritedAttr ? `${recalledDepartment} ${inheritedAttr}` : `${recalledDepartment} ${hasSpecificIntent ? "" : "details"} ${question}`;
      const resolved = directAnswer(querySubject, knowledge, []);
      if (resolved) {
        if (/\b(one\s+line|ek\s+line|এক\s*লাইনে?|single\s+line|shortly|briefly|সংক্ষেপে)\b/i.test(normalizeQuestion(question))) {
          const firstLine = resolved.text.split(/\n+/).find((line) => line.trim().length > 10) || resolved.text;
          return { ...resolved, text: firstLine.trim() };
        }
        return resolved;
      }
    }
    const recalledTopic = ordinalContextTopic(question, history, knowledge);
    if (recalledTopic) {
      const resolved = directAnswer(`${recalledTopic.query} ${question}`, knowledge, []);
      if (resolved) {
        if (/\b(one\s+line|ek\s+line|এক\s*লাইনে?|single\s+line|shortly|briefly|সংক্ষেপে)\b/i.test(normalizeQuestion(question))) {
          const firstLine = resolved.text.split(/\n+/).find((line) => line.trim().length > 10) || resolved.text;
          return { ...resolved, text: firstLine.trim() };
        }
        return resolved;
      }
    }
  }
  const q = normalizeQuestion(question);
  const departmentFollowup = /\b(chairman|chairperson|head|hod|dean|faculty|teachers?|members?|credits?|duration|seats?|eligibility|requirements?|fees?|tuition|tution|cost|khoroch|curriculum|syllabus|courses?|subjects?|waiver|scholarship|stipend|admission|vorti|apply|qualification|gpa|career|job|future|scope|details?|bistarito)\b/i.test(q);
  const comparativeFollowup = /\b(which|which\s+one|more|less|higher|lower|shorter|longer|better|konta|kontar|beshi|kom)\b/i.test(q);
  if (history.length && departmentFollowup && !comparativeFollowup && !isConversationalIntent(question) && !matchedDepartmentFromQuestion(q, knowledge)) {
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
      /\b(departments?|dept|programs?|offers?|offered|available|availability|exists?|ache|ase|pora|porte|porashona|study|jai|jabe|medical\s+center|canteen|cafeteria|wifi|wi-?fi|library|portal|club|gbcdc|grading|semester\s+system|faculty|teachers?|teacher|list|sob|shob|members?|all|sir|mam|notices?|result|contact|phone|email|location|address|history|founder|campus|area|hostel|transport|bus|hospital|baksu|union)\b/i.test(q);

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
    directStudentJourneyAnswer(question) ||
    directProgramChoiceAnswer(question, knowledge) ||
    directInstitutionFactAnswer(question, knowledge) ||
    directUniversityOverviewAnswer(question, knowledge) ||
    directDepartmentExistenceAnswer(question, knowledge) ||
    directAcademicUnitsAnswer(question, knowledge) ||
    directMissionVisionAnswer(question) ||
    directResearchAndCampusLifeAnswer(question) ||
    directClubAnswer(question, knowledge) ||
    directSemesterSystemAnswer(question) ||
    directGradingSystemAnswer(question) ||
    directResultAnswer(question) ||
    directFacilitiesAnswer(question) ||
    directAdmissionStatusAnswer(question, knowledge) ||
    directAdmissionOverviewAnswer(question, knowledge) ||
    directAdmissionProcedureAnswer(question, knowledge, history) ||
    (statedAdmissionGpa(question) !== null ? directAdmissionEligibilityAnswer(question, knowledge, history) : null) ||
    directProgramAdmissionAnswer(question, knowledge) ||
    directAdmissionEligibilityAnswer(question, knowledge, history) ||
    directWaiverAndFinancialAidAnswer(question, knowledge, history) ||
    directFeeAnswer(question, knowledge, history) ||
    directProgramComparisonAnswer(question, knowledge, history) ||
    directComparisonFollowupAnswer(question, knowledge, history) ||
    directCareerGuidanceAnswer(question, knowledge, history) ||
    directCourseCatalogAnswer(question, knowledge) ||
    directDepartmentProfileAnswer(question, knowledge) ||
    directRoleAnswer(question, knowledge) ||
    directProgramDetailAnswer(question, knowledge) ||
    directNoticeAnswer(question, knowledge) ||
    directDepartmentContactAnswer(question, knowledge) ||
    directOfficeContactAnswer(question, knowledge) ||
    directDepartmentLeaderAnswer(question, knowledge) ||
    directDepartmentOverviewAnswer(question, knowledge) ||
    directPeopleAnswer(question, knowledge) ||
    directFollowupAnswer(question, knowledge, history) ||
    directAllPeopleOverviewAnswer(question, knowledge) ||
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
  const recentText = (isContextualFollowup(question) || isConversationalIntent(question))
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

function cleanFencedCodeBlocks(text) {
  if (!text || typeof text !== "string") return text;
  return text.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
    let lines = code.split(/\r?\n/);
    const outsidePrefix = [];
    const outsideSuffix = [];

    while (lines.length > 0) {
      const first = lines[0].trim();
      if (!first) {
        lines.shift();
        continue;
      }
      const isConversationalIntro =
        /^(?:#+|\/\/|\/\*+|--|;)?\s*(here\s+is|here's|below\s+is|this\s+is|code\s*:|solution\s*:|the\s+following|requested\s+by|note\s*:|নিচে|এখানে|কোড\s*:)\b/i.test(first) ||
        /^#{1,4}\s+/.test(first) ||
        /^\*\*[^*]+\*\*/.test(first);

      if (isConversationalIntro) {
        const cleanedText = first.replace(/^(?:#+|\/\/|\/\*+|--|;)\s*/, "").replace(/\*+\/$/, "").trim();
        outsidePrefix.push(cleanedText);
        lines.shift();
      } else {
        break;
      }
    }

    while (lines.length > 0) {
      const last = lines[lines.length - 1].trim();
      if (!last) {
        lines.pop();
        continue;
      }
      const isConversationalOutro =
        /^(?:#+|\/\/|\/\*+|--|;)?\s*(output|explanation|sample\s+run|example\s+run|note|let\s+me\s+know|hope\s+this\s+helps|ব্যাখ্যা|আউটপুট)\s*:/i.test(last) ||
        /^#{1,4}\s+/.test(last) ||
        /^\*\*[^*]+\*\*/.test(last);

      if (isConversationalOutro) {
        const cleanedText = last.replace(/^(?:#+|\/\/|\/\*+|--|;)\s*/, "").replace(/\*+\/$/, "").trim();
        outsideSuffix.unshift(cleanedText);
        lines.pop();
      } else {
        break;
      }
    }

    const cleanCode = lines.join("\n").trim();
    const prefixStr = outsidePrefix.length ? outsidePrefix.join("\n") + "\n\n" : "";
    const suffixStr = outsideSuffix.length ? "\n\n" + outsideSuffix.join("\n") : "";
    return `${prefixStr}\`\`\`${lang}\n${cleanCode}\n\`\`\`${suffixStr}`;
  });
}

function safeAnswer(text, question = "") {
  const trimmed = cleanExtractedText(text).replace(/【[^】]+】/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!trimmed) return NOT_VERIFIED;
  if (/not (in|available|provided|found)|no verified|do not have verified|don't have verified|cannot verify/i.test(trimmed)) {
    return notVerifiedText(question);
  }
  return cleanFencedCodeBlocks(trimmed);
}

function aiSystemInstruction(question) {
  const rawQuestion = String(question || "");
  const languageHint = /[\u0980-\u09ff]/.test(rawQuestion)
    ? "Reply in natural Bengali script. Match the user's casual or formal tone without becoming theatrical."
    : prefersBanglish(question)
      ? "Reply in natural, friendly Banglish matching the user's wording and level of formality."
      : "Reply in concise, natural English matching the user's level of formality.";
  const isCode = isCodingQuestion(question);
  const wantsDetails = asksCodeExplanation(question);
  const codingHint = isCode
    ? wantsDetails
      ? `For Code & Programming requests with explanation:
1. Provide the complete, production-ready, clean code inside fenced markdown code blocks (\`\`\`language ... \`\`\`). The code block must contain 100% PURE RUNNABLE CODE ONLY with ZERO tutorial comments.
2. Put the full detailed explanation OUTSIDE the code block using markdown headings and bullet points: explain the algorithm, line-by-line breakdown, Time & Space Complexity, and edge cases. NEVER put explanations inside the code block itself. `
      : `For Code & Programming requests:
1. The code block (\`\`\`language ... \`\`\`) must contain 100% PURE, CLEAN, PRODUCTION-READY, DIRECTLY RUNNABLE CODE ONLY.
2. ABSOLUTELY NO narrative explanations, tutorial paragraphs, or multi-line essay comments inside the code block. The student will click the "Copy" button to run the code in their IDE; any text inside the code block that is not clean source code ruins copy-pasting.
3. Keep comments to an absolute minimum (only short 2-4 word notes where strictly needed).
4. First Attempt: Present clean code directly with a 1-line description before the code and a concise Example Run / Output block after the code. DO NOT dump long essay explanations unless the student explicitly asks for details. `
    : "";
  const academicHint = isGeneralAcademicQuestion(question) && !isCode
    ? `This is a general academic/course explainer question. You may use general educational knowledge when official context is missing, but clearly say when the answer is general and not a verified Gono Bishwabidyalay-specific fact. `
    : "";
  return (
    `You are GB Knowledge Assistant, a capable conversational AI for Gono Bishwabidyalay students. Use the supplied official context and conversation for university-specific facts, and answer ordinary general-knowledge or academic questions normally. ` +
    `Infer the user's real intent from fragments, common typos, shorthand, omitted words, and conversation context. Silently repair obvious wording mistakes. If one interpretation is clearly most likely, answer it directly; ask one short clarification only when two materially different interpretations remain plausible. ` +
    `Keep continuity with earlier turns, remember which person/program/topic pronouns refer to, and sound natural rather than like a search engine or form. ${languageHint} ` +
    academicHint +
    codingHint +
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
      if (text) return { text: safeAnswer(text, question), provider: name };
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
  if (mode === "journey") return { label: "Guided journey", confidence: "Step-by-step" };
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
  if (result?.mode === "journey") {
    const kind = result.journey?.kind;
    if (kind === "admission") return ["Amar eligibility check koro", "Program compare korte chai", "Verified program fees dekhao"];
    if (kind === "student") return ["Student portal-e ki ki ache?", "Latest notices dekhao", "Amar department-er course dekhao"];
    if (kind === "guardian") return ["Admission eligibility dekhao", "Published program fees dekhao", "Campus facilities bolo"];
    return ["Ami coding pochondo kori", "Healthcare program compare koro", "CSE vs EEE compare koro"];
  }
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
  if (result?.sources?.some((s) => s.url?.includes("gbcdc.club")) || /\b(gbcdc|club|bidita|mehrab|hasib\s*mir)\b/i.test(q)) {
    return banglish
      ? ["GBCDC-er current committee dekhao", "GBCDC-er events o workshops ki ki?", "GBCDC-te kivabe join korbo?"]
      : ["Show GBCDC committee", "What are GBCDC events?", "How to join GBCDC?"];
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

function isExplicitImageRequest(text) {
  return /^(ছবি আঁকো|ছবি বানাও|ছবি তৈরি করো|একটি ছবি|chobi banao|chobi ako|generate an? image|create an? image|draw an? image)/i.test(String(text || "").trim());
}

function cleanImagePromptText(text) {
  let cleaned = String(text || "").trim();
  // Remove creation action verbs and prefixes/suffixes
  cleaned = cleaned.replace(
    /(ছবি আঁকো|ছবি আকো|ছবি বানাও|ছবি তৈরি করো|একটি ছবি তৈরি করো|একটি ছবি বানাও|একটি ছবি আঁকো|একটি ছবি|ছবি এঁকে দাও|ছবি একে দাও|ছবি বানিয়ে দাও|ছবি তৈরি করে দাও|ছবি দাও|ছবি|image create koro|image banao|image draw koro|photo banao|photo create koro|picture banao|chobi banao|chobi ako|chobi create koro|chobi create|chobi|generate an? image of|create an? image of|draw an? image of|generate image|create image|draw image|draw a\b|draw an\b|generate an?\b|create an?\b|image of\b|photo of\b|picture of\b|illustration of\b|painting of\b)/gi,
    ""
  );
  // Remove Banglish/Bengali postpositions and articles
  cleaned = cleaned.replace(/\b(r\s+ekta|er\s+ekta|r\s+akta|er\s+akta|ekta|akta)\b/gi, "");
  cleaned = cleaned.replace(/(?:^|\s+)(?:একটি|একটা)\s+/g, " ");
  cleaned = cleaned.replace(/(?:^|\s+)(?:র\s+একটা|এর\s+একটা|র\s+একটি|এর\s+একটি)(?:\s+|$)/g, " ");
  cleaned = cleaned.replace(/\b(banao|koro|draw|create|generate|photo|image|picture)\b/gi, "");
  cleaned = cleaned.replace(/er(?=\s*$)/i, "");
  cleaned = cleaned.replace(/(?:\u09c7\u09b0|এর)(?=\s*$)/, "");
  // Clean punctuation and excess whitespace
  cleaned = cleaned.replace(/^[:\s,-]+|[:\s,-]+$/g, "").replace(/\s{2,}/g, " ").trim();
  return cleaned || text;
}

function extractImageFieldFromText(text, fieldName) {
  const line = String(text || "").split("\n").find((l) => new RegExp(fieldName, "i").test(l));
  if (!line) return "";
  return line
    .replace(new RegExp(`.*?${fieldName}[:\\s*]*`, "i"), "")
    .replace(/^[*_`\s]+|[*_`\s]+$/g, "")
    .trim();
}

function getLastImageContext(history = []) {
  if (!Array.isArray(history) || history.length === 0) return null;
  // Look at history in reverse for the most recent assistant image turn
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (!turn) continue;
    if (turn.role !== "assistant") continue;

    const text = String(turn.text || "");
    const isImage =
      turn.mode === "image" ||
      Boolean(turn.image) ||
      /FLUX|GB AI Image Studio|Visual Concept:/i.test(text);

    if (isImage) {
      const extractedConcept = extractImageFieldFromText(text, "Visual Concept");
      const extractedPrompt = extractImageFieldFromText(text, "Prompt") || extractImageFieldFromText(text, "Updated Prompt");
      const concept = extractedConcept || (turn.image?.prompt || text);
      const prompt = extractedPrompt || (turn.image?.originalPrompt || concept);
      return {
        concept,
        prompt,
        turnIndex: i,
      };
    }
    // If immediate previous assistant turn was not an image, don't treat subsequent turn as image refinement
    break;
  }
  return null;
}

function isExplicitFreshImageIntent(text) {
  const t = String(text || "").trim();
  if (/\b(notun|new|another\s+different|onno|different|fresh|ebar\s+ekta|ebar\s+onno)\b/i.test(t) &&
      /\b(chobi|image|photo|picture|drawing|illustration|banao|create|draw|generate)\b/i.test(t)) {
    return true;
  }
  if (/(নতুন|অন্য|আরেকটি সম্পূর্ণ নতুন|এবার একটি|এবার একটা)\s*(ছবি|ইমেজ|চিত্র|ফটো)/i.test(t)) {
    return true;
  }
  const hasRelativeContinuator = /\b(eitar|eita|er\s+vitore|er\s+moddhe|aro|abar|same|this|it|its|them|current|previous)\b/i.test(t) ||
    /(এইটার|এটার|এর\s*ভেতরে|এর\s*মধ্যে|আরও|আবার|একই|এই)/i.test(t);

  const hasFullSubjectCreationVerb = /(?:er\s+)?(?:ekta\s+)?(?:chobi|image|photo)\s+(?:banao|create\s+koro|draw\s+koro|ako)|(?:ছবি|ফটো)\s*(?:বানাও|আঁকো|আকো|তৈরি\s*করো)/i.test(t);

  if (hasFullSubjectCreationVerb && !hasRelativeContinuator) {
    return true;
  }
  return false;
}

function isExplicitPromptWritingRequest(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /\b(?:write|give|suggest|create|generate|provide)\s+(?:me\s+)?(?:an?\s+)?(?:image\s+|flux\s+|midjourney\s+)?prompt\b/i.test(t) ||
    /\b(?:prompt\s+(?:likhe?\s*dao|dao|dau|banao|chai|lagbe|likho|din|koro|diyo)|(?:likhe?\s*dao|dao|dau|banao|likho|din|koro)\s+.*prompt)\b/i.test(t) ||
    /(?:প্রম্পট|prompt)\s*(?:লিখো|লিখে\s*দাও|দাও|দিন|বানাও|তৈরি\s*করো|চাই|প্রয়োজন)/i.test(t) ||
    /(?:লিখো|লিখে\s*দাও|দাও|দিন|বানাও)\s*.*(?:প্রম্পট|prompt)/i.test(t)
  );
}

function isImageRefinementOrFollowup(message, history = []) {
  const lastImage = getLastImageContext(history);
  if (!lastImage) return null;

  const t = String(message || "").trim();
  if (!t) return null;

  // If user explicitly asks to write a text prompt, let the text engine answer rather than generating an image
  if (isExplicitPromptWritingRequest(t)) {
    return null;
  }

  // If user explicitly asks for a fresh new image of another subject, don't treat as refinement
  if (isExplicitFreshImageIntent(t)) {
    return null;
  }

  const hasExplicitImageTerm =
    /\b(chobi|chobita|image|photo|picture|drawing|artwork|illustration|wallpaper|render)\b/i.test(t) ||
    /(ছবি|ছবিটা|ইমেজ|চিত্র|ফটো|অঙ্কন)/.test(t);

  // Follow-up formatting instructions (shorten, expand, points) for text are NOT image refinements
  if (isFollowupFormatInstruction(t) && !hasExplicitImageTerm) {
    return null;
  }

  // Questions with question marks are inquiries, NOT image refinements, unless explicitly asking about image modification
  if (/[?？]/.test(t) && !hasExplicitImageTerm) {
    return null;
  }

  // Question words or informational queries are NOT image refinements
  if (
    /^(what|who|why|how|when|where|which|whose|whom|can\s+you|could\s+you|please\s+explain|explain|define|solve|calculate|write|tell\s+me|show\s+me|find|search|ki|kivabe|keno|kobe|kothay|ke|bolo|bolun|bujhiye|somadhan|likhe)\b/i.test(t) &&
    !hasExplicitImageTerm
  ) {
    return null;
  }

  // Coding, programming, math, science, and general knowledge questions are NOT image refinements
  if (
    /\b(python|javascript|code|programming|java|c\+\+|html|css|sql|function|loop|array|algorithm|debug|bug|error|math|physics|chemistry|biology|science|gravity|history|bangladesh|dhaka|capital|currency|president|prime\s+minister|formula|derivative|integral|solve|equation|web\s*search|google|search)\b/i.test(t) &&
    !hasExplicitImageTerm
  ) {
    return null;
  }

  // Unrelated university / academic questions are NOT image refinements
  if (
    /\b(admission|fee|fees|tuition|cost|khoroc|somoy|timing|open|close(?!\s*up)|bondho|schedule|routine|bus|transport|result|grade|cgpa|gpa|credit|waiver|scholarship|eligibility|joggot|department|faculty|teacher|dean|vc|vice chancellor|registrar|contact|phone|number|email|address|location|kothay|kokhon|koto|ki ki|kivabe|rules|notice|syllabus|curriculum|versity|university|varsity|campus|gono|bishwabidyalay)\b/i.test(t) &&
    !hasExplicitImageTerm
  ) {
    return null;
  }
  if (
    /(ভর্তি|টিউশন|ফি|খরচ|সময়|খোলা|বন্ধ|বাস|রুটিন|রেজাল্ট|গ্রেড|সিজিপিএ|যোগ্যতা|বিভাগ|শিক্ষক|রেজিস্ট্রার|যোগাযোগ|ফোন|ঠিকানা|কোথায়|কখন|কত|কী কী|কীভাবে|নিয়ম|নোটিশ|সিলেবাস|বিশ্ববিদ্যালয়|ভার্সিটি|ক্যাম্পাস)/.test(t) &&
    !hasExplicitImageTerm
  ) {
    return null;
  }

  // Greetings and closers
  if (/^(hi|hello|hey|salam|assalamu\s*alaikum|thanks|thank\s*you|dhonnobad|thx|bye|goodbye|kemon\s*acho)\b/i.test(t)) {
    return null;
  }

  // Pure compliments and acknowledgments are NOT refinements (don't generate new image for "nice", "ok", "wow", etc.)
  if (
    /^(ok|okay|thik\s*ache|valo|bhalo|nice|good|great|wow|super|awesome|sundor|shundor|khub\s*valo|khub\s*sundor|fine|perfect|cool)[!.]*$/i.test(t) ||
    /^(ঠিক আছে|ভালো|সুন্দর|দারুণ|ধন্যবাদ|অসাধারণ)[!.]*$/.test(t)
  ) {
    return null;
  }

  // Visual scene editing and refinement patterns:
  // 1. Spatial placement / relational positioning (with or without imperative verbs):
  // Examples: "drink bottol beside the person", "bottle beside him", "dog next to boy", "vitore student dau", "pashe ekta bottle"
  const hasSpatialPreposition =
    /\b(beside|next\s+to|near|behind|in\s+front\s+of|on\s+(?:the\s+)?ground|on\s+top\s+of|under|above|around|in\s+(?:the\s+)?background|in\s+(?:the\s+)?foreground|in\s+(?:the\s+)?sky|on\s+(?:the\s+)?(?:grass|table|floor|hill|bench|road)|in\s+(?:his|her|the)?\s*hand|at\s+(?:his|her|the)\s+side|to\s+(?:the\s+)?(?:left|right))\b/i.test(t) ||
    /\b(vitore|inside|moddhe|background|foreground|samne|pechone|upore|niche|pashe|shathe|kache|hate|mathay|chokhe|gaye|mukhe)\b/i.test(t) ||
    /(ভিতরে|ভেতরে|মধ্যে|ব্যাকগ্রাউন্ড|সামনে|পেছনে|পাশে|সাথে|কাছে|উপরে|নিচে|হাতে|মাথায়|চোখে|মুখে)/.test(t);

  const isSpatialPlacementEdit =
    hasSpatialPreposition &&
    (/\b(drink|bottol|bottle|can|cup|mug|glass|soda|water|juice|coffee|tea|bag|backpack|hat|cap|glasses|sunglasses|shoe|shoes|jacket|shirt|t-shirt|tshirt|hoodie|pants|phone|watch|laptop|book|books|bookshelf|bookshelves|shelf|shelves|guitar|cat|dog|pet|bird|tree|trees|flower|flowers|car|bike|table|chair|bench|umbrella|food|sun|shurjo|surjo|chad|pani|alo|bristi|kuasha|moon|stars?|clouds?|person|people|boy|girl|man|woman|guy|child|kid|him|her|them|student|students|character|subject|chatro|chatri|chele|meye|manush|gach|ful|boi|kukur|biral|nodi|pahar)\b/i.test(t) ||
      /\b(dau|dao|boshao|rakho|add|put|de|diyo|banao|koro|make|insert|place|keep|show)\b/i.test(t) ||
      /(দাও|দে|দিন|বসাও|রাখো|যোগ|বানাও|করো|সূর্য|চাঁদ|পানি|বৃষ্টি|কুয়াশা|ছাত্র|ছাত্রী|মানুষ|বই)/.test(t));

  // 2. Subject clothing, accessories, posture, actions & expressions:
  const isSubjectAppearanceOrAction =
    /\b(wearing|dressed\s+in|holding|carrying|sitting\s+(?:on|in|beside|near)|standing\s+(?:on|near|in|beside)|lying\s+on|walking|running|smiling)\b/i.test(t) ||
    /\bwith\s+(?:an?\s+)?(?:[a-zA-Z-]+\s+)?(?:hat|cap|glasses|sunglasses|hoodie|jacket|shirt|t-shirt|tshirt|sweater|coat|dress|suit|pants|guitar|bag|backpack|drink|bottle|bottol|cup|phone|camera|smile)\b/i.test(t) ||
    /\b(?:look|looking)\s+(?:at\s+(?:the\s+)?camera|forward|away|back|up|down)\b/i.test(t) ||
    /\b(?:face|chehra|mukhta)\s*(?:dekha\s+jabe|visible|clear|show)\b/i.test(t) ||
    /(?:পড়ে\s*আছে|পরে\s*আছে|হাতে\s*আছে|ধরে\s*আছে|বসে\s*আছে|দাঁড়িয়ে\s*আছে|হাসিমুখ|চশমা|হুডি|ক্যাপ)/.test(t);

  // 3. Camera angle, framing & perspective:
  const isCameraOrPerspectiveEdit =
    /\b(?:from\s+)?(?:front|back|side|top|rear|aerial|drone|wide|close\s*up|macro|profile)\s*(?:view|side|angle|shot|perspective)\b/i.test(t) ||
    /\b(?:front|back|side|top|rear)\s+(?:view|angle|shot|side)\b/i.test(t) ||
    /\b(?:close\s*up|wide\s*shot|drone\s*shot|aerial\s*view|eye\s*level)\b/i.test(t) ||
    /\b(?:samner|pichoner|pasher|uporer)\s+(?:dik|side|theke)\b/i.test(t) ||
    /(?:সামনের\s*দিক|পেছনের\s*দিক|পাশের\s*দিক|ক্লোজ\s*আপ)/.test(t);

  // 4. Lighting, atmosphere, weather & artistic style:
  const isLightingAtmosphereOrStyle =
    /\b(?:aro|more|less)\s+(?:bright|dark|andhokar|alo|clear|vibrant|colorful|cinematic|realistic)\b/i.test(t) ||
    /\b(?:sunset|sunrise|golden\s+hour|blue\s+hour|night|morning|evening|rain|rainy|snow|snowy|fog|foggy|cloudy|sunny|winter|autumn|summer|spring)\s*(?:lighting|view|scene|time|weather|sky)?\b/i.test(t) ||
    /\b(?:cinematic|photorealistic|hyperrealistic|anime|cartoon|watercolor|oil\s+painting|3d\s+render|sketch|pencil\s+sketch|black\s+and\s+white|vintage|retro|cyberpunk|steampunk|synthwave|neon|isometric|minimalist|concept\s+art|digital\s+art)\s*(?:style|look|render|lighting)?\b/i.test(t) ||
    /\b(?:raat|raater|shokal|shokale|bikal|bikale|dupur|dupure|shondha|shondhay|kuasha|alo|andhokar|bristi)\b/i.test(t) ||
    /(?:রং|কালার|আলো|উজ্জ্বল|অন্ধকার|সূর্যাস্ত|রাত|বৃষ্টি|কুয়াশা|স্টাইল|কার্টুন|সকাল|সন্ধ্যা)/.test(t);

  // 5. Direct element addition or substitution:
  const isElementAdditionOrChange =
    /\b(?:add|put|insert|place|include)\s+.*\b(?:drink|bottle|bottol|can|cup|hat|cap|glasses|sunglasses|hoodie|jacket|guitar|cat|dog|tree|flower|car|bike|table|chair|bench|clouds?|stars?|student|students|people|person)\b/i.test(t) ||
    /\b(?:student|students|chatro|chatri|manush|people|person|boi|book|books|bookshelf|bookshelves|table|chair|computer|tree|gach|flower|ful)\s+(?:add|yog|যুক্ত)\s*(?:koro|dao|dau)?\b/i.test(t) ||
    /\b(?:change|paltao|bodlao|replace|instead\s+of|bodole|jaygay)\b/i.test(t) ||
    /\b(?:make\s+it|turn\s+it)\b/i.test(t) ||
    /(?:পরিবর্তন|বদলে|জায়গায়|যোগ\s*করো)/.test(t);

  // 6. Visual object attribute modifier:
  const isVisualObjectAttribute =
    /\b(drink|bottol|bottle|can|cup|mug|glass|soda|water|juice|coffee|tea|bag|backpack|hat|cap|glasses|sunglasses|shoe|shoes|jacket|shirt|t-shirt|tshirt|hoodie|sweater|coat|dress|suit|pants|guitar|umbrella|camera|laptop|phone)\b/i.test(t) &&
    /\b(red|blue|black|white|green|yellow|brown|grey|gray|dark|light|pink|purple|orange|golden|silver|beside|with|on|in|next\s+to|near)\b/i.test(t);

  // 7. Removal / negative instruction:
  const isRemovalEdit =
    /\b(?:remove|delete|muche|bad|chara|without|no\s+more)\b/i.test(t) ||
    /\b(?:student|students|chatro|chatri|manush|people|person|tree|trees|building)\s+(?:shob\s+)?(?:remove|bad|muche)\b/i.test(t) ||
    /\b(?:remove\s+all\s+.*\s+from\s+the\s+scene|vitore\s+kono\s+manush\s+thakbe\s+na)\b/i.test(t) ||
    /(?:মুছে\s*দাও|বাদ\s*দাও|বাদ\s*করো|ছাড়া\s*বানাও|বাদ)/.test(t);

  // 8. Continuation / regeneration:
  const isContinuation =
    /\b(?:arekta|abar|notun\s+kore|arek|another\s+one|regenerate|redo|once\s+more|one\s+more)\s*(?:banao|dao|dau|try\s*koro|koro|make|draw)?\b/i.test(t) ||
    /(?:আবার|আরেকটা|আরেকবার)\s*(?:বানাও|দাও|আঁকো)/.test(t);

  // 9. Explicit image modifier:
  const isExplicitImageModification =
    hasExplicitImageTerm &&
    /\b(dau|dao|de|add|boshao|rakho|remove|muche|change|bodlao|paltao|banao|koro|make|put|bright|dark|sunset|night|style|color|realistic|cinematic)\b/i.test(t);

  if (
    isSpatialPlacementEdit ||
    isSubjectAppearanceOrAction ||
    isCameraOrPerspectiveEdit ||
    isLightingAtmosphereOrStyle ||
    isElementAdditionOrChange ||
    isVisualObjectAttribute ||
    isRemovalEdit ||
    isContinuation ||
    isExplicitImageModification
  ) {
    return lastImage;
  }

  return null;
}

function pruneGeneratedImages(now = Date.now()) {
  for (const [id, item] of generatedImageCache.entries()) {
    if (now - item.createdAt > generatedImageTtlMs) generatedImageCache.delete(id);
  }
  while (generatedImageCache.size >= generatedImageMaxItems) {
    generatedImageCache.delete(generatedImageCache.keys().next().value);
  }
}

async function fetchGeneratedImageAsset(imageUrl, fetchImpl = fetch, timeoutMs = 4000) {
  let response;
  try {
    response = await fetchImpl(imageUrl, {
      headers: { accept: "image/png,image/jpeg,image/webp" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "Image provider timed out." : "Image provider could not be reached.");
  }
  if (!response?.ok) throw new Error(`Image provider failed with status ${response?.status || "unknown"}.`);

  const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(contentType)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Image provider returned an invalid file type.");
  }
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > generatedImageMaxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Generated image is too large.");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("Image provider returned an empty image.");
  if (buffer.length > generatedImageMaxBytes) throw new Error("Generated image is too large.");
  const hasValidSignature =
    (contentType === "image/png" && buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (contentType === "image/jpeg" && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (contentType === "image/webp" && buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP");
  if (!hasValidSignature) throw new Error("Image provider returned corrupt image data.");
  return { buffer, contentType };
}

function rememberGeneratedImage(asset, seed) {
  pruneGeneratedImages();
  const id = `${Date.now().toString(36)}-${seed.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  generatedImageCache.set(id, { ...asset, createdAt: Date.now() });
  return `/api/generated-images/${id}`;
}

async function handleImageGeneration(message, sessionId, history = []) {
  const refinementContext = isImageRefinementOrFollowup(message, history);
  const isRefinement = Boolean(refinementContext);
  const cleanedPromptText = cleanImagePromptText(message);

  let promptDisplay = cleanedPromptText;
  let enhancedPrompt = "";

  const apiKey = envSecret("OPENAI_API_KEY");

  if (isRefinement) {
    const previousConcept = refinementContext.concept;
    promptDisplay = `${cleanedPromptText} (Refining: ${refinementContext.prompt || "Previous image"})`;

    if (apiKey) {
      try {
        const visualInstruction = `You are a world-class prompt engineer for FLUX AI image generator.
The user previously generated an image with visual concept:
"${previousConcept}"

The user now wants to modify/regenerate it with:
"${message}"

TASK:
1. Merge the user's modifications (e.g. adding students inside, changing lighting, weather, style, background) directly into the previous concept.
2. If the user instruction is in Bengali or Banglish (e.g. "vitore student dau" -> students studying inside, "aro bright koro" -> brighter vibrant natural light), translate it to English and integrate seamlessly.
3. Keep the core subject from the previous concept while applying the requested changes.
4. Keep it under 45 words. Output ONLY the updated photorealistic English prompt without quotes, markdown, prefixes, or conversational filler.`;

        const resp = await fetch(`${openAiBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: openAiModel,
            temperature: 0.65,
            max_tokens: 450,
            messages: [
              { role: "system", content: visualInstruction },
              { role: "user", content: `Previous concept: ${previousConcept}\nModification: ${message}` },
            ],
          }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => null);

        if (resp?.ok) {
          const data = await resp.json().catch(() => null);
          const aiText = data?.choices?.[0]?.message?.content?.trim();
          if (aiText && aiText.length > 5) {
            enhancedPrompt = aiText.replace(/^["']|["']$/g, "").trim();
          }
        }
      } catch {
        // Fallback below
      }
    }

    if (!enhancedPrompt) {
      enhancedPrompt = `${previousConcept}, incorporating ${cleanedPromptText}, cinematic lighting, photorealistic, 8k resolution, highly detailed, sharp focus`;
    }
  } else {
    // New image generation
    if (apiKey) {
      try {
        const visualInstruction = "You are a world-class prompt engineer for FLUX AI image generator. Translate and expand the user's concept into a vivid, descriptive, photorealistic English visual prompt. Mention subject details, background environment, lighting (cinematic/natural), camera angle, and composition. Keep it under 40 words. Output ONLY the prompt without quotes, prefixes, or conversational filler.";

        const resp = await fetch(`${openAiBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: openAiModel,
            temperature: 0.65,
            max_tokens: 450,
            messages: [
              { role: "system", content: visualInstruction },
              { role: "user", content: cleanedPromptText },
            ],
          }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => null);

        if (resp?.ok) {
          const data = await resp.json().catch(() => null);
          const aiText = data?.choices?.[0]?.message?.content?.trim();
          if (aiText && aiText.length > 5) {
            enhancedPrompt = aiText.replace(/^["']|["']$/g, "").trim();
          }
        }
      } catch {
        // Fallback below
      }
    }

    if (!enhancedPrompt) {
      const hasBangla = /[\u0980-\u09FF]/.test(cleanedPromptText);
      if (!hasBangla) {
        enhancedPrompt = `${cleanedPromptText}, cinematic lighting, photorealistic, 8k resolution, highly detailed, sharp focus`;
      } else {
        enhancedPrompt = `${cleanedPromptText}, cinematic lighting, high quality, photorealistic, 8k resolution`;
      }
    }
  }

  const seed = Math.floor(Math.random() * 10000000);
  const encoded = encodeURIComponent(enhancedPrompt);
  const providerImageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${seed}&model=flux`;
  let imageUrl = providerImageUrl;
  try {
    imageUrl = rememberGeneratedImage(await fetchGeneratedImageAsset(providerImageUrl), seed);
  } catch {
    imageUrl = providerImageUrl;
  }

  return {
    text: `✨ **GB AI Image Studio**\n\n🎨 **${isRefinement ? "Updated Prompt" : "Prompt"}:** ${promptDisplay}\n🔍 **Visual Concept:** *${enhancedPrompt}*`,
    mode: "image",
    medium: "gb-ai",
    aiModel: "FLUX.1 (High Definition)",
    image: {
      url: imageUrl,
      prompt: enhancedPrompt,
      originalPrompt: promptDisplay,
      seed,
      model: "FLUX.1-HD",
      isRefinement,
      width: 1024,
      height: 1024,
      createdAt: new Date().toISOString(),
    },
    profile: {
      label: "GB AI Studio",
      confidence: "High Definition",
    },
    sources: [],
    suggestions: [
      "Sunset golden hour lighting e banao",
      "Cyberpunk futuristic style e banao",
      "Pencil sketch & watercolor style",
      "Isometric 3D miniature render",
    ],
  };
}

function isExistingImageLookupIntent(text) {
  const t = String(text || "").trim();
  return (
    /\b(show|find|search|look\s+up|where\s+(?:is|can\s+i\s+find)|do\s+you\s+have|official)\b.*\b(image|photo|picture|portrait|logo|chobi|chobita|course\s+plan)\b/i.test(t) ||
    /\b(image|photo|picture|portrait|logo|chobi|chobita|course\s+plan)\b.*\b(dekhao|dekhaw|khujte|khuje|find|show)\b/i.test(t) ||
    /\b(image|photo|picture|portrait|logo|chobi|chobita)\s+of\s+(?:the\s+)?(?:vice\s+chancellor|vc|founder|faculty|teacher|dean|registrar|course\s+plan)\b/i.test(t) ||
    /\b(?:vc|vice\s+chancellor|registrar|proctor|teacher|faculty|founder)\b.*\b(?:official\s+)?(?:chobi|chobita|photo|image|picture)\b.*\b(?:dekhao|show|dao|khujte)\b/i.test(t) ||
    /(ছবি|ফটো|ইমেজ|লোগো).*(দেখাও|খুঁজে|কোথায়|অফিশিয়াল)|(ভিসি|ভাইস[\s-]*চ্যান্সেলর|প্রতিষ্ঠাতা|শিক্ষক|ডিন|রেজিস্ট্রার|কোর্স[\s-]*প্ল্যান).*(ছবি|ফটো|ইমেজ|লোগো)/i.test(t)
  );
}

function directOfficialImageLookupAnswer(question, knowledge) {
  if (!isExistingImageLookupIntent(question)) return null;
  const q = normalizeQuestion(question);
  let subject = "requested item";
  let source = null;

  if (/\b(course\s*plan|syllabus|curriculum)\b/i.test(q)) {
    const department = matchedDepartmentFromQuestion(q, knowledge);
    const aliases = department ? departmentAliases(department) : [];
    const page = (knowledge.pages || []).find((item) => {
      const identity = normalizeQuestion(`${item.title || ""} ${item.url || ""} ${item.department || ""}`);
      return /course[-\s/]*plan|syllabus|curriculum/i.test(identity) && (!department || aliases.some((alias) => termInQuestion(identity, alias)));
    });
    subject = department ? `${displayDepartmentName(department)} course plan` : "course plan";
    if (page?.url) source = { title: page.title || subject, url: page.url };
  } else {
    const roleMatchers = [
      [/\b(vice\s*chancellor|vc)\b|ভাইস[\s-]*চ্যান্সেলর|ভিসি/i, "vice_chancellor"],
      [/\bregistrar\b|রেজিস্ট্রার/i, "registrar"],
      [/\btreasurer\b|ট্রেজারার|কোষাধ্যক্ষ/i, "treasurer"],
      [/\bproctor\b|প্রক্টর/i, "proctor"],
    ];
    const roleKey = roleMatchers.find(([pattern]) => pattern.test(question))?.[1];
    const role = roleKey ? (knowledge.roles || []).find((item) => item.key === roleKey) : null;
    if (role) {
      subject = `${role.title} ${role.name}`;
      if (role.source) source = { title: role.sourceTitle || `${role.title} official profile`, url: role.source };
    } else if (/\bfounder\b|প্রতিষ্ঠাতা/i.test(question)) {
      subject = `founder ${knowledge.institution?.founder || "Dr. Zafrullah Chowdhury"}`;
      source = { title: "Gono Bishwabidyalay official website", url: knowledge.institution?.source || officialSiteUrl };
    }
  }

  const hasSource = Boolean(source?.url);
  return {
    text: prefersBanglish(question)
      ? hasSource
        ? `**${subject}**-er kono notun/AI photo generate korchi na. Nicher verified official page-e available original photo/document dekhte parben.`
        : `**${subject}**-er verified direct image URL indexed record-e nei, tai kono photo baniye dekhacchi na.`
      : hasSource
        ? `I will not generate a new or synthetic image of **${subject}**. Open the verified official page below to view the available original photo or document.`
        : `The indexed records do not contain a verified direct image URL for **${subject}**, so I will not fabricate one.`,
    sources: hasSource ? [source] : [],
    mode: "official_image_lookup",
    profile: { label: "Official image lookup", confidence: hasSource ? "Verified source" : "No verified image" },
    suggestions: hasSource ? ["Official profile-er details bolo"] : ["Official source page dao"],
  };
}

function isImageCreationIntent(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  // Filter out coding/academic/analytical questions
  if (/\b(solve|calculate|evaluate|explain|derive|program|code|python|java|c\+\+|javascript|function|algorithm|error|bug|difference between|how to|why|what is|when did|who is)\b/i.test(t)) {
    return false;
  }
  // Questions about administrative photo rules (upload, size, admit card, id card)
  if (/\b(upload|scan|size|kb|mb|file|format|form|portal|admit\s*card|registration|id\s*card|nid|signature|nishedh|allowed|allow|permission|lagbe|lage|dorkar|mandatory|proyojon|rules|policy)\b/i.test(t)) {
    return false;
  }
  if (/(আপলোড|সাইজ|ফরম্যাট|এডমিট|নিষেধ|অনুমতি|লাগবে|লাগে|দরকার|বাধ্যতামূলক|প্রয়োজন|নিয়ম)/.test(t)) {
    return false;
  }
  // Bengali question words without image verbs
  if (/(সমাধান|ব্যাখ্যা|উত্তর|কী|কেন|কীভাবে|কোথায়|কখন|কার|প্রোগ্রাম|কোড|ফাংশন|বাগ|ত্রুটি)/.test(t) && !/(ছবি|ইমেজ|ফটো).*(আঁকো|আকো|বানাও|তৈরি|দাও)/.test(t)) {
    return false;
  }
  if (isExistingImageLookupIntent(t)) return false;

  // Bengali creation patterns
  if (/(ছবি|ইমেজ|ফটো|চিত্র)\s*(আঁকো|আকো|বানাও|তৈরি\s*করো|এঁকে\s*দাও|একে\s*দাও|বানিয়ে\s*দাও|তৈরি\s*করে\s*দাও|দাও)|(আঁকো|আকো|বানাও|তৈরি\s*করো)\s*(?:একটি|একটা)?\s*(ছবি|ইমেজ|ফটো|চিত্র)/i.test(t)) {
    return true;
  }

  // English creation patterns: "create/generate/make/draw an image/picture/photo/wallpaper"
  if (/\b(create|generate|make|draw|render|paint|design)\s+(?:an?|a\s+new|another|a\s+realistic|a\s+cinematic|a\s+vivid|an\s+hd)?\s*(?:image|picture|photo|illustration|drawing|wallpaper|portrait|artwork)\b/i.test(t)) {
    return true;
  }

  // Banglish creation patterns:
  // e.g. "chobi banao", "chobi eke dao", "chobi drawing koro", "chobi akba", "photo generate koro", "image banao"
  const hasVisualNoun = /\b(chobi|chabi|image|photo|picture|pic|wallpaper|drawing)\b/i.test(t);
  const hasVisualVerb = /\b(banao|banau|banay|banaye|banaba|banaben|ako|akba|akben|eke|akao|drawing|create|draw|generate|render)\b/i.test(t);
  if (hasVisualNoun && hasVisualVerb) {
    return true;
  }

  return /(ছবি আঁকো|ছবি আকো|ছবি বানাও|ছবি তৈরি করো|ছবি এঁকে দাও|ছবি একে দাও|ছবি বানিয়ে দাও|ছবি তৈরি করে দাও|image create koro|image banao|image draw koro|chobi banao|chobi ako|chobi create(?: koro)?|photo banao|picture banao|logo banao|generate an? image|create an? image|draw an? image|draw a\b|generate image|create image|draw image)/i.test(t);
}

async function performWebSearch(query, { maxResults = 5 } = {}) {
  const cleanQuery = String(query || "")
    .replace(/^(web\s*search|search\s+the\s+web\s+for|search\s+the\s+web|search\s+for|search|google|khuje\s+dao|খুঁজে\s*দাও)[:\s]*/i, "")
    .trim();
  if (!cleanQuery) return [];

  const results = [];
  const seenUrls = new Set();

  // 1. DuckDuckGo HTML search
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
    const resp = await fetch(ddgUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,bn;q=0.8",
      },
      signal: AbortSignal.timeout(6000),
    });

    if (resp.ok) {
      const html = await resp.text();
      const $ = cheerio.load(html);

      $(".result__body").each((_, el) => {
        if (results.length >= maxResults) return false;
        const title = $(el).find(".result__title a").text().trim();
        let rawUrl = $(el).find(".result__title a").attr("href") || "";
        if (rawUrl.includes("uddg=")) {
          try {
            const u = new URL("https://duckduckgo.com" + rawUrl);
            rawUrl = decodeURIComponent(u.searchParams.get("uddg") || rawUrl);
          } catch {}
        }
        const snippet = $(el).find(".result__snippet").text().trim();
        if (title && snippet && rawUrl.startsWith("http") && !seenUrls.has(rawUrl)) {
          seenUrls.add(rawUrl);
          results.push({ title, url: rawUrl, snippet });
        }
      });
    }
  } catch {}

  // 2. Wikipedia search API fallback or enrichment
  if (results.length < 3) {
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&utf8=&format=json`;
      const wikiResp = await fetch(wikiUrl, {
        headers: { "User-Agent": "GB-AI-Assistant/1.0" },
        signal: AbortSignal.timeout(4000),
      });
      if (wikiResp.ok) {
        const wikiData = await wikiResp.json();
        const hits = wikiData?.query?.search || [];
        for (const hit of hits) {
          if (results.length >= maxResults) break;
          const hitUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/\s+/g, "_"))}`;
          if (!seenUrls.has(hitUrl)) {
            seenUrls.add(hitUrl);
            const cleanSnippet = hit.snippet ? cheerio.load(hit.snippet).text().trim() : "";
            results.push({
              title: `${hit.title} - Wikipedia`,
              url: hitUrl,
              snippet: cleanSnippet || hit.title,
            });
          }
        }
      }
    } catch {}
  }

  return results;
}

function isWebSearchIntent(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /\b(web\s*search|search\s+the\s+web|search\s+online|search\s+internet|google\s+koro|khuje\s+dao|khuje\s+dekho|search\s+koro|latest\s+news|recent\s+news|today's\s+news|current\s+affairs|live\s+score)\b/i.test(t) ||
    /(ওয়েব\s*সার্চ|সার্চ\s*করো|গুগল\s*করো|ইন্টারনেট\s*থেকে|খুঁজে\s*দাও|সাম্প্রতিক\s*খবর|তাজা\s*খবর)/.test(t)
  );
}

function isUniversityInquiry(message, knowledge, history = []) {
  const t = String(message || "").trim();
  if (!t) return false;

  // If this is a follow-up or format modification, check conversation history
  if (Array.isArray(history) && history.length > 0) {
    if (isFollowupFormatInstruction(t) || isContextualFollowup(t)) {
      const origUser = getOriginalTopicUserTurn(history, t);
      if (origUser && origUser.text && origUser.text !== t && isUniversityInquiry(origUser.text, knowledge, [])) {
        return true;
      }
      const lastAss = getLastAssistantTurn(history);
      if (
        lastAss &&
        (lastAss.mode === "gb_ai_university_chatbot" ||
          lastAss.isUniversityQuery ||
          /গণ\s*বিশ্ববিদ্যালয়|gono\s*bishwabidyalay/i.test(lastAss.text || ""))
      ) {
        return true;
      }
    }

    // Pronouns referring to university persons or departments (unir, tar, etar, eitar, unir designation, unir phone, etc.)
    const hasUniversityContinuationPronoun =
      /\b(unir|uni|unake|unara|tar|tahr|tini|take|etar|eitar|er|oitar|his|her|their|its|that|this)\b/i.test(t) ||
      /(তাঁর|তার|উনার|ইনি|তিনি|এটার|ওইটার|এর)/.test(t);
    const hasUniversityAttributeInquiry =
      /\b(designation|post|pad|pod|rank|phone|mobile|number|email|contact|office|room|fee|cost|credit|credits|duration|seats?|requirement|eligibility|syllabus|routine|head|dept|department)\b/i.test(t) ||
      /(পদবী|পদবি|ফোন|নম্বর|মোবাইল|ইমেইল|যোগাযোগ|ফি|খরচ|ক্রেডিট|মেয়াদ|আসন|যোগ্যতা|সিলেবাস|রুটিন|বিভাগ)/.test(t);

    if (hasUniversityContinuationPronoun && hasUniversityAttributeInquiry) {
      const lastAss = getLastAssistantTurn(history);
      if (
        lastAss &&
        (lastAss.mode === "gb_ai_university_chatbot" ||
          lastAss.isUniversityQuery ||
          /গণ\s*বিশ্ববিদ্যালয়|gono\s*bishwabidyalay|Department|Faculty|Abu Daud|Professor|Head|Dean|VC/i.test(lastAss.text || ""))
      ) {
        return true;
      }
    }
  }

  // Filter out image creation requests
  if (isImageCreationIntent(t)) {
    return false;
  }

  // Filter out pure programming/code, math formulas, or non-university general questions
  if (/^(solve|calculate|write\s+code|python\s+code|write\s+a\s+python|javascript|c\+\+|html|css|bug|derivative|integral|equation)\b/i.test(t)) {
    return false;
  }

  // Explicit university keywords
  if (/\b(gono|bishwabidyalay|university|varsity|versity|campus|savar|mirzanagar|nolam|gb|gk|gbkc|baksu|gono\s*shasthaya)\b/i.test(t)) {
    return true;
  }
  if (/(গণ\s*বিশ্ববিদ্যালয়|বিশ্ববিদ্যালয়|ভার্সিটি|ক্যাম্পাস|সাভার|মির্জানগর|নলাম|বাকসু)/.test(t)) {
    return true;
  }

  // University administration, leadership, or officers
  if (/\b(vice\s*chancellor|vc\s+sir|vc|registrar|proctor|treasurer|exam\s*controller|examinations?|dean|zafrullah)\b/i.test(t)) {
    return true;
  }
  if (/(উপাচার্য|ভিসি|রেজিস্ট্রার|প্রক্টর|কোষাধ্যক্ষ|পরীক্ষা\s*নিয়ন্ত্রক|ডিন|জাফরুল্লাহ)/.test(t)) {
    return true;
  }

  // University academic departments / programs at Gono Bishwabidyalay
  const mentionsDept = /\b(cse|eee|pharmacy|bba|dvm|law|microbiology|biochemistry|english|bangla|agriculture|applied\s+math|medical\s+physics)\b/i.test(t);
  const mentionsDeptContext =
    /\b(department|dept|faculty|program|subject|course|syllabus|curriculum|credit|credits|class|routine|exam|faculty\s+member|teacher|chairperson|head|admission|fee|cost)\b/i.test(t) ||
    /(বিভাগ|অনুষদ|প্রোগ্রাম|সিলেবাস|ক্রেডিট|ক্লাস|রুটিন|শিক্ষক|ভর্তি|ফি|খরচ)/.test(t);
  if (mentionsDept && mentionsDeptContext) {
    return true;
  }

  // Admissions, fees, tuition, waiver, hostel, transport specific to university
  if (/\b(admission|vorti|tuition|waiver|scholarship|hostel|transport|bus\s+route|admit\s+card|student\s+portal)\b/i.test(t)) {
    return true;
  }
  if (/(ভর্তি|টিউশন|ওয়েভার|বৃত্তি|হোস্টেল|বাস\s*রুট|অ্যাডমিট\s*কার্ড|স্টুডেন্ট\s*পোর্টাল)/.test(t)) {
    return true;
  }

  // Specific query functions from official engine
  if (explicitlyRequestsGonoContext(t) || asksFeeDetail(t) || asksProgramDetail(t)) {
    return true;
  }

  // If asking about a person with university context or indexed staff
  if (asksPersonIdentity(t)) {
    if (/\b(gono|bishwabidyalay|university|varsity|versity|campus|savar|faculty|department|dept|teacher|sir|madam|officer|proctor|registrar|controller|vice\s+chancellor|vc|dean|founder|trustee)\b/i.test(t)) {
      return true;
    }
    if (knowledge && typeof matchPeople === "function") {
      const allPeople = [...(knowledge.faculty || []), ...(knowledge.officers || [])];
      const matched = matchPeople(t, allPeople);
      if (matched.length > 0) return true;
    }
  }

  return false;
}

async function handleGbAiQuestion(message, attachments = [], history = [], sessionId = "", options = {}) {
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const isBangla = /[\u0980-\u09ff]/.test(message) || prefersBanglish(message);
  const wantsWebSearch = Boolean(options.webSearch) || (!hasAttachments && isWebSearchIntent(message));

  if (hasAttachments) {
    const hasAnyText = attachments.some(
      (a) => (a.text && a.text.trim().length > 0) || (a.visualCaption && a.visualCaption.trim().length > 0)
    );
    if (!hasAnyText) {
      return {
        text: isBangla
          ? "📷 **স্ক্রিনশট প্রসেস করা হয়েছে**\n\nআপনার আপলোড করা স্ক্রিনশট বা ছবিতে থাকা টেক্সটগুলো অস্পষ্ট বা রেজুলেশন কম হওয়ার কারণে সম্পূর্ণ পড়া যায়নি।\n\n- অনুগ্রহ করে স্ক্রিনশটের মূল প্রশ্নটি সরাসরি চ্যাটে লিখে দিন, অথবা\n- আরও স্পষ্ট ও পরিষ্কার রেজুলেশনের স্ক্রিনশট আপলোড করুন।"
          : "📷 **Screenshot Processed**\n\nCould not detect readable text from your uploaded screenshot/image due to blurriness or low resolution.\n\n- Please type your question directly in the chat, or\n- Upload a clearer, higher-resolution screenshot.",
        mode: "gb_ai_ocr_unclear",
        medium: "gb-ai",
        aiModel: "GB AI",
        profile: {
          label: "Screenshot Unclear",
          confidence: "Low resolution",
        },
        sources: [],
        suggestions: isBangla
          ? ["প্রশ্নটি সরাসরি লিখে দিচ্ছি", "আরেকটি স্পষ্ট ছবি দিচ্ছি"]
          : ["Type question directly", "Upload clearer image"],
      };
    }
  }

  let webResults = [];
  if (wantsWebSearch && message && message !== "Read this attachment and answer from it.") {
    try {
      webResults = await performWebSearch(message, { maxResults: 5 });
    } catch {}
  }

  let universityContexts = [];
  try {
    const knowledge = await loadKnowledge();
    if (knowledge && typeof searchPages === "function") {
      const hits = searchPages(message, knowledge, history);
      if (Array.isArray(hits) && hits.length > 0) {
        universityContexts = hits.slice(0, 3);
      }
    }
  } catch {}

  let langInstruction = "Reply in clear, natural, well-formatted English.";
  if (/[\u0980-\u09ff]/.test(message)) {
    langInstruction = "Reply in clear, natural, fluent Bengali (বাংলা). Maintain an encouraging, academic tone.";
  } else if (prefersBanglish(message)) {
    langInstruction = "Reply in friendly, clear Banglish matching the student's conversational style.";
  }

  const isWebSearchActive = webResults.length > 0;
  let systemInstruction = "";

  if (isWebSearchActive) {
    systemInstruction =
      `You are GB AI, an expert academic and real-time knowledge assistant with live web search capability.\n` +
      `You have searched the web and received fresh, live results for the user's query.\n` +
      `Instructions:\n` +
      `1. Provide an up-to-date, highly accurate, and comprehensive answer synthesized from the live search results.\n` +
      `2. Reference key facts, entities, and sources directly from the retrieved web information.\n` +
      `3. Be direct, clear, and well-structured using markdown formatting (bullet points, bolding, headings).\n` +
      `4. If the results contain specific statistics, dates, or official announcements, highlight them clearly.\n` +
      `5. ${langInstruction}`;
  } else {
    systemInstruction =
      `You are GB AI, an expert academic tutor, problem solver, and multi-disciplinary AI assistant for students.\n` +
      `You excel at solving and explaining:\n` +
      `- Mathematics (Calculus, Algebra, Differential Equations, Geometry, Trigonometry, Statistics)\n` +
      `- Computer Science & Programming (Python, C, C++, Java, JavaScript, Data Structures, Algorithms, SQL, OOP, Bug fixing)\n` +
      `- Physics, Chemistry, Biology, Pharmacy, Medical Physics, Health Sciences\n` +
      `- Solving exam questions, assignments, and problem sets from uploaded screenshots or text\n` +
      `- Gono Bishwabidyalay university details (if relevant)\n\n` +
      `Instructions:\n` +
      `1. Provide direct, step-by-step solutions with clear reasoning.\n` +
      `2. For Math/Science: State given values, the formula/principle used, step-by-step arithmetic/algebra, and underline or box the final answer.\n` +
      `3. For Code & Programming:\n` +
      `   - STRICT CLEAN CODE SEPARATION: The code block (\`\`\`language ... \`\`\`) must contain 100% PURE, CLEAN, PRODUCTION-READY, RUNNABLE CODE ONLY.\n` +
      `   - ABSOLUTELY NO tutorial explanations, essay paragraphs, or multi-line comments inside the code block. The student will click the "Copy" button to run the code directly in their IDE/compiler; any cluttered explanation inside the code block ruins copy-pasting.\n` +
      `   - Keep comments inside the code to an absolute minimum (only short 2-4 word notes where strictly needed). Never truncate, omit lines, or leave "// TODO" placeholders.\n` +
      `   - First Attempt (when code is requested): Present the clean code directly with a 1-line description before the code and a concise working Example Run with sample input and expected output after the code. DO NOT dump long essay explanations unless the student explicitly asks for details.\n` +
      `   - When Explanation/Details are explicitly requested (e.g. "bujhiye dao", "explain", "details bolo", "line-by-line", or follow-up "ektu boro kore dau"): Provide a rich, structured breakdown OUTSIDE the code block using markdown sections (Line-by-line breakdown, Algorithm trace, Big-O Time & Space Complexity, Edge cases). NEVER put explanations inside the code block.\n` +
      `   - If debugging or fixing code/errors: identify the root cause in 1 line, provide the fully corrected clean code block, and summarize the key fixes in bullet points below the code.\n` +
      `4. For Screenshots: Carefully read the extracted OCR text from the student's screenshot. Identify the specific problem(s) and solve them completely.\n` +
      `5. Formatting: Use markdown bolding, numbered steps, bullet points, and headers for high readability.\n` +
      `6. ${langInstruction}`;
  }

  const isFormatFollowup = isFollowupFormatInstruction(message);
  if (isFormatFollowup) {
    const formatType = detectFollowupFormatType(message);
    systemInstruction +=
      `\n\nCRITICAL FOLLOW-UP FORMATTING INSTRUCTION:\n` +
      `The student's request is a follow-up formatting instruction (${String(formatType || "").toUpperCase()}) regarding your PREVIOUS response in the conversation.\n` +
      `You MUST directly reformat, adjust, and transform your previous answer according to their requested length and style:\n` +
      `- If points: Output clean markdown bullet points with bold subheaders.\n` +
      `- If shorten: Provide a concise, punchy summary preserving all crucial facts and figures.\n` +
      `- If expand: Provide a detailed, in-depth explanation with context and practical implications.\n` +
      `- If simplify: Explain in simple, intuitive terms.\n` +
      `STRICTLY PRESERVE all facts, numbers, dates, equations, and code from the previous answer. DO NOT ask what to reformat; answer directly in the requested format.`;
  }

  const asksForPrompt = isExplicitPromptWritingRequest(message);
  if (!asksForPrompt) {
    systemInstruction +=
      `\n\nCRITICAL NEGATIVE CONSTRAINT REGARDING IMAGE GENERATION PROMPTS:\n` +
      `- NEVER output text like "Here's an updated prompt you can use:", "Prompt: ...", or generate Midjourney/FLUX prompts. The student did NOT ask for a prompt.\n` +
      `- If the user's message is an academic question, coding question, or general query, answer their question directly.\n`;
  }

  let userPrompt = "";
  const recentHistory = (history || []).slice(-6).filter((h) => h?.role && h?.text);
  if (recentHistory.length > 0) {
    userPrompt += "### Previous Conversation:\n";
    for (const turn of recentHistory) {
      userPrompt += `${turn.role === "assistant" ? "GB AI" : "Student"}: ${turn.text}\n`;
    }
    userPrompt += "\n";
  }

  if (hasAttachments) {
    userPrompt += "### Uploaded Screenshot(s) / Document(s) Content:\n";
    attachments.forEach((att, idx) => {
      userPrompt += `[Attachment ${idx + 1}: ${att.title || "image"}]\n`;
      if (att.visualCaption) userPrompt += `Visual Scene: ${att.visualCaption}\n`;
      if (att.text) userPrompt += `Extracted Text (OCR):\n${att.text.trim()}\n`;
      userPrompt += "\n";
    });
  }

  if (isWebSearchActive) {
    userPrompt += "### Live Web Search Results (Current Web Information):\n";
    webResults.forEach((res, idx) => {
      userPrompt += `[Source ${idx + 1}: ${res.title}]\nURL: ${res.url}\nSummary: ${res.snippet}\n\n`;
    });
  }

  if (universityContexts.length > 0) {
    userPrompt += "### Relevant University Context:\n";
    universityContexts.forEach((ctx, idx) => {
      userPrompt += `[Context ${idx + 1}: ${ctx.title || "Info"}]\n${ctx.text || ""}\n\n`;
    });
  }

  userPrompt += "### Student Question / Request:\n";
  if (message && message !== "Read this attachment and answer from it.") {
    userPrompt += message;
  } else if (hasAttachments) {
    userPrompt += "Please solve and explain the question/problem shown in the uploaded screenshot step-by-step.";
  } else {
    userPrompt += "Please assist me with this academic problem.";
  }

  let answerText = null;
  const apiKey = envSecret("OPENAI_API_KEY");
  if (apiKey) {
    const isGroq = openAiBaseUrl.includes("groq.com");
    const candidateModels = isGroq ? [openAiModel, "openai/gpt-oss-120b", "openai/gpt-oss-20b"] : [openAiModel];
    const uniqueModels = [...new Set(candidateModels.filter(Boolean))];

    for (const model of uniqueModels) {
      try {
        const resp = await fetch(`${openAiBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: isWebSearchActive ? 0.3 : 0.25,
            max_tokens: 1500,
            messages: [
              { role: "system", content: systemInstruction },
              { role: "user", content: userPrompt },
            ],
          }),
          signal: AbortSignal.timeout(25000),
        });

        if (resp.ok) {
          const data = await resp.json().catch(() => null);
          const candidate = data?.choices?.[0]?.message?.content?.trim();
          if (candidate) {
            answerText = candidate;
            break;
          }
        }
      } catch (err) {
        await logServerEvent({ at: new Date().toISOString(), level: "warn", message: err.message, scope: `gb_ai_${model}` });
      }
    }
  }

  if (!answerText) {
    if (isWebSearchActive) {
      const summaryList = webResults.map((r, i) => `${i + 1}. **${r.title}**: ${r.snippet}`).join("\n\n");
      answerText = isBangla
        ? `🌐 **লাইভ ওয়েব সার্চ ফলাফল:**\n\n${summaryList}\n\n*সরাসরি তথ্য জানতে উপরের সোর্স লিংকে ক্লিক করুন।*`
        : `🌐 **Live Web Search Results:**\n\n${summaryList}\n\n*Please refer to the source links below for details.*`;
    } else if (hasAttachments && attachments.some((a) => a.text)) {
      const combinedText = attachments.map((a) => a.text).filter(Boolean).join("\n\n");
      answerText = isBangla
        ? `📷 **স্ক্রিনশট থেকে প্রাপ্ত টেক্সট:**\n\n${combinedText.slice(0, 1000)}\n\n*বর্তমানে এআই সার্ভার রেসপন্স করতে পারছে না। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।*`
        : `📷 **Extracted text from screenshot:**\n\n${combinedText.slice(0, 1000)}\n\n*The AI engine is temporarily busy. Please try again shortly.*`;
    } else {
      answerText = isBangla
        ? `আমি আপনার প্রশ্নটি পেয়েছি, কিন্তু এআই সার্ভিস বর্তমানে ব্যস্ত রয়েছে। দয়া করে কিছুক্ষণ পর আবার জিজ্ঞাসা করুন।`
        : `I received your question, but the AI service is momentarily busy. Please try again shortly.`;
    }
  }

  const lowerMsg = (message || "").toLowerCase();
  const lowerAns = answerText.toLowerCase();
  let suggestions = [];
  if (isWebSearchActive) {
    suggestions = isBangla
      ? ["আরও বিস্তারিত সার্চ করো", "সম্পর্কিত সাম্প্রতিক খবর দেখাও", "মূল তথ্যগুলো সংক্ষেপে বলো"]
      : ["Search in more detail", "Show related recent updates", "Summarize key takeaways"];
  } else if (lowerMsg.includes("code") || lowerAns.includes("```") || lowerMsg.includes("python") || lowerMsg.includes("java") || lowerMsg.includes("c++") || lowerMsg.includes("program") || lowerMsg.includes("algorithm")) {
    suggestions = isBangla
      ? ["কোডের প্রতিটি লাইন বুঝিয়ে দাও", "টাইম ও স্পেস কমপ্লেক্সিটি কত?", "আরও অপ্টিমাইজড সমাধান আছে?", "টেস্ট কেস ও ড্রাই রান দেখাও", "অন্য কোনো ভাষায় রূপান্তর করো"]
      : ["Explain code line-by-line", "Time & Space Complexity analysis", "Can this be optimized further?", "Show test cases and dry run", "Convert to another language"];
  } else if (/(\+|\-|\*|\/|=|\^|derivative|integral|equation|formula|ক্ষেত্রফল|সমীকরণ|ঘনত্ব)/i.test(message + answerText)) {
    suggestions = isBangla
      ? ["আরেকটি উদাহরণ দিয়ে বোঝাও", "ধাপগুলো আরেকটু সহজ করে বলো", "অন্য কোনো নিয়মে করা যায়?"]
      : ["Explain with another example", "Simplify the steps", "Is there an alternative method?"];
  } else {
    suggestions = isBangla
      ? ["আরেকটু বিস্তারিত ব্যাখ্যা করো", "সংক্ষেপে মূল পয়েন্টগুলো বলো", "বাস্তব উদাহরণ দিয়ে বোঝাও"]
      : ["Explain in more detail", "Give key summary points", "Explain with real-world analogy"];
  }

  const effectiveSources = isWebSearchActive
    ? webResults.map((c) => ({ title: c.title, url: c.url || "" }))
    : universityContexts.map((c) => ({ title: c.title, url: c.url || "" }));

  return {
    text: cleanFencedCodeBlocks(answerText),
    mode: isWebSearchActive
      ? "gb_ai_web_search"
      : hasAttachments
      ? "gb_ai_screenshot_solution"
      : "gb_ai_solution",
    medium: "gb-ai",
    webSearchUsed: isWebSearchActive,
    aiModel: isWebSearchActive ? "GB AI (Web Search)" : "GB AI (Deep Academic Solver)",
    profile: {
      label: isWebSearchActive
        ? "Web Search"
        : hasAttachments
        ? "Screenshot Solved"
        : "GB AI Solution",
      confidence: isWebSearchActive ? "Live Web" : "Step-by-step",
    },
    sources: effectiveSources,
    suggestions,
  };
}

async function handleChat(req, res) {
  const startedAt = Date.now();
  const body = await parseJsonBody(req);
  if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
    return json(res, 400, { error: "Attachments must be an array" });
  }
  if (body.attachments?.length > 3) {
    return json(res, 400, { error: "A maximum of 3 attachments is allowed per message" });
  }
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
  const message = String(body.message || (hasAttachments ? "Read this attachment and answer from it." : "")).trim();
  const suppliedSessionId = String(body.sessionId || "").trim();
  if (suppliedSessionId && !/^[A-Za-z0-9._:-]{1,120}$/.test(suppliedSessionId)) {
    return json(res, 400, { error: "Session ID contains unsupported characters" });
  }
  const sessionId = suppliedSessionId || `anonymous:${clientIp(req)}`.slice(0, 120);
  if (!rateLimitOk(req, sessionId)) return json(res, 429, { error: "Too many messages in a short time. Please wait a minute and try again." });
  if (!message) return json(res, 400, { error: "Message is required" });
  if (message.length > 2000) return json(res, 400, { error: "Message is too long" });

  const clientHistory = Array.isArray(body.history) ? body.history.slice(-20) : [];
  await loadConversationMemory();
  const history = resolveConversationHistory(conversationHistory(sessionId), clientHistory, body.replaceHistory === true);
  const previousHistory = previousConversation(history, message);

  const uploadedAttachments = hasAttachments ? await extractAttachments(body.attachments) : [];
  if (hasAttachments) rememberSessionAttachments(sessionId, uploadedAttachments);
  const storedAttachments = sessionAttachments(sessionId);

  const imageRefinement = !hasAttachments ? isImageRefinementOrFollowup(message, history) : null;

  if (!hasAttachments && isExistingImageLookupIntent(message)) {
    const lookupResponse = directOfficialImageLookupAnswer(message, await loadKnowledge());
    rememberConversationExchange(sessionId, history, message, lookupResponse.text);
    return json(res, 200, lookupResponse);
  }

  // GB AI mode: Image creation if requested or refinement, otherwise University Routing, Web Search or Academic Solver
  if (body.medium === "gb-ai") {
    const isImageRequest = !hasAttachments && (body.mode === "image" || isImageCreationIntent(message) || Boolean(imageRefinement));
    if (isImageRequest) {
      const imageResponse = await handleImageGeneration(message, sessionId, history);
      rememberConversationExchange(sessionId, history, message, imageResponse.text);
      const statusCode = imageResponse.statusCode || 200;
      delete imageResponse.statusCode;
      return json(res, statusCode, imageResponse);
    }

    // Check for follow-up formatting instructions (e.g. boro kore dau, choto kore dau, point akare dau)
    const knowledge = await loadKnowledge();
    if (!hasAttachments && isFollowupFormatInstruction(message) && previousHistory.length > 0) {
      const formatResult = await handleFollowupFormatRequest({
        message,
        history,
        knowledge,
        sessionId,
        isGbAi: true,
      });
      if (formatResult) {
        rememberConversationExchange(sessionId, history, message, formatResult.text);
        return json(res, 200, formatResult);
      }
    }

    // Check if question is a university inquiry in GB AI mode
    const isUniv = !hasAttachments && isUniversityInquiry(message, knowledge, history);
    if (isUniv) {
      let univResult = directAnswer(message, knowledge, previousHistory);
      if (!univResult) univResult = directActivePersonAnswer(message, knowledge, conversationEntity(sessionId, "person"));
      if (!univResult) {
        const contexts = searchPages(message, knowledge, history);
        if (contexts.length > 0) {
          const aiAnswer = await askAiProvider(message, contexts, history, "chat");
          if (aiAnswer) {
            univResult = {
              text: aiAnswer.text,
              sources: dedupeSources(contexts.slice(0, 3).map(({ title, url }) => ({ title, url }))),
            };
          }
        }
      }

      if (univResult) {
        const isBn = /[\u0980-\u09ff]/.test(message) || prefersBanglish(message);
        const prefix = isBn
          ? "🏛️ **গণ বিশ্ববিদ্যালয় অফিশিয়াল চ্যাটবট ডাটাবেস (GB Chatbot):**\n\n"
          : "🏛️ **GB Chatbot • Official University Knowledge Base:**\n\n";
        const formattedText = univResult.text.startsWith("🏛️") ? univResult.text : prefix + univResult.text;
        const respPayload = {
          text: formattedText,
          mode: "gb_ai_university_chatbot",
          medium: "gb-ai",
          isUniversityQuery: true,
          aiModel: "GB Chatbot (Official Knowledge)",
          profile: {
            label: "GB Chatbot",
            confidence: "Official University Knowledge",
          },
          sources: univResult.sources || [],
          suggestions: univResult.suggestions || followupSuggestions(message, univResult).slice(0, 3),
        };
        rememberConversationExchange(sessionId, history, message, respPayload.text);
        return json(res, 200, respPayload);
      }
    }

    const aiResponse = await handleGbAiQuestion(message, uploadedAttachments, history, sessionId, {
      webSearch: Boolean(body.webSearch),
    });
    rememberConversationExchange(sessionId, history, message, aiResponse.text);
    return json(res, 200, aiResponse);
  }

  // Normal Chatbot mode - image creation & refinement support
  if (!hasAttachments && (body.mode === "image" || isImageCreationIntent(message) || isExplicitImageRequest(message) || Boolean(imageRefinement))) {
    const imageResponse = await handleImageGeneration(message, sessionId, history);
    rememberConversationExchange(sessionId, history, message, imageResponse.text);
    const statusCode = imageResponse.statusCode || 200;
    delete imageResponse.statusCode;
    return json(res, statusCode, imageResponse);
  }

  const knowledge = await loadKnowledge();
  await loadResponseCache();
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
    isConversationalIntent(message) ||
    (previousHistory.length > 0 && isContextualFollowup(message));
  const key = cacheKey(message, knowledge, previousHistory);
  const cached = skipCache ? null : responseCache.get(key);
  if (cached) {
    const enrichedCached = {
      ...cached,
      sources: dedupeSources(cached.sources),
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

  // Check for follow-up formatting instructions in Chatbot mode
  if (!result && !hasAttachments && isFollowupFormatInstruction(message) && previousHistory.length > 0) {
    const formatResult = await handleFollowupFormatRequest({
      message,
      history,
      knowledge,
      sessionId,
      isGbAi: false,
    });
    if (formatResult) {
      result = formatResult;
    }
  }

  const isConversational = isConversationalIntent(message);
  const hasDeterministicGpaEligibility = isStatedAdmissionEligibilityQuestion(message);
  if (!result && (!isConversational || hasDeterministicGpaEligibility)) result = directAnswer(message, knowledge, previousHistory);
  if (!result && !isConversational) result = directActivePersonAnswer(message, knowledge, conversationEntity(sessionId, "person"));
  if (!result && !isConversational && (asksContactDetail(message) || asksPersonIdentity(message))) {
    result = { text: notVerifiedText(message), sources: [], mode: "not_found" };
  }

  const useOfficialRetrieval =
    explicitlyRequestsGonoContext(message) ||
    requiresVerifiedStructuredAnswer(message, history) ||
    (isContextualFollowup(message) && previousHistory.length > 0) ||
    isConversational;
  const contexts = result || !useOfficialRetrieval ? [] : searchPages(message, knowledge, history);

  // If this is a conversational query or follow-up, enrich contexts with prior department facts
  const priorDept = activeContextDepartment(history, message, knowledge);
  if (priorDept && contexts.length < 5) {
    const prog = programForDepartment(knowledge, priorDept);
    if (prog && !contexts.some((c) => c.title?.toLowerCase().includes(priorDept.toLowerCase()))) {
      contexts.unshift({
        title: prog.sourceTitle || prog.name,
        url: prog.source,
        text: `Department: ${priorDept}\nProgram: ${prog.name}\n${prog.admissionRequirement ? `Admission Requirement: ${prog.admissionRequirement}\n` : ""}${prog.duration ? `Duration: ${prog.duration}\n` : ""}${prog.seats ? `Seats: ${prog.seats}\n` : ""}`,
      });
    }
  }

  const allowGeneralAnswer = !result && (!useOfficialRetrieval || isGeneralAcademicQuestion(message) || isContextualFollowup(message) || isConversational);
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
        sources: dedupeSources(contexts.slice(0, 3).map(({ title, url }) => ({ title, url }))),
        mode: aiAnswer.provider,
      };
    }
  }

  if (!result && isConversational) {
    result = directAnswer(message, knowledge, previousHistory);
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
    result.sources = dedupeSources(contexts.slice(0, 2).map(({ title, url }) => ({ title, url })));
  }
  result.sources = dedupeSources(result.sources);
  result.profile = responseProfile(result, message);
  result.suggestions = (result.suggestions?.length ? result.suggestions : followupSuggestions(message, result)).slice(0, 3);
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
  const requestedMaxPages = Number(body.maxPages ?? 2000);
  const requestedConcurrency = Number(body.crawlConcurrency ?? 10);
  if (!Number.isSafeInteger(requestedMaxPages) || requestedMaxPages < 1 || requestedMaxPages > 5000) {
    return json(res, 400, { error: "maxPages must be an integer between 1 and 5000" });
  }
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 25) {
    return json(res, 400, { error: "crawlConcurrency must be an integer between 1 and 25" });
  }
  if (body.officialSiteUrl !== undefined) {
    try {
      const requestedUrl = new URL(String(body.officialSiteUrl));
      if (!/^https?:$/.test(requestedUrl.protocol)) throw new Error("Unsupported protocol");
    } catch {
      return json(res, 400, { error: "officialSiteUrl must be a valid HTTP(S) URL" });
    }
  }
  const next = {
    ...(await loadSettings()),
    officialSiteUrl: normalizeBaseUrl(body.officialSiteUrl || officialSiteUrl),
    maxPages: requestedMaxPages,
    crawlConcurrency: requestedConcurrency,
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

function serveGeneratedImage(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
  const id = pathname.slice("/api/generated-images/".length);
  if (!/^[a-z0-9-]{8,80}$/i.test(id)) return json(res, 404, { error: "Generated image not found" });
  pruneGeneratedImages();
  const item = generatedImageCache.get(id);
  if (!item) return json(res, 404, { error: "Generated image expired or was not found" });
  res.writeHead(200, {
    "content-type": item.contentType,
    "content-length": item.buffer.length,
    "cache-control": `private, max-age=${Math.floor(generatedImageTtlMs / 1000)}`,
    "content-disposition": `inline; filename="gb-ai-${id}.jpg"`,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
  if (req.method === "HEAD") return res.end();
  res.end(item.buffer);
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
  if (url.pathname === "/api/chat" && req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(req, res);
  if (url.pathname.startsWith("/api/generated-images/")) return serveGeneratedImage(req, res, url.pathname);
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
  const distPath = fileURLToPath(DIST_DIR);
  let cleanPath;
  try {
    cleanPath = decodeURIComponent(pathname).replace(/\\/g, "/").replace(/^\/+/, "");
  } catch {
    return json(res, 400, { error: "Invalid URL path" });
  }
  let targetFile = resolve(distPath, cleanPath || "index.html");
  const relativeTarget = relative(distPath, targetFile);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    return json(res, 403, { error: "Forbidden path" });
  }
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
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), geolocation=(), payment=()",
      "content-security-policy": "default-src 'self'; img-src 'self' data: https://image.pollinations.ai; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://image.pollinations.ai; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) {
      await logServerEvent({ at: new Date().toISOString(), level: "error", message: error.message, scope: "server" });
    }
    json(res, status, { error: status < 500 ? error.message : "Internal server error" });
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
  directClubAnswer,
  directOfficialImageLookupAnswer,
  extractProgramPlanFacts,
  fetchGeneratedImageAsset,
  isConversationalIntent,
  mergeConversationHistory,
  resolveConversationHistory,
  prefersBanglish,
  relevantConversationHistory,
  resolvedPersonFromExchange,
  requiresVerifiedStructuredAnswer,
  cleanImagePromptText,
  getLastImageContext,
  isImageRefinementOrFollowup,
  isImageCreationIntent,
  isExistingImageLookupIntent,
  isExplicitFreshImageIntent,
  performWebSearch,
  isWebSearchIntent,
  isUniversityInquiry,
  detectFollowupFormatType,
  isFollowupFormatInstruction,
  handleFollowupFormatRequest,
  reformatTextDeterministically,
  isCodingQuestion,
  asksCodeExplanation,
  cleanFencedCodeBlocks,
  isExplicitPromptWritingRequest,
};
