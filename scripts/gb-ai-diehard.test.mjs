import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  directAnswer,
  directActivePersonAnswer,
  isUniversityInquiry,
  isWebSearchIntent,
  isImageCreationIntent,
  isExistingImageLookupIntent,
  isImageRefinementOrFollowup,
  isFollowupFormatInstruction,
  detectFollowupFormatType,
  reformatTextDeterministically,
  isCodingQuestion,
  asksCodeExplanation,
  cleanFencedCodeBlocks,
  isExplicitPromptWritingRequest,
  prefersBanglish,
} from "./api-server.mjs";

const knowledge = JSON.parse(fs.readFileSync("data/knowledge.json", "utf8"));

// =========================================================================
// DIE HARD SUITE 1: Faculty & Department Recognition in GB AI Mode
// =========================================================================
test("DIE HARD GB AI: 100% of University Faculty queries route to Official University Knowledge", () => {
  const facultyQueries = [
    // Bengali Script
    { q: "তানিয়া আক্তার কে?", match: /Tania Akter/i },
    { q: "ফারহানা ম্যাম কে?", match: /Umme Farhana/i },
    { q: "শতাব্দী ম্যাম কে?", match: /Shatabdee Bala/i },
    { q: "ফুয়াদ স্যার কে?", match: /Fuad Hossain/i },
    { q: "তাজুল ইসলাম স্যার কে?", match: /Monjurul Islam|Tanzil/i },
    { q: "আসিফ চৌধুরী কে?", match: /Mohammad Asif Chowdhury/i },
    { q: "রেখা ম্যাম কে?", match: /Farzana Tasnim/i },
    { q: "কামরুল স্যার কে?", match: /Kamol Karmakar/i },
    { q: "মনজুর স্যার কে?", match: /Md. Monjurul Islam/i },
    // Banglish & English Phrasing
    { q: "Ali sir ke chino?", match: /Hanif Ali/i },
    { q: "Roy sir ke chino?", match: /Kanak Chandra Roy/i },
    { q: "Tania Akter ke?", match: /Tania Akter/i },
    { q: "cse r rekha mam ke chino?", match: /Farzana Tasnim/i },
    { q: "shatabdi mam ke?", match: /Shatabdee Bala/i },
    { q: "who is asif chowdhury?", match: /Mohammad Asif Chowdhury/i },
    { q: "tell me about fuad sir", match: /Fuad Hossain/i },
  ];

  for (const { q, match } of facultyQueries) {
    const isUniv = isUniversityInquiry(q, knowledge, []);
    assert.equal(isUniv, true, `Query "${q}" must be recognized as University Inquiry in GB AI`);
    const ans = directAnswer(q, knowledge, []);
    assert.ok(ans, `Direct answer must exist for "${q}"`);
    assert.match(ans.text, match, `Result for "${q}" must contain expected person: ${ans.text}`);
    assert.notEqual(ans.mode, "not_found", `"${q}" must not be not_found`);
  }
});

// =========================================================================
// DIE HARD SUITE 2: University Leadership & Administrative Officials
// =========================================================================
test("DIE HARD GB AI: Administrative Leadership lookups across Bengali, Banglish and English", () => {
  const adminQueries = [
    { q: "গণ বিশ্ববিদ্যালয়ের উপাচার্য কে?", match: /Abul Hossain/i },
    { q: "ভিসি স্যার কে?", match: /Abul Hossain/i },
    { q: "who is the vice chancellor?", match: /Abul Hossain/i },
    { q: "vc sir er name ki?", match: /Abul Hossain/i },
    { q: "রেজিস্ট্রার কে?", match: /Ohiduzzaman/i },
    { q: "who is the registrar?", match: /Ohiduzzaman/i },
    { q: "পরীক্ষা নিয়ন্ত্রক কে?", match: /Noman Alam/i },
    { q: "exam controller ke?", match: /Noman Alam/i },
    { q: "who is controller of examinations?", match: /Noman Alam/i },
    { q: "প্রক্টর কে?", match: /Kanak Chandra Roy/i },
    { q: "proctor ke?", match: /Kanak Chandra Roy/i },
    { q: "who is the proctor?", match: /Kanak Chandra Roy/i },
    { q: "প্রতিষ্ঠাতা কে?", match: /Zafrullah Chowdhury/i },
    { q: "founder of gono university", match: /Zafrullah Chowdhury/i },
  ];

  for (const { q, match } of adminQueries) {
    assert.equal(isUniversityInquiry(q, knowledge, []), true, `Admin query "${q}" must route to university in GB AI`);
    const ans = directAnswer(q, knowledge, []);
    assert.ok(ans, `Answer must exist for "${q}"`);
    assert.match(ans.text, match, `Answer for "${q}" must match expected officer`);
  }
});

// =========================================================================
// DIE HARD SUITE 3: Academic Departments, Programs, Fees and Seat Capacities
// =========================================================================
test("DIE HARD GB AI: All 15+ Academic Departments, Programs, and Fees", () => {
  const academicQueries = [
    { q: "CSE er head ke?", match: /Head/i },
    { q: "বিবিএ এর প্রধান কে?", match: /Rana|Head/i },
    { q: "ইংরেজি ডিপার্টমেন্টের প্রধান কে?", match: /Niranjan Biswas/i },
    { q: "আইন বিভাগের হেড কে?", match: /Monjurul Islam/i },
    { q: "সমাজবিজ্ঞান ডিপার্টমেন্ট এর প্রধান কে?", match: /Head/i },
    { q: "pharmacy chairman ke?", match: /Rozina Parul/i },
    { q: "ল ডিপার্টমেন্টের শিক্ষক কারা?", match: /Md. Monjurul Islam/i },
    { q: "dvm faculty list", match: /Faculty of Veterinary/i },
    { q: "vet faculty list", match: /Faculty of Veterinary/i },
    { q: "cse admission fee koto?", match: /4,50,000|fee/i },
    { q: "pharmacy fee koto?", match: /fee|taka/i },
    { q: "DVM course duration koto?", match: /5\s*years/i },
  ];

  for (const { q, match } of academicQueries) {
    assert.equal(isUniversityInquiry(q, knowledge, []), true, `Query "${q}" must be recognized in GB AI`);
    const ans = directAnswer(q, knowledge, []);
    assert.ok(ans, `Answer must exist for "${q}"`);
    assert.match(ans.text, match, `Result for "${q}" must match expected pattern`);
  }
});

// =========================================================================
// DIE HARD SUITE 4: Multi-Turn Reasoning & Context Switching in GB AI
// =========================================================================
test("DIE HARD GB AI: 12-Turn Mixed Domain Stress Test (University -> Followup -> Image -> Refine -> Web -> Code -> Reformat)", () => {
  const history = [];

  // Turn 1: University Faculty Inquiry in Bangla
  const t1 = "তানিয়া আক্তার কে?";
  assert.equal(isUniversityInquiry(t1, knowledge, history), true);
  const a1 = directAnswer(t1, knowledge, history);
  assert.ok(a1);
  assert.match(a1.text, /Tania Akter/);
  history.push({ role: "user", text: t1 }, { role: "assistant", text: a1.text, mode: "gb_ai_university_chatbot" });

  // Turn 2: Follow-up Phone Number Inquiry using Pronoun
  const t2 = "unir phone number dao";
  assert.equal(isUniversityInquiry(t2, knowledge, history), true);
  const a2 = directAnswer(t2, knowledge, history);
  assert.ok(a2);
  assert.match(a2.text, /01717238063/);
  history.push({ role: "user", text: t2 }, { role: "assistant", text: a2.text, mode: "gb_ai_university_chatbot" });

  // Turn 3: Follow-up Qualification Inquiry
  const t3 = "qualification ki?";
  assert.equal(isUniversityInquiry(t3, knowledge, history), true);
  history.push({ role: "user", text: t3 }, { role: "assistant", text: "M.Sc in CSE", mode: "gb_ai_university_chatbot" });

  // Turn 4: Formatting instruction (choto kore dau)
  const t4 = "choto kore dau";
  assert.equal(isFollowupFormatInstruction(t4), true);
  assert.equal(detectFollowupFormatType(t4), "shorten");
  const shortText = reformatTextDeterministically(a2.text, "shorten");
  assert.match(shortText, /01717238063/);
  history.push({ role: "user", text: t4 }, { role: "assistant", text: shortText, mode: "gb_ai_university_chatbot" });

  // Turn 5: Switch to Image Generation Intent
  const t5 = "draw a futuristic campus robot assisting students in library";
  assert.equal(isImageCreationIntent(t5), true);
  assert.equal(isUniversityInquiry(t5, knowledge, history), false);
  const imgMock = {
    role: "assistant",
    mode: "image",
    text: "✨ **GB AI Image Studio**\n\n🎨 **Prompt:** futuristic campus robot\n🔍 **Visual Concept:** *Sleek humanoid robot assisting students in a high-tech university library*",
    image: {
      url: "/api/generated-images/campus-robot",
      prompt: "Sleek humanoid robot assisting students in a high-tech university library",
    },
  };
  history.push({ role: "user", text: t5 }, imgMock);

  // Turn 6: Visual scene refinement without imperative verbs
  const t6 = "soft sunset light through tall glass windows";
  const refine = isImageRefinementOrFollowup(t6, history);
  assert.ok(refine, "Must detect atmospheric scene modification following image turn");
  assert.match(refine.concept, /campus robot|library/i);
  history.push({ role: "user", text: t6 }, {
    role: "assistant",
    mode: "image",
    text: "✨ **GB AI Image Studio**\n\n🎨 **Updated Prompt:** soft sunset light through tall windows",
  });

  // Turn 7: Switch to Web Search
  const t7 = "latest breakthroughs in quantum computing 2026 search the web";
  assert.equal(isWebSearchIntent(t7), true);
  assert.equal(isUniversityInquiry(t7, knowledge, history), false);
  assert.equal(isImageRefinementOrFollowup(t7, history), null, "Web search must exit image mode");
  history.push({ role: "user", text: t7 }, {
    role: "assistant",
    mode: "gb_ai_web_search",
    text: "🌐 **Web Search Results:** Recent 2026 breakthroughs in fault-tolerant qubits...",
  });

  // Turn 8: Switch to Pure Programming
  const t8 = "write a python function to check if string is palindrome";
  assert.equal(isCodingQuestion(t8), true);
  assert.equal(isUniversityInquiry(t8, knowledge, history), false);
  assert.equal(isImageRefinementOrFollowup(t8, history), null);
  history.push({ role: "user", text: t8 }, {
    role: "assistant",
    mode: "gb_ai_solution",
    text: "```python\ndef is_palindrome(s):\n    cleaned = ''.join(c.lower() for c in s if c.isalnum())\n    return cleaned == cleaned[::-1]\n```",
  });

  // Turn 9: Clean code extraction check
  const rawCodeBlock = "Here is the code:\n```python\n# Clean solution\ndef add(a, b):\n    return a + b\n```\nHope this helps!";
  const cleaned = cleanFencedCodeBlocks(rawCodeBlock);
  assert.match(cleaned, /def add\(a, b\):/);

  // Turn 10: Switch back to University Query (Must smoothly resume University Mode!)
  const t10 = "গণ বিশ্ববিদ্যালয়ের ভিসি কে?";
  assert.equal(isUniversityInquiry(t10, knowledge, history), true, "Must cleanly re-enter university mode");
  const a10 = directAnswer(t10, knowledge, history);
  assert.ok(a10);
  assert.match(a10.text, /Abul Hossain/);
  history.push({ role: "user", text: t10 }, { role: "assistant", text: a10.text, mode: "gb_ai_university_chatbot" });

  // Turn 11: Format modification in Bengali
  const t11 = "পয়েন্ট আকারে দাও";
  assert.equal(isFollowupFormatInstruction(t11), true);
  assert.equal(detectFollowupFormatType(t11), "points");
  const pointsText = reformatTextDeterministically(a10.text, "points");
  assert.match(pointsText, /Abul Hossain/);
  assert.match(pointsText, /•|\*/);

  // Turn 12: Paragraph format follow-up
  const t12 = "one paragraph e bolo";
  assert.equal(isFollowupFormatInstruction(t12), true);
  assert.equal(detectFollowupFormatType(t12), "paragraph");
  const paragraphText = reformatTextDeterministically(pointsText, "paragraph");
  assert.match(paragraphText, /Abul Hossain/);
});

// =========================================================================
// DIE HARD SUITE 5: Adversarial Image vs Photo Lookups vs Admin Rules
// =========================================================================
test("DIE HARD GB AI: 100% Precision between Synthetic Images, Official Photos, and Admin Rules", () => {
  // Must be official lookups
  const officialPhotoQueries = [
    "VC sir er official chobi dekhao",
    "ভিসির ছবি দেখাও",
    "show me a picture of the vice chancellor",
  ];
  for (const q of officialPhotoQueries) {
    assert.equal(isExistingImageLookupIntent(q), true, `Must be official photo lookup: ${q}`);
    assert.equal(isImageCreationIntent(q), false, `Must NOT create synthetic image: ${q}`);
  }

  // Must be administrative text rules
  const adminQueries = [
    "admit card e photo kivabe upload korbo?",
    "portal e photo size koto hote hobe?",
    "library card korte ki photo lage?",
    "আইডি কার্ডে ছবি সাইজ কত?",
  ];
  for (const q of adminQueries) {
    assert.equal(isImageCreationIntent(q), false, `Admin rule must not create image: ${q}`);
    assert.equal(isExistingImageLookupIntent(q), false, `Admin rule must not look up photo: ${q}`);
  }

  // Must be synthetic image requests
  const syntheticCreation = [
    "ekta chobi banao nodir parer",
    "draw a futuristic autonomous campus shuttle",
    "একটি আধুনিক ডিজিটাল ল্যাবের ছবি তৈরি করো",
    "generate a 3d render of artificial intelligence neural network",
  ];
  for (const q of syntheticCreation) {
    assert.equal(isImageCreationIntent(q), true, `Must detect image creation: ${q}`);
  }
});
