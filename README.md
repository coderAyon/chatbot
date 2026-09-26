# University Knowledge Assistant

Production-oriented hybrid RAG + AI chatbot for Gono Bishwabidyalay. It separates verified university facts from general academic explanations instead of treating the nearest scraped paragraph as an answer.

## What it does

- Crawls the configured official university website with sitemap plus internal-link discovery.
- Extracts semantic page content, programs, admission requirements, seats, duration, people, leadership roles, fees, office contacts, dated notices, and linked PDF text.
- Caches fetched official pages for 24 hours so interrupted refreshes can continue without repeating completed downloads.
- Stores indexed knowledge in `data/knowledge.json`.
- Serves a REST chat API with hybrid retrieval: keyword, fuzzy matching, synonym expansion, and vector-style lexical similarity.
- Uses Gemini first when configured, then a server-side OpenAI-compatible provider such as Groq/OpenRouter, or an available local Ollama model. Visitors never need a separate AI account or login.
- Applies strict evidence gates to exact numbers, fees, credits, contacts, dates, roles, and campus facts. A weak keyword match cannot become a verified answer.
- Stores structured institution facts, programs, people, roles, contacts, notices, and readable PDF content alongside page chunks.
- Keeps recent person and department context for follow-up questions such as `number please` and `does he have email?`.
- Persists up to 120 turns per local conversation, so long chats and server restarts retain person, department, and program-comparison context. Starting a new chat creates an isolated conversation ID.
- Acts as a structured academic advisor: builds department profiles, compares programs, reads course codes and credits from official curricula, and reasons over comparison follow-ups such as `which one has more credits?`.
- Filters malformed and duplicate crawler records before presenting the verified program catalog.
- Provides dedicated source-grounded answers for mission, library, student portal, research, sports, transport, financial aid, and accommodation availability.
- Supports PDF/image/text attachments with text extraction, OCR, and optional local image captioning.
- Includes responsive dark/light UI, safe rich-text answers, source chips, follow-up actions, keyboard accessibility, and an admin health panel.
- Never fabricates unsupported facts. Unsupported answers return:

```text
I couldn't find verified information from the official university data.
```

## Setup

```bash
npm install
copy .env.example .env
npm run build:knowledge
npm start
```

Open `http://127.0.0.1:5173/`. `npm start` runs both the API and Vite development server.

## Answer Pipeline

1. Normalize English, Bengali, and common Banglish spellings.
2. Resolve conversation context for short follow-ups.
3. Resolve program comparisons, department profiles, and curriculum/course-code questions from structured official records.
4. Try fact handlers for roles, people, programs, fees, credits, contacts, notices, campus services, and institution facts.
5. Search a cached hybrid retrieval index for supporting official evidence.
6. Reject weak, placeholder, malformed, or unrelated evidence for exact university facts.
7. Use the configured server AI when general synthesis is useful.
8. Return answer confidence, relevant official sources, and contextual follow-up actions.

## Important Environment Variables

- `OFFICIAL_SITE_URL`: official university website to crawl.
- `GEMINI_API_KEY`: optional Google AI Studio key for free-tier friendly AI answer synthesis.
- `GEMINI_MODEL`: default `gemini-2.5-flash`.
- `OPENAI_API_KEY`: optional OpenAI-compatible API key.
- `OPENAI_MODEL`: default `gpt-4o-mini`.
- `OPENAI_BASE_URL`: default `https://api.openai.com/v1`; can point to an OpenAI-compatible gateway.
- For Groq on Render, set `OPENAI_API_KEY`, `OPENAI_MODEL=openai/gpt-oss-120b`, `OPENAI_BASE_URL=https://api.groq.com/openai/v1`, and `OPENAI_PROVIDER_NAME=Groq`.
- `OLLAMA_URL` and `OLLAMA_MODEL`: optional local fallback.
- `ADMIN_TOKEN`: optional token required as `x-admin-token` for logs, settings, and rebuild APIs. Public health/status remains readable so the chat UI can report service health.
- `MAX_PAGES`, `MAX_PDFS`, `CRAWL_CONCURRENCY`, `PDF_CONCURRENCY`: crawler limits.
- `FETCH_TIMEOUT_MS`, `FETCH_RETRIES`, `RECOVERY_PAGES`: transient failure handling and the reduced-concurrency recovery pass.

## Admin APIs

- `GET /api/admin/status`: index counts, model status, rebuild status.
- `POST /api/admin/refresh`: recrawl and rebuild `data/knowledge.json`.
- `GET /api/admin/logs`: recent chat and server logs.
- `GET /api/admin/settings`: active crawl/model settings.
- `POST /api/admin/settings`: save crawl target and limits for admin-triggered refresh.

## Data Files

- `data/knowledge.json`: official crawled knowledge.
- `data/chat-history.json`: chat analytics/history.
- `data/server-logs.json`: warnings and errors.
- `data/response-cache.json`: cached answers per knowledge build.
- `data/conversation-memory.json`: bounded persistent context for up to 100 local conversations.
- `data/settings.json`: admin-saved crawl settings.
- `data/crawl-cache/`: resumable 24-hour cache of public official pages.

## Verification

```bash
npm test
npm run build
```

The answer-engine regression tests cover greetings, unclear questions, leadership scope, admission details, program comparison, curriculum lookup, clean program catalogs, cross-department credit isolation, conflicting curricula, multi-turn person/department/comparison context, campus services, research, latest-notice filtering, unsupported campus area, and core institution facts.

Run the complete local verification with:

```bash
npm run check
```

## Accuracy Rules

The backend prompt and retrieval pipeline require source-grounded answers. Do not add hardcoded people, phone numbers, fees, room numbers, or policies unless they are extracted from official data and included in `knowledge.json`. General educational answers are clearly labelled and must not be presented as Gono-specific facts.

## Deployment Notes

- Configure Groq, Gemini, OpenAI/OpenRouter, or Ollama on the Render backend and set a strong `ADMIN_TOKEN`. The Vercel frontend proxies `/api/*` to Render, so provider secrets belong in Render rather than browser-visible `VITE_*` variables.
- After changing Render environment variables, save and redeploy the Render service. Vercel visitors can then use AI without an AI-provider login.
- Chat history and logs are JSON files intended for a single-process final-year-project deployment. Use a database before running multiple API instances.
- The official university website remains the source of truth. Rebuild the index after material website updates and review crawler warnings in Admin.
