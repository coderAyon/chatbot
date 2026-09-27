import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanImagePromptText,
  directOfficialImageLookupAnswer,
  getLastImageContext,
  isImageRefinementOrFollowup,
  isImageCreationIntent,
  isExistingImageLookupIntent,
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

  // If latest assistant message was a text answer, returns null
  const historyAfterText = [
    ...historyWithImage,
    { role: "user", text: "Library timing ki?" },
    { role: "assistant", text: "Library remains open from 9:00 AM to 5:00 PM." },
  ];
  assert.equal(getLastImageContext(historyAfterText), null);
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

  // Must NOT trigger for unrelated academic questions
  assert.equal(isImageRefinementOrFollowup("CSE admission fee koto?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Library kothay?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("VC sir er nam ki?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Hello", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Thanks", historyWithImage), null);

  // Fresh image queries for new subjects after an image turn must NOT be treated as refinement
  assert.equal(isImageRefinementOrFollowup("Notun ekta football ground er chobi banao", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Ebar ekta lal golaper chobi banao", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Campus main gate er chobi banao", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("create a new image of a futuristic flying car", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("একটি সম্পূর্ণ নতুন রোবটের ছবি আঁকো", historyWithImage), null);
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
