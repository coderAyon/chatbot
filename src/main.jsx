import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  BadgeCheck,
  BookOpen,
  Check,
  Clipboard,
  Clock,
  DatabaseZap,
  Download,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  Moon,
  PanelLeft,
  PanelLeftClose,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import "./styles.css";

const GB_LOGO_URL = "/gb-logo.png";
const CHAT_HISTORY_KEY = "university-chat-history-v3";
const LEGACY_CHAT_HISTORY_KEYS = ["university-chat-history", "university-chat-history-v2"];

const QUICK_PROMPTS = [
  {
    icon: "🎓",
    badge: "Programs & Fees",
    title: "B.Sc. in CSE Tuition & Waiver",
    desc: "Tk. 4,50,000/- total fee, initial payment & semester waivers",
    prompt: "CSE total tuition fee, admission cost and waiver koto?",
  },
  {
    icon: "💊",
    badge: "Health Sciences",
    title: "Bachelor of Pharmacy (B.Pharm)",
    desc: "Tk. 6,00,000/- fee, 70 seats & Council eligibility",
    prompt: "Pharmacy course fee and admission requirements ki?",
  },
  {
    icon: "💰",
    badge: "Financial Aid",
    title: "Waivers & Scholarships",
    desc: "10%–50% GPA merit waiver, female stipend & quotas",
    prompt: "Gono Bishwabidyalay-te scholarship and waiver kivabe pabo?",
  },
  {
    icon: "📋",
    badge: "Admissions",
    title: "Admission Schedule & Steps",
    desc: "Spring/Fall intake, required documents & hotline support",
    prompt: "Admission kobe shuru hobe and kivabe apply korbo?",
  },
  {
    icon: "🏫",
    badge: "Campus Life",
    title: "Campus, Transport & Hostels",
    desc: "Green Savar campus, student buses & digital library",
    prompt: "Savar campus facilities, transport bus route and hostel kemon?",
  },
  {
    icon: "💡",
    badge: "Career Guide",
    title: "Career Prospects in CSE",
    desc: "Software engineering, AI, tech jobs & next steps",
    prompt: "CSE porle career scope and future demand kemon? Tar por ki korbo?",
  },
];
function waitForPuter(timeoutMs = 8000) {
  if (window.puter?.ai?.chat) return Promise.resolve(window.puter);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (window.puter?.ai?.chat) {
        clearInterval(timer);
        resolve(window.puter);
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Puter AI did not load"));
      }
    }, 120);
  });
}

function aiResponseText(response) {
  const content = response?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => (typeof item === "string" ? item : item?.text || "")).join("\n").trim();
  }
  return "";
}

let puterModelCandidatesPromise;

function puterModelId(model) {
  if (typeof model === "string") return model;
  return String(model?.id || model?.model || model?.name || "").trim();
}

function modelRank(id) {
  const value = id.toLowerCase();
  let score = value.includes(":free") ? 1000 : 0;
  if (/gpt|gemini|claude|qwen|deepseek|llama|mistral/.test(value)) score += 100;
  if (/nano|mini|flash|lite|small|8b|free/.test(value)) score += 40;
  if (/image|video|audio|speech|tts|embedding|moderation|whisper/.test(value)) score -= 2000;
  return score;
}

async function availablePuterModels(puter, configured = []) {
  if (!puterModelCandidatesPromise) {
    puterModelCandidatesPromise = (async () => {
      try {
        if (typeof puter.ai.listModels !== "function") return [];
        const response = await Promise.race([
          puter.ai.listModels(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Model catalog timed out")), 8000)),
        ]);
        const models = Array.isArray(response) ? response : response?.models || response?.data || [];
        return [...new Set(models.map(puterModelId).filter(Boolean))]
          .filter((id) => modelRank(id) > -1000)
          .sort((a, b) => modelRank(b) - modelRank(a));
      } catch (error) {
        console.warn("Puter model catalog unavailable:", error);
        return [];
      }
    })();
  }
  const discovered = await puterModelCandidatesPromise;
  if (!discovered.length) puterModelCandidatesPromise = undefined;
  const freeModels = discovered.filter((id) => id.toLowerCase().includes(":free"));
  const preferred = freeModels.length ? freeModels : discovered.slice(0, 4);
  return [...new Set([...preferred, ...configured].filter(Boolean))].slice(0, 6);
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)),
  ]);
}

async function enhanceWithPuter(data, onProgress) {
  if (!data?.aiAssist?.messages?.length) return data;
  const { aiAssist, ...fallback } = data;
  try {
    const puter = await waitForPuter();
    const configured = aiAssist.modelCandidates || (aiAssist.model ? [aiAssist.model] : []);
    const candidates = await availablePuterModels(puter, configured);
    let lastError;
    for (const model of candidates.slice(0, 3)) {
      try {
        onProgress?.(`Reasoning with ${model.replace(/:free$/i, "")}...`);
        const response = await withTimeout(
          puter.ai.chat(aiAssist.messages, {
            model,
            normalize: true,
            temperature: 0.3,
            max_tokens: 900,
          }),
          35000,
          model,
        );
        const text = aiResponseText(response);
        if (!text) throw new Error(`${model} returned an empty response`);
        return {
          ...fallback,
          text,
          mode: "puter_ai",
          aiModel: model,
          profile: {
            label: model.toLowerCase().includes(":free") ? "Free AI assisted" : "Puter AI assisted",
            confidence: fallback.sources?.length ? "Official-context guided" : "General knowledge",
          },
        };
      } catch (error) {
        lastError = error;
        console.warn(`Puter model ${model} unavailable:`, error);
      }
    }
    if (lastError) throw lastError;
    return fallback;
  } catch (error) {
    console.warn("Puter AI fallback unavailable:", error);
    return fallback;
  }
}

function createNewConversation() {
  const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    title: "New chat",
    messages: [],
    sessionId: id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function generateChatTitle(userText, attachments = []) {
  if (userText && userText.trim()) {
    const clean = userText.trim().replace(/\s+/g, " ");
    return clean.length > 28 ? clean.slice(0, 28) + "..." : clean;
  }
  if (attachments.length > 0) {
    const name = attachments[0].name || "Attachment";
    return name.length > 28 ? name.slice(0, 28) + "..." : name;
  }
  return "New chat";
}

function App() {
  // Pure in-memory temporary conversations (cleared completely on refresh)
  const [conversations, setConversations] = useState(() => [createNewConversation()]);
  const [activeChatId, setActiveChatId] = useState(() => conversations[0]?.id);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== "undefined" ? window.innerWidth > 820 : true);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState("Thinking...");
  const [theme, setTheme] = useState(() => localStorage.getItem("university-theme") || "dark");
  const [adminOpen, setAdminOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [connectionState, setConnectionState] = useState("checking");
  const [copiedIndex, setCopiedIndex] = useState(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const endRef = useRef(null);
  const activeRequestRef = useRef(null);

  // Clear any legacy storage keys on mount so that no past chats persist across refresh
  useEffect(() => {
    [CHAT_HISTORY_KEY, ...LEGACY_CHAT_HISTORY_KEYS, "university-assistant-session"].forEach((key) =>
      localStorage.removeItem(key),
    );
  }, []);

  const activeConversation =
    conversations.find((c) => c.id === activeChatId) || conversations[0] || createNewConversation();
  const messages = activeConversation.messages || [];
  const hasMessages = messages.length > 0;
  const validHistoryChats = conversations.filter((c) => c.messages.length > 0);

  function startNewChat() {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setIsThinking(false);
    setInput("");
    if (composerInputRef.current) composerInputRef.current.style.height = "auto";
    setAttachments([]);
    setAttachmentError("");

    // If active chat is already empty, just stay on it
    if (activeConversation && activeConversation.messages.length === 0) {
      if (window.innerWidth <= 820) setSidebarOpen(false);
      composerInputRef.current?.focus();
      return;
    }

    // Check if an empty conversation already exists in the list
    const existingEmpty = conversations.find((c) => c.messages.length === 0);
    if (existingEmpty) {
      setActiveChatId(existingEmpty.id);
      if (window.innerWidth <= 820) setSidebarOpen(false);
      composerInputRef.current?.focus();
      return;
    }

    const fresh = createNewConversation();
    setConversations((prev) => [fresh, ...prev]);
    setActiveChatId(fresh.id);
    if (window.innerWidth <= 820) setSidebarOpen(false);
    composerInputRef.current?.focus();
  }

  function selectChat(chatId) {
    if (activeChatId === chatId) {
      if (window.innerWidth <= 820) setSidebarOpen(false);
      return;
    }
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setIsThinking(false);
    setActiveChatId(chatId);
    setInput("");
    if (composerInputRef.current) composerInputRef.current.style.height = "auto";
    setAttachments([]);
    setAttachmentError("");
    if (window.innerWidth <= 820) setSidebarOpen(false);
  }

  function deleteChat(chatId) {
    if (activeRequestRef.current && activeChatId === chatId) {
      activeRequestRef.current.abort();
      activeRequestRef.current = null;
      setIsThinking(false);
    }
    setConversations((prev) => {
      const filtered = prev.filter((c) => c.id !== chatId);
      if (filtered.length === 0) {
        const fresh = createNewConversation();
        setActiveChatId(fresh.id);
        return [fresh];
      }
      if (activeChatId === chatId) {
        setActiveChatId(filtered[0].id);
      }
      return filtered;
    });
  }

  function clearAllChats() {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setIsThinking(false);
    const fresh = createNewConversation();
    setConversations([fresh]);
    setActiveChatId(fresh.id);
    setInput("");
    if (composerInputRef.current) composerInputRef.current.style.height = "auto";
    setAttachments([]);
    setAttachmentError("");
    if (window.innerWidth <= 820) setSidebarOpen(false);
  }

  function resizeComposer(target) {
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("university-theme", theme);
  }, [theme]);

  // Purely in-memory scroll effect without localStorage writes
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isThinking, activeChatId]);

  useEffect(() => {
    refreshStatus();
  }, []);

  async function refreshStatus() {
    try {
      const response = await fetch("/api/admin/status");
      if (response.ok) {
        setStatus(await response.json());
        setConnectionState("online");
      } else {
        setConnectionState("offline");
      }
    } catch {
      setStatus(null);
      setConnectionState("offline");
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleAttachmentChange(event) {
    const files = Array.from(event.target.files || []);
    const maxFiles = Math.max(0, 3 - attachments.length);
    const allowedExtensions = /\.(pdf|png|jpe?g|webp|gif|bmp|txt|md|csv)$/i;
    const selected = files.slice(0, maxFiles);
    const accepted = selected.filter(
      (file) =>
        file.size <= 12 * 1024 * 1024 &&
        (file.type.startsWith("image/") ||
          file.type === "application/pdf" ||
          file.type.startsWith("text/") ||
          allowedExtensions.test(file.name)),
    );
    const rejectedCount = files.length - accepted.length;
    const prepared = await Promise.all(
      accepted.map(async (file) => ({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        data: await readFileAsDataUrl(file),
      })),
    );
    setAttachments((current) => [...current, ...prepared].slice(0, 3));
    setAttachmentError(
      rejectedCount > 0
        ? "Only PDF, image, or text files up to 12 MB are supported. Maximum 3 files per message."
        : "",
    );
    event.target.value = "";
  }

  function removeAttachment(indexToRemove) {
    setAttachments((current) => current.filter((_, index) => index !== indexToRemove));
  }

  async function sendMessage(text = input) {
    const trimmed = text.trim();
    const selectedAttachments = attachments;
    if ((!trimmed && selectedAttachments.length === 0) || activeRequestRef.current) return;
    const request = new AbortController();
    activeRequestRef.current = request;

    const outgoingText = trimmed || "Read this attachment and summarize it.";
    const userMessage = {
      role: "user",
      text: outgoingText,
      attachments: selectedAttachments.map(({ name, mimeType, size }) => ({ name, mimeType, size })),
    };

    let targetId = activeChatId;
    let target = conversations.find((c) => c.id === targetId);
    if (!target) {
      target = createNewConversation();
      targetId = target.id;
      setActiveChatId(targetId);
      setConversations((prev) => [target, ...prev]);
    }

    const isFirstMessage = target.messages.length === 0;
    const newTitle = isFirstMessage ? generateChatTitle(outgoingText, selectedAttachments) : target.title;
    const nextMessages = [...target.messages, userMessage];

    setConversations((prev) =>
      prev.map((c) =>
        c.id === targetId
          ? { ...c, title: newTitle, messages: nextMessages, updatedAt: Date.now() }
          : c,
      ),
    );

    setInput("");
    if (composerInputRef.current) composerInputRef.current.style.height = "auto";
    setAttachments([]);
    setAttachmentError("");
    setIsThinking(true);
    setThinkingLabel("Thinking...");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        signal: request.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: outgoingText,
          attachments: selectedAttachments,
          sessionId: target.sessionId || target.id,
          history: nextMessages.slice(-10).map(({ role, text }) => ({ role, text })),
        }),
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.error || `API request failed with status ${response.status}`);
      }
      let data = await response.json();
      if (activeRequestRef.current !== request) return;
      setConnectionState("online");
      data = await enhanceWithPuter(data, (label) => {
        if (activeRequestRef.current === request) setThinkingLabel(label);
      });
      if (activeRequestRef.current !== request) return;

      const assistantMessage = { role: "assistant", ...data };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? { ...c, messages: [...c.messages, assistantMessage], updatedAt: Date.now() }
            : c,
        ),
      );
    } catch (error) {
      if (activeRequestRef.current !== request || request.signal.aborted) return;
      setConnectionState("offline");
      setInput(trimmed);
      setAttachments(selectedAttachments);
      const errorMessage = {
        role: "assistant",
        text: "Chat service is temporarily offline. Your question is kept in the composer - reconnect the service and press Retry.",
        sources: [],
        mode: "error",
        retryText: outgoingText,
      };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? { ...c, messages: [...c.messages, errorMessage], updatedAt: Date.now() }
            : c,
        ),
      );
    } finally {
      if (activeRequestRef.current === request) {
        activeRequestRef.current = null;
        setIsThinking(false);
        refreshStatus();
      }
    }
  }

  async function copyMessage(text, index) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1400);
    } catch {
      setCopiedIndex(null);
    }
  }

  function exportConversation() {
    const currentMessages = activeConversation?.messages || [];
    const content = [
      "# GB Knowledge Assistant conversation",
      `Exported: ${new Date().toLocaleString()}`,
      `Topic: ${activeConversation?.title || "Conversation"}`,
      "",
      ...currentMessages.flatMap((message) => {
        const speaker = message.role === "assistant" ? "Assistant" : "You";
        const sources = (message.sources || []).filter((source) => source.url);
        return [
          `## ${speaker}`,
          message.text,
          ...(sources.length ? ["", "Sources:", ...sources.map((source) => `- [${source.title || source.url}](${source.url})`)] : []),
          "",
        ];
      }),
    ].join("\n");
    const safeTitle = (activeConversation?.title || "chat")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 24)
      .replace(/^-+|-+$/g, "");
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `gb-assistant-${safeTitle || "chat"}-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const composer = (
    <div className="composer-shell">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          sendMessage();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.txt,.md,.csv"
          multiple
          className="file-input"
          onChange={handleAttachmentChange}
        />
        <button
          className="attachment-button"
          type="button"
          aria-label="Add attachment"
          title="Add attachment"
          onClick={() => fileInputRef.current?.click()}
          disabled={isThinking}
        >
          <Paperclip size={18} />
        </button>
        <Search size={18} aria-hidden="true" />
        <textarea
          ref={composerInputRef}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            resizeComposer(event.target);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendMessage();
            }
          }}
          placeholder="Ask or attach PDF/image..."
          rows={1}
        />
        <button className="send-button" type="submit" disabled={(!input.trim() && attachments.length === 0) || isThinking} aria-label="Send message">
          <ArrowUp size={19} />
        </button>
      </form>
      {attachments.length > 0 && (
        <div className="attachment-row">
          {attachments.map((attachment, index) => (
            <div className="attachment-chip" key={`${attachment.name}-${index}`}>
              <Paperclip size={13} />
              <span>{attachment.name}</span>
              <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(index)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachmentError && <p className="attachment-error">{attachmentError}</p>}
    </div>
  );

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      {/* ChatGPT-style Left Sidebar with Temporary Chat History */}
      <aside className={`chat-sidebar ${sidebarOpen ? "mobile-open" : ""}`} aria-label="Chat history">
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <img src={GB_LOGO_URL} alt="GB Logo" className="sidebar-logo" />
            <span className="sidebar-brand-name">GB Assistant</span>
          </div>
          <button
            className="sidebar-icon-btn"
            type="button"
            onClick={() => setSidebarOpen(false)}
            title="Close sidebar"
            aria-label="Close sidebar"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>

        <div className="sidebar-action-wrap">
          <button
            className="sidebar-new-btn"
            type="button"
            onClick={startNewChat}
            title="New chat"
          >
            <Plus size={18} />
            <span>New chat</span>
          </button>
        </div>

        <div className="sidebar-history-container">
          <div className="sidebar-section-header">
            <span>Recent chats</span>
            {validHistoryChats.length > 0 && (
              <span className="sidebar-badge">{validHistoryChats.length}</span>
            )}
          </div>

          <div className="sidebar-history-list">
            {validHistoryChats.length === 0 ? (
              <div className="sidebar-empty">
                <MessageSquare size={20} className="sidebar-empty-icon" />
                <p className="sidebar-empty-title">No chat history yet</p>
                <span className="sidebar-empty-desc">Your temporary chats will appear here until refresh</span>
              </div>
            ) : (
              validHistoryChats.map((chat) => (
                <div
                  key={chat.id}
                  className={`sidebar-chat-item ${chat.id === activeChatId ? "active" : ""}`}
                  onClick={() => selectChat(chat.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") selectChat(chat.id);
                  }}
                >
                  <MessageSquare size={16} className="chat-item-icon" />
                  <span className="chat-item-title" title={chat.title}>
                    {chat.title}
                  </span>
                  <button
                    className="chat-item-delete-btn"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteChat(chat.id);
                    }}
                    title="Delete chat"
                    aria-label={`Delete chat ${chat.title}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-session-notice" title="Chat history is stored temporarily in memory and is wiped on browser or tab reload">
            <Clock size={13} />
            <span>Temporary session (clears on refresh)</span>
          </div>
          {validHistoryChats.length > 1 && (
            <button
              type="button"
              className="sidebar-clear-btn"
              onClick={clearAllChats}
              title="Clear all chats"
            >
              Clear all
            </button>
          )}
        </div>
      </aside>

      {/* Backdrop for mobile drawer */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <section className={`chat-area ${hasMessages ? "has-messages" : "is-empty"}`}>
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="sidebar-toggle-btn"
              type="button"
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            >
              <PanelLeft size={18} />
            </button>
            <div className="bot-mark">
              <img src={GB_LOGO_URL} alt="Gono Bishwabidyalay logo" />
            </div>
            <div className="topbar-identity">
              <h1>GB Knowledge Assistant</h1>
              <p className={`service-state ${connectionState}`}>
                <span className="service-state-dot" aria-hidden="true" />
                <span className="state-label">
                  {connectionState === "online" ? "Online" : connectionState === "offline" ? "Offline" : "Connecting"}
                </span>
                <span className="state-extra">
                  {connectionState === "online"
                    ? status?.geminiConfigured || status?.openAiConfigured || status?.ollamaAvailable
                      ? " • AI Active"
                      : " • Official Data"
                    : ""}
                </span>
              </p>
            </div>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" onClick={startNewChat} aria-label="New chat" title="New chat">
              <Plus size={18} />
            </button>
            <button className="icon-button optional-mobile-action" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme" title="Toggle theme">
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="icon-button" type="button" onClick={() => setAdminOpen(true)} aria-label="Open admin" title="Admin">
              <Settings size={18} />
            </button>
            {hasMessages && (
              <button className="icon-button optional-mobile-action" type="button" onClick={exportConversation} aria-label="Export conversation" title="Export conversation">
                <Download size={18} />
              </button>
            )}
          </div>
        </header>

        <div className="chat-layout">
          <div className="conversation">
            {!hasMessages && (
              <section className="welcome-screen">
                <div className="welcome-hero">
                  <div className="welcome-mark">
                    <img src={GB_LOGO_URL} alt="Gono Bishwabidyalay logo" />
                  </div>
                  <h2>What would you like to know?</h2>
                  <p>Explore verified admissions, tuition fees, waivers, campus life & academic advice.</p>
                </div>
                <div className="center-composer">{composer}</div>
                <div className="welcome-cards-grid">
                  {QUICK_PROMPTS.map((card, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="welcome-card"
                      onClick={() => sendMessage(card.prompt)}
                    >
                      <div className="welcome-card-header">
                        <span className="welcome-card-icon">{card.icon}</span>
                        <span className="welcome-card-badge">{card.badge}</span>
                      </div>
                      <h4 className="welcome-card-title">{card.title}</h4>
                      <p className="welcome-card-desc">{card.desc}</p>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {hasMessages && (
              <div className="message-stack">
                {messages.map((message, index) => (
                  <MessageBubble
                    message={message}
                    copied={copiedIndex === index}
                    onCopy={() => copyMessage(message.text, index)}
                    onSuggestion={sendMessage}
                    onRetry={(retryText) => sendMessage(retryText)}
                    key={`${message.role}-${index}-${message.text.slice(0, 12)}`}
                  />
                ))}

                {isThinking && (
                  <div className="message assistant" role="status" aria-live="polite">
                    <div className="avatar">
                      <img src={GB_LOGO_URL} alt="Gono Bishwabidyalay logo" />
                    </div>
                    <div className="message-body">
                      <div className="bubble compact">
                        <Loader2 className="spin inline-loader" size={15} />
                        <span>{thinkingLabel}</span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>
        </div>

        {hasMessages && <footer className="composer-wrap">{composer}</footer>}
      </section>
      {adminOpen && <AdminPanel status={status} onClose={() => setAdminOpen(false)} onRefreshStatus={refreshStatus} />}
    </main>
  );
}

function MessageBubble({ message, copied, onCopy, onSuggestion, onRetry }) {
  const isAssistant = message.role === "assistant";
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar">
        {isAssistant ? <img src={GB_LOGO_URL} alt="Gono Bishwabidyalay logo" /> : <UserRound size={18} />}
      </div>
      <div className="message-body">
        {!isAssistant && message.attachments?.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((attachment, index) => (
              <span key={`${attachment.name}-${index}`}>
                <Paperclip size={13} />
                {attachment.name}
              </span>
            ))}
          </div>
        )}
        {isAssistant && message.profile && (
          <div className="response-meta">
            <span>
              <BadgeCheck size={13} />
              {message.profile.label}
            </span>
            <span>
              <BookOpen size={13} />
              {message.profile.confidence}
            </span>
            {message.aiModel && (
              <span className="model-chip" title={`Model: ${message.aiModel}`}>
                <Sparkles size={13} />
                {message.aiModel.replace(/:free$/i, "").split("/").at(-1)}
              </span>
            )}
          </div>
        )}
        <div className="bubble">{renderMessageText(message.text)}</div>
        {isAssistant && (
          <div className="message-actions">
            <button className="message-action" type="button" onClick={onCopy} aria-label="Copy response" title="Copy response">
              {copied ? <Check size={16} /> : <Clipboard size={16} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
            {message.mode === "error" && (
              <button className="message-action retry-action" type="button" onClick={() => onRetry(message.retryText || "")}>
                <RotateCcw size={16} />
                <span>Retry</span>
              </button>
            )}
          </div>
        )}
        {isAssistant && message.suggestions?.length > 0 && (
          <div className="suggestion-row" aria-label="Follow-up suggestions">
            {message.suggestions.map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => onSuggestion(suggestion)}>
                <Sparkles size={13} />
                <span>{suggestion}</span>
              </button>
            ))}
          </div>
        )}
        {isAssistant && message.sources?.length > 0 && (
          <div className="citation-row">
            {message.sources.map((source, sourceIndex) => (
              <a href={source.url || "#"} target={source.url ? "_blank" : undefined} rel="noreferrer" key={`${source.url}-${sourceIndex}`}>
                <LinkIcon size={13} />
                <span>{source.title || "Official source"}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function AdminPanel({ status, onClose, onRefreshStatus }) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [logs, setLogs] = useState([]);
  const [chats, setChats] = useState([]);
  const [settings, setSettings] = useState(null);
  const [adminError, setAdminError] = useState("");
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem("gb-admin-token") || "");

  function adminFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(adminToken ? { "x-admin-token": adminToken } : {}),
      },
    });
  }

  useEffect(() => {
    loadAdminData();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function loadAdminData() {
    try {
      const [logsResponse, settingsResponse] = await Promise.all([adminFetch("/api/admin/logs"), adminFetch("/api/admin/settings")]);
      if (logsResponse.status === 401 || settingsResponse.status === 401) throw new Error("Admin token required for logs and refresh controls.");
      if (!logsResponse.ok || !settingsResponse.ok) throw new Error("Admin data could not be loaded.");
      const data = await logsResponse.json();
      setLogs(data.logs || []);
      setChats(data.chats || []);
      setSettings(await settingsResponse.json());
      setAdminError("");
    } catch (error) {
      setAdminError(error.message || "Admin data could not be loaded.");
    }
  }

  async function refreshKnowledge() {
    setIsRefreshing(true);
    try {
      const response = await adminFetch("/api/admin/refresh", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Knowledge refresh could not be started.");
      }
      setAdminError("");
      await onRefreshStatus();
      await loadAdminData();
    } catch (error) {
      setAdminError(error.message || "Knowledge refresh could not be started.");
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <aside className="admin-backdrop" role="dialog" aria-modal="true">
      <section className="admin-panel">
        <header className="admin-header">
          <div>
            <h2>Admin</h2>
            <p>Refresh knowledge, monitor logs, and inspect indexing health.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close admin">
            <X size={18} />
          </button>
        </header>

        <div className="admin-grid">
          <Metric label="Official pages" value={status?.pageCount ?? "-"} />
          <Metric label="People records" value={status?.peopleCount ?? "-"} />
          <Metric label="Documents" value={status?.documentCount ?? "-"} />
          <Metric label="Programs" value={status?.programCount ?? "-"} />
          <Metric label="Notices" value={status?.noticeCount ?? "-"} />
          <Metric label="Office contacts" value={status?.contactCount ?? "-"} />
        </div>

        {status?.warnings?.length > 0 && (
          <div className="admin-warning-list">
            {status.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}

        {adminError && <p className="admin-inline-error" role="alert">{adminError}</p>}

        <div className="admin-auth">
          <label htmlFor="admin-token">Admin token</label>
          <div>
            <input
              id="admin-token"
              type="password"
              value={adminToken}
              placeholder="Only needed when ADMIN_TOKEN is configured"
              autoComplete="off"
              onChange={(event) => setAdminToken(event.target.value)}
            />
            <button
              className="secondary-action"
              type="button"
              onClick={() => {
                sessionStorage.setItem("gb-admin-token", adminToken);
                loadAdminData();
              }}
            >
              <Check size={17} />
              <span>Apply</span>
            </button>
          </div>
        </div>

        <div className="admin-actions">
          <button className="primary-action" type="button" onClick={refreshKnowledge} disabled={isRefreshing || status?.rebuild?.running}>
            {isRefreshing || status?.rebuild?.running ? <Loader2 className="spin" size={18} /> : <RotateCcw size={18} />}
            <span>{status?.rebuild?.running ? "Rebuilding..." : "Re-crawl website"}</span>
          </button>
          <button className="secondary-action" type="button" onClick={loadAdminData}>
            <DatabaseZap size={18} />
            <span>Reload logs</span>
          </button>
        </div>

        {settings && (
          <div className="admin-section">
            <h3>Knowledge Source</h3>
            <p>{settings.officialSiteUrl}</p>
            <small>
              Answer mode: {status?.geminiConfigured ? "Gemini AI" : status?.openAiConfigured ? status?.openAiProviderName || "OpenAI-compatible AI" : status?.ollamaAvailable ? "Ollama" : "official knowledge + general academic fallback"}.
            </small>
            <small>Free model options: Puter.js no-key browser AI, Gemini free tier, OpenRouter free models, or local Ollama.</small>
            <small>Set `OFFICIAL_SITE_URL` or save admin settings before rebuilding for another university.</small>
          </div>
        )}

        <div className="admin-section">
          <h3>Latest Activity</h3>
          <div className="log-list">
            {[...logs.slice(0, 4), ...chats.slice(0, 4)].slice(0, 8).map((item, index) => (
              <div className="log-item" key={`${item.at}-${index}`}>
                <strong>{item.level || item.mode || "chat"}</strong>
                <span>{item.message || item.question}</span>
              </div>
            ))}
            {!logs.length && !chats.length && <p>No activity recorded yet.</p>}
          </div>
        </div>
      </section>
    </aside>
  );
}

function Metric({ label, value }) {
  return (
    <div className="admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function renderMessageText(text) {
  const lines = String(text || "").split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      output.push(<h3 key={`heading-${index}`}>{renderInlineText(heading[2], `heading-${index}`)}</h3>);
      index += 1;
      continue;
    }
    const isOrdered = /^\d+[.)]\s+/.test(line);
    const isUnordered = /^[-*]\s+/.test(line);
    if (isOrdered || isUnordered) {
      const items = [];
      const pattern = isOrdered ? /^\d+[.)]\s+(.+)$/ : /^[-*]\s+(.+)$/;
      while (index < lines.length) {
        const match = lines[index].trim().match(pattern);
        if (!match) break;
        items.push(<li key={`item-${index}`}>{renderInlineText(match[1], `item-${index}`)}</li>);
        index += 1;
      }
      const List = isOrdered ? "ol" : "ul";
      output.push(<List key={`list-${index}`}>{items}</List>);
      continue;
    }
    output.push(<p key={`paragraph-${index}`}>{renderInlineText(line, `paragraph-${index}`)}</p>);
    index += 1;
  }
  return <div className="rich-message">{output}</div>;
}

function renderInlineText(text, keyPrefix) {
  return String(text)
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      const key = `${keyPrefix}-${index}`;
      if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
      if (part.startsWith("*") && part.endsWith("*")) return <em key={key}>{part.slice(1, -1)}</em>;
      return <React.Fragment key={key}>{part}</React.Fragment>;
    });
}

const rootElement = document.getElementById("root");
const appRoot = import.meta.hot?.data.appRoot || createRoot(rootElement);
if (import.meta.hot) import.meta.hot.data.appRoot = appRoot;
appRoot.render(<App />);
