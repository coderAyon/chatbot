import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFollowupFormatType,
  isFollowupFormatInstruction,
  reformatTextDeterministically,
  directAnswer,
  handleFollowupFormatRequest,
} from "./api-server.mjs";

const sampleFixture = {
  programs: [
    {
      name: "B.Sc. (Honours) in Computer Science & Engineering",
      department: "Computer Science & Engineering",
      admissionRequirement: "SSC and HSC combined GPA 6.50 with minimum 3.00 in each.",
      duration: "4 Years (8 Semesters)",
      seats: "100",
      sourceTitle: "CSE Department",
      source: "https://gonouniversity.edu.bd/academic/cse/",
    },
  ],
  fees: [
    {
      program: "B.Sc. (Honours) in Computer Science & Engineering",
      aliases: ["CSE", "Computer Science"],
      admissionCost: "Tk. 4,50,000/-",
      admissionCostIncludes: "Total 4-year tuition fee",
      sourceTitle: "Tuition and Other Fees - Gono Bishwabidyalay",
      source: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/",
      note: "Total 4-year tuition fee is Tk. 4,50,000/- with admission initial payment Tk. 54,500/-.",
    },
  ],
  faculty: [
    {
      name: "Abu Daud",
      designation: "Assistant Professor & Head",
      department: "Computer Science & Engineering",
      role: "faculty",
      sourceTitle: "CSE Faculty",
      source: "https://gonouniversity.edu.bd/cse-faculty/",
    },
  ],
  officers: [],
  pages: [],
};

test("detectFollowupFormatType correctly identifies Banglish, Bengali, and English formatting intents", () => {
  // Expand / make longer
  assert.equal(detectFollowupFormatType("ektu boro kore dau"), "expand");
  assert.equal(detectFollowupFormatType("boro kore dao"), "expand");
  assert.equal(detectFollowupFormatType("aro boro kore bolo"), "expand");
  assert.equal(detectFollowupFormatType("aro details bolo"), "expand");
  assert.equal(detectFollowupFormatType("details e bolo"), "expand");
  assert.equal(detectFollowupFormatType("bistarito bolo"), "expand");
  assert.equal(detectFollowupFormatType("বড় করে দাও"), "expand");
  assert.equal(detectFollowupFormatType("বিস্তারিত বলুন"), "expand");
  assert.equal(detectFollowupFormatType("make it longer"), "expand");
  assert.equal(detectFollowupFormatType("explain in detail"), "expand");

  // Shorten / summarize / brief
  assert.equal(detectFollowupFormatType("choto kore dau"), "shorten");
  assert.equal(detectFollowupFormatType("choto kore dao"), "shorten");
  assert.equal(detectFollowupFormatType("short kore bolo"), "shorten");
  assert.equal(detectFollowupFormatType("shongkhepe bolo"), "shorten");
  assert.equal(detectFollowupFormatType("brief e bolo"), "shorten");
  assert.equal(detectFollowupFormatType("summary dao"), "shorten");
  assert.equal(detectFollowupFormatType("ছোট করে দিন"), "shorten");
  assert.equal(detectFollowupFormatType("সংক্ষেপে বলুন"), "shorten");
  assert.equal(detectFollowupFormatType("make it shorter"), "shorten");
  assert.equal(detectFollowupFormatType("summarize this"), "shorten");

  // Bullet points / in points / list
  assert.equal(detectFollowupFormatType("point akare dau"), "points");
  assert.equal(detectFollowupFormatType("point akare dao"), "points");
  assert.equal(detectFollowupFormatType("point kore bolo"), "points");
  assert.equal(detectFollowupFormatType("bullet point e dao"), "points");
  assert.equal(detectFollowupFormatType("bullet points e bolo"), "points");
  assert.equal(detectFollowupFormatType("in points"), "points");
  assert.equal(detectFollowupFormatType("point by point"), "points");
  assert.equal(detectFollowupFormatType("list akare dau"), "points");
  assert.equal(detectFollowupFormatType("পয়েন্ট আকারে দিন"), "points");
  assert.equal(detectFollowupFormatType("পয়েন্ট করে বলুন"), "points");

  // Simplify
  assert.equal(detectFollowupFormatType("shohoj kore bolo"), "simplify");
  assert.equal(detectFollowupFormatType("সহজ করে বুঝিয়ে দাও"), "simplify");
  assert.equal(detectFollowupFormatType("simplify this"), "simplify");
});

test("detectFollowupFormatType rejects non-followups and ordinal topic recalls", () => {
  assert.equal(detectFollowupFormatType("GPA 3.0 point thakle admission pabo?"), null);
  assert.equal(detectFollowupFormatType("grading point scale koto?"), null);
  assert.equal(detectFollowupFormatType("short course ache ki?"), null);
  assert.equal(detectFollowupFormatType("CSE te admission fee koto?"), null);
  assert.equal(detectFollowupFormatType("prothom topic ta abar details bolo"), null);
  assert.equal(detectFollowupFormatType("second topic one niye bolo"), null);
});

test("reformatTextDeterministically produces high-quality short, points, and expanded text", () => {
  const sample =
    "**Computer Science & Engineering (CSE)**\n" +
    "Total 4-year tuition fee is Tk. 4,50,000/-.\n" +
    "Admission time initial payment is Tk. 54,500/-.\n" +
    "Duration is 4 Years (8 Semesters) with 160 credits.\n" +
    "Admission requirement: SSC and HSC combined GPA 6.50.";

  // Shorten
  const shortened = reformatTextDeterministically(sample, "shorten", "choto kore dau", "cse fee koto");
  assert.match(shortened, /4,50,000/);
  assert.match(shortened, /সংক্ষেপে|Summary|In Short/i);

  // Points
  const points = reformatTextDeterministically(sample, "points", "point akare dau", "cse fee koto");
  assert.match(points, /4,50,000/);
  assert.match(points, /54,500/);
  assert.match(points, /-\s+\*\*/); // Bullet with bold header

  // Expand
  const expanded = reformatTextDeterministically(sample, "expand", "ektu boro kore dau", "cse fee koto", sampleFixture);
  assert.match(expanded, /4,50,000/);
  assert.match(expanded, /Computer Science/i);
  assert.match(expanded, /বিস্তারিত|Detailed Overview/i);
});

test("in Chatbot mode, choto kore dau preserves fee context and does not lose data", () => {
  // Turn 1: user asks fee
  const turn1Answer = directAnswer("cse fee koto?", sampleFixture, []);
  assert.equal(turn1Answer.mode, "structured");
  assert.match(turn1Answer.text, /4,50,000/);

  const history = [
    { role: "user", text: "cse fee koto?" },
    { role: "assistant", text: turn1Answer.text, sources: turn1Answer.sources, mode: turn1Answer.mode },
  ];

  // Turn 2: user says "choto kore dau"
  const turn2Answer = directAnswer("choto kore dau", sampleFixture, history);
  assert.equal(turn2Answer.mode, "structured");
  assert.match(turn2Answer.text, /4,50,000/);
  assert.match(turn2Answer.text, /সংক্ষেপে|Summary|In Short/i);
  assert.ok(turn2Answer.sources.length > 0);

  // Turn 3: user says "point akare dau"
  const historyTurn3 = [
    ...history,
    { role: "user", text: "choto kore dau" },
    { role: "assistant", text: turn2Answer.text, sources: turn2Answer.sources, mode: turn2Answer.mode },
  ];
  const turn3Answer = directAnswer("point akare dau", sampleFixture, historyTurn3);
  assert.match(turn3Answer.text, /4,50,000/);
  assert.match(turn3Answer.text, /-\s+/);

  // Turn 4: user says "ektu boro kore dau"
  const historyTurn4 = [
    ...historyTurn3,
    { role: "user", text: "point akare dau" },
    { role: "assistant", text: turn3Answer.text, sources: turn3Answer.sources, mode: turn3Answer.mode },
  ];
  const turn4Answer = directAnswer("ektu boro kore dau", sampleFixture, historyTurn4);
  assert.match(turn4Answer.text, /4,50,000/);
  assert.match(turn4Answer.text, /Computer Science|CSE/i);
});

test("in GB AI mode, handleFollowupFormatRequest preserves university chatbot branding and sources", async () => {
  const history = [
    { role: "user", text: "cse admission fee koto?" },
    {
      role: "assistant",
      text:
        "🏛️ **গণ বিশ্ববিদ্যালয় অফিশিয়াল চ্যাটবট ডাটাবেস (GB Chatbot):**\n\n" +
        "**B.Sc. (Honours) in Computer Science & Engineering**\n" +
        "Total 4-year tuition fee is Tk. 4,50,000/-.\n" +
        "Admission time initial payment: Tk. 54,500/-.\n" +
        "Minimum eligibility: SSC and HSC combined GPA 6.50.",
      mode: "gb_ai_university_chatbot",
      isUniversityQuery: true,
      sources: [{ title: "CSE Fees", url: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/" }],
    },
  ];

  const formatResult = await handleFollowupFormatRequest({
    message: "choto kore dau",
    history,
    knowledge: sampleFixture,
    sessionId: "test-session-gb-ai-format",
    isGbAi: true,
  });

  assert.ok(formatResult);
  assert.equal(formatResult.medium, "gb-ai");
  assert.equal(formatResult.mode, "gb_ai_university_chatbot");
  assert.equal(formatResult.isUniversityQuery, true);
  assert.match(formatResult.text, /🏛️ \*\*গণ বিশ্ববিদ্যালয় অফিশিয়াল চ্যাটবট ডাটাবেস/);
  assert.match(formatResult.text, /4,50,000/);
  assert.equal(formatResult.sources.length, 1);
  assert.equal(formatResult.sources[0].title, "CSE Fees");
});

test("in GB AI mode, general academic questions preserve academic context across formatting follow-ups", async () => {
  const history = [
    { role: "user", text: "What is photosynthesis?" },
    {
      role: "assistant",
      text:
        "Photosynthesis is the process by which green plants and certain other organisms transform light energy into chemical energy. " +
        "During photosynthesis in green plants, light energy is captured and used to convert water, carbon dioxide, and minerals into oxygen and energy-rich organic compounds.",
      mode: "gb_ai_solution",
      aiModel: "GB AI",
      sources: [],
    },
  ];

  const pointsResult = await handleFollowupFormatRequest({
    message: "point akare dau",
    history,
    knowledge: sampleFixture,
    sessionId: "test-session-general-academic",
    isGbAi: true,
  });

  assert.ok(pointsResult);
  assert.equal(pointsResult.medium, "gb-ai");
  assert.equal(pointsResult.mode, "gb_ai_solution");
  assert.match(pointsResult.text, /Photosynthesis|plants|chemical energy/i);
  assert.match(pointsResult.text, /-\s+/); // Bullet points
});
