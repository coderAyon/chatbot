import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanImagePromptText,
  directOfficialImageLookupAnswer,
  getLastImageContext,
  isImageRefinementOrFollowup,
  isImageCreationIntent,
  isExistingImageLookupIntent,
  isWebSearchIntent,
  isUniversityInquiry,
  isExplicitPromptWritingRequest,
} from "./api-server.mjs";

test("cleanImagePromptText strips action verbs, articles, and genitive particles", () => {
  assert.equal(cleanImagePromptText("Library r ekta image create Koro"), "Library");
  assert.equal(cleanImagePromptText("Library er ekta photo banao"), "Library");
  assert.equal(cleanImagePromptText("একটি সুন্দর ফুলের ছবি আঁকো"), "সুন্দর ফুল");
  assert.equal(cleanImagePromptText("Gono Bishwabidyalay campus er ekta chobi banao"), "Gono Bishwabidyalay campus");
  assert.equal(cleanImagePromptText("a red sports car on highway"), "a red sports car on highway");
  assert.equal(cleanImagePromptText("computer lab er chobi"), "computer lab");
});

test("official image lookup returns verified sources without generating synthetic media", () => {
  const knowledge = {
    pages: [{ title: "Course Plan - Department of Law", url: "https://gonouniversity.edu.bd/law/ug-programme/course-plan/", department: "Department of Law", chunks: [] }],
    programs: [{ name: "LL.B. (Honours)", department: "Department of Law", aliases: ["Law"], source: "https://gonouniversity.edu.bd/law/" }],
    roles: [{ key: "vice_chancellor", title: "Vice-Chancellor", name: "Professor Example", sourceTitle: "Vice-Chancellor's Office", source: "https://gonouniversity.edu.bd/offices/office-of-the-vice-chancellor/" }],
    institution: { founder: "Dr. Zafrullah Chowdhury", source: "https://gonouniversity.edu.bd/" },
  };

  assert.equal(isExistingImageLookupIntent("show me a photo of the vice chancellor"), true);
  const viceChancellor = directOfficialImageLookupAnswer("show me a photo of the vice chancellor", knowledge);
  assert.equal(viceChancellor.mode, "official_image_lookup");
  assert.equal(viceChancellor.sources[0].url, knowledge.roles[0].source);
  assert.equal(viceChancellor.image, undefined);

  const coursePlan = directOfficialImageLookupAnswer("Law course plan image dekhao", knowledge);
  assert.equal(coursePlan.mode, "official_image_lookup");
  assert.match(coursePlan.sources[0].url, /law\/ug-programme\/course-plan/);
});

test("isImageCreationIntent detects Bangla, Banglish, and English image requests", () => {
  assert.equal(isImageCreationIntent("Library r ekta image create Koro"), true);
  assert.equal(isImageCreationIntent("ekta chobi banao"), true);
  assert.equal(isImageCreationIntent("draw a cat sitting on a table"), true);
  assert.equal(isImageCreationIntent("generate image of university main gate"), true);
  assert.equal(isImageCreationIntent("একটি সুন্দর বিড়ালের ছবি আঁকো"), true);
  assert.equal(isImageCreationIntent("logo banao for my science club"), true);

  // Rejects academic questions, code questions, and requests for existing/official images.
  assert.equal(isImageCreationIntent("What is the admission fee?"), false);
  assert.equal(isImageCreationIntent("Solve this python function error"), false);
  assert.equal(isImageCreationIntent("How to calculate CGPA?"), false);
  assert.equal(isImageCreationIntent("লাইব্রেরির সময়সূচি কী?"), false);
  assert.equal(isImageCreationIntent("show me a photo of the vice chancellor"), false);
  assert.equal(isImageCreationIntent("image of course plan"), false);
  assert.equal(isImageCreationIntent("VC er official chobi dekhao"), false);
  assert.equal(isImageCreationIntent("ভিসির ছবি দেখাও"), false);
});

test("getLastImageContext extracts concept from assistant image response in history", () => {
  const historyWithImage = [
    { role: "user", text: "Library r ekta image create Koro" },
    {
      role: "assistant",
      text: "✨ **GB AI Image Studio**\n\n🎨 **Prompt:** Library\n🔍 **Visual Concept:** *Spacious modern university library interior, tall wooden bookshelves, floor-to-ceiling windows with warm daylight*",
    },
  ];

  const context = getLastImageContext(historyWithImage);
  assert.ok(context, "Context should be extracted");
  assert.equal(
    context.concept,
    "Spacious modern university library interior, tall wooden bookshelves, floor-to-ceiling windows with warm daylight"
  );
  assert.equal(context.prompt, "Library");

  // Text turns do not erase the image; the intent classifier decides whether
  // a later message explicitly refers back to this retained context.
  const historyAfterText = [
    ...historyWithImage,
    { role: "user", text: "Library timing ki?" },
    { role: "assistant", text: "Library remains open from 9:00 AM to 5:00 PM." },
  ];
  const retainedContext = getLastImageContext(historyAfterText);
  assert.ok(retainedContext);
  assert.equal(retainedContext.prompt, "Library");
  assert.equal(retainedContext.turnsSince, 2);
});

test("isImageRefinementOrFollowup detects scene modifications following an image turn", () => {
  const historyWithImage = [
    { role: "user", text: "Library r ekta image create Koro" },
    {
      role: "assistant",
      text: "✨ **GB AI Image Studio**\n\n🎨 **Prompt:** Library\n🔍 **Visual Concept:** *Spacious modern university library interior, tall wooden bookshelves*",
    },
  ];

  // User's exact prompt from screenshot
  const result1 = isImageRefinementOrFollowup("Vitore student dau", historyWithImage);
  assert.ok(result1, "Should detect 'Vitore student dau' as refinement");
  assert.equal(result1.prompt, "Library");

  // User's exact second prompt from screenshot (drink bottol beside the person)
  const solitaryBoyHistory = [
    { role: "user", text: "create image that alone boy sitting on the hill with drink. image from back side" },
    {
      role: "assistant",
      text: "✨ **GB AI Image Studio**\n\n🎨 **Prompt:** that alone boy sitting on the hill with drink. from back side\n🔍 **Visual Concept:** *Back view of a solitary teenage boy perched on a grassy hill at sunset, holding a soda, golden light casting long shadows, distant mountains blurred, low-angle shot, wide composition, cinematic natural lighting.*",
    },
  ];

  const drinkBottolResult = isImageRefinementOrFollowup("drink bottol beside the person", solitaryBoyHistory);
  assert.ok(drinkBottolResult, "Should detect 'drink bottol beside the person' as refinement");
  assert.match(drinkBottolResult.concept, /solitary teenage boy/i);

  // Other natural spatial and visual modifications
  assert.ok(isImageRefinementOrFollowup("drink bottle beside him", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("water bottle next to the boy", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("dog sitting beside him", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("wearing sunglasses", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("with sunglasses", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("guitar in his hand", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("sitting on a wooden bench", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("sunset in the background", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("front side view", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("close up shot", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("pashe ekta bottle", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("clouds in the sky", solitaryBoyHistory));
  assert.ok(isImageRefinementOrFollowup("change shirt color to blue", solitaryBoyHistory));

  // Other Banglish / Bengali refinements
  assert.ok(isImageRefinementOrFollowup("student add koro", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("vitore kichu chatro boshe porche emon banao", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("aro bright koro", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("sunset lighting e banao", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("night view dau", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("background change kore pahar dau", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("arekta banao", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("put some students reading books inside", historyWithImage));

  // Negative instruction refinements
  assert.ok(isImageRefinementOrFollowup("student shob remove koro", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("student chara banao", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("vitore kono manush thakbe na", historyWithImage));
  assert.ok(isImageRefinementOrFollowup("remove all people from the scene", historyWithImage));

  // Compliments and acknowledgments must NOT generate an image
  assert.equal(isImageRefinementOrFollowup("nice", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("good", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("ok", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("khub sundor", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("wow", historyWithImage), null);

  // When user explicitly asks to WRITE a prompt, it must NOT create an image
  assert.equal(isImageRefinementOrFollowup("prompt likhe dao", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("write a prompt for midjourney", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("ekta prompt banao", historyWithImage), null);

  // Must NOT trigger for unrelated academic, coding, math, general questions, or university queries
  assert.equal(isImageRefinementOrFollowup("CSE admission fee koto?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Library kothay?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("VC sir er nam ki?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Hello", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Thanks", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("tell me about bangladesh", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("what is photosynthesis?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("explain gravity", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("write python code for binary search", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("how to make tea?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("versity somporke bolo", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("who is einstein", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("solve 2x + 10 = 20", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("web search koro", historyWithImage), null);

  // Fresh image queries for new subjects after an image turn must NOT be treated as refinement
  assert.equal(isImageRefinementOrFollowup("Notun ekta football ground er chobi banao", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Ebar ekta lal golaper chobi banao", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Campus main gate er chobi banao", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("create a new image of a futuristic flying car", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("একটি সম্পূর্ণ নতুন রোবটের ছবি আঁকো", historyWithImage), null);
});

test("isExplicitPromptWritingRequest detects explicit prompt requests and rejects visual scene edits", () => {
  assert.equal(isExplicitPromptWritingRequest("prompt likhe dao"), true);
  assert.equal(isExplicitPromptWritingRequest("write a prompt for midjourney"), true);
  assert.equal(isExplicitPromptWritingRequest("give me an image prompt"), true);
  assert.equal(isExplicitPromptWritingRequest("ekta prompt banao"), true);
  assert.equal(isExplicitPromptWritingRequest("একটি সুন্দর প্রম্পট লিখে দাও"), true);

  assert.equal(isExplicitPromptWritingRequest("drink bottol beside the person"), false);
  assert.equal(isExplicitPromptWritingRequest("sunset lighting e banao"), false);
  assert.equal(isExplicitPromptWritingRequest("wearing sunglasses"), false);
  assert.equal(isExplicitPromptWritingRequest("cat er ekta chobi banao"), false);
});

test("isWebSearchIntent detects live search inquiries", () => {
  assert.equal(isWebSearchIntent("web search koro"), true);
  assert.equal(isWebSearchIntent("search the web for latest cricket score"), true);
  assert.equal(isWebSearchIntent("google koro ajker khobor"), true);
  assert.equal(isWebSearchIntent("khuje dao recent news"), true);
  assert.equal(isWebSearchIntent("আজকের তাজা খবর সার্চ করো"), true);

  assert.equal(isWebSearchIntent("explain theory of relativity"), false);
  assert.equal(isWebSearchIntent("what is calculus?"), false);
  assert.equal(isWebSearchIntent("solve x^2 + 5x + 6 = 0"), false);
});

test("isUniversityInquiry identifies Gono Bishwabidyalay topics and rejects general academic/code topics", () => {
  assert.equal(isUniversityInquiry("CSE admission fee koto?"), true);
  assert.equal(isUniversityInquiry("VC sir er nam ki?"), true);
  assert.equal(isUniversityInquiry("Campus kothay?"), true);
  assert.equal(isUniversityInquiry("versity somporke bolo"), true);
  assert.equal(isUniversityInquiry("Gono Bishwabidyalay founder ke?"), true);
  assert.equal(isUniversityInquiry("Pharmacy department e koyta credit?"), true);
  assert.equal(isUniversityInquiry("গণ বিশ্ববিদ্যালয়ের উপাচার্য কে?"), true);

  assert.equal(isUniversityInquiry("what is photosynthesis?"), false);
  assert.equal(isUniversityInquiry("write a python code to sort an array"), false);
  assert.equal(isUniversityInquiry("solve 2x + 10 = 20"), false);
  assert.equal(isUniversityInquiry("who is albert einstein?"), false);
});

test("isImageCreationIntent supports broad Banglish/English creation verbs and rejects admin photo queries", () => {
  // Expanded natural Banglish & English creation verbs
  assert.equal(isImageCreationIntent("ekta chobi eke dao"), true);
  assert.equal(isImageCreationIntent("chobi akba ekta"), true);
  assert.equal(isImageCreationIntent("chobi banay dao"), true);
  assert.equal(isImageCreationIntent("chobi drawing koro"), true);
  assert.equal(isImageCreationIntent("create a new image of a futuristic campus"), true);
  assert.equal(isImageCreationIntent("generate a realistic picture of a cat"), true);
  assert.equal(isImageCreationIntent("make a picture of a mountain sunset"), true);
  assert.equal(isImageCreationIntent("ekta nature wallpaper banao"), true);
  assert.equal(isImageCreationIntent("campus er ekta realistic photo generate koro"), true);

  // Rejects administrative photo/rules inquiries
  assert.equal(isImageCreationIntent("admit card e photo kivabe upload korbo?"), false);
  assert.equal(isImageCreationIntent("library card korte ki photo lage?"), false);
  assert.equal(isImageCreationIntent("campus e chobi tola ki nishedh?"), false);
  assert.equal(isImageCreationIntent("portal e photo size koto hote hobe?"), false);
});
