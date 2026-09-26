import test from "node:test";
import assert from "node:assert/strict";
import {
  directActivePersonAnswer,
  directAnswer,
  mergeConversationHistory,
  relevantConversationHistory,
  resolvedPersonFromExchange,
  requiresVerifiedStructuredAnswer,
} from "./api-server.mjs";

const root = "https://gonouniversity.edu.bd/";
const eee = "Department of Electrical and Electronic Engineering (EEE)";
const chemistry = "Department of Chemistry";
const fixture = {
  pages: [], documents: [], fees: [], contacts: [], notices: [],
  institution: {
    establishedDate: "14 July 1998",
    founder: "Dr. Zafrullah Chowdhury",
    foundingOrganization: "Gonoshasthaya Kendra (GK) Public Charitable Trust",
    address: "Nolam, P.O. Mirzanagar via Savar Cantonment, Ashulia, Savar, Dhaka-1344",
    statistics: { undergraduateStudents: "4200+", graduateStudents: "500+", facultyMembers: "180+", officeStaff: "120+" },
    faculties: [
      { name: "Faculty of Health Sciences", departments: ["Pharmacy", "Microbiology", "Biochemistry and Molecular Biology"] },
      { name: "Faculty of Science & Engineering", departments: ["Computer Science and Engineering (CSE)", "Electrical and Electronic Engineering (EEE)", "Chemistry"] },
    ],
  },
  faculty: [
    { name: "Example Chemistry Head", department: chemistry, designation: "Professor and Head", phone: "01000000000", email: "head@example.edu", source: `${root}chemistry/faculty-members/` },
    { name: "Example Pharmacy Head", department: "Department of Pharmacy", designation: "Head", source: `${root}pharmacy/faculty-members/` },
    { name: "Example CSE Head", department: "Department of Computer Science and Engineering (CSE)", designation: "Associate Professor & Head", source: `${root}cse/faculty-members/` },
  ],
  roles: [
    { key: "vice_chancellor", name: "Example VC", title: "Vice-Chancellor", source: root },
    { key: "pro_vice_chancellor", name: "Example Pro VC", title: "Pro-Vice-Chancellor", source: root },
    { key: "treasurer", name: "Example University Treasurer", title: "Treasurer", source: root },
    { key: "student_union_treasurer", name: "Example Union Treasurer", title: "Treasurer", source: root },
  ],
  programs: [
    { name: "B.Sc. in Electrical and Electronic Engineering", department: eee, aliases: ["EEE"], duration: "4 years (8 semesters)", seats: "40", admissionRequirement: "GPA 2.5", source: `${root}admission/undergraduate-admission-requirements/` },
    { name: "B.Sc. (Honours) in Computer Science & Engineering", department: "Department of Computer Science and Engineering (CSE)", aliases: ["CSE", "Computer Science and Engineering"], duration: "4 years (8 semesters)", seats: "50", admissionRequirement: "GPA 2.5", source: `${root}admission/undergraduate-admission-requirements/` },
  ],
};

test("greetings and unclear input never dump scraped text", () => {
  assert.equal(directAnswer("hi", fixture).mode, "greeting");
  assert.equal(directAnswer("?", fixture).mode, "clarify");
  assert.equal(requiresVerifiedStructuredAnswer("Explain data structures with examples"), false);
});

test("role punctuation and institution/union scope are understood", () => {
  assert.match(directAnswer("who is the VC?", fixture).text, /Example VC/);
  assert.doesNotMatch(directAnswer("university treasurer ke?", fixture).text, /Union/);
  assert.match(directAnswer("gaksu treasurer ke?", fixture).text, /Union/);
  assert.doesNotMatch(directAnswer("pro vc ke?", fixture).text, /\*\*Example VC\*\*/);
});

test("missing leadership roles get a role-specific honest answer", () => {
  const withoutProVc = { ...fixture, roles: fixture.roles.filter((role) => role.key !== "pro_vice_chancellor") };
  const answer = directAnswer("who is the pro vc?", withoutProVc);
  assert.equal(answer.mode, "not_found");
  assert.match(answer.text, /Pro-Vice-Chancellor/);
  assert.match(answer.text, /will not guess/i);
});

test("seats and eligibility do not trigger fee or faculty replies", () => {
  assert.match(directAnswer("EEE seats koto?", fixture).text, /Seats:\*\* 40/);
  assert.match(directAnswer("EEE vorti requirement ki?", fixture).text, /GPA 2.5/);
  const missingFee = directAnswer("pharmacy total tuition fee koto?", fixture);
  assert.ok(!missingFee || missingFee.mode === "not_found");
  assert.equal(requiresVerifiedStructuredAnswer("pharmacy total tuition fee koto?"), true);
});

test("credits work for departments other than CSE, with department evidence", () => {
  const knowledge = { ...fixture, pages: [
    { title: "EEE course plan", url: `${root}eee/course-plan/`, department: eee, chunks: ["Total Credits: 156. Duration 4 years."] },
    { title: "CSE course plan", url: `${root}cse/course-plan/`, chunks: ["Total Credits: 160. EEE is another department."] },
  ] };
  const answer = directAnswer("how many total credits in EEE?", knowledge);
  assert.equal(answer.mode, "structured");
  assert.match(answer.text, /156/);
  assert.doesNotMatch(answer.text, /160/);
});

test("course-plan table and grand-total formats expose verified credits", () => {
  const knowledge = { ...fixture, pages: [
    { title: "EEE Course Plan", url: `${root}eee/ug-programme/course-plan/`, department: eee, chunks: ["Duration | Total Contact Hours Theory/ Lab | Total Credits\n4 years | 121/69 | 151"] },
    { title: "Chemistry Course Plan", url: `${root}chemistry/ug-programme/course-plan/`, department: chemistry, chunks: ["Total minimum credit requirement to complete the program: 148 (according to BNQF)."] },
    { title: "CSE syllabus", url: `${root}cse/CSE-Syllabus-2018.pdf`, department: "Department of Computer Science and Engineering (CSE)", chunks: ["Grand Total 2088/1296 160 4750"] },
  ] };
  assert.match(directAnswer("EEE credits?", knowledge).text, /151/);
  assert.match(directAnswer("Chemistry credits?", knowledge).text, /148/);
  assert.match(directAnswer("CSE credits?", knowledge).text, /160/);
});

test("advanced academic advisor compares programs using structured facts", () => {
  const knowledge = { ...fixture, pages: [
    { title: "EEE Course Plan", url: `${root}eee/ug-programme/course-plan/`, department: eee, chunks: ["Duration | Total Contact Hours Theory/ Lab | Total Credits\n4 years | 121/69 | 151\nEEE 111 | Electrical Circuits-I | 3"] },
    { title: "CSE syllabus", url: `${root}cse/CSE-Syllabus-2018.pdf`, department: "Department of Computer Science and Engineering (CSE)", chunks: ["CSE1101 Introduction to Computer System 36 2 50\nCSE2301 Data Structures 54 3 100\nGrand Total 2088/1296 160 4750"] },
  ] };
  const answer = directAnswer("compare CSE vs EEE", knowledge);
  assert.equal(answer.mode, "structured");
  assert.match(answer.text, /Computer Science.*160.*Electrical and Electronic.*151/s);
  assert.match(answer.text, /How to choose/);
});

test("comparison follow-ups retain both programs and reason over metrics", () => {
  const knowledge = { ...fixture, pages: [
    { title: "EEE Course Plan", url: `${root}eee/ug-programme/course-plan/`, department: eee, chunks: ["Duration | Total Contact Hours Theory/ Lab | Total Credits\n4 years | 121/69 | 151\nEEE 111 | Electrical Circuits-I | 3"] },
    { title: "CSE syllabus", url: `${root}cse/CSE-Syllabus-2018.pdf`, department: "Department of Computer Science and Engineering (CSE)", chunks: ["CSE1101 Introduction to Computer System 36 2 50\nCSE2301 Data Structures 54 3 100\nGrand Total 2088/1296 160 4750"] },
  ] };
  const history = [
    { role: "user", text: "compare CSE vs EEE" },
    { role: "assistant", text: "CSE has 160 credits and EEE has 151 credits." },
  ];
  const credits = directAnswer("which one has more credits?", knowledge, history);
  assert.match(credits.text, /CSE.*160.*EEE.*151.*9 more/s);
  const interest = directAnswer("which is better for programming?", knowledge, history);
  assert.match(interest.text, /Computer Science.*closer match.*programming/s);
});

test("long conversations preserve older comparison context", () => {
  const knowledge = { ...fixture, pages: [
    { title: "EEE Course Plan", url: `${root}eee/ug-programme/course-plan/`, department: eee, chunks: ["Duration | Total Contact Hours Theory/ Lab | Total Credits\n4 years | 121/69 | 151"] },
    { title: "CSE syllabus", url: `${root}cse/CSE-Syllabus-2018.pdf`, department: "Department of Computer Science and Engineering (CSE)", chunks: ["Grand Total 2088/1296 160 4750"] },
  ] };
  const stored = [
    { role: "user", text: "compare CSE vs EEE" },
    { role: "assistant", text: "CSE has 160 credits and EEE has 151." },
  ];
  for (let index = 0; index < 35; index += 1) {
    stored.push({ role: "user", text: `unrelated question ${index}` }, { role: "assistant", text: `unrelated answer ${index}` });
  }
  const incoming = [...stored.slice(-10), { role: "user", text: "which one has more credits?" }];
  const merged = mergeConversationHistory(stored, incoming);
  assert.equal(merged.filter((turn) => turn.text === "unrelated question 34").length, 1);
  assert.ok(merged.length > 70);
  const answer = directAnswer("which one has more credits?", knowledge, merged.slice(0, -1));
  assert.match(answer.text, /160.*151.*9 more/s);
});

test("department profile combines program, leadership, seats, credits, and courses", () => {
  const knowledge = { ...fixture, pages: [
    { title: "CSE syllabus", url: `${root}cse/CSE-Syllabus-2018.pdf`, department: "Department of Computer Science and Engineering (CSE)", chunks: ["CSE1101 Introduction to Computer System 36 2 50\nCSE2301 Data Structures 54 3 100\nGrand Total 2088/1296 160 4750"] },
  ] };
  const answer = directAnswer("tell me details about CSE department", knowledge);
  assert.match(answer.text, /Example CSE Head/);
  assert.match(answer.text, /Published seats:\*\* 50/);
  assert.match(answer.text, /Total credits:\*\* 160/);
  assert.match(answer.text, /Data Structures/);
});

test("official course lookup returns code and credits", () => {
  const knowledge = { ...fixture, pages: [
    { title: "CSE syllabus", url: `${root}cse/CSE-Syllabus-2018.pdf`, department: "Department of Computer Science and Engineering (CSE)", chunks: ["CSE2301 Data Structures 54 3 100\nCSE2302L Data Structures Lab 72 2 50"] },
  ] };
  const answer = directAnswer("CSE data structures course details", knowledge);
  assert.match(answer.text, /CSE2301.*3 credits/s);
  assert.match(answer.text, /CSE2302L.*2 credits/s);
  const concise = directAnswer("CSE te Data Structures course code and credit koto?", knowledge);
  assert.match(concise.text, /CSE2301.*3 credits/s);
  assert.doesNotMatch(concise.text, /course records|Representative courses/i);
});

test("program catalog excludes malformed and duplicate crawler records", () => {
  const knowledge = { ...fixture, programs: [
    ...fixture.programs,
    { name: "1st", department: "", duration: "2nd", source: root },
    { name: "B.Sc. (Hons) in CSE", department: "Department of Computer Science and Engineering (CSE)", duration: "30000", source: root },
  ] };
  const answer = directAnswer("show all programs", knowledge);
  assert.doesNotMatch(answer.text, /\b1st\b|30000/);
  assert.match(answer.text, /2 programs/);
});

test("conflicting official totals ask for the applicable session", () => {
  const knowledge = { ...fixture, pages: [
    { title: "EEE course plan 2020", url: `${root}eee/course-plan-2020/`, chunks: ["Total Credits: 156"] },
    { title: "EEE course plan 2025", url: `${root}eee/course-plan-2025/`, chunks: ["Total Credits: 160"] },
  ] };
  assert.equal(directAnswer("EEE total credits?", knowledge).mode, "clarify");
});

test("a syllabus named for another department cannot supply credits", () => {
  const mpbme = "Department of Medical Physics and Biomedical Engineering";
  const knowledge = {
    ...fixture,
    faculty: [...fixture.faculty, { name: "Example MPBME Teacher", department: mpbme, designation: "Lecturer", source: `${root}mpbme/faculty-members/` }],
    pages: [{ title: "PDF document: CSE-Syllabus-2018.pdf", url: `${root}mpbme/CSE-Syllabus-2018.pdf`, department: mpbme, chunks: ["Grand Total 2088/1296 160 4750"] }],
  };
  const answer = directAnswer("medical physics total credits koto?", knowledge);
  assert.equal(answer.mode, "not_found");
  assert.doesNotMatch(answer.text, /\b160\b/);
});

test("department follow-up keeps the last user's department", () => {
  const history = [{ role: "user", text: "how many credits in chemistry?" }, { role: "assistant", text: "Please specify the syllabus." }];
  const answer = directAnswer("chairman name?", fixture, history);
  assert.match(answer.text, /Example Chemistry Head/);
  const contact = directAnswer("number?", fixture, [...history, { role: "assistant", text: answer.text }]);
  assert.match(contact.text, /01000000000/);
  const emailHistory = [...history, { role: "assistant", text: answer.text }, { role: "user", text: "number please" }, { role: "assistant", text: contact.text }];
  const email = directAnswer("does he have email?", fixture, emailHistory);
  assert.match(email.text, /head@example\.edu/);
  assert.doesNotMatch(email.text, /admin@/);
});

test("structured entity memory keeps the same person across contact follow-ups", () => {
  const sharif = {
    name: "Sharif Ahamed",
    designation: "Lecturer",
    department: "Department of Computer Science and Engineering (CSE)",
    phone: "01881-062304",
    email: "diptosharifahamed@gmail.com",
    qualification: "M.Sc. in CSE",
    source: `${root}cse/faculty-members/`,
    profileUrl: `${root}cse/employees/sharif-ahamed/`,
  };
  const knowledge = { ...fixture, faculty: [...fixture.faculty, sharif] };
  const identity = directAnswer("sharif sir ke cheno?", knowledge);
  const active = resolvedPersonFromExchange("sharif sir ke cheno?", identity, knowledge);
  assert.equal(active.name, "Sharif Ahamed");
  assert.match(directActivePersonAnswer("number please", knowledge, active).text, /01881-062304/);
  assert.match(directActivePersonAnswer("does he have email?", knowledge, active).text, /diptosharifahamed@gmail\.com/);
  assert.match(directActivePersonAnswer("tar qualification ki?", knowledge, active).text, /M\.Sc\. in CSE/);
});

test("latest notices cannot fall through to unrelated scraped paragraphs", () => {
  assert.equal(directAnswer("latest notice ki?", fixture).mode, "not_found");
  const answer = directAnswer("latest EEE notice?", { ...fixture, notices: [
    { title: "EEE exam notice", source: `${root}eee/exam-notice/`, publishedAt: "2026-01-02" },
    { title: "Chemistry exam notice", source: `${root}chemistry/exam-notice/`, publishedAt: "2026-02-02" },
  ] });
  assert.match(answer.text, /EEE exam/);
  assert.doesNotMatch(answer.text, /Chemistry exam/);
});

test("unknown campus area never falls through to an unrelated nearby page", () => {
  const knowledge = { ...fixture, pages: [
    { title: "Second convocation", url: `${root}2nd-convocation/`, chunks: ["The convocation speech praised university activities."] },
  ] };
  const answer = directAnswer("area size of gono bishwabidyalay?", knowledge);
  assert.equal(answer.mode, "not_found");
  assert.match(answer.text, /do not state|deya nei/i);
  assert.doesNotMatch(answer.text, /convocation/i);
  assert.ok(answer.sources.every((source) => !/convocation/i.test(source.url)));
  assert.equal(requiresVerifiedStructuredAnswer("how many laboratories does Gono University have?"), true);
});

test("core institution facts use dedicated verified answers", () => {
  assert.match(directAnswer("who founded Gono University?", fixture).text, /Zafrullah Chowdhury/);
  assert.match(directAnswer("when was Gono University established?", fixture).text, /14 July 1998/);
  assert.match(directAnswer("where is Gono University campus located?", fixture).text, /Nolam.*Savar.*Dhaka-1344/i);
  assert.match(directAnswer("how many students and faculty in Gono University?", fixture).text, /4,200\+.*180\+/s);
});

test("external university facts are source-attributed and preserve official conflicts", () => {
  const knowledge = {
    ...fixture,
    externalKnowledge: {
      identity: {
        bengaliName: "গণ বিশ্ববিদ্যালয়",
        literalMeaning: "People's University",
        colors: ["Blue", "Gray", "Green"],
        coordinates: { latitude: 23.9287, longitude: 90.2447 },
        sources: [{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Gono_Bishwabidyalay" }],
      },
      campusArea: {
        value: "32 acres",
        sources: [{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Gono_Bishwabidyalay" }],
      },
      rankings: [{ publisher: "QS", ranking: "Asian University Rankings 2026", band: "1301-1400", source: { title: "QS", url: "https://www.topuniversities.com/universities/gono-bishwabidyalay" } }],
      qsSnapshot: { totalStudents: 4574, facultyStaff: 158 },
    },
  };
  const area = directAnswer("Gono University campus area size?", knowledge);
  assert.equal(area.mode, "source_aware");
  assert.match(area.text, /Wikipedia reports.*32 acres/i);
  assert.match(area.text, /official.*do not publish/i);
  const ranking = directAnswer("What is Gono University QS ranking?", knowledge);
  assert.match(ranking.text, /1301-1400.*2026/s);
  assert.match(directAnswer("Gono name meaning ki?", knowledge).text, /People's University/);
});

test("broad university questions receive a synthesized official profile", () => {
  const answer = directAnswer("tell me about Gono University", fixture);
  assert.equal(answer.mode, "structured");
  assert.match(answer.text, /not-for-profit.*14 July 1998.*UGC/s);
  assert.doesNotMatch(answer.text, /notice|convocation/i);
});

test("academic-unit and program lists come from structured knowledge", () => {
  const departments = directAnswer("what departments are available?", fixture);
  assert.match(departments.text, /Electrical and Electronic Engineering/);
  assert.match(departments.text, /Chemistry/);
  assert.match(departments.text, /Pharmacy/);
  const programs = directAnswer("show all programs", fixture);
  assert.match(programs.text, /B\.Sc\. in Electrical and Electronic Engineering/);
  const health = directAnswer("List all departments under Faculty of Health Sciences", fixture);
  assert.match(health.text, /3 departments.*Pharmacy.*Microbiology.*Biochemistry/s);
  assert.doesNotMatch(health.text, /people records/i);
});

test("person qualifications never fall through to admission eligibility", () => {
  const knowledge = { ...fixture, faculty: [
    ...fixture.faculty,
    { name: "Sharif Ahamed", department: "Department of Computer Science and Engineering (CSE)", designation: "Lecturer", qualification: "M.Sc. in CSE", source: `${root}cse/employees/sharif-ahamed/` },
  ] };
  const answer = directAnswer("Sharif sir er qualification ki?", knowledge);
  assert.match(answer.text, /Sharif Ahamed.*M\.Sc\. in CSE/s);
  assert.doesNotMatch(answer.text, /SSC|HSC|GPA 2\.50/);
});

test("combined founder questions include both founder and establishment date", () => {
  const answer = directAnswer("Who founded Gono Bishwabidyalay and when?", fixture);
  assert.match(answer.text, /Dr\. Zafrullah Chowdhury.*14 July 1998/s);
  const bengali = directAnswer("গণ বিশ্ববিদ্যালয়ের প্রতিষ্ঠাতা কে এবং কবে প্রতিষ্ঠিত?", fixture);
  assert.match(bengali.text, /Dr\. Zafrullah Chowdhury.*14 July 1998/s);
});

test("deadline and hostel questions do not invent current availability", () => {
  assert.equal(directAnswer("What is the admission deadline?", fixture).mode, "not_found");
  assert.match(directAnswer("Does the university provide hostel facilities?", fixture).text, /not publish verified hostel/i);
});

test("compound department questions answer each supported intent", () => {
  const knowledge = { ...fixture, pages: [
    { title: "CSE Course Plan", url: `${root}cse/course-plan/`, department: "Department of Computer Science and Engineering (CSE)", chunks: ["Total Credits: 160. Duration 4 years."] },
  ] };
  const combined = directAnswer("CSE department head and total credit koto?", knowledge);
  assert.match(combined.text, /Example CSE Head.*160/s);
  const room = directAnswer("What is the exact room number of the CSE head?", knowledge);
  assert.equal(room.mode, "not_found");
  assert.match(room.text, /does not publish an office room/i);
});

test("a department faculty-list request is not mistaken for an unknown person", () => {
  const answer = directAnswer("show chemistry faculty list", fixture);
  assert.equal(answer.mode, "structured");
  assert.match(answer.text, /Example Chemistry Head/);
});

test("faculty lists exclude non-teaching officers", () => {
  const knowledge = { ...fixture, faculty: [
    ...fixture.faculty,
    { name: "Example Lab Officer", department: chemistry, designation: "Assistant Lab Officer", source: `${root}chemistry/staff-members/` },
  ] };
  const answer = directAnswer("show chemistry faculty list", knowledge);
  assert.match(answer.text, /Example Chemistry Head/);
  assert.doesNotMatch(answer.text, /Example Lab Officer/);
});

test("library, portal, transport, mission, and admission have dedicated answers", () => {
  const library = directAnswer("what library facilities does Gono University have?", fixture).text;
  assert.match(library, /Wi-Fi.*computer access/i);
  assert.match(library, /digital/i);
  assert.match(directAnswer("does Gono University have transport?", fixture).text, /No university transport/i);
  assert.match(directAnswer("what is Gono University mission and vision?", fixture).text, /social development and human welfare/i);
  assert.match(directAnswer("how can I apply for admission?", fixture).text, /Apply Online/i);
  assert.match(directAnswer("what can I do in the student portal?", fixture).text, /course registration.*attendance.*payment/is);
});

test("research, sports, financial aid, and hostel questions avoid generic retrieval", () => {
  assert.match(directAnswer("what research facilities does Gono University have?", fixture).text, /Center for Multidisciplinary Research/);
  assert.match(directAnswer("tell me about sports at Gono University", fixture).text, /cricket.*football.*volleyball/i);
  assert.equal(directAnswer("what scholarship waiver is available?", fixture).mode, "not_found");
  assert.match(directAnswer("does Gono University have hostel facilities?", fixture).text, /not publish verified hostel/i);
});

test("unknown questions remain eligible for conversational AI", () => {
  assert.equal(directAnswer("Explain recursion with a simple example", fixture), null);
  assert.equal(directAnswer("Explain quantum computing simply", fixture), null);
});

test("AI history keeps anchors, relevant older turns, and recent conversation", () => {
  const history = [
    { role: "user", text: "I am comparing CSE and EEE" },
    { role: "assistant", text: "CSE focuses more on software and EEE on electrical systems." },
    ...Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      text: `unrelated conversation turn ${index}`,
    })),
    { role: "user", text: "CSE has programming and algorithms" },
    { role: "assistant", text: "Yes, those are core CSE topics." },
  ];
  const selected = relevantConversationHistory("which is better for CSE programming?", history, 16);
  assert.ok(selected.length <= 16);
  assert.match(selected.map((item) => item.text).join("\n"), /comparing CSE and EEE/);
  assert.match(selected.map((item) => item.text).join("\n"), /programming and algorithms/);
  assert.match(selected.at(-1).text, /core CSE topics/);
});

test("cost and tuition fee inquiries correctly identify program fee and never trigger clarification", () => {
  const cseFeeFixture = {
    ...fixture,
    fees: [
      {
        program: "B.Sc. (Honours) in Computer Science & Engineering",
        aliases: ["CSE", "Computer Science", "B.Sc. in CSE", "BSc in CSE"],
        admissionCost: "Tk. 4,50,000/-",
        admissionCostIncludes: "Total 4-year tuition fee",
        sourceTitle: "Tuition and Other Fees - Gono Bishwabidyalay",
        source: `${root}admission/tuition-and-other-fees/`,
        note: "Total 4-year tuition fee is Tk. 4,50,000/-.",
      },
    ],
  };

  const costAnswer = directAnswer("cost of cse?", cseFeeFixture);
  assert.equal(costAnswer.mode, "structured");
  assert.match(costAnswer.text, /4,50,000/);
  assert.match(costAnswer.text, /Computer Science & Engineering/);

  const tutionAnswer = directAnswer("cse tution fee koto?", cseFeeFixture);
  assert.equal(tutionAnswer.mode, "structured");
  assert.match(tutionAnswer.text, /4,50,000/);

  const cseCostAnswer = directAnswer("cse cost", cseFeeFixture);
  assert.equal(cseCostAnswer.mode, "structured");
  assert.match(cseCostAnswer.text, /4,50,000/);
});

test("conversational follow-up maintains previous attribute when specifying target subject", () => {
  const creditKnowledge = {
    ...fixture,
    pages: [
      {
        title: "CSE Course Plan",
        url: `${root}cse/course-plan/`,
        department: "Department of Computer Science and Engineering (CSE)",
        chunks: ["Total Credits: 160. Duration 4 years."],
      },
    ],
  };
  const creditHistory = [
    { role: "user", text: "how many total credits?" },
    { role: "assistant", text: "The official course plan for Department of Medical Physics lists total credits 160." },
  ];
  const creditFollowup = directAnswer("in cse", creditKnowledge, creditHistory);
  assert.equal(creditFollowup.mode, "structured");
  assert.match(creditFollowup.text, /160/);
  assert.match(creditFollowup.text, /Computer Science and Engineering/);

  const feeKnowledge = {
    ...fixture,
    fees: [
      {
        program: "B.Sc. (Honours) in Computer Science & Engineering",
        aliases: ["CSE", "Computer Science", "B.Sc. in CSE", "BSc in CSE"],
        admissionCost: "Tk. 4,50,000/-",
        source: `${root}admission/tuition-and-other-fees/`,
      },
    ],
  };
  const feeHistory = [
    { role: "user", text: "what is the tuition fee?" },
    { role: "assistant", text: "Gono Bishwabidyalay published program fees..." },
  ];
  const feeFollowup = directAnswer("in cse", feeKnowledge, feeHistory);
  assert.equal(feeFollowup.mode, "structured");
  assert.match(feeFollowup.text, /4,50,000/);
});

test("generic fee and leadership queries never falsely match unrelated departments", () => {
  const mathKnowledge = {
    ...fixture,
    faculty: [
      ...fixture.faculty,
      { name: "Dr. Math Head", department: "Department of Applied Mathematics", designation: "Head", source: `${root}math/` },
    ],
    fees: [
      {
        program: "B.Sc. in Computer Science & Engineering",
        aliases: ["CSE"],
        admissionCost: "Tk. 4,50,000/-",
        source: `${root}admission/fees/`,
      },
    ],
  };

  const genericFee = directAnswer("what is the fee", mathKnowledge, []);
  assert.equal(genericFee.mode, "structured");
  assert.doesNotMatch(genericFee.text, /Applied Mathematics/i);
  assert.match(genericFee.text, /CSE/i);

  const genericHead = directAnswer("who is the head", mathKnowledge, []);
  assert.equal(genericHead.mode, "clarify");
  assert.match(genericHead.text, /which department/i);

  const contextHead = directAnswer("who is the head", mathKnowledge, [
    { role: "user", text: "tell me about cse credits" },
    { role: "assistant", text: "CSE requires 160 credits." },
  ]);
  assert.equal(contextHead.mode, "structured");
  assert.match(contextHead.text, /Example CSE Head/i);
});

test("followup with distinct attribute overrides previous conversational attribute", () => {
  const subjectHistory = [
    { role: "user", text: "ki ki subject ache?" },
    { role: "assistant", text: "Graduate Admission Requirements - Gono Bishwabidyalay" },
  ];
  const feeKnowledge = {
    ...fixture,
    fees: [
      {
        program: "B.Sc. in Computer Science & Engineering",
        aliases: ["CSE"],
        admissionCost: "Tk. 4,50,000/-",
        source: `${root}admission/fees/`,
      },
    ],
  };
  const costAnswer = directAnswer("cse r cost koto?", feeKnowledge, subjectHistory);
  assert.equal(costAnswer.mode, "structured");
  assert.match(costAnswer.text, /4,50,000/);
  assert.doesNotMatch(costAnswer.text, /course records/i);
});
