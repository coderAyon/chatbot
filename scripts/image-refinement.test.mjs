import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanImagePromptText,
  getLastImageContext,
  isImageRefinementOrFollowup,
  isImageCreationIntent,
} from "./api-server.mjs";

test("cleanImagePromptText strips action verbs, articles, and genitive particles", () => {
  assert.equal(cleanImagePromptText("Library r ekta image create Koro"), "Library");
  assert.equal(cleanImagePromptText("Library er ekta photo banao"), "Library");
  assert.equal(cleanImagePromptText("একটি সুন্দর ফুলের ছবি আঁকো"), "সুন্দর ফুল");
  assert.equal(cleanImagePromptText("Gono Bishwabidyalay campus er ekta chobi banao"), "Gono Bishwabidyalay campus");
  assert.equal(cleanImagePromptText("a red sports car on highway"), "a red sports car on highway");
  assert.equal(cleanImagePromptText("computer lab er chobi"), "computer lab");
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

  // Must NOT trigger for unrelated academic questions
  assert.equal(isImageRefinementOrFollowup("CSE admission fee koto?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Library kothay?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("VC sir er nam ki?", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Hello", historyWithImage), null);
  assert.equal(isImageRefinementOrFollowup("Thanks", historyWithImage), null);
});
