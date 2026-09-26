import { readFile, rename, writeFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";

const knowledgePath = new URL("../data/knowledge.json", import.meta.url);
const coreDocuments = [
  {
    title: "CSE Syllabus (effective October 2018)",
    url: "https://gonouniversity.edu.bd/cse/wp-content/uploads/sites/2/2024/11/CSE-Syllabus-2018.pdf",
    pageUrl: "https://gonouniversity.edu.bd/cse/ug-programme/course-description/",
  },
];

function cleanText(value) {
  return String(value || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function chunks(text, size = 1300) {
  const paragraphs = text.split(/\n{2,}/).filter(Boolean);
  const result = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) {
      result.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) result.push(current);
  return result;
}

const knowledge = JSON.parse(await readFile(knowledgePath, "utf8"));
for (const document of coreDocuments) {
  const response = await fetch(document.url);
  if (!response.ok) throw new Error(`Could not download ${document.url}: HTTP ${response.status}`);
  const parser = new PDFParse({ data: Buffer.from(await response.arrayBuffer()) });
  try {
    const result = await parser.getText();
    const text = cleanText(result.text);
    const record = { ...document, text, chunks: chunks(text), pageCount: result.total || null, textQuality: "text" };
    knowledge.documents = (knowledge.documents || []).filter((item) => item.url !== document.url);
    knowledge.documents.push(record);
  } finally {
    await parser.destroy();
  }
}

knowledge.coverage = knowledge.coverage || {};
knowledge.coverage.pdfs = knowledge.documents.length;
knowledge.coreEnrichedAt = new Date().toISOString();
const temporary = new URL(`../data/knowledge.json.${process.pid}.tmp`, import.meta.url);
await writeFile(temporary, JSON.stringify(knowledge, null, 2));
await rename(temporary, knowledgePath);
console.log(`Added ${coreDocuments.length} verified core syllabus document(s).`);
