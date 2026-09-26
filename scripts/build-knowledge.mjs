import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { load } from "cheerio";
import { createHash } from "node:crypto";

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

const defaultSite = "https://gonouniversity.edu.bd/";
const sourceUrl = normalizeBaseUrl(process.env.OFFICIAL_SITE_URL || defaultSite);
const sourceHost = new URL(sourceUrl).hostname;
const sourceRootHost = sourceHost.replace(/^www\./i, "");
const maxPages = Number(process.env.MAX_PAGES || 2500);
const maxPdfs = Number(process.env.MAX_PDFS || 120);
const concurrency = Math.max(1, Number(process.env.CRAWL_CONCURRENCY || 12));
const allowedHosts = new Set([sourceRootHost, `www.${sourceRootHost}`]);
const queue = [];
const seen = new Set();
const failedPages = new Set();
const pages = [];
const faculty = [];
const documents = [];
const roles = [];
const fees = [];
const programs = [];
const contacts = [];
const notices = [];
const wordpressMeta = new Map();
const sitemapLastModified = new Map();

const priorityPaths = [
  "/",
  "/about-gb/general-information/",
  "/about-gb/general-information/background/",
  "/about-gb/general-information/mission-vision/",
  "/about-gb/general-information/location/",
  "/about-gb/academic-calendar/",
  "/administration/administrative/",
  "/administration/authority/board-of-trustees/",
  "/administration/authority/syndicate/",
  "/administration/authority/academic-council/",
  "/administration/authority/deans-of-faculties/",
  "/gb-central-students-union-2025-2027/",
  "/admission/",
  "/admission/undergraduate-admission-requirements/",
  "/admission/graduate-admission-requirements/",
  "/admission/financial-aid/",
  "/admission/tuition-and-other-fees/",
  "/admission/online-facilities/",
  "/academics/",
  "/category/notice/",
  "/category/top-scroll-notice/",
  "/category/exam-notice/",
  "/category/admission-notice/",
  "/category/job-notice/",
  "/category/news-events/",
  "/contact-us/",
  "/offices/",
  "/offices/admission-office/",
  "/offices/office-of-the-registrar/",
  "/offices/office-of-the-controller-of-examination/",
  "/library/",
  "/research/",
  "/downloads/",
  "/cse/",
  "/cse/faculty-members/",
  "/pharmacy/",
  "/pharmacy/faculty-members/",
  "/microbiology/",
  "/bmb/",
  "/mpbme/",
  "/eee/",
  "/physics/",
  "/chemistry/",
  "/math/",
  "/english/",
  "/bangla/",
  "/politics/",
  "/sociology/",
  "/law/",
  "/bba/",
  "/veterinary/",
  "/agriculture/",
];

const highValuePathPatterns = [
  /\/(academics?|department|faculty|staff|employee|teacher|office|contact|admission|notice|tuition|fees|library|research|calendar|downloads?|syllabus|curriculum|course|programme|program)\b/i,
  /\/(cse|pharmacy|microbiology|bmb|biochemistry|mpbme|biomedical|eee|physics|chemistry|math|english|bangla|politics|sociology|law|business|bba|veterinary|agriculture)\b/i,
];

const departmentBySlug = new Map([
  ["pharmacy", "Department of Pharmacy"],
  ["microbiology", "Department of Microbiology"],
  ["bmb", "Department of Biochemistry and Molecular Biology"],
  ["biochemistry-and-molecular-biology", "Department of Biochemistry and Molecular Biology"],
  ["cse", "Department of Computer Science and Engineering (CSE)"],
  ["eee", "Department of Electrical and Electronic Engineering (EEE)"],
  ["mpbme", "Department of Medical Physics and Biomedical Engineering"],
  ["physics", "Department of Physics"],
  ["chemistry", "Department of Chemistry"],
  ["math", "Department of Applied Mathematics"],
  ["english", "Department of English"],
  ["bangla", "Department of Bangla"],
  ["politics", "Department of Politics and Governance"],
  ["sociology", "Department of Sociology and Social Work"],
  ["law", "Department of Law"],
  ["bba", "Department of Business Administration"],
  ["business-administration", "Department of Business Administration"],
  ["veterinary", "Faculty of Veterinary and Animal Sciences"],
  ["agriculture", "Faculty of Agriculture"],
  ["library", "Library"],
  ["sports", "Sports Office"],
]);

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/?$/, "/");
  } catch {
    return defaultSite;
  }
}

function normalizeUrl(href, base = sourceUrl) {
  try {
    const rawHref = String(href || "").replace(/&amp;/g, "&").trim();
    if (!rawHref || /^(?:mailto|tel|javascript|data):/i.test(rawHref)) return null;
    if (/@/.test(rawHref) || /^10\.\d{4,9}\//i.test(rawHref)) return null;
    const url = new URL(rawHref, base);
    url.hash = "";
    if (!allowedHosts.has(url.hostname)) return null;
    if (/\/(?:wp-admin|wp-login|wp-json)(?:\/|$)/i.test(url.pathname)) return null;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|pdf|docx?|xlsx?|pptx?|zip|rar|7z|mp4|mp3|avi|mov|woff2?|ttf|eot)$/i.test(url.pathname)) return null;
    if (/\/(?:__MACOSX|www\.[a-z0-9-]+\.[a-z]{2,})(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return null;
    if (/@|%40|\/10\.\d{4,9}\//i.test(decodeURIComponent(url.pathname))) return null;
    if (/\/(?:feed|comments)(?:\/|$)/i.test(url.pathname)) return null;
    url.search = "";
    const value = url.toString();
    return value.replace(/\/?$/, url.pathname.includes(".") ? "" : "/");
  } catch {
    return null;
  }
}

function normalizePdfUrl(raw, base) {
  try {
    const url = new URL(String(raw || "").replace(/&amp;/g, "&"), base);
    const nestedFile = url.searchParams.get("file");
    if (nestedFile) {
      const nested = new URL(decodeURIComponent(nestedFile), base);
      nested.hash = "";
      if (allowedHosts.has(nested.hostname) && /\.pdf$/i.test(nested.pathname)) return nested.toString();
    }
    url.hash = "";
    if (!allowedHosts.has(url.hostname) || !/\.pdf$/i.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function cleanText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\bMicrobiololgy\b/gi, "Microbiology")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value) {
  if (!value) return "";
  return cleanText(load(`<div>${value}</div>`)("div").text());
}

function cleanTitle($, fallback) {
  return (
    cleanText($("meta[property='og:title']").attr("content")) ||
    cleanText($("h1").first().text()) ||
    cleanText($("title").first().text()) ||
    fallback
  );
}

function uniqueStrings(values) {
  const seenValues = new Set();
  return values.filter((value) => {
    const cleaned = cleanText(value);
    const key = cleaned.toLowerCase();
    if (!cleaned || seenValues.has(key)) return false;
    seenValues.add(key);
    return true;
  });
}

function chunkText(text, size = 1200) {
  const blocks = cleanText(text).split(/\n+/).filter((block) => block.length > 1);
  const chunks = [];
  let current = "";
  for (const block of blocks) {
    const pieces = block.length > size ? block.match(new RegExp(`.{1,${size}}(?:\\s|$)`, "g")) || [block] : [block];
    for (const piece of pieces) {
      const next = current ? `${current}\n${piece.trim()}` : piece.trim();
      if (next.length > size && current.length > 120) {
        chunks.push(current.trim());
        current = piece.trim();
      } else {
        current = next;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((chunk) => chunk.length > 35);
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1].trim().replace(/&amp;/g, "&"));
}

function rememberSitemapMetadata(xml, sitemapUrl) {
  for (const match of xml.matchAll(/<url>\s*([\s\S]*?)<\/url>/gi)) {
    const block = match[1];
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
    const lastmod = block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1];
    const normalized = loc ? normalizeUrl(loc.replace(/&amp;/g, "&"), sitemapUrl) : null;
    if (normalized && lastmod) sitemapLastModified.set(normalized, lastmod.trim());
  }
}

function failedHttpResponse(response) {
  const error = new Error(`${response.status} ${response.statusText}`);
  error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  return error;
}

async function fetchBuffer(url, accept = "*/*") {
  const attempts = Math.max(1, Number(process.env.FETCH_RETRIES || 3));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.FETCH_TIMEOUT_MS || 10000));
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "GB-Knowledge-Assistant/2.0 (+official public website indexer)",
          accept,
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw failedHttpResponse(response);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (error.retryable === false) break;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchText(url, accept = "text/html,application/xhtml+xml,application/xml,text/xml") {
  const cachePath = `data/crawl-cache/${createHash("sha256").update(String(url)).digest("hex")}.json`;
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (cached.url === String(url) && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) return cached.text;
  } catch {
    // Missing or expired cache entries are fetched from the official site.
  }
  const text = (await fetchBuffer(url, accept)).toString("utf8");
  await mkdir("data/crawl-cache", { recursive: true });
  await writeFile(cachePath, JSON.stringify({ url: String(url), fetchedAt: Date.now(), text }));
  return text;
}

async function fetchWordPressPage(url) {
  const attempts = Math.max(1, Number(process.env.FETCH_RETRIES || 3));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.FETCH_TIMEOUT_MS || 10000));
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "GB-Knowledge-Assistant/2.0 (+official public website indexer)",
          accept: "application/json",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (response.status === 400) return { items: [], totalPages: 0, exhausted: true };
      if (!response.ok) throw failedHttpResponse(response);
      const totalPages = Number(response.headers.get("x-wp-totalpages") || 1);
      return { items: await response.json(), totalPages, exhausted: false };
    } catch (error) {
      lastError = error;
      if (error.retryable === false) break;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function discoverSitemapUrls() {
  const sitemapIndexes = new Set([new URL("/sitemap.xml", sourceUrl).toString(), new URL("/sitemap_index.xml", sourceUrl).toString()]);
  try {
    const robots = await fetchText(new URL("/robots.txt", sourceUrl), "text/plain");
    for (const match of robots.matchAll(/^Sitemap:\s*(.+)$/gim)) sitemapIndexes.add(match[1].trim());
  } catch (error) {
    console.warn(`Could not read robots.txt: ${error.message}`);
  }

  const sitemapQueue = [...sitemapIndexes];
  const seenSitemaps = new Set();
  const urls = new Set(priorityPaths.map((path) => normalizeUrl(path)).filter(Boolean));

  while (sitemapQueue.length) {
    const batch = [];
    while (sitemapQueue.length && batch.length < 4) {
      const sitemapUrl = sitemapQueue.shift();
      if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
      seenSitemaps.add(sitemapUrl);
      batch.push(sitemapUrl);
    }
    const results = await Promise.all(
      batch.map(async (sitemapUrl) => {
        try {
          return { sitemapUrl, xml: await fetchText(sitemapUrl, "application/xml,text/xml") };
        } catch (error) {
          console.warn(`Skipped sitemap ${sitemapUrl}: ${error.message}`);
          return null;
        }
      }),
    );
    for (const result of results.filter(Boolean)) {
      const { sitemapUrl, xml } = result;
      const locs = extractLocs(xml);
      if (/<sitemapindex/i.test(xml)) {
        for (const loc of locs) if (!seenSitemaps.has(loc)) sitemapQueue.push(loc);
      } else {
        rememberSitemapMetadata(xml, sitemapUrl);
        for (const loc of locs) {
          const normalized = normalizeUrl(loc, sitemapUrl);
          if (normalized) urls.add(normalized);
        }
      }
    }
  }

  return [...urls];
}

async function discoverWordPressUrls() {
  const urls = new Set();
  for (const type of ["pages", "posts"]) {
    for (let page = 1; page <= 50; page += 1) {
      const endpoint = new URL(`/wp-json/wp/v2/${type}?per_page=100&page=${page}&_embed=1`, sourceUrl);
      try {
        const { items, totalPages, exhausted } = await fetchWordPressPage(endpoint);
        if (exhausted) break;
        for (const item of Array.isArray(items) ? items : []) {
          const normalized = normalizeUrl(item.link || "");
          if (!normalized) continue;
          urls.add(normalized);
          const terms = item?._embedded?.["wp:term"]?.flat?.() || [];
          wordpressMeta.set(normalized, {
            kind: type === "posts" ? "post" : "page",
            title: decodeHtml(item?.title?.rendered || ""),
            publishedAt: item.date || "",
            modifiedAt: item.modified || "",
            categories: terms.filter((term) => term?.taxonomy === "category").map((term) => cleanText(term.name)),
          });
        }
        if (page >= totalPages || !items.length) break;
      } catch (error) {
        console.warn(`Skipped WordPress discovery ${endpoint}: ${error.message}`);
        break;
      }
    }
  }
  return [...urls];
}

function urlPriority(url) {
  const path = new URL(url).pathname;
  if (priorityPaths.some((priorityPath) => normalizeUrl(priorityPath) === url)) return 0;
  if (highValuePathPatterns.some((pattern) => pattern.test(path))) return 1;
  if (/\/category\/(?:notice|exam-notice|admission-notice|top-scroll-notice|job-notice)/i.test(path)) return 2;
  if (/\/page\/\d+\//i.test(path) || /\/author\//i.test(path)) return 9;
  return 4;
}

function sortByPriority(urls) {
  return [...new Set(urls)].sort((a, b) => urlPriority(a) - urlPriority(b) || a.length - b.length || a.localeCompare(b));
}

function inferDepartment($, pageUrl) {
  const pathPart = new URL(pageUrl).pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (pathPart && departmentBySlug.has(pathPart)) return departmentBySlug.get(pathPart);
  const combined = `${cleanText($("meta[property='og:title']").attr("content"))} ${cleanText($("h1").first().text())}`;
  const departmentMatch = combined.match(/Department of\s+(.+?)(?=\s+(?:Gono Bishwabidyalay|Faculty Members|\||-|–)|$)/i);
  if (departmentMatch) return `Department of ${cleanText(departmentMatch[1])}`;
  return pathPart ? cleanText(pathPart.replace(/-/g, " ")) : "Gono Bishwabidyalay";
}

function contentRoot($, pageUrl) {
  const path = new URL(pageUrl).pathname;
  const selectors = [
    ".single-page-articleContent",
    ".single-post-articleContent",
    ".employee-list-content-section",
    ".single-post-content-section",
    "article",
    "main",
    ".content-area",
  ];
  for (const selector of selectors) {
    const candidate = $(selector).first();
    if (candidate.length && (cleanText(candidate.text()).length > 35 || candidate.find("table, iframe, embed, .employee-list-card").length)) return candidate;
  }
  if (path === "/") return $("body");
  return $("body");
}

function extractSemanticText($, pageUrl) {
  const root = contentRoot($, pageUrl).clone();
  root.find("script, style, noscript, svg, iframe, embed, object, header, nav, footer, #footer-section, .breadcrumb, .breadcrumbs, .share-area, .social-share, .back-to-top, form").remove();
  const blocks = [];
  root.find(".statistic-card, .counter-item, .fun-fact, [class*='statistic']").each((_, element) => {
    const card = root.find(element);
    const value = cleanText(card.find(".count-number, .counter, [class*='number']").first().text());
    const label = cleanText(card.find(".count-title, [class*='title']").first().text());
    if (value && label) blocks.push(`${label}: ${value}`);
  });
  root.find("h1,h2,h3,h4,h5,h6,p,li,dt,dd,figcaption,tr").each((_, element) => {
    const item = root.find(element);
    if (item.closest("table").length && element.tagName !== "tr") return;
    let value = "";
    if (element.tagName === "tr") {
      value = item
        .find("th,td")
        .map((__, cell) => cleanText(root.find(cell).text()))
        .get()
        .filter(Boolean)
        .join(" | ");
    } else {
      value = cleanText(item.text());
    }
    if (value.length > 1 && value.length < 12_000) blocks.push(value);
  });
  const deduped = uniqueStrings(blocks);
  if (deduped.length) return deduped.join("\n");
  return cleanText(root.text());
}

function isValidPersonName(name) {
  const value = cleanText(name).replace(/^(?:Profile|View Profile)\s+/i, "");
  return value.length >= 4 && value.length <= 90 && /[\p{L}]/u.test(value) && !/^(?:view profile|faculty members?|read more|profile)$/i.test(value);
}

function roleKeyFromDesignation(designation, isStudentUnion = false) {
  const value = cleanText(designation).toLowerCase();
  const prefix = isStudentUnion ? "student_union_" : "";
  if (/^vice[-\s]?chancellor$/.test(value)) return "vice_chancellor";
  if (/^pro[-\s]?vice[-\s]?chancellor$/.test(value)) return "pro_vice_chancellor";
  if (/^registrar$/.test(value)) return "registrar";
  if (/^treasurer$/.test(value)) return `${prefix}treasurer`;
  if (isStudentUnion && /^vice president$/.test(value)) return "student_union_vice_president";
  if (isStudentUnion && /^general secretary$/.test(value)) return "student_union_general_secretary";
  if (isStudentUnion && /^joint general secretary$/.test(value)) return "student_union_joint_general_secretary";
  return "";
}

function extractPeopleFromCards($, pageUrl, title) {
  const department = inferDepartment($, pageUrl);
  const isStudentUnion = /student.*union|gaksu|গাকসু|gb-central-students-union/i.test(`${title} ${pageUrl}`);
  $(".employee-list-card, .team-member, .faculty-member, .staff-member").each((_, card) => {
    const root = $(card);
    const name = cleanText(
      root.find(".employee-list-card-name").first().attr("title") ||
        root.find(".employee-list-card-name, .team-name, .member-name, h3, h4").first().text() ||
        root.find("img[alt]").first().attr("alt") ||
        root.find("a").first().text(),
    ).replace(/^(?:Profile|View Profile)\s+/i, "");
    if (!isValidPersonName(name)) return;
    const profileUrl = normalizeUrl(root.find("a.read-more-btn, a[href*='/employees/'], a").first().attr("href") || "", pageUrl);
    const phone = cleanText(
      root.find(".employee-list-card-phone [title]").first().attr("title") ||
        root.find(".employee-list-card-phone, a[href^='tel:']").first().text() ||
        (root.find("a[href^='tel:']").attr("href") || "").replace(/^tel:/i, ""),
    ).replace(/[^\d,+ -]/g, "").trim();
    const email = cleanText(
      root.find(".employee-list-card-email [title]").first().attr("title") ||
        root.find(".employee-list-card-email, a[href^='mailto:']").first().text() ||
        (root.find("a[href^='mailto:']").attr("href") || "").replace(/^mailto:/i, ""),
    );
    const designation = cleanText(root.find(".employee-list-card-designation, .designation, .position").first().text());
    const qualification = cleanText(root.find(".employee-list-card-qualification, .qualification").first().text());
    faculty.push({ name, designation, phone, email, qualification, department, source: pageUrl, profileUrl });

    const roleKey = roleKeyFromDesignation(designation, isStudentUnion);
    if (roleKey) {
      roles.push({
        key: roleKey,
        title: designation,
        name,
        group: isStudentUnion ? "Gono Bishwabidyalay Central Students' Union" : department,
        phone,
        email,
        sourceTitle: title,
        source: profileUrl || pageUrl,
      });
    }
  });
}

function extractLeadershipCards($, pageUrl, title) {
  $(".message-card").each((_, card) => {
    const root = $(card);
    const name = cleanText(root.find(".message-card-name").first().text() || root.find("h3,h4,h5").first().text());
    const designation = cleanText(root.find(".message-card-designation").first().text());
    const key = roleKeyFromDesignation(designation, false);
    if (!key || !isValidPersonName(name)) return;
    const source = normalizeUrl(root.find("a[href]").first().attr("href") || "", pageUrl) || pageUrl;
    roles.push({
      key,
      title: designation,
      name,
      group: "Gono Bishwabidyalay administration",
      phone: "",
      email: "",
      sourceTitle: title,
      source,
    });
  });
}

function extractDocuments($, pageUrl) {
  $("a[href], iframe[src], embed[src], object[data]").each((_, element) => {
    const raw = $(element).attr("href") || $(element).attr("src") || $(element).attr("data") || "";
    const url = normalizePdfUrl(raw, pageUrl);
    if (!url) return;
    const title =
      cleanText($(element).text()) ||
      cleanText($(element).attr("title") || "") ||
      decodeURIComponent(new URL(url).pathname.split("/").pop());
    documents.push({ title, url, pageUrl });
  });
}

function programAliases(name) {
  const value = cleanText(name);
  const aliases = new Set([value, value.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim()]);
  for (const match of value.matchAll(/\(([^)]+)\)/g)) aliases.add(cleanText(match[1]));
  if (/computer science/i.test(value)) aliases.add("CSE").add("Computer Science and Engineering");
  if (/electrical and electronic/i.test(value)) aliases.add("EEE").add("Electrical and Electronic Engineering");
  if (/medical physics/i.test(value)) aliases.add("MPBME").add("Biomedical Engineering").add("Medical Physics");
  if (/pharmacy/i.test(value)) aliases.add("Pharmacy").add("BPharm").add("B.Pharm");
  if (/business administration/i.test(value)) aliases.add("BBA").add("Business Administration");
  if (/veterinary/i.test(value)) aliases.add("Veterinary").add("DVM");
  return [...aliases].filter(Boolean);
}

function departmentForProgram(name) {
  const value = cleanText(name);
  const entries = [
    [/pharmacy/i, "Department of Pharmacy"],
    [/microbiology/i, "Department of Microbiology"],
    [/biochemistry/i, "Department of Biochemistry and Molecular Biology"],
    [/medical physics|biomedical/i, "Department of Medical Physics and Biomedical Engineering"],
    [/computer science/i, "Department of Computer Science and Engineering (CSE)"],
    [/electrical and electronic/i, "Department of Electrical and Electronic Engineering (EEE)"],
    [/applied mathematics/i, "Department of Applied Mathematics"],
    [/chemistry/i, "Department of Chemistry"],
    [/physics/i, "Department of Physics"],
    [/business administration/i, "Department of Business Administration"],
    [/english/i, "Department of English"],
    [/politics/i, "Department of Politics and Governance"],
    [/bangla/i, "Department of Bangla"],
    [/sociology|social work/i, "Department of Sociology and Social Work"],
    [/\blaw\b|ll\.?\s*b/i, "Department of Law"],
    [/veterinary|animal husbandry/i, "Faculty of Veterinary and Animal Sciences"],
    [/agriculture/i, "Faculty of Agriculture"],
  ];
  return entries.find(([pattern]) => pattern.test(value))?.[1] || "";
}

function extractProgramsFromTables($, pageUrl, title) {
  $("table").each((_, table) => {
    const rows = [];
    $(table)
      .find("tr")
      .each((__, row) => {
        const cells = $(row)
          .find("th,td")
          .map((___, cell) => cleanText($(cell).text()))
          .get();
        if (cells.length >= 2) rows.push(cells);
      });
    if (rows.length < 2) return;
    const headers = rows[0].map((header) => header.toLowerCase());
    const programIndex = headers.findIndex((header) => /department|program|course|degree/.test(header));
    const requirementIndex = headers.findIndex((header) => /admission|requirement|eligibility/.test(header));
    const durationIndex = headers.findIndex((header) => /duration/.test(header));
    const seatsIndex = headers.findIndex((header) => /seat/.test(header));
    if (programIndex < 0 || (requirementIndex < 0 && durationIndex < 0 && seatsIndex < 0)) return;
    for (const row of rows.slice(1)) {
      const name = cleanText(row[programIndex]);
      if (!name || name.length > 180) continue;
      programs.push({
        name,
        aliases: programAliases(name),
        department: departmentForProgram(name),
        admissionRequirement: requirementIndex >= 0 ? cleanText(row[requirementIndex]) : "",
        duration: durationIndex >= 0 ? cleanText(row[durationIndex]) : "",
        seats: seatsIndex >= 0 ? cleanText(row[seatsIndex]) : "",
        sourceTitle: title,
        source: pageUrl,
      });
    }
  });
}

function extractFeeRecords(text, pageUrl, title) {
  if (!/admission|tuition|fee/i.test(`${title} ${pageUrl}`)) return;
  const segments = cleanText(text).split(/(?=Program\s*:)/i);
  for (const segment of segments) {
    const program = segment.match(/Program\s*:\s*([^\n]+)/i)?.[1];
    const amount = segment.match(/Total\s+Tuition\s+Fee\s*:\s*((?:Tk\.?|BDT|৳)\s*[\d,]+(?:\s*\/-)?)/i)?.[1];
    if (!program || !amount) continue;
    fees.push({
      program: cleanText(program),
      aliases: programAliases(program),
      admissionCost: cleanText(amount),
      sourceTitle: title,
      source: pageUrl,
      note: "Total tuition fee published on the official programme admission page.",
    });
  }
}

function contactLabel(context, fallback) {
  const cleaned = cleanText(context).replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "").replace(/\+?\d[\d ()-]{6,}\d/g, "");
  const label = cleanText(cleaned.split(/[:|]/)[0]).replace(/^[,;\s]+|[,;\s]+$/g, "");
  return label && label.length <= 80 ? label : fallback;
}

function extractContacts($, pageUrl, title) {
  const path = new URL(pageUrl).pathname;
  if (!(path === "/" || /\/contact(?:-us)?\/?$|\/offices\//i.test(path))) return;
  const roots = path === "/" ? $("#footer-section, footer") : contentRoot($, pageUrl);
  const department = inferDepartment($, pageUrl);
  roots.find("a[href^='tel:'], a[href^='Tel:'], a[href^='mailto:']").each((_, element) => {
    const href = String($(element).attr("href") || "").trim();
    const isEmail = /^mailto:/i.test(href);
    const value = cleanText(href.replace(/^(?:mailto|tel):/i, "")).replace(isEmail ? /\?.*$/ : /[^\d+,-]/g, "");
    if (!value) return;
    const parentText = cleanText($(element).closest("li,p,div").first().text()).slice(0, 220);
    const label = contactLabel(parentText, /admission/i.test(`${title} ${path}`) ? "Admission" : title);
    contacts.push({
      label,
      title,
      department,
      phones: isEmail ? [] : [value],
      emails: isEmail ? [value] : [],
      source: pageUrl,
    });
  });
}

function classifyPage(title, url, meta) {
  const combined = `${title} ${url} ${(meta?.categories || []).join(" ")}`.toLowerCase();
  if (/faculty|employee|staff|teacher/.test(combined)) return "people";
  if (/admission|tuition|fee|financial aid/.test(combined)) return "admission";
  if (/notice|exam|tender|job|result|routine|schedule/.test(combined)) return "notice";
  if (/syllabus|curriculum|course|programme|program/.test(combined)) return "academic";
  if (/research|journal|publication/.test(combined)) return "research";
  if (/office|administration|authority|council|trustee|syndicate/.test(combined)) return "administration";
  if (/library/.test(combined)) return "library";
  if (meta?.kind === "post") return "news";
  return "general";
}

function htmlPageMetadata($) {
  const publishedAt =
    cleanText($("meta[property='article:published_time']").attr("content")) ||
    cleanText($("time[datetime]").first().attr("datetime"));
  const modifiedAt = cleanText($("meta[property='article:modified_time']").attr("content"));
  const categories = uniqueStrings(
    $("a[rel~='category'], a[rel~='tag'], .post-category a, .category a")
      .map((_, item) => cleanText($(item).text()))
      .get(),
  );
  return {
    kind: publishedAt ? "post" : "page",
    publishedAt,
    modifiedAt,
    categories,
  };
}

function extractNoticeRecord(title, pageUrl, text, meta, documentUrls) {
  if (meta?.kind !== "post") return;
  const categoryText = (meta.categories || []).join(" ");
  if (!/notice|exam|admission|job|tender|result|routine|schedule|calendar|office order|বিজ্ঞপ্তি|পরীক্ষা|ফলাফল|সময়সূচী/i.test(`${title} ${categoryText}`)) return;
  notices.push({
    title,
    category: meta.categories?.[0] || "Notice",
    publishedAt: meta.publishedAt || "",
    modifiedAt: meta.modifiedAt || "",
    summary: chunkText(text, 700)[0] || "",
    documents: documentUrls,
    source: pageUrl,
  });
}

const sitemapUrls = await discoverSitemapUrls();
console.log(`Sitemaps discovered ${sitemapUrls.length} URLs.`);
const wordpressUrls = await discoverWordPressUrls();
console.log(`WordPress API discovered ${wordpressUrls.length} URLs.`);
const discoveredUrls = sortByPriority([...sitemapUrls, ...wordpressUrls]);
for (const url of discoveredUrls) if (!queue.includes(url)) queue.push(url);
console.log(`Official source: ${sourceUrl}`);
console.log(`Discovered ${queue.length} public URLs. Crawling up to ${Math.min(queue.length, maxPages)} pages.`);

async function processPage(url) {
  if (!url || seen.has(url) || /\.pdf$/i.test(new URL(url).pathname)) return;
  seen.add(url);
  try {
    const html = await fetchText(url);
    failedPages.delete(url);
    const $ = load(html);
    const title = cleanTitle($, url);
    const department = inferDepartment($, url);
    const htmlMeta = htmlPageMetadata($);
    const apiMeta = wordpressMeta.get(url) || {};
    const meta = {
      ...htmlMeta,
      ...apiMeta,
      categories: uniqueStrings([...(htmlMeta.categories || []), ...(apiMeta.categories || [])]),
    };
    const documentStart = documents.length;

    extractPeopleFromCards($, url, title);
    extractLeadershipCards($, url, title);
    extractDocuments($, url);
    extractProgramsFromTables($, url, title);
    extractContacts($, url, title);

    const mainText = extractSemanticText($, url);
    const chunks = chunkText(mainText);
    extractFeeRecords(mainText, url, title);
    const pageDocumentUrls = documents.slice(documentStart).map((document) => document.url);
    extractNoticeRecord(title, url, mainText, meta, pageDocumentUrls);

    if (chunks.length || pageDocumentUrls.length) {
      pages.push({
        url,
        title,
        department,
        type: classifyPage(title, url, meta),
        publishedAt: meta.publishedAt || "",
        modifiedAt: meta.modifiedAt || sitemapLastModified.get(url) || "",
        headings: uniqueStrings($("h1,h2,h3").map((_, heading) => cleanText($(heading).text())).get()).slice(0, 30),
        chunks,
      });
    }

    $("a[href]").each((_, link) => {
      const next = normalizeUrl($(link).attr("href"), url);
      if (next && !seen.has(next) && !queue.includes(next) && queue.length < maxPages * 3) queue.push(next);
    });
  } catch (error) {
    if (error.retryable === false) failedPages.delete(url);
    else failedPages.add(url);
    console.warn(`Skipped ${url}: ${error.message}`);
  }
}

for (let index = 0; index < Math.min(queue.length, maxPages); index += concurrency) {
  const batch = queue.slice(index, Math.min(index + concurrency, maxPages));
  await Promise.all(batch.map((url) => processPage(url)));
  console.log(`Crawled ${Math.min(index + batch.length, maxPages, queue.length)}/${Math.min(queue.length, maxPages)}`);
}

const recoveryLimit = Math.max(
  0,
  Number(process.env.RECOVERY_PAGES ?? (process.env.KNOWLEDGE_OUTPUT ? 0 : 120)),
);
const recoveryUrls = sortByPriority([...failedPages]).slice(0, recoveryLimit);
const recoveryConcurrency = Math.max(1, Math.min(2, concurrency));
if (recoveryUrls.length) console.log(`Retrying ${recoveryUrls.length} high-priority pages with reduced concurrency.`);
for (let index = 0; index < recoveryUrls.length; index += recoveryConcurrency) {
  const batch = recoveryUrls.slice(index, index + recoveryConcurrency);
  for (const url of batch) seen.delete(url);
  await Promise.all(batch.map((url) => processPage(url)));
  console.log(`Recovery pass ${Math.min(index + batch.length, recoveryUrls.length)}/${recoveryUrls.length}`);
}

function pdfTextQuality(text) {
  if (!text) return "none";
  const suspicious = (text.match(/[\\{}<>]/g) || []).length;
  const letters = (text.match(/[\p{L}]/gu) || []).length;
  if (letters < 80 || suspicious > Math.max(30, letters * 0.12)) return "low";
  return "text";
}

async function extractPdfDocument(document) {
  const cachePath = `data/pdf-cache/${createHash("sha256").update(document.url).digest("hex")}.json`;
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (cached.url === document.url && Date.now() - cached.fetchedAt < 7 * 24 * 60 * 60 * 1000) {
      return { ...document, ...cached.document };
    }
  } catch {
    // Missing or expired parsed-PDF cache entries are rebuilt.
  }
  try {
    const { PDFParse } = await import("pdf-parse");
    const buffer = await fetchBuffer(document.url, "application/pdf");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText({ first: Number(process.env.MAX_PDF_PAGES || 60) });
      const text = cleanText(result.text);
      const chunks = chunkText(text, 1300).slice(0, 24);
      const parsedDocument = {
        ...document,
        text: chunks.join("\n\n"),
        chunks,
        pageCount: result.total || result.pages?.length || null,
        textQuality: pdfTextQuality(text),
      };
      await mkdir("data/pdf-cache", { recursive: true });
      await writeFile(cachePath, JSON.stringify({ url: document.url, fetchedAt: Date.now(), document: parsedDocument }));
      return parsedDocument;
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    console.warn(`Skipped PDF text ${document.url}: ${error.message}`);
    const failedDocument = { ...document, text: "", chunks: [], textQuality: "none" };
    await mkdir("data/pdf-cache", { recursive: true });
    await writeFile(cachePath, JSON.stringify({ url: document.url, fetchedAt: Date.now(), document: failedDocument })).catch(() => {});
    return failedDocument;
  }
}

function mergePeople(items) {
  const merged = new Map();
  for (const item of items) {
    const key = `${cleanText(item.name).toLowerCase()}:${cleanText(item.department).toLowerCase()}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, item);
      continue;
    }
    const score = (record) => Number(Boolean(record.phone)) + Number(Boolean(record.email)) + Number(Boolean(record.qualification));
    const preferred = score(item) > score(current) ? item : current;
    const other = preferred === item ? current : item;
    merged.set(key, {
      ...other,
      ...preferred,
      phone: preferred.phone || other.phone || "",
      email: preferred.email || other.email || "",
      qualification: preferred.qualification || other.qualification || "",
      profileUrl: preferred.profileUrl || other.profileUrl || "",
    });
  }
  return [...merged.values()];
}

function mergeContacts(items) {
  const merged = new Map();
  for (const item of items) {
    const key = `${item.source}:${cleanText(item.label).toLowerCase()}`;
    const current = merged.get(key) || { ...item, phones: [], emails: [] };
    current.phones = uniqueStrings([...(current.phones || []), ...(item.phones || [])]);
    current.emails = uniqueStrings([...(current.emails || []), ...(item.emails || [])]);
    merged.set(key, current);
  }
  return [...merged.values()].filter((item) => item.phones.length || item.emails.length);
}

function mergePrograms(items) {
  const merged = new Map();
  for (const item of items) {
    const key = cleanText(item.name).toLowerCase();
    const current = merged.get(key);
    if (!current) merged.set(key, item);
    else {
      merged.set(key, {
        ...current,
        ...item,
        aliases: uniqueStrings([...(current.aliases || []), ...(item.aliases || [])]),
        admissionRequirement: item.admissionRequirement || current.admissionRequirement,
        duration: item.duration || current.duration,
        seats: item.seats || current.seats,
      });
    }
  }
  return [...merged.values()];
}

function documentPriority(document) {
  const value = `${document.title || ""} ${document.pageUrl || ""} ${document.url || ""}`;
  if (/syllabus|curriculum|course|admission|tuition|fee/i.test(value)) return 0;
  if (/notice|routine|schedule|calendar|form|policy|requirement|programme|program|department|office|download/i.test(value)) return 1;
  if (/result/i.test(value)) return 4;
  if (/research|journal|publication|article|conference|thesis/i.test(value)) return 5;
  return 3;
}

function documentDeduplicationKey(document) {
  try {
    const filename = decodeURIComponent(new URL(document.url).pathname.split("/").pop() || "").toLowerCase();
    const namedForProgram = /(?:^|[-_])(cse|eee|bba|bpharm|mpharm|pharmacy|microbiology|chemistry|physics|bangla|english|law|agriculture|veterinary|biochemistry|biomedical)(?:[-_.]|$)/i.test(filename);
    return namedForProgram ? `program-file:${filename}` : `url:${document.url}`;
  } catch {
    return `url:${document.url}`;
  }
}

const uniqueDocuments = Array.from(new Map(documents.map((item) => [documentDeduplicationKey(item), item])).values())
  .sort((a, b) => documentPriority(a) - documentPriority(b) || a.title.localeCompare(b.title))
  .slice(0, maxPdfs);
const documentsWithText = [];
const pdfConcurrency = Math.max(1, Math.min(concurrency, Number(process.env.PDF_CONCURRENCY || 3)));
for (let index = 0; index < uniqueDocuments.length; index += pdfConcurrency) {
  const batch = uniqueDocuments.slice(index, index + pdfConcurrency);
  documentsWithText.push(...(await Promise.all(batch.map((document) => extractPdfDocument(document)))));
  console.log(`Parsed PDFs ${Math.min(index + batch.length, uniqueDocuments.length)}/${uniqueDocuments.length}`);
}

const uniqueFaculty = mergePeople(faculty);
const uniqueRoles = Array.from(new Map(roles.map((item) => [item.key, item])).values());
const uniqueFees = Array.from(new Map(fees.map((item) => [`${item.program}:${item.admissionCost}`, item])).values());
const uniquePrograms = mergePrograms(programs);
const uniqueContacts = mergeContacts(contacts);
const uniqueNotices = Array.from(new Map(notices.map((item) => [item.source, item])).values()).sort(
  (a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0),
);
const pageTypeCounts = Object.fromEntries(
  [...new Set(pages.map((page) => page.type))].map((type) => [type, pages.filter((page) => page.type === type).length]),
);
const departments = uniqueStrings([
  ...uniquePrograms.map((program) => program.department),
  ...uniqueFaculty.map((person) => person.department),
]).filter(Boolean);

function extractInstitutionFacts(indexedPages, indexedContacts) {
  const officialPages = indexedPages.filter((page) => {
    const path = new URL(page.url).pathname;
    return path === "/" || /\/about-gb\/general-information|\/contact-us\/?$/i.test(path);
  });
  const corpus = officialPages.flatMap((page) => page.chunks || []).join("\n");
  const statistic = (label) => {
    const match = corpus.match(new RegExp(`(?:^|\\n)${label}\\s*:\\s*([\\d,]+\\s*\\+?)`, "i"));
    return match?.[1]?.replace(/\s+/g, "") || "";
  };
  const addressContact = indexedContacts.find((contact) =>
    /contact information|gono bishwabidyalay|university/i.test(`${contact.label || ""} ${contact.title || ""}`),
  );
  return {
    establishedDate: corpus.match(/(?:established|founded)[^.]{0,80}\b(14\s+July\s+1998)\b/i)?.[1] || "",
    founder: /Dr\.\s*Zafrullah Chowdhury/i.test(corpus) ? "Dr. Zafrullah Chowdhury" : "",
    foundingOrganization: /Gonoshasthaya Kendra \(GK\) Public Charitable Trust/i.test(corpus)
      ? "Gonoshasthaya Kendra (GK) Public Charitable Trust"
      : "",
    address:
      addressContact?.address ||
      corpus.match(/(?:Address:\s*)?(Nolam,?\s*P\.O\.\s*Mirzanagar[^.\n]*Dhaka-1344)/i)?.[1] ||
      "",
    statistics: {
      undergraduateStudents: statistic("Undergraduate Students"),
      graduateStudents: statistic("Graduate Students"),
      facultyMembers: statistic("Faculty Members"),
      officeStaff: statistic("Office Staff"),
    },
    sources: officialPages.slice(0, 5).map((page) => ({ title: page.title, url: page.url })),
  };
}

const institutionFacts = extractInstitutionFacts(pages, uniqueContacts);
const usableDocuments = documentsWithText.filter((document) => document.textQuality !== "none");

if (pages.length === 0) {
  console.error("Knowledge build failed: no pages were crawled. Existing knowledge file was not overwritten.");
  process.exit(1);
}

const target = process.env.KNOWLEDGE_OUTPUT || "data/knowledge.json";
let preservedExternalKnowledge = null;
let preservedExternalPages = [];
if (!process.env.KNOWLEDGE_OUTPUT) {
  let previousPageCount = 0;
  try {
    const previous = JSON.parse(await readFile(target, "utf8"));
    previousPageCount = Number(previous.pageCount || previous.pages?.length || 0);
    preservedExternalKnowledge = previous.externalKnowledge || null;
    preservedExternalPages = Array.isArray(previous.externalPages) ? previous.externalPages : [];
  } catch {
    // A first build has no previous coverage to protect.
  }
  const minimumPageCount = previousPageCount >= 100 ? Math.max(500, Math.floor(previousPageCount * 0.65)) : 100;
  const structuredCoverageOk = uniquePrograms.length >= 10 && uniqueRoles.length >= 3 && uniqueContacts.length >= 3;
  if (pages.length < minimumPageCount || !structuredCoverageOk) {
    console.error(
      `Knowledge build rejected by coverage gate: ${pages.length}/${minimumPageCount} pages, ${uniquePrograms.length} programs, ${uniqueRoles.length} roles, ${uniqueContacts.length} contacts. Existing knowledge was preserved.`,
    );
    process.exit(1);
  }
}

const knowledge = {
  schemaVersion: 2,
  builtAt: new Date().toISOString(),
  source: sourceUrl,
  pageCount: pages.length,
  coverage: {
    discoveredUrls: discoveredUrls.length,
    crawledUrls: seen.size,
    indexedPages: pages.length,
    totalChunks: pages.reduce((total, page) => total + page.chunks.length, 0),
    departments,
    pageTypes: pageTypeCounts,
    pdfs: usableDocuments.length,
    attemptedPdfs: documentsWithText.length,
    lowQualityPdfs: usableDocuments.filter((document) => document.textQuality === "low").length,
  },
  institution: institutionFacts,
  programs: uniquePrograms,
  faculty: uniqueFaculty,
  roles: uniqueRoles,
  fees: uniqueFees,
  contacts: uniqueContacts,
  notices: uniqueNotices,
  documents: usableDocuments,
  pages,
  externalKnowledge: preservedExternalKnowledge,
  externalPages: preservedExternalPages,
};

await mkdir("data", { recursive: true });
const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
await writeFile(temporary, JSON.stringify(knowledge, null, 2));
await rename(temporary, target);

console.log(
  `Knowledge built: ${pages.length} pages, ${uniquePrograms.length} programs, ${uniqueFaculty.length} people, ${uniqueRoles.length} roles, ${uniqueFees.length} fees, ${uniqueContacts.length} contacts, ${uniqueNotices.length} notices, ${usableDocuments.length}/${documentsWithText.length} readable PDFs`,
);
