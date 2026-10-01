import test from "node:test";
import assert from "node:assert/strict";
import {
  directAnswer,
  directActivePersonAnswer,
  directOfficialImageLookupAnswer,
  cleanImagePromptText,
  getLastImageContext,
  isImageRefinementOrFollowup,
  isImageCreationIntent,
  isExistingImageLookupIntent,
  isExplicitFreshImageIntent,
  isWebSearchIntent,
  isUniversityInquiry,
  detectFollowupFormatType,
  isFollowupFormatInstruction,
  reformatTextDeterministically,
  isCodingQuestion,
  asksCodeExplanation,
  cleanFencedCodeBlocks,
  isExplicitPromptWritingRequest,
} from "./api-server.mjs";

const knowledgeFixture = {
  programs: [
    {
      name: "B.Sc. (Honours) in Computer Science & Engineering",
      department: "Department of Computer Science and Engineering (CSE)",
      admissionRequirement: "SSC and HSC combined GPA 6.50 with minimum 3.00 in each.",
      duration: "4 Years (8 Semesters)",
      seats: "100",
      sourceTitle: "CSE Department",
      source: "https://gonouniversity.edu.bd/academic/cse/",
    },
    {
      name: "Bachelor of Pharmacy (Honours)",
      department: "Department of Pharmacy",
      admissionRequirement: "SSC and HSC with minimum GPA 7.00.",
      duration: "4 Years (8 Semesters)",
      seats: "120",
      sourceTitle: "Pharmacy Department",
      source: "https://gonouniversity.edu.bd/academic/pharmacy/",
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
      department: "Department of Computer Science and Engineering (CSE)",
      role: "faculty",
      sourceTitle: "CSE Faculty",
      source: "https://gonouniversity.edu.bd/cse-faculty/",
    },
  ],
  roles: [
    {
      key: "vice_chancellor",
      title: "Vice-Chancellor",
      name: "Professor Dr. Md. Abul Hossain",
      sourceTitle: "Office of the Vice-Chancellor",
      source: "https://gonouniversity.edu.bd/offices/office-of-the-vice-chancellor/",
    },
    {
      key: "proctor",
      title: "Proctor",
      name: "Dr. Example Proctor",
      sourceTitle: "Office of the Proctor",
      source: "https://gonouniversity.edu.bd/offices/proctor/",
    },
  ],
  institution: {
    name: "Gono Bishwabidyalay",
    founder: "Dr. Zafrullah Chowdhury",
    established: "14 July 1998",
    source: "https://gonouniversity.edu.bd/",
  },
  pages: [],
};

// -------------------------------------------------------------
// TEST SUITE 1: Hard Multi-Turn Conversational Transitions
// -------------------------------------------------------------
test("COMPLEX HARD: Multi-domain context switching across 10 conversational turns", () => {
  const history = [];

  // Turn 1: University question
  const q1 = "CSE admission fee koto?";
  assert.equal(isUniversityInquiry(q1, knowledgeFixture, history), true);
  assert.equal(isImageCreationIntent(q1), false);
  const a1 = directAnswer(q1, knowledgeFixture, []);
  assert.ok(a1, "Should answer fee query");
  assert.match(a1.text, /4,50,000/);
  history.push({ role: "user", text: q1 }, { role: "assistant", text: a1.text });

  // Turn 2: Follow-up formatting (shorten)
  const q2 = "choto kore dau";
  assert.equal(isFollowupFormatInstruction(q2), true);
  assert.equal(detectFollowupFormatType(q2), "shorten");
  assert.equal(isImageCreationIntent(q2), false);
  assert.equal(isImageRefinementOrFollowup(q2, history), null);
  const reformattedShort = reformatTextDeterministically(a1.text, "shorten");
  assert.match(reformattedShort, /4,50,000/);
  history.push({ role: "user", text: q2 }, { role: "assistant", text: reformattedShort });

  // Turn 3: Follow-up formatting (points)
  const q3 = "point akare dau";
  assert.equal(isFollowupFormatInstruction(q3), true);
  assert.equal(detectFollowupFormatType(q3), "points");
  assert.equal(isImageRefinementOrFollowup(q3, history), null);
  const reformattedPoints = reformatTextDeterministically(reformattedShort, "points");
  assert.match(reformattedPoints, /4,50,000/);
  assert.match(reformattedPoints, /•|\*/);
  history.push({ role: "user", text: q3 }, { role: "assistant", text: reformattedPoints });

  // Turn 4: University teacher inquiry
  const q4 = "CSE head of department ke?";
  assert.equal(isUniversityInquiry(q4, knowledgeFixture, history), true);
  assert.equal(isImageCreationIntent(q4), false);
  const a4 = directAnswer(q4, knowledgeFixture, history);
  assert.ok(a4);
  assert.match(a4.text, /Abu Daud/);
  history.push({ role: "user", text: q4 }, { role: "assistant", text: a4.text });

  // Turn 5: Pronoun follow-up about the teacher
  const q5 = "unir designation ki?";
  assert.equal(isUniversityInquiry(q5, knowledgeFixture, history), true);
  assert.equal(isImageRefinementOrFollowup(q5, history), null);
  history.push({ role: "user", text: q5 }, { role: "assistant", text: "Assistant Professor & Head" });

  // Turn 6: Switch to Image Creation
  const q6 = "create image of modern university library with glass windows";
  assert.equal(isImageCreationIntent(q6), true);
  assert.equal(isUniversityInquiry(q6, knowledgeFixture, history), false);
  const imgResponse = {
    role: "assistant",
    mode: "image",
    text: "✨ **GB AI Image Studio**\n\n🎨 **Prompt:** modern university library with glass windows\n🔍 **Visual Concept:** *Spacious university library with large floor to ceiling glass windows*",
    image: {
      url: "/api/generated-images/test-1",
      prompt: "Spacious university library with large floor to ceiling glass windows",
      originalPrompt: "modern university library with glass windows",
    },
  };
  history.push({ role: "user", text: q6 }, imgResponse);

  // Turn 7: Visual refinement without imperative verbs (User's real pain point)
  const q7 = "students sitting beside the bookshelves";
  const refinement7 = isImageRefinementOrFollowup(q7, history);
  assert.ok(refinement7, "Must detect spatial noun phrase as image refinement");
  assert.match(refinement7.concept, /glass windows/i);
  history.push({ role: "user", text: q7 }, {
    role: "assistant",
    mode: "image",
    text: "✨ **GB AI Image Studio**\n\n🎨 **Updated Prompt:** students sitting beside the bookshelves\n🔍 **Visual Concept:** *Spacious university library with students sitting beside bookshelves*",
  });

  // Turn 8: Another visual refinement (Weather/Atmosphere)
  const q8 = "rain falling outside the glass window";
  const refinement8 = isImageRefinementOrFollowup(q8, history);
  assert.ok(refinement8, "Must detect rain atmospheric refinement");
  history.push({ role: "user", text: q8 }, {
    role: "assistant",
    mode: "image",
    text: "✨ **GB AI Image Studio**\n\n🎨 **Updated Prompt:** rain falling outside\n🔍 **Visual Concept:** *Rain falling outside library glass window*",
  });

  // Turn 9: Sudden shift from image to Programming / Algorithm
  const q9 = "write python code for binary search";
  assert.equal(isCodingQuestion(q9), true);
  assert.equal(isImageRefinementOrFollowup(q9, history), null, "Coding query MUST NOT be treated as image refinement");
  assert.equal(isImageCreationIntent(q9), false);
  history.push({ role: "user", text: q9 }, {
    role: "assistant",
    text: "```python\ndef binary_search(arr, target):\n    low, high = 0, len(arr) - 1\n    while low <= high:\n        mid = (low + high) // 2\n        if arr[mid] == target:\n            return mid\n        elif arr[mid] < target:\n            low = mid + 1\n        else:\n            high = mid - 1\n    return -1\n```",
  });

  // Turn 10: Explicit prompt request (Must NOT create image!)
  const q10 = "FLUX er jonno ekta photorealistic prompt likhe dao";
  assert.equal(isExplicitPromptWritingRequest(q10), true);
  assert.equal(isImageRefinementOrFollowup(q10, history), null, "Prompt writing request MUST NOT generate image");
});

// -------------------------------------------------------------
// TEST SUITE 2: Hard Adversarial Ambiguities (Photo / Image Words)
// -------------------------------------------------------------
test("COMPLEX HARD: Disambiguating image generation vs official photo lookups vs photo rules", () => {
  // 1. Official Person Photo -> MUST be official lookup, NEVER synthetic generation
  assert.equal(isExistingImageLookupIntent("show me a photo of the vice chancellor"), true);
  assert.equal(isImageCreationIntent("show me a photo of the vice chancellor"), false);

  assert.equal(isExistingImageLookupIntent("VC sir er official chobi dekhao"), true);
  assert.equal(isImageCreationIntent("VC sir er official chobi dekhao"), false);

  assert.equal(isExistingImageLookupIntent("ভিসির ছবি দেখাও"), true);
  assert.equal(isImageCreationIntent("ভিসির ছবি দেখাও"), false);

  // 2. Administrative photo rules -> NEVER create image, NEVER official lookup
  const adminQueries = [
    "admit card e photo kivabe upload korbo?",
    "library card korte ki photo lage?",
    "campus e chobi tola ki nishedh?",
    "portal e photo size koto hote hobe?",
    "admit card er chobir size koto?",
    "ফরম পূরণে কি ছবি লাগবে?",
    "আইডি কার্ডে ছবি সাইজ কত?",
  ];
  for (const query of adminQueries) {
    assert.equal(isImageCreationIntent(query), false, `Should not treat admin rule as image creation: ${query}`);
    assert.equal(isExistingImageLookupIntent(query), false, `Should not treat admin rule as official lookup: ${query}`);
  }

  // 3. Genuine synthetic creation requests in various dialects
  const genuineCreationQueries = [
    "ekta chobi banao nodir parer",
    "draw an illustration of a flying car",
    "generate a photorealistic wallpaper of rainy dhaka city",
    "একটি মনোরম প্রাকৃতিক দৃশ্যের ছবি আঁকো",
    "campus main gate er ekta 3d render chobi create koro",
    "logo banao for my coding club",
    "draw a solitary cat sleeping on a wooden table at sunset",
  ];
  for (const query of genuineCreationQueries) {
    assert.equal(isImageCreationIntent(query), true, `Should detect genuine creation: ${query}`);
    assert.equal(isExistingImageLookupIntent(query), false, `Should not confuse with lookup: ${query}`);
  }
});

// -------------------------------------------------------------
// TEST SUITE 3: Hard Visual Refinement Variations (No Imperative Verbs)
// -------------------------------------------------------------
test("COMPLEX HARD: Diverse visual scene modifications following image generation", () => {
  const imageHistory = [
    { role: "user", text: "create image that alone boy sitting on the hill with drink. image from back side" },
    {
      role: "assistant",
      mode: "image",
      text: "✨ **GB AI Image Studio**\n\n🎨 **Prompt:** alone boy sitting on the hill\n🔍 **Visual Concept:** *Back view of a solitary teenage boy perched on a grassy hill at sunset, holding a soda*",
      image: {
        prompt: "Back view of a solitary teenage boy perched on a grassy hill at sunset, holding a soda",
      },
    },
  ];

  // Variations of spatial positioning without imperative verbs
  const spatialVariations = [
    "drink bottol beside the person",
    "bottle beside him",
    "water bottle next to the boy",
    "backpack on the ground",
    "guitar in his hand",
    "dog sitting near him",
    "clouds in the sky",
    "moon above the mountains",
    "trees behind the boy",
    "pashe ekta pani bottle",
    "hate ekta cup",
    "pechone shurjo",
  ];
  for (const varPhrase of spatialVariations) {
    assert.ok(isImageRefinementOrFollowup(varPhrase, imageHistory), `Failed to detect spatial refinement: ${varPhrase}`);
  }

  // Variations of clothing, accessories, and posture
  const appearanceVariations = [
    "wearing sunglasses",
    "with black hoodie",
    "wearing a red baseball cap",
    "holding a camera",
    "sitting on a wooden bench",
    "looking at the camera",
    "smiling face",
    "chokhe sunglasses pore ache",
    "mathay cap dao",
  ];
  for (const varPhrase of appearanceVariations) {
    assert.ok(isImageRefinementOrFollowup(varPhrase, imageHistory), `Failed to detect appearance refinement: ${varPhrase}`);
  }

  // Camera and perspective variations
  const cameraVariations = [
    "from front side",
    "front view",
    "side angle shot",
    "drone shot",
    "close up view",
    "wide angle view",
    "samner theke dekhao",
  ];
  for (const varPhrase of cameraVariations) {
    assert.ok(isImageRefinementOrFollowup(varPhrase, imageHistory), `Failed to detect camera refinement: ${varPhrase}`);
  }

  // Lighting, atmosphere, and time of day
  const lightingVariations = [
    "golden hour sunset lighting",
    "night view with stars",
    "heavy rain falling",
    "foggy morning atmosphere",
    "cinematic lighting",
    "cyberpunk neon style",
    "kuasha ghera shokal",
    "raater bela banao",
  ];
  for (const varPhrase of lightingVariations) {
    assert.ok(isImageRefinementOrFollowup(varPhrase, imageHistory), `Failed to detect lighting refinement: ${varPhrase}`);
  }

  // Negative / removal variations
  const removalVariations = [
    "remove the drink bottle",
    "manush shob remove koro",
    "drink chara banao",
    "vitore kono gach thakbe na",
    "remove all background mountains",
  ];
  for (const varPhrase of removalVariations) {
    assert.ok(isImageRefinementOrFollowup(varPhrase, imageHistory), `Failed to detect removal refinement: ${varPhrase}`);
  }

  // Substitutions / changes
  const substitutionVariations = [
    "change shirt color to blue",
    "coffee instead of soda",
    "pahar er jaygay nodi",
    "replace hill with beach",
  ];
  for (const varPhrase of substitutionVariations) {
    assert.ok(isImageRefinementOrFollowup(varPhrase, imageHistory), `Failed to detect substitution refinement: ${varPhrase}`);
  }
});

test("COMPLEX HARD: Explicit image edits retain context across a long mixed conversation", () => {
  const longHistory = [
    { role: "user", text: "create an image of a student reading beside a university lake" },
    {
      role: "assistant",
      mode: "image",
      text: "✨ **GB AI Image Studio**\n\n🎨 **Prompt:** student reading beside a lake\n🔍 **Visual Concept:** *A student reading beside a calm university lake at sunset*",
      image: { prompt: "A student reading beside a calm university lake at sunset" },
    },
    { role: "user", text: "what is photosynthesis?" },
    { role: "assistant", text: "Photosynthesis converts light energy into chemical energy." },
    { role: "user", text: "CSE admission fee koto?" },
    { role: "assistant", text: "The verified fee information is available in the university records." },
    { role: "user", text: "thanks" },
    { role: "assistant", text: "You're welcome." },
  ];

  const refinement = isImageRefinementOrFollowup("ager image-er background night view koro", longHistory);
  assert.ok(refinement);
  assert.match(refinement.prompt, /student reading beside a lake/i);
  assert.ok(refinement.turnsSince >= 6);

  assert.equal(isImageRefinementOrFollowup("what is machine learning?", longHistory), null);
  assert.equal(isImageRefinementOrFollowup("bottle beside him", longHistory), null);
  assert.equal(isImageRefinementOrFollowup("create a new image of a red car", longHistory), null);
});

// -------------------------------------------------------------
// TEST SUITE 4: Hard Negative Rejections Following Image Generation
// -------------------------------------------------------------
test("COMPLEX HARD: Non-image questions following an image turn must NEVER be treated as image refinements", () => {
  const imageHistory = [
    { role: "user", text: "create image of campus" },
    {
      role: "assistant",
      mode: "image",
      text: "✨ **GB AI Image Studio**\n\n🎨 **Prompt:** campus\n🔍 **Visual Concept:** *Campus building*",
      image: { prompt: "Campus building" },
    },
  ];

  // Pure compliments / acknowledgments
  assert.equal(isImageRefinementOrFollowup("nice", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("good", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("ok", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("wow", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("khub sundor", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("thik ache", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("ধন্যবাদ", imageHistory), null);

  // University queries with question marks
  assert.equal(isImageRefinementOrFollowup("CSE admission fee koto?", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("Library kothay?", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("VC sir er nam ki?", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("admission routine kobe dibe?", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("bus schedule ki?", imageHistory), null);

  // General academic, math, and science questions
  assert.equal(isImageRefinementOrFollowup("what is photosynthesis?", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("solve 3x + 12 = 36", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("explain Newton's third law", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("derivative of sin(x) ki?", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("who discovered gravity?", imageHistory), null);

  // Programming queries
  assert.equal(isImageRefinementOrFollowup("write python code to reverse a string", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("how to fix null pointer exception in java?", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("explain time complexity of quicksort", imageHistory), null);

  // Web search queries
  assert.equal(isImageRefinementOrFollowup("web search koro ajker khobor", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("search the web for election results", imageHistory), null);

  // Explicit prompt writing requests
  assert.equal(isImageRefinementOrFollowup("midjourney er jonno ekta prompt likhe dao", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("write a flux prompt for a cyberpunk car", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("give me an image prompt", imageHistory), null);

  // Fresh new image requests (must NOT be treated as refinement of the old campus image)
  assert.equal(isImageRefinementOrFollowup("Notun ekta football ground er chobi banao", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("create a new image of an astronaut on mars", imageHistory), null);
  assert.equal(isImageRefinementOrFollowup("ebar ekta lal golaper chobi banao", imageHistory), null);
});

// -------------------------------------------------------------
// TEST SUITE 5: Strict Code Cleanliness & Block Separation
// -------------------------------------------------------------
test("COMPLEX HARD: Clean code blocks strip conversational clutter and preserve runnable code", () => {
  // Cluttered AI response with markdown tutorial inside code block
  const dirtyAiCode = "Here is the Python solution:\n```python\n# Here is the code requested by the student\n# Note: This is an efficient O(log n) solution\ndef binary_search(arr, target):\n    low, high = 0, len(arr) - 1\n    while low <= high:\n        mid = (low + high) // 2\n        if arr[mid] == target:\n            return mid\n        elif arr[mid] < target:\n            low = mid + 1\n        else:\n            high = mid - 1\n    return -1\n```\nLet me know if you need changes!";

  const cleaned = cleanFencedCodeBlocks(dirtyAiCode);
  const pythonInner = cleaned.match(/```python\r?\n([\s\S]*?)```/)[1];
  assert.match(pythonInner, /def binary_search/);
  assert.doesNotMatch(pythonInner, /# Here is the code requested/);

  // Code with conversational header immediately inside the code block
  const codeWithInnerHeader = "```javascript\nHere is the function you requested:\nfunction add(a, b) {\n  return a + b;\n}\n```";
  const cleanedJs = cleanFencedCodeBlocks(codeWithInnerHeader);
  const jsInner = cleanedJs.match(/```javascript\r?\n([\s\S]*?)```/)[1];
  assert.doesNotMatch(jsInner, /Here is the function/);
  assert.match(jsInner, /function add/);
});

// -------------------------------------------------------------
// TEST SUITE 6: Multi-Turn Reformatting Fidelity (Preserving Crucial Data)
// -------------------------------------------------------------
test("COMPLEX HARD: Deterministic reformatting preserves all numbers, fees, and dates across transformations", () => {
  const originalAnswer = "Gono Bishwabidyalay Computer Science and Engineering (CSE) 4-year tuition fee is Tk. 4,50,000/- with initial admission payment Tk. 54,500/-. Classes are held 5 days a week at Mirzanagar, Savar campus.";

  // Transform 1: Shorten
  const shortened = reformatTextDeterministically(originalAnswer, "shorten");
  assert.match(shortened, /4,50,000/, "Shortened text MUST retain the total fee");
  assert.match(shortened, /54,500/, "Shortened text MUST retain initial payment");

  // Transform 2: Points
  const bulletPoints = reformatTextDeterministically(originalAnswer, "points");
  assert.match(bulletPoints, /4,50,000/, "Bullet points MUST retain total fee");
  assert.match(bulletPoints, /54,500/, "Bullet points MUST retain initial payment");
  assert.match(bulletPoints, /•|\*/, "Bullet points MUST contain bullet markers");

  // Transform 3: Expand
  const expanded = reformatTextDeterministically(originalAnswer, "expand");
  assert.match(expanded, /4,50,000/, "Expanded text MUST retain total fee");
  assert.match(expanded, /54,500/, "Expanded text MUST retain initial payment");
  assert.ok(expanded.length >= originalAnswer.length, "Expanded text should be at least as long as original");
});
