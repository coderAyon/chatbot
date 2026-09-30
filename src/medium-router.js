export function inferMessageMedium(text, attachments = [], history = [], webSearchEnabled = false) {
  const value = String(text || "").trim();
  const normalized = value.toLowerCase();
  if (attachments.length > 0 || webSearchEnabled) return "gb-ai";

  const webSearchIntent =
    /\b(web\s*search|search\s+(?:the\s+)?web|search\s+online|search\s+(?:the\s+)?internet|google\s+(?:it|this|koro|kore)|look\s+it\s+up|latest\s+news|current\s+news)\b/i.test(normalized) ||
    /(?:ওয়েব\s*সার্চ|ওয়েব\s*সার্চ|গুগল\s*কর|ইন্টারনেট\s*থেকে\s*খুঁজ|সাম্প্রতিক\s*খবর)/u.test(normalized);
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

  if (webSearchIntent || creationIntent || solverIntent) return "gb-ai";

  const lastAssistant = [...history].reverse().find((message) => message?.role === "assistant");
  const lastUser = [...history].reverse().find((message) => message?.role === "user");
  const aiFollowup =
    /\b(again|another|change|edit|modify|improve|regenerate|make\s+it|add|remove|same|version|variant|aro|abar|eta|eita)\b|(?:আবার|আরও|এটা|এইটা|পরিবর্তন|যোগ|বাদ|ভালো\s*কর)/iu.test(normalized) &&
    (lastAssistant?.medium === "gb-ai" || lastAssistant?.image || inferMessageMedium(lastUser?.text || "", [], [], false) === "gb-ai");

  return aiFollowup ? "gb-ai" : "chatbot";
}
