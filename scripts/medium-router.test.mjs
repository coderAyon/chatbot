import test from "node:test";
import assert from "node:assert/strict";
import { inferMessageMedium } from "../src/medium-router.js";

test("routes creation and solving requests to GB AI", () => {
  const gbAiRequests = [
    "create a calculator app",
    "generate an image of the campus",
    "website banai dao",
    "একটা পোস্টার বানাও",
    "solve this equation",
    "debug this code",
  ];
  for (const request of gbAiRequests) {
    assert.equal(inferMessageMedium(request), "gb-ai", request);
  }
});

test("routes typed live-search intent to GB AI", () => {
  assert.equal(inferMessageMedium("search the web for latest admission news"), "gb-ai");
  assert.equal(inferMessageMedium("গুগল করে সর্বশেষ খবর দেখো"), "gb-ai");
});

test("routes files and an enabled web control to GB AI", () => {
  assert.equal(inferMessageMedium("what is this?", [{ name: "question.png" }]), "gb-ai");
  assert.equal(inferMessageMedium("latest update?", [], [], true), "gb-ai");
});

test("routes ordinary and university questions to Chatbot", () => {
  assert.equal(inferMessageMedium("hello"), "chatbot");
  assert.equal(inferMessageMedium("Gono University kobe established?"), "chatbot");
  assert.equal(inferMessageMedium("CSE admission fee koto?"), "chatbot");
  assert.equal(inferMessageMedium("What does create mean?"), "chatbot");
  assert.equal(inferMessageMedium("Who created the C language?"), "chatbot");
  assert.equal(inferMessageMedium("What is database design?"), "chatbot");
});

test("keeps an AI creation follow-up in GB AI", () => {
  const history = [
    { role: "user", text: "create a logo" },
    { role: "assistant", text: "Here is the logo", medium: "gb-ai" },
  ];
  assert.equal(inferMessageMedium("make it blue", [], history), "gb-ai");
  assert.equal(inferMessageMedium("aro valo koro", [], history), "gb-ai");
});

test("a clear university question exits prior GB AI context", () => {
  const history = [
    { role: "user", text: "create a logo" },
    { role: "assistant", text: "Here is the logo", medium: "gb-ai" },
  ];
  assert.equal(inferMessageMedium("Gono University admission fee koto?", [], history), "chatbot");
});
