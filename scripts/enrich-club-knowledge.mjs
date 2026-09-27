import { readFile, rename, writeFile } from "node:fs/promises";

const knowledgePath = new URL("../data/knowledge.json", import.meta.url);
const knowledge = JSON.parse(await readFile(knowledgePath, "utf8"));

// Load fetched GBCDC API data
const executivesData = JSON.parse(await readFile(new URL("../scratch/api_data_executives.json", import.meta.url), "utf8")).data || [];
const advisoryData = JSON.parse(await readFile(new URL("../scratch/api_data_advisory.json", import.meta.url), "utf8")).data || [];
const mentorsData = JSON.parse(await readFile(new URL("../scratch/api_data_mentors.json", import.meta.url), "utf8")).data || [];
const eventsData = JSON.parse(await readFile(new URL("../scratch/api_data_events.json", import.meta.url), "utf8")).data?.items || [];
const coursesData = JSON.parse(await readFile(new URL("../scratch/api_data_courses.json", import.meta.url), "utf8")).data?.items || [];
const noticesData = JSON.parse(await readFile(new URL("../scratch/api_data_notices.json", import.meta.url), "utf8")).data?.items || [];
const newsData = JSON.parse(await readFile(new URL("../scratch/api_data_news.json", import.meta.url), "utf8")).data?.items || [];

const gbcdc = {
  name: "Gono Bishwabidyalay Career Development Club",
  abbreviation: "GBCDC",
  bengaliName: "গণ বিশ্ববিদ্যালয় ক্যারিয়ার ডেভেলপমেন্ট ক্লাব",
  established: 2021,
  yearsActive: "5+",
  membersCount: "500+",
  tagline: "Empowering students with skills, leadership, and career opportunities for a brighter future.",
  website: "https://www.gbcdc.club/",
  facebook: "https://www.facebook.com/GonoBishwabidyalayCareerDevelopmentClub/",
  email: "info@gbcdc.edu.bd",
  phone: "+880-1234-567890",
  location: "Nolam, Mirzanagar, Savar, Dhaka, Bangladesh",
  description: "Gono Bishwabidyalay Career Development Club (GBCDC) is a premier student organization at Gono Bishwabidyalay founded in 2021. It bridges academia with corporate and industry excellence through career counseling, skill bootcamps, workshops, national competitions, and leadership development.",
  coreActivities: [
    "Career Workshops & Seminars (CV writing, interview preparation, higher education abroad, corporate readiness)",
    "Certified Skill Development Courses (communication, freelancing, graphic design, digital marketing, AI tools)",
    "Executive Leadership & Department Management (HR, IT, Media, Corporate Affairs, Publication, Communication)",
    "Volunteer Wing Recruitment & Hands-on Campus Event Management",
    "National Competitions, Business Case Challenges & Awards",
    "Corporate Networking, Mock Interviews & Industry Expert Mentorship",
    "Social initiatives (Tree plantation, World Book Giving Day celebration, anti-trafficking awareness with BRAC)"
  ],
  recruitmentProcess: {
    type: "Offline Recruitment Drive (Held every semester)",
    steps: [
      "1. Collect Registration Form: Collect the physical application form from the GBCDC campus recruitment booth or club room.",
      "2. Fill Form & Attach Photo + CV: Complete academic and contact info, attach 1 passport-size photo and updated printed CV.",
      "3. In-Person Hardcopy Submission: Submit completed dossier at the club booth before the deadline.",
      "4. Offline Written Assessment: Appear for on-campus written test on general aptitude, reasoning, and problem solving.",
      "5. Face-to-Face Viva & Interview: Board evaluation with senior club executives.",
      "6. Final Selection & Induction: Official volunteer badge, orientation, and department wing onboarding."
    ]
  },
  currentLeadership: {
    session: "3rd Executive Committee (Current)",
    president: "Bidita Chowdhury (Department of Computer Science and Engineering - CSE, 4th Year)",
    generalSecretary: "Mehrab Hossain Jishan (Department of Electrical and Electronic Engineering - EEE)",
    vicePresident: "Nusrat Jahan Setu (Department of Microbiology)",
    jointSecretary: "Md. Tanvir Ahmmed (Department of Biochemistry and Molecular Biology - BMB, 2nd Year)",
    organizingSecretary: "Shuvo Molla (Department of Sociology and Social Work)",
    treasurer: "Jahid Hasan Sany (Department of Electrical and Electronic Engineering - EEE, 3rd Year)",
    mediaSecretary: "Dipro Saha (Department of Computer Science and Engineering - CSE)",
    hrSecretary: "Md. Abrar Faiyaj Khan (Department of Computer Science and Engineering - CSE, 3rd Year)",
    itSecretary: "Shuvo Chandra Debnath (Department of Computer Science and Engineering - CSE, 4th Year)",
    communicationSecretary: "MD. Nayeemur Rahman (Department of Computer Science and Engineering - CSE)",
    publicationSecretary: "Sakib Reza Tasni (Department of Chemistry)",
    corporateAffairsSecretary: "Mazharul Islam (Department of Computer Science and Engineering - CSE)",
    executiveMembers: [
      "Md. Monim Ahamed (Department of Pharmacy, 3rd Year)",
      "Md. Abdur Rahman (Department of Biochemistry and Molecular Biology - BMB, 2nd Year)",
      "Nabila Hossen Suchi (Department of Biochemistry and Molecular Biology - BMB)"
    ]
  },
  committeeHistory: {
    third: {
      session: "3rd Executive Committee",
      count: 15,
      president: "Bidita Chowdhury",
      generalSecretary: "Mehrab Hossain Jishan",
      vicePresident: "Nusrat Jahan Setu"
    },
    second: {
      session: "2nd Executive Committee",
      count: 21,
      actingPresident: "Sheikh Muhammad Redwan (Law)",
      president: "Rubaet Toha (EEE)",
      generalSecretary: "Nasim Khan (Chemistry)",
      vicePresident: "Mahinur Islam (MPBME)"
    },
    first: {
      session: "1st Executive Committee (Founding)",
      count: 11,
      foundingPresident: "Advocate Hasib Mir (Law)",
      foundingGeneralSecretary: "Saifullah Mansur (Microbiology)",
      vicePresident: "Asif Hossain (Pharmacy)"
    }
  },
  executives: executivesData,
  advisoryBoard: advisoryData.map(a => ({
    name: a.name,
    designation: a.designation,
    institution: a.institution || a.department || "Gono Bishwabidyalay",
    role: a.role || a.designation
  })),
  mentors: mentorsData.map(m => ({
    name: m.name,
    designation: m.designation,
    department: m.department || "Gono Bishwabidyalay"
  })),
  flagshipEvents: eventsData.map(e => ({
    title: e.title,
    date: e.date,
    time: e.time,
    venue: e.location,
    category: e.category,
    attendees: e.attendees,
    description: e.description
  })),
  courses: coursesData.map(c => ({
    title: c.title,
    instructor: c.instructor,
    category: c.category,
    duration: c.duration,
    lessons: c.lessons,
    description: c.description
  })),
  notices: noticesData.map(n => ({
    title: n.title,
    date: n.date,
    category: n.category,
    priority: n.priority,
    author: n.author,
    description: n.description
  })),
  news: newsData.map(nw => ({
    title: nw.title || nw.slug,
    date: nw.publishedAt || nw.date || nw.createdAt,
    category: nw.category,
    author: nw.author,
    content: nw.content?.replace(/<[^>]+>/g, " ").trim()
  }))
};

knowledge.clubs = {
  gbcdc
};

// Add externalPages for GBCDC so search & retrieval can find them
const gbcdcPages = [
  {
    url: "https://www.gbcdc.club/",
    title: "GBCDC - Gono Bishwabidyalay Career Development Club",
    tier: "official-club",
    chunks: [
      `Gono Bishwabidyalay Career Development Club (GBCDC). Website: https://www.gbcdc.club/. Founded in 2021. Empowering students with industry skills, leadership vision, and professional career opportunities. Over 500+ active members and 5+ years of campus impact. Located at Nolam, Savar, Dhaka, Bangladesh. Official contact: info@gbcdc.edu.bd, phone +880-1234-567890. Facebook: https://www.facebook.com/GonoBishwabidyalayCareerDevelopmentClub/`,
      `GBCDC Activities & Wings: Organizes Career Workshops, Seminars, CV Writing Bootcamps, Skill Development Training, Corporate Networking, Mock Interviews, and Offline Volunteer Recruitment Drives. Flagship sessions include Make Your CV Shape Your Career, Higher Studies in South Korea (Speaker: Dr. Jakir Hossain Imran), Volunteer Playbook, and GBian Success Story.`
    ]
  },
  {
    url: "https://www.gbcdc.club/executive",
    title: "GBCDC Executive Committee - Leadership & Members",
    tier: "official-club",
    chunks: [
      `GBCDC 3rd Executive Committee (Current Leadership): President: Bidita Chowdhury (CSE 4th Year), General Secretary: Mehrab Hossain Jishan (EEE), Vice President: Nusrat Jahan Setu (Microbiology), Joint Secretary: Md. Tanvir Ahmmed (BMB 2nd Year), Organizing Secretary: Shuvo Molla (Sociology and Social Work), Treasurer: Jahid Hasan Sany (EEE 3rd Year), Media Secretary: Dipro Saha (CSE), HR Secretary: Md. Abrar Faiyaj Khan (CSE 3rd Year), IT Secretary: Shuvo Chandra Debnath (CSE 4th Year), Communication Secretary: MD. Nayeemur Rahman (CSE), Publication Secretary: Sakib Reza Tasni (Chemistry), Corporate Affairs Secretary: Mazharul Islam (CSE). Executive Members: Md. Monim Ahamed (Pharmacy 3rd Year), Md. Abdur Rahman (BMB 2nd Year), Nabila Hossen Suchi (BMB).`,
      `GBCDC Past Leadership: 2nd Executive Committee: Acting President Sheikh Muhammad Redwan (Law), President Rubaet Toha (EEE), General Secretary Nasim Khan (Chemistry), Vice President Mahinur Islam (MPBME). 1st Founding Committee: Founding President Advocate Hasib Mir (Law), Founding General Secretary Saifullah Mansur (Microbiology), Vice President Asif Hossain (Pharmacy).`
    ]
  },
  {
    url: "https://www.gbcdc.club/advisory",
    title: "GBCDC Advisory Board & Mentors",
    tier: "official-club",
    chunks: [
      `GBCDC Advisory Panel: Chief Patron & Advisor: Professor Dr. Md. Abul Hossain (Vice-Chancellor, Gono Bishwabidyalay); Advisor: Dr. Md. Fuad Hossain (Dean, Faculty of Health Sciences); Lifetime Advisor: Advocate Hasib Mir (Founding President, Alumni - Law); Advisors: Saifullah Mansur (Founding GS, Alumni - Microbiology), Sheikh Muhammad Redwan (Former Acting President, Alumni - Law), Mst Rafia Tasnim Rity (Alumni - Law), Rubaet Toha (Former President, Alumni - EEE).`,
      `GBCDC Mentor Panel: Faculty mentors include Tania Ahmed (Assistant Professor), Gazi Ishmam Hasan (Lecturer), Md. Abu Rayhan (Lecturer), and Sharif Ahamed (Lecturer) from Gono Bishwabidyalay.`
    ]
  },
  {
    url: "https://www.gbcdc.club/events",
    title: "GBCDC Events & Workshops",
    tier: "official-club",
    chunks: [
      `GBCDC Flagship Events: 1. Make Your CV, Shape Your Career (206 Seminar Room) - CV writing and job market readiness; 2. Higher Studies in South Korea: Research Opportunities & Career Pathways (Speaker: Dr. Jakir Hossain Imran); 3. The Volunteer Playbook - Volunteer roadmap & leadership orientation; 4. GBian Success Story (Season 01 & 02); 5. Email Communication Workshop (Professional email writing and business communication); 6. How to Organize a Program (Led by Advocate Hasib Mir); 7. Learn the Tools That Matter (MS Office and productivity tools workshop); 8. Awareness Orientation on Prevention of Human Trafficking and Migrant Smuggling (Jointly with BRAC Migration Program).`
    ]
  },
  {
    url: "https://www.gbcdc.club/courses",
    title: "GBCDC Certified Skill Courses",
    tier: "official-club",
    chunks: [
      `GBCDC Skill Courses: Communication Hacks (কমিউনিケーション হ্যাকস), English Grammar Fundamentals, Freelancing এর হাতেখড়ি, Graphic Designing with Photoshop, CV Writing & Interview Skills, Academic English Grammar, English for Everyday, মোবাইল দিয়ে Graphic Designing, Learn & Earn Digital Marketing, How AI Works. Courses are designed for students to master high-demand practical tools.`
    ]
  }
];

knowledge.externalPages = (knowledge.externalPages || []).filter(p => !p.url.includes("gbcdc.club"));
knowledge.externalPages.push(...gbcdcPages);

const tempPath = new URL(`../data/knowledge.json.${process.pid}.tmp`, import.meta.url);
await writeFile(tempPath, JSON.stringify(knowledge, null, 2));
await rename(tempPath, knowledgePath);
console.log("Successfully enriched data/knowledge.json with GBCDC club data and pages!");
