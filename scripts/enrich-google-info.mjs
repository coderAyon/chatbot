import { readFile, writeFile } from "node:fs/promises";

const knowledgePath = new URL("../data/knowledge.json", import.meta.url);
const raw = await readFile(knowledgePath, "utf8");
const knowledge = JSON.parse(raw);

knowledge.institution = {
  ...knowledge.institution,
  name: "Gono Bishwabidyalay",
  bengaliName: "গণ বিশ্ববিদ্যালয়",
  establishedDate: "14 July 1998",
  foundationYear: "1994 (UGC approved 14 July 1998)",
  motto: "A University with a difference",
  founder: "Dr. Zafrullah Chowdhury",
  founderTitle: "বীর মুক্তিযোদ্ধা ডা. জাফরুল্লাহ চৌধুরী",
  foundingOrganization: "Gonoshasthaya Kendra (GK) Public Charitable Trust",
  address: "Nolam, P.O. Mirzanagar via Savar Cantonment, Ashulia, Savar, Dhaka-1344",
  campusArea: "32 acres (৩২ একর স্থায়ী সবুজ ক্যাম্পাস)",
  chancellor: "President of the People's Republic of Bangladesh (ex-officio) / মহামান্য রাষ্ট্রপতি",
  viceChancellor: "Professor Dr. Md. Abul Hossain (অধ্যাপক ড. মোঃ আবুল হোসেন)",
  treasurer: "Prof. Md. Serajul Islam (অধ্যাপক মোঃ সিরাজুল ইসলাম)",
  registrar: "Engr. Md. Ohiduzzaman (ইঞ্জিনিয়ার মোঃ ওহিদুজ্জামান)",
  examinationController: "Mir Murtoza Ali (মীর মুর্ত্তজা আলী)",
  accreditations: [
    "University Grants Commission (UGC) of Bangladesh",
    "Ministry of Education, Government of Bangladesh",
    "Pharmacy Council of Bangladesh (PCB)",
    "Bangladesh Bar Council"
  ],
  hospitalAffiliation: "Gonoshasthaya Nagar Hospital (500-bed hospital at Savar & Dhanmondi) and Gonoshasthaya Samaj Vittik Medical College",
  studentUnion: {
    name: "Gono Bishwabidyalay Central Students' Union (GBKC / বাকসু)",
    established: "2013",
    significance: "ঢাকা বিশ্ববিদ্যালয়ের ডাকসু (DUCSU)-র পর দেশের দ্বিতীয় সক্রিয় কেন্দ্রীয় ছাত্র সংসদ এবং বাংলাদেশের বেসরকারি বিশ্ববিদ্যালয়ের একমাত্র নির্বাচিত ছাত্র সংসদ।",
    vp: "Iyasin Al Mridul Dewan (ইয়াসিন আল মৃদুল দেওয়ান)",
    gs: "Md. Raihan Khan (মোঃ রায়হান খান)",
    jgs: "Samiul Hasan Shovon (সামিউল হাসান শোভন)",
    treasurer: "Khondokar Abdur Rahim (খন্দকার আব্দুর রহিম)"
  },
  faculties: [
    {
      name: "Faculty of Science & Engineering",
      bengaliName: "বিজ্ঞান ও প্রকৌশল অনুষদ",
      departments: [
        "Computer Science and Engineering (CSE)",
        "Electrical and Electronic Engineering (EEE)",
        "Medical Physics and Biomedical Engineering",
        "Applied Mathematics",
        "Physics",
        "Chemistry"
      ]
    },
    {
      name: "Faculty of Health Sciences",
      bengaliName: "স্বাস্থ্য বিজ্ঞান অনুষদ",
      departments: [
        "Pharmacy (B.Pharm, M.Pharm)",
        "Microbiology",
        "Biochemistry and Molecular Biology"
      ]
    },
    {
      name: "Faculty of Arts & Social Sciences",
      bengaliName: "কলা ও সামাজিক বিজ্ঞান অনুষদ",
      departments: [
        "Business Administration (BBA)",
        "English",
        "Bangla",
        "Politics and Governance",
        "Sociology and Social Work",
        "Law (LL.B, LL.M)"
      ]
    },
    {
      name: "Faculty of Veterinary & Animal Sciences",
      bengaliName: "ভেটেরিনারি ও অ্যানিম্যাল সায়েন্সেস অনুষদ",
      departments: ["Doctor of Veterinary Medicine (DVM)"]
    },
    {
      name: "Faculty of Agriculture",
      bengaliName: "কৃষি অনুষদ",
      departments: ["B.Sc. (Hons) in Agriculture"]
    }
  ],
  transport: "ঢাকা ও আশপাশের বিভিন্ন রুট (গাবতলী, মিরপুর-১০, উত্তরা, নবীনগর, আশুলিয়া, বাইপাইল) থেকে শিক্ষার্থীদের জন্য নিজস্ব বাস সার্ভিস চালু রয়েছে।",
  hostel: "ক্যাম্পাসের সন্নিকটে ছাত্র ও ছাত্রীদের জন্য পৃথক, নিরাপদ ও বিশ্ববিদ্যালয় অনুমোদিত আবাসিক হোস্টেল সুবিধা রয়েছে।",
  library: "কেন্দ্রীয় লাইব্রেরিতে হাজার হাজার টেক্সটবুক, জার্নাল, ই-বুক, অনলাইন ক্যাটালগ এবং ওয়াইফাই স্টাডি সুবিধা রয়েছে।",
  helpline: "01950003314, 01950003319 | Email: admin@gonouniversity.edu.bd"
};

await writeFile(knowledgePath, JSON.stringify(knowledge, null, 2), "utf8");
console.log("Successfully enriched Gono Bishwabidyalay knowledge base with all Google/Wikipedia information!");
