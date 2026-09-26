import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";

const KNOWLEDGE_FILE = new URL("../data/knowledge.json", import.meta.url);
const officialRoot = "https://gonouniversity.edu.bd/";
const rootHints = [
  "pharmacy",
  "cse",
  "microbiology",
  "bba",
  "bangla",
  "english",
  "politics",
  "law",
  "veterinary",
  "agriculture",
  "employees",
];

function cleanText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(href, base = officialRoot) {
  try {
    const url = new URL(href, base);
    if (url.hostname !== "gonouniversity.edu.bd") return "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/?$/, url.pathname.includes(".") ? "" : "/");
  } catch {
    return "";
  }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "University RAG Assistant People Knowledge Refresh",
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOptionalHtml(url) {
  try {
    return await fetchHtml(url);
  } catch {
    return "";
  }
}

function departmentFromPage($, pageUrl) {
  const pathPart = new URL(pageUrl).pathname.split("/").filter(Boolean)[0] || "";
  const rootNames = {
    bba: "Department of Business Administration",
    cse: "Department of Computer Science and Engineering (CSE)",
    bangla: "Department of Bangla",
    english: "Department of English",
    politics: "Department of Politics and Governance",
    law: "Department of Law",
    veterinary: "Department of Veterinary and Animal Sciences",
    agriculture: "Department of Agriculture",
    microbiology: "Department of Microbiology",
    pharmacy: "Department of Pharmacy",
    employees: "Gono University",
  };
  if (rootNames[pathPart]) return rootNames[pathPart];
  const title = cleanText($("title").first().text());
  const heading = cleanText($("h1, h2").first().text());
  const combined = `${heading} ${title}`;
  const departmentMatch = combined.match(/Department of [^-|]+/i);
  if (departmentMatch) return cleanText(departmentMatch[0]);
  return cleanText(pathPart.replace(/-/g, " ")) || "Gono University";
}

function textOrTitle(root, selector) {
  const element = root.find(selector).first();
  return cleanText(element.text()) || cleanText(element.attr("title") || "");
}

function extractPeopleCards(html, pageUrl) {
  const $ = load(html);
  const department = departmentFromPage($, pageUrl);
  const people = [];
  $(".employee-list-card, .team-member, .faculty-member, .staff-member").each((_, card) => {
    const root = $(card);
    const name =
      cleanText(root.find(".employee-list-card-name, .team-name, .member-name, h3, h4").first().text()) ||
      cleanText(root.find("a").first().text());
    if (!name || name.length > 90 || /\b(view profile|read more|details)\b/i.test(name)) return;
    const profileUrl = normalizeUrl(root.find("a.read-more-btn, a").attr("href") || "", pageUrl) || pageUrl;
    const phone = textOrTitle(root, ".employee-list-card-phone, a[href^='tel:']").replace(/[^\d,+ ]/g, "").trim();
    const email =
      textOrTitle(root, ".employee-list-card-email, a[href^='mailto:']").replace(/^mailto:/i, "") ||
      cleanText((root.find("a[href^='mailto:']").attr("href") || "").replace(/^mailto:/i, ""));
    const designation = cleanText(root.find(".employee-list-card-designation, .designation, .position").first().text());
    const qualification = cleanText(root.find(".employee-list-card-qualification, .qualification").first().text());
    people.push({
      name,
      designation,
      phone,
      email,
      qualification,
      department,
      source: pageUrl,
      profileUrl,
    });
  });
  return people;
}

function discoverLinks(html, baseUrl) {
  const $ = load(html);
  const links = new Set();
  $("a[href]").each((_, link) => {
    const url = normalizeUrl($(link).attr("href") || "", baseUrl);
    if (url) links.add(url);
  });
  return links;
}

async function discoverDepartmentRoots() {
  const roots = new Set(rootHints.map((path) => normalizeUrl(`/${path}/`)).filter(Boolean));
  for (const url of [officialRoot, normalizeUrl("/academics/")]) {
    const html = await fetchOptionalHtml(url);
    for (const link of discoverLinks(html, url)) {
      const path = new URL(link).pathname.split("/").filter(Boolean);
      if (path.length !== 1) continue;
      if (/(pharmacy|cse|microbiology|bba|bangla|english|politics|law|veterinary|agriculture|business|department)/i.test(link)) {
        roots.add(link);
      }
    }
  }
  return [...roots].sort();
}

async function candidatePagesForRoot(root) {
  const candidates = new Set([
    root,
    normalizeUrl("faculty-members/", root),
    normalizeUrl("employees/", root),
    normalizeUrl("employee/", root),
    normalizeUrl("staff/", root),
  ]);
  const html = await fetchOptionalHtml(root);
  for (const link of discoverLinks(html, root)) {
    if (/(faculty-members|employees|employee|staff|teacher)/i.test(link)) candidates.add(link);
  }
  return [...candidates].filter(Boolean);
}

async function writeJsonAtomic(url, value) {
  const targetPath = fileURLToPath(url);
  const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpPath, JSON.stringify(value, null, 2));
  await rename(tmpPath, targetPath);
}

const knowledge = JSON.parse(await readFile(KNOWLEDGE_FILE, "utf8"));
const roots = await discoverDepartmentRoots();
const people = [];
const sourcePages = new Map();

for (const root of roots) {
  for (const pageUrl of await candidatePagesForRoot(root)) {
    const html = await fetchOptionalHtml(pageUrl);
    if (!html) continue;
    const extracted = extractPeopleCards(html, pageUrl);
    if (!extracted.length) continue;
    people.push(...extracted);
    sourcePages.set(pageUrl, extracted);
  }
}

function recordQuality(person) {
  return Number(Boolean(person.phone)) + Number(Boolean(person.email)) + Number(Boolean(person.qualification)) + Number(/faculty-members|employees/i.test(person.source || ""));
}

const uniquePeopleMap = new Map();
for (const person of people) {
  const key = `${cleanText(person.name).toLowerCase()}:${person.department}`;
  const existing = uniquePeopleMap.get(key);
  if (!existing || recordQuality(person) > recordQuality(existing)) uniquePeopleMap.set(key, person);
}
const uniquePeople = [...uniquePeopleMap.values()];
const refreshedDepartments = new Set(uniquePeople.map((person) => person.department));
const refreshedProfiles = new Set(uniquePeople.map((person) => normalizeUrl(person.profileUrl)).filter(Boolean));

knowledge.faculty = [
  ...(knowledge.faculty || []).filter((person) => {
    const profile = normalizeUrl(person.profileUrl);
    if (profile && refreshedProfiles.has(profile)) return false;
    if (refreshedDepartments.has(person.department)) return false;
    return true;
  }),
  ...uniquePeople,
].sort((a, b) => (a.department || "").localeCompare(b.department || "") || (a.name || "").localeCompare(b.name || ""));

const departmentGroups = new Map();
for (const person of uniquePeople) {
  const list = departmentGroups.get(person.department) || [];
  list.push(person);
  departmentGroups.set(person.department, list);
}

knowledge.pages = (knowledge.pages || []).filter((page) => !/^people-refresh:/.test(page.id || ""));
for (const [department, list] of departmentGroups.entries()) {
  knowledge.pages.push({
    id: `people-refresh:${department}`,
    url: list[0]?.source || officialRoot,
    title: `${department} People`,
    chunks: [
      `${department} official people records: ${list
        .map((person) => `${person.name}${person.designation ? ` (${person.designation})` : ""}`)
        .join(", ")}.`,
    ],
  });
}
knowledge.pageCount = knowledge.pages.length;
knowledge.builtAt = new Date().toISOString();

await writeJsonAtomic(KNOWLEDGE_FILE, knowledge);
console.log(`Refreshed people knowledge: ${uniquePeople.length} official records from ${roots.length} roots`);
for (const [department, list] of departmentGroups.entries()) console.log(`${department}: ${list.length}`);
