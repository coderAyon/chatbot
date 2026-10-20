import test from "node:test";
import assert from "node:assert/strict";
import { directAnswer } from "./api-server.mjs";

const root = "https://gonouniversity.edu.bd/";
const fixture = {
  pages: [],
  documents: [],
  fees: [],
  contacts: [],
  notices: [],
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
  programs: [
    { name: "B.Sc. (Honours) in Computer Science & Engineering", department: "Department of Computer Science and Engineering (CSE)", duration: "4 years (8 semesters)", seats: "100", admissionRequirement: "Science with GPA 2.50 in SSC and HSC", source: `${root}cse/` },
    { name: "Bachelor of Pharmacy (B.Pharm)", department: "Department of Pharmacy", duration: "4 years (8 semesters)", seats: "80", admissionRequirement: "Science with GPA 3.00 in SSC and HSC", source: `${root}pharmacy/` },
    { name: "M. Pharm. (Master of Pharmacy)", department: "Department of Pharmacy", duration: "1 year (2 semesters)", seats: "30", admissionRequirement: "B.Pharm degree", source: `${root}pharmacy/` },
    { name: "Bachelor in Business Administration (BBA)", department: "Department of Business Administration", duration: "4 years (8 semesters)", seats: "60", admissionRequirement: "Any group GPA 2.50", source: `${root}bba/` },
    { name: "Doctor of Veterinary Medicine (DVM)", department: "Faculty of Veterinary and Animal Sciences", duration: "5 years", seats: "40", admissionRequirement: "Science background", source: `${root}veterinary/` },
  ],
  faculty: [
    { name: "Tania Akter", department: "Department of Computer Science and Engineering (CSE)", designation: "Associate Professor & Head", source: root },
    { name: "Dr. Md. Hanif Ali", department: "Department of Computer Science and Engineering (CSE)", designation: "Professor", source: root },
    { name: "Md. Atikur Rahman", department: "Department of Computer Science and Engineering (CSE)", designation: "Assistant Professor", phone: "01912288599", email: "atikhasan.cse@gmail.com", source: root },
  ],
  roles: [
    { key: "vice_chancellor", name: "Dr. Md. Abul Hossain", title: "Vice-Chancellor", source: root },
  ],
};

test("QA A-to-Z: Direct Yes/No questions on academic program features and campus rules", () => {
  // 1. Evening Batch -> No
  const rEvening = directAnswer("CSE te evening batch ache?", fixture);
  assert.equal(rEvening?.mode, "structured");
  assert.match(rEvening.text, /না|No/);
  assert.match(rEvening.text, /সান্ধ্যকালীন|Evening/i);

  // 2. Weekend Batch -> No
  const rWeekend = directAnswer("Weekend batch ki ache?", fixture);
  assert.equal(rWeekend?.mode, "structured");
  assert.match(rWeekend.text, /না|No/);

  // 3. Diploma Holder Admission -> Yes
  const rDiploma = directAnswer("Diploma holder ra admission nite parbe?", fixture);
  assert.equal(rDiploma?.mode, "structured");
  assert.match(rDiploma.text, /হ্যাঁ|Yes/);
  assert.match(rDiploma.text, /ডিপ্লোমা|Diploma/i);

  // 4. Permanent Campus -> Yes
  const rCampus = directAnswer("Permanent campus ache?", fixture);
  assert.equal(rCampus?.mode, "structured");
  assert.match(rCampus.text, /হ্যাঁ|Yes/);
  assert.match(rCampus.text, /স্থায়ী|নলাম|Savar|32\s*acres?/i);

  // 5. Friday Open -> No (closed Fri-Sat)
  const rFriday = directAnswer("Friday te campus khola?", fixture);
  assert.equal(rFriday?.mode, "structured");
  assert.match(rFriday.text, /না|No/);
  assert.match(rFriday.text, /শুক্রবার|Friday/i);

  // 6. Credit Transfer -> Yes
  const rTransfer = directAnswer("Credit transfer kora jay?", fixture);
  assert.equal(rTransfer?.mode, "structured");
  assert.match(rTransfer.text, /হ্যাঁ|Yes/);

  // 7. Internship -> Yes
  const rIntern = directAnswer("Internship ache?", fixture);
  assert.equal(rIntern?.mode, "structured");
  assert.match(rIntern.text, /হ্যাঁ|Yes/);

  // 8. Boys Hostel -> No
  const rBoysHostel = directAnswer("Boys hostel ache?", fixture);
  assert.equal(rBoysHostel?.mode, "structured");
  assert.match(rBoysHostel.text, /না|No/);

  // 9. Girls Hostel -> Yes
  const rGirlsHostel = directAnswer("Girls hostel ache?", fixture);
  assert.equal(rGirlsHostel?.mode, "structured");
  assert.match(rGirlsHostel.text, /হ্যাঁ|Yes/);
});

test("QA A-to-Z: New faculty and live attendance inquiries resolve directly without dumping lists", () => {
  const history = [
    { role: "user", text: "CSE department" },
    { role: "assistant", text: "Department of Computer Science and Engineering" },
  ];

  // 1. Notun sir asche? -> Direct No
  const rSir = directAnswer("notun kono sir asche??", fixture, history);
  assert.equal(rSir?.mode, "structured");
  assert.match(rSir.text, /না|No/);
  assert.doesNotMatch(rSir.text, /Hanif Ali|Atikur Rahman/);

  // 2. Notun madam asche? -> Direct No
  const rMadam = directAnswer("notun kono madam asche??", fixture, history);
  assert.equal(rMadam?.mode, "structured");
  assert.match(rMadam.text, /না|No/);

  // 3. Notun teacher asche? -> Direct No
  const rTeacher = directAnswer("notun teacher asche?", fixture, history);
  assert.equal(rTeacher?.mode, "structured");
  assert.match(rTeacher.text, /না|No/);

  // 4. Live attendance -> Explains live attendance not tracked
  const rPresence = directAnswer("sir ki campus e ache?", fixture, history);
  assert.equal(rPresence?.mode, "structured");
  assert.match(rPresence.text, /দৈনিক উপস্থিতি|লাইভ উপস্থিতি|ক্লাসের উপস্থিতি/);

  // 5. Named faculty live presence -> Explains live attendance not tracked
  const rNamedPresence = directAnswer("Atikur sir ajke campus e ache?", fixture, history);
  assert.equal(rNamedPresence?.mode, "structured");
  assert.match(rNamedPresence.text, /দৈনিক লাইভ উপস্থিতি|আজকের ক্লাসের উপস্থিতি/);
});

test("QA A-to-Z: Program duration and semester count queries never fall into clarification", () => {
  // 1. CSE te koyta semester?
  const rCseSem = directAnswer("CSE te koyta semester?", fixture);
  assert.equal(rCseSem?.mode, "structured");
  assert.match(rCseSem.text, /4 years.*8 semesters/i);
  assert.doesNotMatch(rCseSem.text, /general concept.*faculty.*career/i);

  // 2. CSE te koita semester?
  const rCseSem2 = directAnswer("CSE te koita semester?", fixture);
  assert.equal(rCseSem2?.mode, "structured");
  assert.match(rCseSem2.text, /8 semesters/i);

  // 3. CSE koto bochorer?
  const rCseBochor = directAnswer("CSE koto bochorer?", fixture);
  assert.equal(rCseBochor?.mode, "structured");
  assert.match(rCseBochor.text, /4 years/i);

  // 4. BBA te koyta semester?
  const rBbaSem = directAnswer("BBA te koyta semester?", fixture);
  assert.equal(rBbaSem?.mode, "structured");
  assert.match(rBbaSem.text, /8 semesters/i);

  // 5. DVM course duration
  const rDvm = directAnswer("DVM course koto bochorer?", fixture);
  assert.equal(rDvm?.mode, "structured");
  assert.match(rDvm.text, /5 years/i);

  // 6. BPT course duration
  const rBpt = directAnswer("BPT course koto bochorer?", fixture);
  assert.equal(rBpt?.mode, "structured");
  assert.match(rBpt.text, /5 years/i);
});

test("QA A-to-Z: Department existence checks return direct No for unsupported majors", () => {
  // 1. Existing department -> Yes
  const rCse = directAnswer("CSE department ache?", fixture);
  assert.equal(rCse?.mode, "structured");
  assert.match(rCse.text, /হ্যাঁ|Yes/);

  // 2. Robotics -> No
  const rRobo = directAnswer("Robotics department ache?", fixture);
  assert.equal(rRobo?.mode, "structured");
  assert.match(rRobo.text, /না|No/);
  assert.match(rRobo.text, /Robotics/i);

  // 3. Data Science -> No
  const rData = directAnswer("Data Science department ache?", fixture);
  assert.equal(rData?.mode, "structured");
  assert.match(rData.text, /না|No/);

  // 4. Biotechnology -> No
  const rBio = directAnswer("Biotechnology department ache?", fixture);
  assert.equal(rBio?.mode, "structured");
  assert.match(rBio.text, /না|No/);

  // 5. Civil Engineering -> No
  const rCivil = directAnswer("Civil Engineering ache?", fixture);
  assert.equal(rCivil?.mode, "structured");
  assert.match(rCivil.text, /না|No/);

  // 6. Fashion Design -> No
  const rFashion = directAnswer("Fashion Design department ache?", fixture);
  assert.equal(rFashion?.mode, "structured");
  assert.match(rFashion.text, /না|No/);

  // 7. Generic unknown department -> No
  const rUnknown = directAnswer("Astrophysics department ache?", fixture);
  assert.equal(rUnknown?.mode, "structured");
  assert.match(rUnknown.text, /না|No/);
});

test("QA A-to-Z: Stated GPA eligibility boundary tests return direct Yes/No answers", () => {
  // 1. GPA 2.00 in CSE -> Direct No (min 2.50)
  const rCseLow = directAnswer("GPA 2.00 te CSE hobe?", fixture);
  assert.equal(rCseLow?.mode, "structured");
  assert.match(rCseLow.text, /না|no/i);

  // 2. GPA 3.50 in CSE -> Direct Yes
  const rCseHigh = directAnswer("GPA 3.50 te CSE hobe?", fixture);
  assert.equal(rCseHigh?.mode, "structured");
  assert.match(rCseHigh.text, /হ্যাঁ|yes/i);

  // 3. GPA 2.00 in Pharmacy -> Direct No (min 3.00)
  const rPharmLow = directAnswer("GPA 2.00 te Pharmacy hobe?", fixture);
  assert.equal(rPharmLow?.mode, "structured");
  assert.match(rPharmLow.text, /না|no/i);

  // 4. GPA 3.50 in Pharmacy -> Direct Yes
  const rPharmHigh = directAnswer("GPA 3.50 te Pharmacy hobe?", fixture);
  assert.equal(rPharmHigh?.mode, "structured");
  assert.match(rPharmHigh.text, /হ্যাঁ|yes/i);

  // 5. General undergraduate GPA 2.00 -> Direct No
  const rGenLow = directAnswer("GPA 2.00 te admission hobe?", fixture);
  assert.equal(rGenLow?.mode, "structured");
  assert.match(rGenLow.text, /না|no/i);

  // 6. General undergraduate GPA 3.00 -> Direct Yes
  const rGenHigh = directAnswer("GPA 3.00 te admission hobe?", fixture);
  assert.equal(rGenHigh?.mode, "structured");
  assert.match(rGenHigh.text, /হ্যাঁ|yes/i);
});

test("QA A-to-Z: Unknown person inquiries return direct not found response with No", () => {
  const rPerson = directAnswer("Unknown Person ke chino?", fixture);
  assert.equal(rPerson?.mode, "not_found");
  assert.match(rPerson.text, /না|No/);

  const rTeacher = directAnswer("Abdur Rahim sir ke chino?", fixture);
  assert.equal(rTeacher?.mode, "not_found");
  assert.match(rTeacher.text, /না|No/);
});
