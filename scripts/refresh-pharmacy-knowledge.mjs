import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";

const KNOWLEDGE_FILE = new URL("../data/knowledge.json", import.meta.url);
const pharmacyUrls = [
  "https://gonouniversity.edu.bd/pharmacy/faculty-members/",
  "https://gonouniversity.edu.bd/pharmacy/employees/",
  "https://gonouniversity.edu.bd/pharmacy/",
];

function cleanText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(href, base) {
  try {
    const url = new URL(href, base);
    url.hash = "";
    return url.toString().replace(/\/?$/, url.pathname.includes(".") ? "" : "/");
  } catch {
    return "";
  }
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "University RAG Assistant Targeted Knowledge Refresh",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${response.statusText}`);
  return response.text();
}

function extractPeople(html, pageUrl) {
  const $ = load(html);
  const people = [];
  $(".employee-list-card").each((_, card) => {
    const root = $(card);
    const name = cleanText(root.find(".employee-list-card-name, h3, h4").first().text());
    if (!name || name.length > 90) return;
    const designation = cleanText(root.find(".employee-list-card-designation, .designation, .position").first().text());
    const phone =
      cleanText(root.find(".employee-list-card-phone, a[href^='tel:']").first().text()).replace(/[^\d,+ ]/g, "").trim() ||
      cleanText(root.find(".employee-list-card-phone span").attr("title") || "");
    const email =
      cleanText(root.find(".employee-list-card-email, a[href^='mailto:']").first().text()).replace(/^mailto:/i, "") ||
      cleanText(root.find(".employee-list-card-email span").attr("title") || "") ||
      cleanText((root.find("a[href^='mailto:']").attr("href") || "").replace(/^mailto:/i, ""));
    const qualification = cleanText(root.find(".employee-list-card-qualification, .qualification").first().text());
    const profileUrl = normalizeUrl(root.find("a.read-more-btn, a").attr("href") || "", pageUrl);
    people.push({
      name,
      designation,
      phone,
      email,
      qualification,
      department: "Department of Pharmacy",
      source: "https://gonouniversity.edu.bd/pharmacy/faculty-members/",
      profileUrl: profileUrl || pageUrl,
    });
  });
  return people;
}

async function writeJsonAtomic(url, value) {
  const targetPath = fileURLToPath(url);
  const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpPath, JSON.stringify(value, null, 2));
  await rename(tmpPath, targetPath);
}

const knowledge = JSON.parse(await readFile(KNOWLEDGE_FILE, "utf8"));
const pharmacyPeople = [];
for (const url of pharmacyUrls) {
  pharmacyPeople.push(...extractPeople(await fetchHtml(url), url));
}

const uniquePharmacyPeople = Array.from(
  new Map(pharmacyPeople.map((person) => [`${person.name}:${person.department}`, person])).values(),
);

knowledge.faculty = [
  ...(knowledge.faculty || []).filter((person) => person.department !== "Department of Pharmacy"),
  ...uniquePharmacyPeople,
];

const pharmacyPageText = `Department of Pharmacy official faculty members: ${uniquePharmacyPeople
  .map((person) => `${person.name}${person.designation ? ` (${person.designation})` : ""}`)
  .join(", ")}.`;
knowledge.pages = (knowledge.pages || []).filter((page) => page.url !== "https://gonouniversity.edu.bd/pharmacy/faculty-members/");
knowledge.pages.push({
  url: "https://gonouniversity.edu.bd/pharmacy/faculty-members/",
  title: "Department of Pharmacy Faculty Members",
  chunks: [pharmacyPageText],
});
knowledge.pageCount = knowledge.pages.length;
knowledge.builtAt = new Date().toISOString();

await writeJsonAtomic(KNOWLEDGE_FILE, knowledge);
console.log(`Refreshed Pharmacy knowledge: ${uniquePharmacyPeople.length} official people records`);
