import { mkdir, writeFile } from "node:fs/promises";

const cseSource = "https://gonouniversity.edu.bd/cse/faculty-members/";
const pharmacySource = "https://gonouniversity.edu.bd/pharmacy/";
const studentUnionSource = "https://gonouniversity.edu.bd/gb-central-students-union-2025-2027/";
const viceChancellorSource = "https://gonouniversity.edu.bd/offices/office-of-the-vice-chancellor/";

const faculty = [
  ["Tania Akter", "Associate Professor & Head", "01717238063", "aktertania30@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/tania-akter/"],
  ["Dr. Md. Hanif Ali", "Professor", "01712596955", "drhanifai@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/dr-md-hanif-ali/"],
  ["Md. Atikur Rahman", "Assistant Professor", "01912288599", "atikurcse@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/md-atikur-rahman/"],
  ["Md. Rasel Mia", "Assistant Professor", "01738189846", "mdraselmia10@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/md-rasel-mia/"],
  ["Farzana Tasnim", "Assistant Professor", "+8801765524232", "farzana@daffodilvarsity.edu.bd", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/farzana-tasnim/"],
  ["Shatabdee Bala", "Assistant Professor", "+8801743612112", "shatabdeebala.cse@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/shatabdee-bala/"],
  ["Umme Farhana", "Assistant Professor", "+8801797172447", "ummefarhanacse@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/umme-farhana/"],
  ["Bipasa Sharmin Satu", "Lecturer", "01770189827", "bipasharminsatu@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/bipasa-sharmin-satu/"],
  ["Sharif Ahamed", "Lecturer", "01881062304", "diptosharifahamed@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/sharif-ahamed/"],
  ["Tania Sultana", "Lecturer", "01794787601", "taniasultana.cse@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/tania-sultana/"],
  ["Md. Rakibuzzaman Khan Pathan", "Lecturer", "01917635345", "rakibuzzamankhan@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/md-rakibuzzaman-khan-pathan/"],
  ["Adila Nuzhat", "Lecturer", "01957202891", "adila.nuzhat@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/adila-nuzhat/"],
  ["Shahriar Hassan", "Lecturer", "01778390534", "shahriar.hassan.cse@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/shahriar-hassan/"],
  ["Shanta Islam", "Lecturer", "01518459182", "shantai9896bist@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/shanta-islam/"],
  ["Prof. Md. Karam Newaz", "Adjunct Faculty", "01716199431", "newaz2017@gmail.com", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/employees/prof-md-karam-newaz/"],
  ["Purabi Sarkar Nitu", "Senior Section Officer", "+8801727684880", "", "Admission Office", "https://gonouniversity.edu.bd/offices/admission-office/"],
  ["Asfaq Hossain", "Administrative Officer", "01950003312", "", "Admission Office", "https://gonouniversity.edu.bd/offices/admission-office/"],
  ["Md. Jamal Hossain Jony", "Senior Assistant Administrative Officer", "01944293020", "", "Admission Office", "https://gonouniversity.edu.bd/offices/admission-office/"],
  ["Ripon Chandra", "Assistant Administrative Officer", "01732869379", "", "Admission Office", "https://gonouniversity.edu.bd/offices/admission-office/"],
  ["Md. Shahinur Islam", "Assistant Lab Officer", "01928787860", "", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/staff-members/"],
  ["Tanvir Rahman Dip", "Senior Asst. IT Officer", "01741340158", "", "Department of Computer Science and Engineering (CSE)", "https://gonouniversity.edu.bd/cse/staff-members/"],
  ["Dr. Mst. Rozina Parul", "Associate Professor & Head of the Department", "", "", "Department of Pharmacy", pharmacySource],
].map(([name, designation, phone, email, department, profileUrl]) => ({
  name,
  designation,
  phone,
  email,
  qualification: "",
  department,
  source: department === "Admission Office" || department === "Department of Pharmacy" ? profileUrl : cseSource,
  profileUrl,
}));

const roles = [
  {
    key: "student_union_vice_president",
    title: "Vice President",
    name: "Iyasin Al Mridul Dewan",
    group: "Gono Bishwabidyalay Central Students' Union 2025-2027",
    sourceTitle: "GB Central Students Union 2025-2027",
    source: studentUnionSource,
  },
  {
    key: "student_union_general_secretary",
    title: "General Secretary",
    name: "Md. Raihan Khan",
    group: "Gono Bishwabidyalay Central Students' Union 2025-2027",
    sourceTitle: "GB Central Students Union 2025-2027",
    source: studentUnionSource,
  },
  {
    key: "student_union_joint_general_secretary",
    title: "Joint General Secretary",
    name: "Shamsunnahar Shormi",
    group: "Gono Bishwabidyalay Central Students' Union 2025-2027",
    sourceTitle: "GB Central Students Union 2025-2027",
    source: studentUnionSource,
  },
  {
    key: "student_union_treasurer",
    title: "Treasurer",
    name: "Ishrat Jahan",
    group: "Gono Bishwabidyalay Central Students' Union 2025-2027",
    sourceTitle: "GB Central Students Union 2025-2027",
    source: studentUnionSource,
  },
  {
    key: "vice_chancellor",
    title: "Vice-Chancellor",
    name: "Professor Dr. Md. Abul Hossain",
    group: "Gono Bishwabidyalay",
    sourceTitle: "Office of the Vice-Chancellor",
    source: viceChancellorSource,
  },
];

const fees = [
  {
    program: "B.Sc. (Honours) in Computer Science & Engineering",
    aliases: [
      "cse",
      "computer science",
      "computer science and engineering",
      "computer science & engineering",
      "bsc in cse",
      "b.sc. in cse",
      "bsc cse",
      "b.sc. (honours) in computer science & engineering",
    ],
    admissionCost: "Tk. 4,50,000/-",
    admissionCostIncludes: "Total 4-year tuition fee (admission-time payment: BDT 54,500 including admission fee & 1st semester tuition)",
    sourceTitle: "Tuition and Other Fees",
    source: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/",
    note: "Total 4-year tuition fee (8 semesters) is Tk. 4,50,000/-. Initial admission payment is BDT 54,500.",
  },
];

const pages = [
  {
    url: "https://gonouniversity.edu.bd/",
    title: "Gono Bishwabidyalay",
    chunks: [
      "Gono Bishwabidyalay is a private university in Bangladesh. The official website contains information about admissions, academic departments, notices, offices, research, library, sports, and contact information.",
    ],
  },
  {
    url: "https://gonouniversity.edu.bd/admission/undergraduate-admission-requirements/",
    title: "Undergraduate Admission Requirements",
    chunks: [
      "Undergraduate admission requirements are published on the official admission requirements page. Requirements depend on the chosen program and applicant academic background.",
    ],
  },
  {
    url: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/",
    title: "Tuition and Other Fees",
    chunks: [
      "Tuition and other fees are published on the official tuition and fees page. Fee amounts vary by program, semester, waiver, and university policy. B.Sc. in Computer Science and Engineering (CSE) total admission fee/admission-time cost is BDT 54,500, including admission fee and first semester tuition.",
    ],
  },
  {
    url: cseSource,
    title: "CSE Faculty Members",
    chunks: [
      `CSE regular faculty members: ${faculty.filter((person) => person.department.includes("Computer Science") && !/adjunct|officer/i.test(person.designation)).map((person) => person.name).join(", ")}. Adjunct faculty: Prof. Md. Karam Newaz.`,
    ],
  },
  {
    url: pharmacySource,
    title: "Department of Pharmacy",
    chunks: [
      "Department of Pharmacy official page lists Dr. Mst. Rozina Parul as Associate Professor & Head of the Department.",
    ],
  },
  {
    url: "https://gonouniversity.edu.bd/contact/",
    title: "Contact",
    chunks: [
      "Official contact page contains Gono Bishwabidyalay address, phone, email, and office contact information. Admission phone: 01950003314. Administrative phone: 01950003319, 01950003320.",
    ],
  },
  {
    url: studentUnionSource,
    title: "GB Central Students Union 2025-2027",
    chunks: [
      "Gono Bishwabidyalay Central Students' Union 2025-2027 members include Vice President Iyasin Al Mridul Dewan, General Secretary Md. Raihan Khan, Joint General Secretary Shamsunnahar Shormi, and Treasurer Ishrat Jahan.",
    ],
  },
  {
    url: viceChancellorSource,
    title: "Office of the Vice-Chancellor",
    chunks: [
      "Office of the Vice-Chancellor: Professor Dr. Md. Abul Hossain is the Vice-Chancellor of Gono Bishwabidyalay.",
    ],
  },
];

await mkdir("data", { recursive: true });
await writeFile(
  "data/knowledge.json",
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      source: "https://gonouniversity.edu.bd/",
      pageCount: pages.length,
      faculty,
      roles,
      fees,
      documents: [
        {
          title: "Tuition and Other Fees",
          url: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/",
          pageUrl: "https://gonouniversity.edu.bd/admission/tuition-and-other-fees/",
        },
      ],
      pages,
    },
    null,
    2,
  ),
);

console.log(`Seed knowledge restored: ${pages.length} pages, ${faculty.length} people records`);
