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
  Headphones,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  Moon,
  PanelLeft,
  PanelLeftClose,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Square,
  Sun,
  Trash2,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import "./styles.css";

const GB_LOGO_URL = "/gb-logo.png";
const CHAT_HISTORY_KEY = "university-chat-history-v3";
const ACTIVE_CHAT_KEY = "university-active-chat-v3";
const LEGACY_CHAT_HISTORY_KEYS = ["university-chat-history", "university-chat-history-v2"];

function parseBanglaOrEnglishNum(str) {
  const bnToEn = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };
  return String(str).replace(/[০-৯]/g, (d) => bnToEn[d]).replace(/,/g, "");
}

function toBanglaDigits(numStr) {
  const enToBn = { "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪", "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯" };
  return String(numStr).replace(/[0-9]/g, (d) => enToBn[d]);
}

function formatSpokenNumber(num, isBangla) {
  if (isNaN(num) || num < 1000) return isBangla ? toBanglaDigits(num) : String(num);
  const crore = Math.floor(num / 10000000);
  let rem = num % 10000000;
  const lakh = Math.floor(rem / 100000);
  rem = rem % 100000;
  const thousand = Math.floor(rem / 1000);
  const rest = rem % 1000;

  const parts = [];
  if (crore > 0) parts.push(isBangla ? `${toBanglaDigits(crore)} কোটি` : `${crore} crore`);
  if (lakh > 0) parts.push(isBangla ? `${toBanglaDigits(lakh)} লাখ` : `${lakh} lakh`);
  if (thousand > 0) parts.push(isBangla ? `${toBanglaDigits(thousand)} হাজার` : `${thousand} thousand`);
  if (rest > 0) {
    if (rest >= 100) {
      const hundreds = Math.floor(rest / 100);
      const subRest = rest % 100;
      if (isBangla) {
        parts.push(subRest > 0 ? `${toBanglaDigits(hundreds)} শত ${toBanglaDigits(subRest)}` : `${toBanglaDigits(hundreds)} শত`);
      } else {
        parts.push(subRest > 0 ? `${hundreds} hundred ${subRest}` : `${hundreds} hundred`);
      }
    } else {
      parts.push(isBangla ? toBanglaDigits(rest) : String(rest));
    }
  }

  return parts.join(" ");
}

function humanizeNumbersForSpeech(text, isBangla) {
  if (!text) return "";

  // 1. Currency patterns:
  // e.g. ৳ 45,000 / ৳45000 / 45,000/- / 45,000 টাকা / BDT 45,000 / TK 45,000
  const currencyRegex = /(?:৳|tk\.?|bdt)\s*([০-৯0-9,]+(?:\.\d+)?)(?:\s*\/-)?(?:\s*(?:টাকা|taka))?|([০-৯0-9,]+(?:\.\d+)?)\s*(?:টাকা|taka|\/-)/gi;

  let cleaned = text.replace(currencyRegex, (match, num1, num2) => {
    const rawNum = (num1 || num2 || "").replace(/\.00$/, "");
    const cleanNum = parseBanglaOrEnglishNum(rawNum);
    const val = Math.round(parseFloat(cleanNum));
    if (!isNaN(val) && val >= 1000) {
      const spoken = formatSpokenNumber(val, isBangla);
      return isBangla ? `${spoken} টাকা` : `${spoken} taka`;
    }
    return isBangla ? `${toBanglaDigits(cleanNum)} টাকা` : `${cleanNum} taka`;
  });

  // 2. Standalone large numbers (>= 1,000 with commas or >= 10,000 without commas)
  // Preserves 4-digit years like 1998, 2024.
  const largeNumRegex = /(?<![০-৯0-9])([০-৯0-9]{1,3}(?:,[০-৯0-9]{2,3})+|[0-9]{5,10}|[০-৯]{5,10})(?![০-৯0-9])/g;
  cleaned = cleaned.replace(largeNumRegex, (match) => {
    const cleanNum = parseBanglaOrEnglishNum(match);
    const val = parseInt(cleanNum, 10);
    if (!isNaN(val) && val >= 1000) {
      return formatSpokenNumber(val, isBangla);
    }
    return match;
  });

  return cleaned;
}

function cleanTextForSpeech(text, lang) {
  if (!text) return "";
  const isBangla = lang ? lang.startsWith("bn") : detectSpeechLanguage(text).startsWith("bn");
  let cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#~>]/g, " ")
    .replace(/\|\s*[-:]+\s*\|/g, " ")
    .replace(/\|/g, ", ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  cleaned = humanizeNumbersForSpeech(cleaned, isBangla);
  return cleaned;
}

function detectSpeechLanguage(text) {
  return /[\u0980-\u09FF]/.test(text) ? "bn-BD" : "en-US";
}

function speakUtterance(text, { lang, onStart, onEnd, onError, isVoiceMode = false } = {}) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onError?.(new Error("Speech synthesis not supported in this browser"));
    return () => {};
  }

  window.speechSynthesis.cancel();
  const determinedLang = lang || detectSpeechLanguage(text);
  const rawCleaned = cleanTextForSpeech(text, determinedLang);
  if (!rawCleaned) {
    onEnd?.();
    return () => {};
  }

  let spokenText = rawCleaned;
  if (isVoiceMode && rawCleaned.length > 360) {
    const sentences = rawCleaned.split(/(?<=[.!?।])\s+/);
    let gathered = "";
    for (const s of sentences) {
      if ((gathered + " " + s).trim().length > 340) break;
      gathered = (gathered + " " + s).trim();
    }
    spokenText = gathered || rawCleaned.slice(0, 340);
  }

  const utterance = new SpeechSynthesisUtterance(spokenText);
  utterance.lang = determinedLang;
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  const voices = window.speechSynthesis.getVoices?.() || [];
  if (voices.length > 0) {
    const match = voices.find(
      (v) =>
        v.lang.toLowerCase().startsWith(determinedLang.slice(0, 2).toLowerCase()) ||
        (determinedLang.startsWith("bn") &&
          (v.name.toLowerCase().includes("bangla") || v.name.toLowerCase().includes("bengali")))
    );
    if (match) utterance.voice = match;
  }

  utterance.onstart = () => onStart?.();
  utterance.onend = () => onEnd?.();
  utterance.onerror = (e) => {
    if (e.error !== "canceled" && e.error !== "interrupted") {
      onError?.(e);
    } else {
      onEnd?.();
    }
  };

  window.speechSynthesis.speak(utterance);

  return () => {
    window.speechSynthesis.cancel();
  };
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

function loadStoredConversations() {
  for (const key of [CHAT_HISTORY_KEY, ...LEGACY_CHAT_HISTORY_KEYS]) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      if (!Array.isArray(parsed)) continue;
      const valid = parsed
        .filter((chat) => chat?.id && Array.isArray(chat.messages))
        .slice(0, 40)
        .map((chat) => ({
          ...chat,
          sessionId: chat.sessionId || chat.id,
          messages: chat.messages.slice(-120),
        }));
      if (valid.length) return valid;
    } catch {
      // Ignore malformed legacy browser data.
    }
  }
  return [createNewConversation()];
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
  const [conversations, setConversations] = useState(loadStoredConversations);
  const [activeChatId, setActiveChatId] = useState(() => {
    const stored = localStorage.getItem(ACTIVE_CHAT_KEY);
    return conversations.some((chat) => chat.id === stored) ? stored : conversations[0]?.id;
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== "undefined" ? window.innerWidth > 820 : true);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.innerWidth <= 640 : false);
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
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const [speakingIndex, setSpeakingIndex] = useState(null);
  const [isListeningComposer, setIsListeningComposer] = useState(false);
  const composerRecognitionRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const endRef = useRef(null);
  const activeRequestRef = useRef(null);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 640);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.speechSynthesis?.cancel();
      composerRecognitionRef.current?.abort();
    };
  }, []);

  function toggleSpeakMessage(text, index) {
    if (speakingIndex === index) {
      window.speechSynthesis?.cancel();
      setSpeakingIndex(null);
      return;
    }
    setSpeakingIndex(index);
    speakUtterance(text, {
      onEnd: () => setSpeakingIndex(null),
      onError: () => setSpeakingIndex(null),
    });
  }

  function toggleComposerVoiceInput() {
    const SpeechRecognition = typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;

    if (!SpeechRecognition) {
      alert("Voice recognition is not supported in this browser. Please try Chrome, Edge, or Safari.");
      return;
    }

    if (isListeningComposer) {
      composerRecognitionRef.current?.stop();
      setIsListeningComposer(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      composerRecognitionRef.current = recognition;
      recognition.lang = "bn-BD";
      recognition.interimResults = true;
      recognition.continuous = false;

      let finalCaptured = "";
      recognition.onstart = () => {
        setIsListeningComposer(true);
      };
      recognition.onresult = (event) => {
        let currentInterim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const item = event.results[i];
          if (item.isFinal) {
            finalCaptured += item[0].transcript + " ";
          } else {
            currentInterim += item[0].transcript;
          }
        }
        const full = (finalCaptured + currentInterim).trim();
        if (full) {
          setInput(full);
          if (composerInputRef.current) {
            resizeComposer(composerInputRef.current);
          }
        }
      };
      recognition.onerror = () => {
        setIsListeningComposer(false);
      };
      recognition.onend = () => {
        setIsListeningComposer(false);
        composerInputRef.current?.focus();
      };
      recognition.start();
    } catch {
      setIsListeningComposer(false);
    }
  }

  useEffect(() => {
    try {
      const bounded = conversations.slice(0, 40).map((chat) => ({ ...chat, messages: chat.messages.slice(-120) }));
      localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(bounded));
      localStorage.setItem(ACTIVE_CHAT_KEY, activeChatId || "");
      LEGACY_CHAT_HISTORY_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch {
      // The chat remains usable in memory if browser storage is unavailable or full.
    }
  }, [conversations, activeChatId]);

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
    window.speechSynthesis?.cancel();
    setSpeakingIndex(null);
    composerRecognitionRef.current?.abort();
    setIsListeningComposer(false);

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
    window.speechSynthesis?.cancel();
    setSpeakingIndex(null);
    composerRecognitionRef.current?.abort();
    setIsListeningComposer(false);
    if (window.innerWidth <= 820) setSidebarOpen(false);
  }

  function deleteChat(chatId) {
    if (activeRequestRef.current && activeChatId === chatId) {
      activeRequestRef.current.abort();
      activeRequestRef.current = null;
      setIsThinking(false);
    }
    window.speechSynthesis?.cancel();
    setSpeakingIndex(null);
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
    window.speechSynthesis?.cancel();
    setSpeakingIndex(null);
    composerRecognitionRef.current?.abort();
    setIsListeningComposer(false);
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

      const assistantMessage = { role: "assistant", ...data };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? { ...c, messages: [...c.messages, assistantMessage], updatedAt: Date.now() }
            : c,
        ),
      );
      return assistantMessage;
    } catch (error) {
      if (activeRequestRef.current !== request || request.signal.aborted) return null;
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
      return null;
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
          placeholder={isMobile ? "Ask anything..." : "Ask or attach PDF/image..."}
          rows={1}
        />
        <button
          className={`composer-mic-button ${isListeningComposer ? "listening" : ""}`}
          type="button"
          onClick={toggleComposerVoiceInput}
          disabled={isThinking}
          aria-label={isListeningComposer ? "Stop voice input" : "Voice input"}
          title={isListeningComposer ? "Listening... click to stop" : "Voice input (বাংলা/English)"}
        >
          {isListeningComposer ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        {input.trim() || attachments.length > 0 ? (
          <button className="send-button" type="submit" disabled={isThinking} aria-label="Send message" title="Send message">
            <ArrowUp size={19} />
          </button>
        ) : (
          <button
            className="composer-voice-mode-button"
            type="button"
            onClick={() => {
              window.speechSynthesis?.cancel();
              setSpeakingIndex(null);
              setVoiceModeOpen(true);
            }}
            disabled={isThinking}
            aria-label="Open Voice Mode"
            title="ChatGPT Voice Mode (Live Voice)"
          >
            <Headphones size={18} />
          </button>
        )}
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
      {/* Chat history is stored locally so conversations survive refreshes. */}
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
                <span className="sidebar-empty-desc">Your conversations will appear here</span>
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
          <div className="sidebar-session-notice" title="Chat history is saved only in this browser">
            <Clock size={13} />
            <span>Saved on this device</span>
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
            <button
              className="voice-mode-trigger-btn"
              type="button"
              onClick={() => {
                window.speechSynthesis?.cancel();
                setSpeakingIndex(null);
                setVoiceModeOpen(true);
              }}
              aria-label="Open ChatGPT Voice Mode"
              title="ChatGPT Voice Mode (Live Voice)"
            >
              <Headphones size={17} />
              <span className="voice-mode-trigger-label">Voice Mode</span>
            </button>
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
                    isSpeaking={speakingIndex === index}
                    onToggleSpeak={() => toggleSpeakMessage(message.text, index)}
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
      {voiceModeOpen && (
        <VoiceModeModal
          isOpen={voiceModeOpen}
          onClose={() => {
            window.speechSynthesis?.cancel();
            setVoiceModeOpen(false);
          }}
          onSendMessage={sendMessage}
          activeConversation={activeConversation}
        />
      )}
    </main>
  );
}

function MessageBubble({ message, copied, onCopy, onSuggestion, onRetry, isSpeaking, onToggleSpeak }) {
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
            <button
              className={`message-action ${isSpeaking ? "is-speaking" : ""}`}
              type="button"
              onClick={onToggleSpeak}
              aria-label={isSpeaking ? "Stop voice" : "Read aloud"}
              title={isSpeaking ? "Stop voice" : "Read aloud in voice (বাংলা/English)"}
            >
              {isSpeaking ? <VolumeX size={16} /> : <Volume2 size={16} />}
              <span>{isSpeaking ? "Stop" : "Listen"}</span>
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
            <small>Server AI options: Groq, Gemini, OpenRouter, or local Ollama. Visitors never need a separate AI login.</small>
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

function VoiceModeModal({ isOpen, onClose, onSendMessage, activeConversation }) {
  const [voiceStatus, setVoiceStatus] = useState("listening"); // "listening" | "thinking" | "speaking" | "idle"
  const [voiceLang, setVoiceLang] = useState("bn-BD");
  const [isMuted, setIsMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [userTranscript, setUserTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [assistantReply, setAssistantReply] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const recognitionRef = useRef(null);
  const isComponentMounted = useRef(true);

  // Monitor microphone volume via Web Audio API for reactive Orb glow/scale
  useEffect(() => {
    if (!isOpen) return;
    let stream = null;
    let audioCtx = null;
    let analyser = null;
    let animId = null;

    async function initAudio() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.4;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const checkAudio = () => {
          if (!analyser) return;
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          const avg = sum / dataArray.length;
          const level = Math.min(1, Math.max(0, (avg - 10) / 55));
          setAudioLevel(level);
          animId = requestAnimationFrame(checkAudio);
        };
        checkAudio();
      } catch {
        // Fallback gracefully if mic stream visualization cannot be accessed
      }
    }

    initAudio();

    return () => {
      if (animId) cancelAnimationFrame(animId);
      if (audioCtx) audioCtx.close().catch(() => {});
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [isOpen]);

  // Main SpeechRecognition handling loop
  useEffect(() => {
    if (!isOpen) return;
    isComponentMounted.current = true;

    const SpeechRecognition = typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;

    if (!SpeechRecognition) {
      setErrorMessage("ভয়েস রিকগনিশন এই ব্রাউজারে সাপোর্টেড নয়। সেরা অভিজ্ঞতার জন্য Chrome, Edge বা Safari ব্যবহার করুন।");
      return;
    }

    if (voiceStatus !== "listening" || isMuted) {
      recognitionRef.current?.abort();
      return;
    }

    let recognition = null;
    try {
      recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.lang = voiceLang;
      recognition.interimResults = true;
      recognition.continuous = false;

      let finalCaptured = "";

      recognition.onstart = () => {
        setErrorMessage("");
      };

      recognition.onresult = (event) => {
        let currentInterim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            finalCaptured += res[0].transcript;
          } else {
            currentInterim += res[0].transcript;
          }
        }
        setInterimTranscript(currentInterim);
        if (finalCaptured) {
          setUserTranscript(finalCaptured.trim());
        }
      };

      recognition.onerror = (e) => {
        if (e.error === "no-speech") {
          if (voiceStatus === "listening" && isComponentMounted.current && !isMuted) {
            try {
              recognition.start();
            } catch {}
          }
        } else if (e.error === "not-allowed") {
          setErrorMessage("মাইক্রোফোনের অনুমতি দেওয়া হয়নি। অনুগ্রহ করে ব্রাউজার সেটিংসে মাইক অ্যাক্সেস অ্যালাউ করুন।");
          setVoiceStatus("idle");
        }
      };

      recognition.onend = async () => {
        setInterimTranscript("");
        const query = finalCaptured.trim();
        if (query && voiceStatus === "listening") {
          handleUserVoiceQuery(query);
        } else if (voiceStatus === "listening" && !isMuted && isComponentMounted.current) {
          try {
            recognition.start();
          } catch {}
        }
      };

      recognition.start();
    } catch {
      // Ignore start errors
    }

    return () => {
      recognition?.abort();
    };
  }, [isOpen, voiceStatus, voiceLang, isMuted]);

  async function handleUserVoiceQuery(text) {
    if (!text) return;
    setVoiceStatus("thinking");
    setAssistantReply("");
    try {
      const result = await onSendMessage(text);
      if (result && result.text) {
        setAssistantReply(result.text);
        setVoiceStatus("speaking");
        speakUtterance(result.text, {
          lang: voiceLang,
          isVoiceMode: true,
          onEnd: () => {
            if (isComponentMounted.current) {
              setVoiceStatus("listening");
            }
          },
          onError: () => {
            if (isComponentMounted.current) {
              setVoiceStatus("listening");
            }
          },
        });
      } else {
        setVoiceStatus("idle");
      }
    } catch {
      setVoiceStatus("idle");
    }
  }

  function handleInterrupt() {
    window.speechSynthesis?.cancel();
    setVoiceStatus("listening");
    setAssistantReply("");
  }

  function toggleLanguage() {
    window.speechSynthesis?.cancel();
    setVoiceLang((prev) => (prev === "bn-BD" ? "en-US" : "bn-BD"));
    setVoiceStatus("listening");
  }

  function handleClose() {
    isComponentMounted.current = false;
    window.speechSynthesis?.cancel();
    recognitionRef.current?.abort();
    onClose();
  }

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") handleClose();
      if (e.key === " " && voiceStatus === "speaking") {
        e.preventDefault();
        handleInterrupt();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      isComponentMounted.current = false;
    };
  }, [voiceStatus]);

  if (!isOpen) return null;

  return (
    <div className="voice-mode-overlay" role="dialog" aria-modal="true" aria-label="ChatGPT Voice Mode">
      <header className="voice-mode-header">
        <div className="voice-mode-brand">
          <img src={GB_LOGO_URL} alt="Gono Bishwabidyalay logo" className="voice-mode-logo" />
          <div className="voice-mode-title-wrap">
            <span className="voice-mode-title">GB Voice Mode</span>
            <span className={`voice-mode-status-badge ${voiceStatus}`}>
              <span className="voice-status-dot" />
              <span>
                {voiceStatus === "listening"
                  ? voiceLang === "bn-BD" ? "শুনছি... বলুন" : "Listening..."
                  : voiceStatus === "thinking"
                  ? voiceLang === "bn-BD" ? "ভাবছি..." : "Thinking..."
                  : voiceStatus === "speaking"
                  ? voiceLang === "bn-BD" ? "বলছি..." : "Speaking..."
                  : voiceLang === "bn-BD" ? "প্রস্তুত" : "Ready"}
              </span>
            </span>
          </div>
        </div>

        <div className="voice-mode-top-actions">
          <button
            type="button"
            className="voice-lang-pill"
            onClick={toggleLanguage}
            title="Toggle Language (বাংলা / English)"
            aria-label="Toggle Language"
          >
            <span>{voiceLang === "bn-BD" ? "বাংলা" : "English"}</span>
          </button>
          <button
            type="button"
            className="voice-mode-close-btn"
            onClick={handleClose}
            title="Exit Voice Mode (Esc)"
            aria-label="Exit Voice Mode"
          >
            <X size={20} />
          </button>
        </div>
      </header>

      {/* Main visualizer and ChatGPT Glowing Orb */}
      <main className="voice-mode-main">
        <div
          className={`voice-orb-container ${voiceStatus}`}
          onClick={voiceStatus === "speaking" ? handleInterrupt : undefined}
          title={voiceStatus === "speaking" ? "Click to interrupt and speak" : ""}
        >
          {/* Outer diffuse ambient glow */}
          <div
            className="voice-orb-glow"
            style={{
              transform: `scale(${1 + audioLevel * 0.45})`,
              opacity: 0.5 + audioLevel * 0.5,
            }}
          />

          {/* Soundwave expanding rings */}
          {(voiceStatus === "listening" || voiceStatus === "speaking") && (
            <>
              <div className="voice-orb-wave wave-1" />
              <div className="voice-orb-wave wave-2" />
            </>
          )}

          {/* The Central Glowing Orb */}
          <div
            className={`voice-orb ${voiceStatus}`}
            style={{
              transform: `scale(${1 + audioLevel * (voiceStatus === "listening" ? 0.35 : 0.15)})`,
            }}
          >
            <div className="voice-orb-inner" />
            <div className="voice-orb-highlight" />
          </div>
        </div>

        {/* Dynamic Transcripts & Subtitles */}
        <div className="voice-transcript-card">
          {errorMessage ? (
            <p className="voice-error-text">{errorMessage}</p>
          ) : voiceStatus === "speaking" && assistantReply ? (
            <div className="voice-reply-box">
              <span className="voice-role-tag">GB Assistant</span>
              <p className="voice-reply-text">{assistantReply}</p>
            </div>
          ) : userTranscript || interimTranscript ? (
            <div className="voice-user-box">
              <span className="voice-role-tag user">You</span>
              <p className="voice-user-text">
                {userTranscript}
                {interimTranscript && <span className="voice-interim"> {interimTranscript}</span>}
              </p>
            </div>
          ) : (
            <p className="voice-hint-text">
              {voiceLang === "bn-BD"
                ? "মুখে বলুন... যেমন: 'ভর্তি ফি কত?' বা 'ফার্মেসি ডিপার্টমেন্ট সম্পর্কে বলো'"
                : "Ask anything aloud... e.g. 'What is the tuition fee?' or 'Campus contact numbers'"}
            </p>
          )}
        </div>
      </main>

      {/* Bottom Floating Control Dock */}
      <footer className="voice-mode-footer">
        <div className="voice-dock">
          <button
            type="button"
            className={`voice-dock-btn ${isMuted ? "muted" : "active"}`}
            onClick={() => setIsMuted((prev) => !prev)}
            title={isMuted ? "Unmute Mic" : "Mute Mic"}
            aria-label={isMuted ? "Unmute Mic" : "Mute Mic"}
          >
            {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>

          {voiceStatus === "speaking" ? (
            <button
              type="button"
              className="voice-dock-btn interrupt-btn"
              onClick={handleInterrupt}
              title="Interrupt & Speak"
              aria-label="Interrupt & Speak"
            >
              <Square size={18} />
              <span>Interrupt</span>
            </button>
          ) : voiceStatus === "thinking" ? (
            <button
              type="button"
              className="voice-dock-btn disabled-btn"
              disabled
              title="Generating answer..."
              aria-label="Thinking"
            >
              <Loader2 className="spin" size={20} />
            </button>
          ) : (
            <button
              type="button"
              className="voice-dock-btn listening-pill"
              onClick={() => {
                if (voiceStatus === "idle") setVoiceStatus("listening");
              }}
              title="Listening to your voice"
              aria-label="Listening"
            >
              <span className="voice-pulsing-circle" />
              <span>{voiceLang === "bn-BD" ? "কথা শুনছি..." : "Listening..."}</span>
            </button>
          )}

          <button
            type="button"
            className="voice-dock-btn exit-btn"
            onClick={handleClose}
            title="Back to text chat"
            aria-label="Back to text chat"
          >
            <MessageSquare size={19} />
          </button>
        </div>
      </footer>
    </div>
  );
}

const rootElement = document.getElementById("root");
const appRoot = import.meta.hot?.data.appRoot || createRoot(rootElement);
if (import.meta.hot) import.meta.hot.data.appRoot = appRoot;
appRoot.render(<App />);
