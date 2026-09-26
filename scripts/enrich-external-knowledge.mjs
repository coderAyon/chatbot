import { readFile, rename, writeFile } from "node:fs/promises";

const knowledgePath = new URL("../data/knowledge.json", import.meta.url);
const knowledge = JSON.parse(await readFile(knowledgePath, "utf8"));

const sources = {
  wikipedia: {
    title: "Gono Bishwabidyalay - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Gono_Bishwabidyalay",
    tier: "tertiary",
  },
  qs: {
    title: "Gono Bishwabidyalay - QS TopUniversities",
    url: "https://www.topuniversities.com/universities/gono-bishwabidyalay",
    tier: "primary-ranking",
  },
  ugc: {
    title: "UGC Bangladesh - permanent campus and certified university information",
    url: "https://ugc.gov.bd/service-details/permanent-campus-information",
    tier: "government",
  },
  anniversary: {
    title: "GB observes 25th anniversary - New Age",
    url: "https://www.newagebd.net/article/206837/gb-observes-25th-anniversary",
    tier: "independent-news",
  },
  officialBackground: {
    title: "Background - Gono Bishwabidyalay",
    url: "https://gonouniversity.edu.bd/about-gb/general-information/background/",
    tier: "official",
  },
};

knowledge.externalKnowledge = {
  updatedAt: new Date().toISOString(),
  policy: "Official university and government sources override tertiary sources for conflicting institutional facts. Rankings are attributed to the ranking publisher. Wikipedia-only claims are always labeled.",
  identity: {
    englishName: "Gono Bishwabidyalay",
    bengaliName: "গণ বিশ্ববিদ্যালয়",
    literalMeaning: "People's University",
    abbreviation: "GB",
    type: "Not-for-profit private university",
    motto: "A University with a difference",
    colors: ["Blue", "Gray", "Green"],
    affiliation: "University Grants Commission (UGC) of Bangladesh",
    coordinates: { latitude: 23.9287, longitude: 90.2447 },
    campusCharacter: "Rural permanent campus at Nolam, Mirzanagar, Savar, Dhaka",
    sources: [sources.wikipedia, sources.officialBackground, sources.ugc],
  },
  timeline: [
    { year: 1971, event: "The roots of Gonoshasthaya Kendra (GK) began during Bangladesh's Liberation War.", source: sources.officialBackground },
    { year: 1972, event: "Gonoshasthaya Kendra continued its public-health and social-development work after independence.", source: sources.officialBackground },
    { year: 1994, event: "The university concept was originated under the Private University Act 1992.", source: sources.officialBackground },
    { year: 1998, date: "14 July 1998", event: "Gono Bishwabidyalay formally began its journey and received institutional approval.", source: sources.officialBackground },
    { year: 2023, event: "The university observed its 25th founding anniversary.", source: sources.anniversary },
  ],
  campusArea: {
    value: "32 acres",
    status: "externally reported",
    note: "Wikipedia reports a 32-acre rural campus, but the currently indexed official general-information pages do not state an acreage figure.",
    sources: [sources.wikipedia],
  },
  rankings: [
    {
      publisher: "QS",
      ranking: "Asian University Rankings 2026",
      band: "1301-1400",
      source: sources.qs,
    },
  ],
  qsSnapshot: {
    year: 2026,
    totalStudents: 4574,
    undergraduateShare: "89.8%",
    postgraduateShare: "10.2%",
    facultyStaff: 158,
    note: "QS-published profile snapshot; figures may differ from the university homepage because of reporting date and methodology.",
    source: sources.qs,
  },
  historicalUgcSnapshot: {
    year: 2019,
    students: 3367,
    faculty: 111,
    studentTeacherRatio: "1:19",
    note: "Historical figures from the UGC Bangladesh 2019 annual report, not current enrollment.",
    source: {
      title: "UGC Bangladesh Annual Report 2019",
      url: "https://ugc.gov.bd/sites/default/files/files/ugc.portal.gov.bd/annual_reports/0b944cc5_aa77_44b7_b1db_cc1a20e0eb37/2021-09-08-06-49-e0bf991565e624555d9915b54629624d.pdf",
      tier: "government",
    },
  },
  establishmentConflict: {
    preferred: "14 July 1998",
    explanation: "The official university background says the concept originated in 1994 and the university was established on 14 July 1998. Wikipedia's article text has contained a conflicting 1994 establishment statement, while its infobox has also shown 1998.",
    sources: [sources.officialBackground, sources.wikipedia],
  },
  sources: Object.values(sources),
};

knowledge.externalPages = [
  {
    ...sources.wikipedia,
    chunks: [
      "Source type: tertiary encyclopedia. Gono Bishwabidyalay (গণ বিশ্ববিদ্যালয়), literally People's University and abbreviated GB, is described as a private university in Savar. The article reports a rural 32-acre campus, blue/gray/green colors, UGC affiliation, and coordinates 23.9287 N, 90.2447 E. These claims must be attributed to Wikipedia when not independently stated by an official source.",
    ],
  },
  {
    ...sources.qs,
    chunks: [
      "Source type: ranking publisher. QS lists Gono Bishwabidyalay in the 1301-1400 band of the Asian University Rankings 2026. Its profile snapshot reports 4,574 students, 89.8% undergraduate, 10.2% postgraduate, and 158 faculty staff. These are QS figures and may use a different reporting date from university statistics.",
    ],
  },
  {
    ...sources.ugc,
    chunks: [
      "Source type: Bangladesh government regulator. UGC Bangladesh publishes certified-university and permanent-campus information. Historical UGC annual-report figures must always include their report year and must not be presented as current enrollment.",
    ],
  },
  {
    ...sources.anniversary,
    chunks: [
      "Source type: independent news. New Age reported that Gono Bishwabidyalay observed its 25th founding anniversary in July 2023 and that the university officially started its journey on 14 July 1998.",
    ],
  },
];

knowledge.institution = knowledge.institution || {};
knowledge.institution.establishedDate = "14 July 1998";
knowledge.institution.foundationConceptYear = "1994";
knowledge.institution.foundationYear = "1998 (the university concept originated in 1994)";
delete knowledge.institution.campusArea;

const temporary = new URL(`../data/knowledge.json.${process.pid}.tmp`, import.meta.url);
await writeFile(temporary, JSON.stringify(knowledge, null, 2));
await rename(temporary, knowledgePath);
console.log(`Added ${knowledge.externalPages.length} source-aware external knowledge records.`);
