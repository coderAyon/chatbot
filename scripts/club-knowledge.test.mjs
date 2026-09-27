import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { directAnswer } from "./api-server.mjs";

const knowledge = JSON.parse(await readFile(new URL("../data/knowledge.json", import.meta.url), "utf8"));

test("gbcdc overview returns verified club details and website link", () => {
  const result = directAnswer("gbcdc club details bolo", knowledge);
  assert.ok(result);
  assert.match(result.text, /GBCDC/i);
  assert.match(result.text, /https:\/\/www\.gbcdc\.club\//i);
  assert.match(result.text, /Bidita Chowdhury/i);
  assert.ok(result.sources.some(s => s.url.includes("gbcdc.club")));
});

test("gbcdc president question identifies Bidita Chowdhury as current president", () => {
  const resultBanglish = directAnswer("gbcdc president ke", knowledge);
  assert.ok(resultBanglish);
  assert.match(resultBanglish.text, /Bidita Chowdhury/i);
  assert.match(resultBanglish.text, /CSE/i);
  assert.match(resultBanglish.text, /3rd Executive Committee/i);

  const resultEnglish = directAnswer("Who is the president of GBCDC?", knowledge);
  assert.ok(resultEnglish);
  assert.match(resultEnglish.text, /Bidita Chowdhury/i);
  assert.match(resultEnglish.text, /Advocate Hasib Mir/i);
});

test("gbcdc general secretary question identifies Mehrab Hossain Jishan", () => {
  const result = directAnswer("gbcdc er gs ke", knowledge);
  assert.ok(result);
  assert.match(result.text, /Mehrab Hossain Jishan/i);
  assert.match(result.text, /EEE/i);
});

test("gbcdc committee query lists executive members across departments", () => {
  const result = directAnswer("gbcdc committee member list dekhao", knowledge);
  assert.ok(result);
  assert.match(result.text, /Bidita Chowdhury/i);
  assert.match(result.text, /Mehrab Hossain Jishan/i);
  assert.match(result.text, /Nusrat Jahan Setu/i);
  assert.match(result.text, /Shuvo Molla/i);
  assert.match(result.text, /Jahid Hasan Sany/i);
});

test("gbcdc activities and events return workshops, seminars, and summits", () => {
  const result = directAnswer("gbcdc ki kaj kore ar ki ki events ache?", knowledge);
  assert.ok(result);
  assert.match(result.text, /Make Your CV/i);
  assert.match(result.text, /South Korea/i);
  assert.match(result.text, /Volunteer Playbook/i);
});

test("gbcdc courses return certified skill courses", () => {
  const result = directAnswer("gbcdc er skill courses ki ki?", knowledge);
  assert.ok(result);
  assert.match(result.text, /Communication Hacks/i);
  assert.match(result.text, /Freelancing/i);
  assert.match(result.text, /Graphic Designing/i);
});

test("gbcdc membership inquiry returns 6-step recruitment process", () => {
  const result = directAnswer("gbcdc te kivabe join korbo?", knowledge);
  assert.ok(result);
  assert.match(result.text, /Registration Form/i);
  assert.match(result.text, /Written Assessment|written test/i);
  assert.match(result.text, /Viva|Interview/i);
  assert.match(result.text, /Volunteer Wing/i);
});

test("general club query about Gono Bishwabidyalay points to GBCDC", () => {
  const result = directAnswer("gb te ki ki club ache?", knowledge);
  assert.ok(result);
  assert.match(result.text, /GBCDC/i);
  assert.match(result.text, /https:\/\/www\.gbcdc\.club\//i);
});

test("bidita chowdhury ke cheno identifies Bidita Chowdhury as GBCDC president and not faculty Asif Chowdhury", () => {
  const result = directAnswer("bidita chowdhury ke cheno?", knowledge);
  assert.ok(result);
  assert.match(result.text, /Bidita Chowdhury/i);
  assert.match(result.text, /President/i);
  assert.match(result.text, /GBCDC/i);
  assert.match(result.text, /CSE/i);
  assert.doesNotMatch(result.text, /Mohammad Asif Chowdhury/i);
  assert.doesNotMatch(result.text, /Politics and Governance/i);
  assert.ok(result.sources.some(s => s.url.includes("gbcdc.club")));
});

test("mehrab hossain jishan ke cheno identifies Mehrab Hossain Jishan as GBCDC General Secretary", () => {
  const result = directAnswer("mehrab hossain jishan ke cheno?", knowledge);
  assert.ok(result);
  assert.match(result.text, /Mehrab Hossain Jishan/i);
  assert.match(result.text, /General Secretary/i);
  assert.match(result.text, /EEE/i);
  assert.ok(result.sources.some(s => s.url.includes("gbcdc.club")));
});

test("hasib mir ke identifies Advocate Hasib Mir as founding president", () => {
  const result = directAnswer("hasib mir ke?", knowledge);
  assert.ok(result);
  assert.match(result.text, /Advocate Hasib Mir/i);
  assert.match(result.text, /President/i);
  assert.ok(result.sources.some(s => s.url.includes("gbcdc.club")));
});

test("faculty asif chowdhury ke cheno correctly matches Mohammad Asif Chowdhury", () => {
  const result = directAnswer("asif chowdhury ke cheno?", knowledge);
  assert.ok(result);
  assert.match(result.text, /Mohammad Asif Chowdhury/i);
  assert.match(result.text, /Politics and Governance/i);
});

test("proctor and exam controller resolve verified officers", () => {
  const proctor = directAnswer("gb er proctor ke?", knowledge);
  assert.ok(proctor);
  assert.match(proctor.text, /Kanak Chandra Roy/i);

  const controller = directAnswer("exam controller ke?", knowledge);
  assert.ok(controller);
  assert.match(controller.text, /A\. S\. M\. Noman Alam/i);
});

test("academic semester system and grading scale return verified facts", () => {
  const sem = directAnswer("gono bishwabidyalay te koyta semester?", knowledge);
  assert.ok(sem);
  assert.match(sem.text, /Bi-semester|২টি সেমিস্টার/i);
  assert.match(sem.text, /Spring/i);
  assert.match(sem.text, /Fall/i);

  const grade = directAnswer("grading system kemon?", knowledge);
  assert.ok(grade);
  assert.match(grade.text, /৪\.০০|4\.00/i);
  assert.match(grade.text, /A\+/i);
});

test("result lookup returns student portal and exam controller guidance", () => {
  const res = directAnswer("result kivabe pabo?", knowledge);
  assert.ok(res);
  assert.match(res.text, /Portal|i-EMS/i);
  assert.match(res.text, /Controller of Examinations/i);
});

test("bot identity, capability, gratitude and farewell respond politely and comprehensively", () => {
  const identity = directAnswer("tumi ke?", knowledge);
  assert.ok(identity);
  assert.match(identity.text, /Assistant|Helpdesk/i);

  const capability = directAnswer("tumi ki korte paro?", knowledge);
  assert.ok(capability);
  assert.match(capability.text, /ভর্তি|বিভাগ|কোর্স ফি/i);

  const thanks = directAnswer("dhonnobad", knowledge);
  assert.ok(thanks);
  assert.match(thanks.text, /ধন্যবাদ|স্বাগতম/i);

  const bye = directAnswer("bye", knowledge);
  assert.ok(bye);
  assert.match(bye.text, /goodbye|আল্লাহ\s*হাফেজ|বিদায়/i);
});

test("institution faculties count and bba chairman resolve properly", () => {
  const faculties = directAnswer("faculty কয়টি আছে?", knowledge);
  assert.ok(faculties);
  assert.match(faculties.text, /অনুষদ|Faculties/i);

  const bbaHead = directAnswer("bba chairman ke?", knowledge);
  assert.ok(bbaHead);
  assert.match(bbaHead.text, /Rana-Al\s*-?Mosharrafa/i);

  const admissionElig = directAnswer("admission eligibility ki?", knowledge);
  assert.ok(admissionElig);
  assert.match(admissionElig.text, /GPA 2\.50|এসএসসি/i);
});


