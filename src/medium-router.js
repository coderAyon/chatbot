export function isInformationalMessage(text) {
  const value = String(text || "").trim();
  // A request to edit can be phrased as a question. Keep that explicit action.
  if (/^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:add|remove|change|edit|modify|make|draw|generate|create|replace)\b/i.test(value)) return false;
  return /\b(?:what|who|why|how|when|where|which|whose|whom|explain|define|meaning|tell\s+me|kivabe|keno|kobe|kothay|kokhon|koto|somproke|somporke|bujhiye)\b/i.test(value) ||
    /\b(?:ki|ke)\s*[?!.]*$/i.test(value) ||
    /(?:কী|কি|কেন|কিভাবে|কীভাবে|কোথায়|কোথায়|কখন|কত|ব্যাখ্যা|সম্পর্কে)/u.test(value) ||
    /[?？]/u.test(value);
}

export function isWebSearchIntent(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  // 1. Explicit search commands
  if (
    /\b(web\s*search|search\s+(?:the\s+)?web|search\s+online|search\s+(?:the\s+)?internet|google\s+(?:it|this|koro|kore|kori)|look\s+it\s+up|khuje\s+(?:dao|dau|dekho)|search\s+koro|net\s*e\s*khujo)\b/i.test(t) ||
    /(?:ওয়েব\s*সার্চ|ওয়েব\s*সার্চ|গুগল\s*কর|সার্চ\s*কর|ইন্টারনেট\s*থেকে|খুঁজে\s*দাও|অনুসন্ধান)/u.test(t)
  ) return true;

  // 2. News, live updates, current affairs
  if (
    /\b(latest\s+news|recent\s+news|today'?s\s+news|current\s+news|breaking\s+news|live\s+score|current\s+affairs|ajker\s+(?:news|khobor)|taza\s+khobor|somprotik?\s+khobor)\b/i.test(t) ||
    /(?:সাম্প্রতিক\s*খবর|তাজা\s*খবর|আজকের\s*খবর|লাইভ\s*স্কোর|সর্বশেষ\s*সংবাদ|ব্রেকিং\s*নিউজ)/u.test(t)
  ) return true;

  // 3. Current leaders, heads of state, national governance (rastropoti, president, prime minister, etc.)
  // (Exclude Gono university specific leadership inquiries which belong to university knowledge)
  if (!/\b(gono|bishwabidyalay|varsity|campus|gbcdc)\b/i.test(t)) {
    if (
      /\b(rastropoti|rashtrapati|president|prodhan\s*montri|prime\s*minister|chief\s*advis[oe]r|chief\s*justice)\b/i.test(t) ||
      /(?:রাষ্ট্রপতি|প্রধানমন্ত্রী|প্রধান\s*উপদেষ্টা|প্রধান\s*বিচারপতি)/u.test(t)
    ) {
      if (
        /\b(ekhon|bortoman|current|present|who|ke|nam\s*ki|kon|kake)\b/i.test(t) ||
        /(?:এখন|বর্তমান|কে|কারা|নাম\s*কী|নাম\s*কি)/u.test(t) ||
        /\?$/.test(t)
      ) {
        return true;
      }
    }

    // 4. Temporal questions: 'ekhon ... ke', 'who is the current ...', 'bortoman ... ke'
    if (
      /\b(ekhon|bortoman|current|present|somproti|recent)\b[\s\S]{0,35}\b(ke|who|kader|kar)\b/i.test(t) ||
      /\b(who\s+is|who\s+are)\b[\s\S]{0,35}\b(now|currently|presently|today)\b/i.test(t) ||
      /(?:এখন|বর্তমান|সাম্প্রতিক|আজকের)[\s\S]{0,25}(?:কে|কারা|কোনটি|কী|কি)\b/u.test(t)
    ) return true;
  }

  // 5. Live real-world metrics (gold price, dollar rate, weather, score)
  if (
    /\b(dollar\s*rate|dollar\s*er\s*dam|gold\s*price|shonar\s*dam|weather|temperature|abhawa|live\s*score|cricket\s*score|fifa|world\s*cup)\b/i.test(t) ||
    /(?:ডলার\s*রেট|টাকার\s*মান|সোনার\s*দাম|স্বর্ণের\s*দাম|আবহাওয়া|তাপমাত্রা)/u.test(t)
  ) return true;

  return false;
}

export function inferMessageMedium(text, attachments = [], history = [], webSearchEnabled = false, currentSelectedMedium = null) {
  const value = String(text || "").trim();
  const normalized = value.toLowerCase();
  if (attachments.length > 0 || webSearchEnabled || isWebSearchIntent(value)) return "gb-ai";
  if (currentSelectedMedium === "gb-ai") return "gb-ai";

  const creationIntent =
    /^(?:please\s+)?(?:create|generate|draw|design|build|compose)\b/i.test(normalized) ||
    /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:create|generate|draw|design|build|compose)\b/i.test(normalized) ||
    /\b(?:i\s+want\s+you\s+to|help\s+me)\s+(?:create|generate|draw|design|build|compose)\b/i.test(normalized) ||
    /\bhow\s+to\s+(?:create|generate|draw|design|build|compose)\b/i.test(normalized) ||
    /\b(?:ban(?:ao|a|ai|ate)|toiri\s+koro|design\s+koro|likhe\s+(?:dao|dau))\b/i.test(normalized) ||
    /(?:তৈরি\s*কর|বানাও|আঁকো|ডিজাইন\s*কর|লিখে\s*দাও)/u.test(normalized) ||
    /\b(create|generate|draw|design|make|build|develop|compose|write)\b[\s\S]{0,60}\b(image|photo|picture|logo|poster|banner|illustration|website|webpage|app|application|code|program|presentation|slides?|document|report|cv|resume)\b/i.test(normalized) ||
    /\b(image|photo|picture|logo|poster|banner|illustration|website|webpage|app|application|code|program|presentation|slides?|document|report|cv|resume)\b[\s\S]{0,60}\b(create|generate|draw|design|make|build|develop|ban(?:ao|a|ai|ate)|toiri|likhe|koro|dao|dau)\b/i.test(normalized) ||
    /(ছবি|লোগো|পোস্টার|ব্যানার|ওয়েবসাইট|ওয়েবসাইট|অ্যাপ|কোড|প্রোগ্রাম|প্রেজেন্টেশন|ডকুমেন্ট|রিপোর্ট).{0,40}(তৈরি|বানাও|আঁকো|লিখে|করো|দাও)/u.test(normalized);
  const solverIntent =
    /\b(solve|calculate|debug|fix\s+(?:this\s+)?code|write\s+(?:a\s+)?(?:python|javascript|java|c\+\+|c#|php|sql)|explain\s+(?:this\s+)?(?:equation|code|algorithm))\b/i.test(normalized) ||
    /(সমাধান|হিসাব|ক্যালকুলেট|কোড\s*(?:লিখ|কর|দাও)|বাগ\s*(?:ঠিক|ফিক্স))/u.test(normalized);

  if (creationIntent || solverIntent) return "gb-ai";

  const lastAssistant = [...history].reverse().find((message) => message?.role === "assistant");
  const lastUser = [...history].reverse().find((message) => message?.role === "user");
  const aiFollowup = !isInformationalMessage(value) &&
    /\b(again|another|change|edit|modify|improve|regenerate|make\s+it|add|remove|same|version|variant|aro|abar|eta|eita)\b|(?:আবার|আরও|এটা|এইটা|পরিবর্তন|যোগ|বাদ|ভালো\s*কর)/iu.test(normalized) &&
    (lastAssistant?.medium === "gb-ai" || lastAssistant?.image || inferMessageMedium(lastUser?.text || "", [], [], false) === "gb-ai");

  return aiFollowup ? "gb-ai" : "chatbot";
}

