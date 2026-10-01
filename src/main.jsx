import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  BadgeCheck,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  Clipboard,
  Clock,
  Copy,
  DatabaseZap,
  Download,
  Eye,
  Globe,
  Headphones,
  Image as ImageIcon,
  Link as LinkIcon,
  LockKeyhole,
  LogIn,
  Loader2,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Moon,
  PanelLeft,
  PanelLeftClose,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
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
import { inferMessageMedium } from "./medium-router.js";

const GB_LOGO_URL = "/gb-logo.png";
const CHAT_HISTORY_KEY = "university-chat-history-v3";
const ACTIVE_CHAT_KEY = "university-active-chat-v3";
const LEGACY_CHAT_HISTORY_KEYS = ["university-chat-history", "university-chat-history-v2"];
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""), window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

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

const VOICE_LANGUAGE_KEY = "university-voice-language";

function preferredVoiceLanguage() {
  if (typeof window === "undefined") return "en-US";
  const saved = window.localStorage?.getItem(VOICE_LANGUAGE_KEY);
  if (saved === "bn-BD" || saved === "en-US") return saved;
  return String(window.navigator?.language || "en-US").toLowerCase().startsWith("bn") ? "bn-BD" : "en-US";
}

function bestRecognitionTranscript(result, lang) {
  const alternatives = Array.from(result || []).map((item) => String(item?.transcript || "").trim()).filter(Boolean);
  if (!alternatives.length) return "";
  const wantsBangla = String(lang || "").startsWith("bn");
  return alternatives.find((text) => /[\u0980-\u09FF]/.test(text) === wantsBangla) || alternatives[0];
}

function preferredSynthesisVoice(voices, lang) {
  const locale = String(lang || "en-US").toLowerCase();
  const language = locale.slice(0, 2);
  const matching = voices.filter((voice) => String(voice.lang || "").toLowerCase().startsWith(language));
  return (
    matching.find((voice) => String(voice.lang || "").toLowerCase() === locale) ||
    matching.find((voice) => language === "en" && /aria|zira|google.*english|samantha|daniel/i.test(voice.name || "")) ||
    matching.find((voice) => language === "bn" && /bangla|bengali/i.test(voice.name || "")) ||
    matching[0] ||
    null
  );
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
  const voice = preferredSynthesisVoice(voices, determinedLang);
  if (voice) utterance.voice = voice;

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
  const [editingIndex, setEditingIndex] = useState(null);
  const [editText, setEditText] = useState("");
  const composerRecognitionRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const editInputRef = useRef(null);
  const endRef = useRef(null);
  const activeRequestRef = useRef(null);
  const modeDropdownRef = useRef(null);
  const [currentMedium, setCurrentMedium] = useState("chatbot"); // "chatbot" | "gb-ai"
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [lightboxImage, setLightboxImage] = useState(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(event.target)) {
        setModeDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
      // Use the language selected in Voice Mode (or the browser language on
      // first use) instead of forcing every English utterance through bn-BD.
      recognition.lang = preferredVoiceLanguage();
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.maxAlternatives = 3;

      let finalCaptured = "";
      let silenceTimer = null;

      const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          // Auto-stop after 2.5s silence so the captured text stays in composer
          recognition.stop();
        }, 2500);
      };

      recognition.onstart = () => {
        setIsListeningComposer(true);
        resetSilenceTimer();
      };
      recognition.onresult = (event) => {
        let currentInterim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const item = event.results[i];
          if (item.isFinal) {
            finalCaptured += bestRecognitionTranscript(item, recognition.lang) + " ";
          } else {
            currentInterim += bestRecognitionTranscript(item, recognition.lang);
          }
        }
        const full = (finalCaptured + currentInterim).trim();
        if (full) {
          setInput(full);
          if (composerInputRef.current) {
            resizeComposer(composerInputRef.current);
          }
        }
        // Reset silence timer on every new result so it doesn't cut off mid-sentence
        resetSilenceTimer();
      };
      recognition.onerror = (e) => {
        if (silenceTimer) clearTimeout(silenceTimer);
        // "no-speech" is normal during pauses — don't kill the listener
        if (e.error === "no-speech" || e.error === "aborted") return;
        setIsListeningComposer(false);
      };
      recognition.onend = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
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

    // Always create one unambiguous fresh chat. Hidden empty records can otherwise
    // leave the UI on the current conversation when their ids are stale/duplicated.
    const fresh = createNewConversation();
    setConversations((prev) => [fresh, ...prev.filter((chat) => chat.messages.length > 0)]);
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
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [activeChatId]);

  useEffect(() => {
    // Follow the user's new message and the thinking indicator, but leave the
    // viewport at the beginning of a long assistant response once it arrives.
    if (messages.at(-1)?.role === "user") {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length]);

  useEffect(() => {
    refreshStatus();
  }, []);

  async function refreshStatus() {
    try {
      const response = await fetch("/api/health");
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
    const maxFiles = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const allowedExtensions = /\.(pdf|png|jpe?g|webp|gif|bmp|txt|md|csv)$/i;
    const selected = files.slice(0, maxFiles);
    const accepted = selected.filter(
      (file) =>
        file.size <= MAX_ATTACHMENT_BYTES &&
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
    setAttachments((current) => [...current, ...prepared].slice(0, MAX_ATTACHMENTS));
    setAttachmentError(
      rejectedCount > 0
        ? "Only PDF, image, or text files up to 8 MB are supported. Maximum 3 files per message."
        : "",
    );
    event.target.value = "";
  }

  function removeAttachment(indexToRemove) {
    setAttachments((current) => current.filter((_, index) => index !== indexToRemove));
  }

  async function sendMessage(text = input, options = {}) {
    const trimmed = text.trim();
    const selectedAttachments = options.attachments ?? attachments;
    if ((!trimmed && selectedAttachments.length === 0) || activeRequestRef.current) return;
    const request = new AbortController();
    activeRequestRef.current = request;

    const outgoingText = trimmed || "Read this attachment and summarize it.";
    const userMessage = {
      role: "user",
      text: outgoingText,
      attachments: selectedAttachments.map(({ name, mimeType, size }) => ({ name, mimeType, size })),
    };

    let targetId = options.targetId || activeChatId;
    let target = conversations.find((c) => c.id === targetId);
    if (!target) {
      target = createNewConversation();
      targetId = target.id;
      setActiveChatId(targetId);
      setConversations((prev) => [target, ...prev]);
    }
    if (Array.isArray(options.baseMessages)) {
      target = { ...target, messages: options.baseMessages };
    }

    const effectiveMedium = inferMessageMedium(
      outgoingText,
      selectedAttachments,
      target.messages,
      webSearchEnabled,
    );
    setCurrentMedium(effectiveMedium);

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
    let thinkingMsg = "Thinking...";
    if (effectiveMedium === "gb-ai") {
      if (selectedAttachments?.length > 0) {
        thinkingMsg = "GB AI is reading screenshot & solving...";
      } else if (/^(ছবি আঁকো|ছবি বানাও|ছবি তৈরি করো|একটি ছবি|chobi banao|chobi ako|generate an? image|create an? image|draw an? image)/i.test(outgoingText.trim())) {
        thinkingMsg = "GB AI is creating your image...";
      } else if (webSearchEnabled) {
        thinkingMsg = "GB AI is searching the web & synthesizing...";
      } else {
        thinkingMsg = "GB AI is solving your question...";
      }
    }
    setThinkingLabel(thinkingMsg);

    let reachedServer = false;
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
          medium: effectiveMedium,
          webSearch: webSearchEnabled,
          replaceHistory: options.replaceHistory === true,
        }),
      });
      reachedServer = true;
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
      setConnectionState(reachedServer ? "online" : "offline");
      setInput(trimmed);
      setAttachments(selectedAttachments);
      const errorMessage = {
        role: "assistant",
        text: reachedServer
          ? `Request failed: ${error.message || "The requested service is temporarily unavailable."}`
          : "Chat service is temporarily offline. Your question is kept in the composer - reconnect the service and press Retry.",
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

  function startEditMessage(index) {
    const msg = messages[index];
    if (!msg || msg.role !== "user" || isThinking) return;
    setEditingIndex(index);
    setEditText(msg.text);
    setTimeout(() => {
      if (editInputRef.current) {
        editInputRef.current.focus();
        editInputRef.current.style.height = "auto";
        editInputRef.current.style.height = `${Math.min(editInputRef.current.scrollHeight, 160)}px`;
      }
    }, 30);
  }

  function cancelEdit() {
    setEditingIndex(null);
    setEditText("");
  }

  async function submitEdit(index) {
    const trimmed = editText.trim();
    if (!trimmed || isThinking) return;
    const targetId = activeChatId;
    const target = conversations.find((c) => c.id === targetId);
    if (!target) return;

    // Regenerate from the edited turn. Everything after it belongs to the old branch.
    const kept = target.messages.slice(0, index);
    setEditingIndex(null);
    setEditText("");

    await sendMessage(trimmed, {
      targetId,
      baseMessages: kept,
      attachments: [],
      replaceHistory: true,
    });
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

  const composer = (
    <div className="composer-shell">
      <form
        className={`composer ${currentMedium === "gb-ai" ? "is-ai-mode" : ""} ${isListeningComposer ? "is-listening" : ""}`}
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
          placeholder={
            currentMedium === "gb-ai"
              ? webSearchEnabled
                ? isMobile
                  ? "লাইভ ওয়েব সার্চ ও প্রশ্নের উত্তর..."
                  : "Search the live web or ask GB AI..."
                : isMobile
                  ? "প্রশ্ন লিখুন, স্ক্রিনশট দিন বা ছবি আঁকুন..."
                  : "Ask any question, upload screenshot to solve, or generate image..."
              : isMobile
                ? "Ask anything..."
                : "Ask or attach PDF/image..."
          }
          rows={1}
        />
        {currentMedium === "gb-ai" && (
          <button
            type="button"
            className={`composer-web-btn ${webSearchEnabled ? "active" : ""}`}
            onClick={() => setWebSearchEnabled((prev) => !prev)}
            title={webSearchEnabled ? "Web Search: ON (Live web search active - click to turn off)" : "Web Search: OFF (Click to search live web)"}
            aria-pressed={webSearchEnabled}
          >
            <Globe size={14} />
            <span className="web-btn-label">{webSearchEnabled ? "Search: ON" : "Web"}</span>
          </button>
        )}
        <div className="composer-mode-dropdown-wrap" ref={modeDropdownRef}>
          <button
            type="button"
            className={`composer-mode-btn ${currentMedium === "gb-ai" ? "is-ai-mode" : ""}`}
            onClick={() => setModeDropdownOpen((prev) => !prev)}
            aria-haspopup="listbox"
            aria-expanded={modeDropdownOpen}
            title="Switch medium: Chatbot or GB AI"
          >
            <span className="mode-btn-label">
              {currentMedium === "gb-ai" ? "GB AI" : "Chatbot"}
            </span>
            <ChevronDown size={14} className={`mode-caret ${modeDropdownOpen ? "open" : ""}`} />
          </button>
          {modeDropdownOpen && (
            <div className="composer-mode-menu" role="listbox">
              <div className="mode-menu-header">Assistant Medium</div>
              <button
                type="button"
                className={`mode-menu-item ${currentMedium === "chatbot" ? "selected" : ""}`}
                onClick={() => {
                  setCurrentMedium("chatbot");
                  setModeDropdownOpen(false);
                }}
              >
                <div className="mode-item-icon bot">
                  <Bot size={15} />
                </div>
                <div className="mode-item-details">
                  <strong>GB Chatbot</strong>
                  <span>Admissions, fees, faculty & official info</span>
                </div>
                {currentMedium === "chatbot" && <Check size={14} className="mode-item-check" />}
              </button>
              <button
                type="button"
                className={`mode-menu-item ${currentMedium === "gb-ai" ? "selected" : ""}`}
                onClick={() => {
                  setCurrentMedium("gb-ai");
                  setModeDropdownOpen(false);
                }}
              >
                <div className="mode-item-icon ai">
                  <Sparkles size={15} />
                </div>
                <div className="mode-item-details">
                  <div className="mode-title-row">
                    <strong>GB AI</strong>
                    <span className="mode-badge-pill">Super AI</span>
                  </div>
                  <span>Solve questions, screenshots & AI image studio</span>
                </div>
                {currentMedium === "gb-ai" && <Check size={14} className="mode-item-check" />}
              </button>
            </div>
          )}
        </div>
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
                <div className="welcome-cards-grid" aria-label="Guided student journeys">
                  {[
                    { icon: "🎓", title: "Admission journey", desc: "Eligibility থেকে application—step by step", prompt: "Start admission journey" },
                    { icon: "📚", title: "Current student", desc: "Portal, courses, notices ও academic support", prompt: "Start current student journey" },
                    { icon: "👨‍👩‍👧", title: "Guardian guide", desc: "Program, fee, facilities ও official contacts", prompt: "Start guardian journey" },
                    { icon: "🧭", title: "Choose a program", desc: "Interest ও verified curriculum দিয়ে সিদ্ধান্ত", prompt: "Help me choose a program" },
                  ].map((journey) => (
                    <button className="welcome-card" type="button" key={journey.title} onClick={() => sendMessage(journey.prompt)} disabled={isThinking}>
                      <span className="welcome-card-icon" aria-hidden="true">{journey.icon}</span>
                      <strong className="welcome-card-title">{journey.title}</strong>
                      <span className="welcome-card-desc">{journey.desc}</span>
                    </button>
                  ))}
                </div>
                <div className="center-composer">{composer}</div>
              </section>
            )}

            {hasMessages && (
              <div className="message-stack">
                {messages.map((message, index) => (
                  <MessageBubble
                    message={message}
                    index={index}
                    copied={copiedIndex === index}
                    onCopy={() => copyMessage(message.text, index)}
                    onSuggestion={sendMessage}
                    onRetry={(retryText) => sendMessage(retryText)}
                    isSpeaking={speakingIndex === index}
                    onToggleSpeak={() => toggleSpeakMessage(message.text, index)}
                    isEditing={editingIndex === index}
                    editText={editText}
                    onStartEdit={() => startEditMessage(index)}
                    onCancelEdit={cancelEdit}
                    onEditTextChange={setEditText}
                    onSubmitEdit={() => submitEdit(index)}
                    editInputRef={editInputRef}
                    isThinking={isThinking}
                    onOpenLightbox={setLightboxImage}
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
      {lightboxImage && (
        <ImageLightboxModal
          image={lightboxImage}
          onClose={() => setLightboxImage(null)}
        />
      )}
    </main>
  );
}

function MessageBubble({ message, index, copied, onCopy, onSuggestion, onRetry, isSpeaking, onToggleSpeak, isEditing, editText, onStartEdit, onCancelEdit, onEditTextChange, onSubmitEdit, editInputRef, isThinking, onOpenLightbox }) {
  const isAssistant = message.role === "assistant";
  const isUser = message.role === "user";
  const [allCodeCopied, setAllCodeCopied] = useState(false);
  const completeCode = isAssistant ? extractCompleteCode(message.text) : "";

  const copyCompleteCode = async () => {
    if (!completeCode) return;
    try {
      await navigator.clipboard.writeText(completeCode);
      setAllCodeCopied(true);
      setTimeout(() => setAllCodeCopied(false), 2000);
    } catch {}
  };

  return (
    <article className={`message ${message.role} ${isEditing ? "is-editing" : ""}`}>
      <div className="avatar">
        {isAssistant ? <img src={GB_LOGO_URL} alt="Gono Bishwabidyalay logo" /> : <UserRound size={18} />}
      </div>
      <div className="message-body">
        {isUser && message.attachments?.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((attachment, attIdx) => (
              <span key={`${attachment.name}-${attIdx}`}>
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
            {message.isUniversityQuery && (
              <span className="meta-badge-university" title="Official GB Chatbot Knowledge">
                <Bot size={13} />
                GB Chatbot
              </span>
            )}
            {message.webSearchUsed && (
              <span className="meta-badge-web" title="Sourced from live web search">
                <Globe size={13} />
                Live Web
              </span>
            )}
            {message.aiModel && (
              <span className="model-chip" title={`Model: ${message.aiModel}`}>
                <Sparkles size={13} />
                {message.aiModel.replace(/:free$/i, "").split("/").at(-1)}
              </span>
            )}
          </div>
        )}
        {isAssistant && message.journey?.steps?.length > 0 && (
          <section className="journey-card" aria-label={message.journey.title || "Guided journey"}>
            <div className="journey-card-heading">
              <span className="journey-card-icon" aria-hidden="true">🧭</span>
              <div>
                <strong>{message.journey.title}</strong>
                <span>{message.journey.audience}</span>
              </div>
            </div>
            <ol className="journey-steps">
              {message.journey.steps.map((step, stepIndex) => (
                <li key={`${step.title}-${stepIndex}`}>
                  <span className="journey-step-number">{stepIndex + 1}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
        {isUser && isEditing ? (
          <div className="edit-bubble">
            <textarea
              ref={editInputRef}
              className="edit-textarea"
              value={editText}
              onChange={(e) => {
                onEditTextChange(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmitEdit();
                }
                if (e.key === "Escape") {
                  onCancelEdit();
                }
              }}
              rows={1}
            />
            <div className="edit-actions">
              <button className="edit-cancel-btn" type="button" onClick={onCancelEdit}>
                <X size={14} />
                <span>Cancel</span>
              </button>
              <button className="edit-submit-btn" type="button" onClick={onSubmitEdit} disabled={!editText.trim()}>
                <ArrowUp size={14} />
                <span>Send</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="bubble">
            {renderMessageText(message.text)}
            {isAssistant && message.image && (
              <AiImageCard image={message.image} onOpenLightbox={onOpenLightbox} />
            )}
          </div>
        )}
        {isUser && !isEditing && (
          <div className="message-actions user-actions">
            <button
              className="message-action"
              type="button"
              onClick={onStartEdit}
              disabled={isThinking}
              aria-label="Edit message"
              title="Edit message"
            >
              <Pencil size={14} />
              <span>Edit</span>
            </button>
          </div>
        )}
        {isAssistant && (
          <div className="message-actions">
            {completeCode && (
              <button
                className={`message-action ${allCodeCopied ? "is-copied" : ""}`}
                type="button"
                onClick={copyCompleteCode}
                aria-label="Copy all code"
                title="Copy every code block"
              >
                {allCodeCopied ? <Check size={16} /> : <Copy size={16} />}
                <span>{allCodeCopied ? "Code copied" : "Copy all code"}</span>
              </button>
            )}
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
        {isAssistant && message.sources?.some((source) => safeExternalUrl(source.url)) && (
          <div className="citation-row">
            {message.sources.filter((source) => safeExternalUrl(source.url)).map((source, sourceIndex) => (
              <a href={safeExternalUrl(source.url)} target="_blank" rel="noopener noreferrer" key={`${source.url}-${sourceIndex}`}>
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

function AiImageCard({ image, onOpenLightbox }) {
  const [loaded, setLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    try {
      setDownloading(true);
      const res = await fetch(image.url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `gb-ai-image-${image.seed || Date.now()}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(image.url, "_blank");
    } finally {
      setDownloading(false);
    }
  };

  const handleCopyPrompt = () => {
    navigator.clipboard?.writeText(image.originalPrompt || image.prompt || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="ai-image-card">
      <div className="ai-image-preview-wrap">
        {!loaded && !hasError && (
          <div className="ai-image-skeleton">
            <Loader2 size={24} className="spin" />
            <span>GB AI is rendering FLUX image...</span>
          </div>
        )}
        {hasError ? (
          <div className="ai-image-error">
            <span>Failed to load image preview.</span>
            <a href={image.url} target="_blank" rel="noopener noreferrer">Open direct link</a>
          </div>
        ) : (
          <img
            src={image.url}
            alt={image.prompt || "GB AI Generated Artwork"}
            className={`ai-image-display ${loaded ? "is-loaded" : ""}`}
            onLoad={() => setLoaded(true)}
            onError={() => setHasError(true)}
            onClick={() => onOpenLightbox(image)}
            title="Click to view full size"
          />
        )}
        {loaded && (
          <div className="ai-image-quick-actions">
            <button
              type="button"
              className="ai-img-action-btn"
              onClick={() => onOpenLightbox(image)}
              title="View full size"
              aria-label="View full size"
            >
              <Maximize2 size={15} />
            </button>
            <button
              type="button"
              className="ai-img-action-btn"
              onClick={handleDownload}
              disabled={downloading}
              title="Download high-resolution image"
              aria-label="Download image"
            >
              {downloading ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
            </button>
          </div>
        )}
      </div>

      <div className="ai-image-meta-bar">
        <div className="ai-image-info">
          <span className="ai-model-tag">
            <Sparkles size={12} />
            {image.model || "FLUX.1-HD"}
          </span>
          <span className="ai-res-tag">1024 × 1024</span>
        </div>
        <button
          type="button"
          className="ai-copy-prompt-btn"
          onClick={handleCopyPrompt}
          title="Copy prompt"
        >
          {copied ? <Check size={13} /> : <Clipboard size={13} />}
          <span>{copied ? "Copied" : "Copy Prompt"}</span>
        </button>
      </div>
    </div>
  );
}

function ImageLightboxModal({ image, onClose }) {
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleDownload = async () => {
    try {
      setDownloading(true);
      const res = await fetch(image.url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `gb-ai-image-${image.seed || Date.now()}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(image.url, "_blank");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="image-lightbox-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="image-lightbox-container" onClick={(e) => e.stopPropagation()}>
        <header className="image-lightbox-header">
          <div className="image-lightbox-title">
            <Sparkles size={16} />
            <span>GB AI Studio • Full View</span>
          </div>
          <div className="image-lightbox-actions">
            <button
              type="button"
              className="lightbox-btn"
              onClick={handleDownload}
              disabled={downloading}
              title="Download image"
            >
              {downloading ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
              <span>Download</span>
            </button>
            <button type="button" className="lightbox-btn close" onClick={onClose} title="Close (Esc)">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="image-lightbox-body">
          <img src={image.url} alt={image.prompt || "GB AI Generated Artwork"} className="lightbox-img" />
        </div>

        {image.prompt && (
          <footer className="image-lightbox-footer">
            <p><strong>Prompt:</strong> {image.originalPrompt || image.prompt}</p>
          </footer>
        )}
      </div>
    </div>
  );
}

function AdminPanel({ status, onClose, onRefreshStatus }) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [logs, setLogs] = useState([]);
  const [chats, setChats] = useState([]);
  const [settings, setSettings] = useState(null);
  const [dashboardStatus, setDashboardStatus] = useState(null);
  const [adminError, setAdminError] = useState("");
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem("gb-admin-token") || "");

  function adminFetch(url, options = {}, token = adminToken) {
    return fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(token ? { "x-admin-token": token } : {}),
      },
    });
  }

  useEffect(() => {
    if (adminToken) authenticateAdmin(adminToken);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function loadAdminData(token = adminToken) {
    try {
      const [logsResponse, settingsResponse, statusResponse] = await Promise.all([
        adminFetch("/api/admin/logs", {}, token),
        adminFetch("/api/admin/settings", {}, token),
        adminFetch("/api/admin/status", {}, token),
      ]);
      if ([logsResponse, settingsResponse, statusResponse].some((response) => [401, 403].includes(response.status))) {
        throw new Error("Incorrect admin password.");
      }
      if (!logsResponse.ok || !settingsResponse.ok || !statusResponse.ok) throw new Error("Admin data could not be loaded.");
      const data = await logsResponse.json();
      setLogs(data.logs || []);
      setChats(data.chats || []);
      setSettings(await settingsResponse.json());
      setDashboardStatus(await statusResponse.json());
      setAdminError("");
      return true;
    } catch (error) {
      setAdminError(error.message || "Admin data could not be loaded.");
      return false;
    }
  }

  async function authenticateAdmin(token = adminToken) {
    if (!token.trim()) {
      setAdminError("Enter the admin password.");
      return;
    }
    setIsAuthenticating(true);
    const authenticated = await loadAdminData(token.trim());
    setIsAuthenticated(authenticated);
    if (authenticated) sessionStorage.setItem("gb-admin-token", token.trim());
    else sessionStorage.removeItem("gb-admin-token");
    setIsAuthenticating(false);
  }

  function logoutAdmin() {
    sessionStorage.removeItem("gb-admin-token");
    setAdminToken("");
    setIsAuthenticated(false);
    setLogs([]);
    setChats([]);
    setSettings(null);
    setDashboardStatus(null);
    setAdminError("");
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

        {!isAuthenticated ? (
          <form
            className="admin-login-card"
            onSubmit={(event) => {
              event.preventDefault();
              authenticateAdmin();
            }}
          >
            <div className="admin-login-icon"><LockKeyhole size={22} /></div>
            <div className="admin-login-copy">
              <h3>Admin login</h3>
              <p>Indexing health, activity logs, and crawler controls are restricted.</p>
            </div>
            <label htmlFor="admin-password">Admin password</label>
            <div className="admin-login-row">
              <input
                id="admin-password"
                type="password"
                value={adminToken}
                placeholder="Enter password"
                autoComplete="current-password"
                autoFocus
                onChange={(event) => {
                  setAdminToken(event.target.value);
                  setAdminError("");
                }}
              />
              <button className="primary-action" type="submit" disabled={isAuthenticating || !adminToken.trim()}>
                {isAuthenticating ? <Loader2 className="spin" size={17} /> : <LogIn size={17} />}
                <span>{isAuthenticating ? "Checking" : "Login"}</span>
              </button>
            </div>
            {adminError && <p className="admin-inline-error" role="alert">{adminError}</p>}
          </form>
        ) : (
          <>
            <div className="admin-session-bar">
              <span><ShieldCheck size={15} /> Authenticated admin</span>
              <button type="button" onClick={logoutAdmin}>Log out</button>
            </div>

        <div className="admin-grid">
          <Metric label="Official pages" value={dashboardStatus?.pageCount ?? "-"} />
          <Metric label="People records" value={dashboardStatus?.peopleCount ?? "-"} />
          <Metric label="Documents" value={dashboardStatus?.documentCount ?? "-"} />
          <Metric label="Programs" value={dashboardStatus?.programCount ?? "-"} />
          <Metric label="Notices" value={dashboardStatus?.noticeCount ?? "-"} />
          <Metric label="Office contacts" value={dashboardStatus?.contactCount ?? "-"} />
        </div>

        {dashboardStatus?.warnings?.length > 0 && (
          <div className="admin-warning-list">
            {dashboardStatus.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}

        {adminError && <p className="admin-inline-error" role="alert">{adminError}</p>}

        <div className="admin-actions">
          <button className="primary-action" type="button" onClick={refreshKnowledge} disabled={isRefreshing || dashboardStatus?.rebuild?.running}>
            {isRefreshing || dashboardStatus?.rebuild?.running ? <Loader2 className="spin" size={18} /> : <RotateCcw size={18} />}
            <span>{dashboardStatus?.rebuild?.running ? "Rebuilding..." : "Re-crawl website"}</span>
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
              Answer mode: {dashboardStatus?.geminiConfigured ? "Gemini AI" : dashboardStatus?.openAiConfigured ? dashboardStatus?.openAiProviderName || "OpenAI-compatible AI" : dashboardStatus?.ollamaAvailable ? "Ollama" : "official knowledge + general academic fallback"}.
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
          </>
        )}
        <p className="admin-developer-credit">Developed by <strong>Ayon</strong></p>
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

function sanitizeCodeForExecution(rawCode) {
  let text = String(rawCode || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[^\n]*\n?/, "");
  }
  if (text.endsWith("```")) {
    text = text.replace(/\n?```$/, "");
  }
  return text.trim();
}

function extractCompleteCode(text) {
  const blocks = [];
  const pattern = /```[^\r\n]*\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(String(text || ""))) !== null) {
    const code = sanitizeCodeForExecution(match[1]);
    if (code) blocks.push(code);
  }
  return blocks.join("\n\n");
}

function CodeBlock({ code, lang = "" }) {
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const cleanCode = sanitizeCodeForExecution(code);
  const codeLines = cleanCode.split("\n");
  const normalizedLang = (lang || "").toLowerCase().trim();
  const canPreview = ["html", "svg", "htm"].includes(normalizedLang);

  const handleCopy = () => {
    try {
      navigator.clipboard?.writeText(cleanCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const handleDownload = () => {
    const extMap = {
      python: "py", py: "py",
      javascript: "js", js: "js",
      typescript: "ts", ts: "ts",
      cpp: "cpp", "c++": "cpp",
      c: "c",
      java: "java",
      html: "html",
      css: "css",
      sql: "sql",
      json: "json",
      bash: "sh", sh: "sh",
      php: "php",
      rust: "rs",
      go: "go",
    };
    const ext = extMap[normalizedLang] || "txt";
    const blob = new Blob([cleanCode], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `solution.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="message-code-block">
      <div className="code-block-header">
        <div className="code-block-lang-wrap">
          <span className="code-lang-dot" />
          <span className="code-lang-label">{lang || "CODE"}</span>
          <span className="code-lines-count">{codeLines.length} {codeLines.length === 1 ? "line" : "lines"}</span>
        </div>
        <div className="code-block-actions">
          {canPreview && (
            <button
              type="button"
              className={`code-action-btn ${showPreview ? "active" : ""}`}
              onClick={() => setShowPreview((prev) => !prev)}
              title={showPreview ? "Show Code" : "Live Preview"}
            >
              <Eye size={13} />
              <span>{showPreview ? "Code" : "Preview"}</span>
            </button>
          )}
          <button
            type="button"
            className="code-action-btn"
            onClick={handleDownload}
            title="Download Code File"
          >
            <Download size={13} />
            <span>Download</span>
          </button>
          <button
            type="button"
            className={`code-action-btn ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            title="Copy Code"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? "Copied!" : "Copy"}</span>
          </button>
        </div>
      </div>
      {showPreview && canPreview ? (
        <div className="code-preview-frame-wrap">
          <iframe
            srcDoc={code}
            title="Code Preview"
            sandbox="allow-scripts"
            className="code-preview-frame"
          />
        </div>
      ) : (
        <div className="code-pre-wrap">
          <pre className="code-pre">
            <code>
              {codeLines.map((lineText, idx) => (
                <div key={idx} className="code-line">
                  <span className="code-line-num">{idx + 1}</span>
                  <span className="code-line-text">{lineText || "\n"}</span>
                </div>
              ))}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
}

function renderMessageText(text) {
  const lines = String(text || "").split("\n");
  const output = [];
  let index = 0;

  const parseTableRow = (value) => {
    const normalized = String(value || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    return normalized.split("|").map((cell) => cell.trim());
  };

  const isTableDivider = (value) => {
    const cells = parseTableRow(value);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  };

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && lines[index].trim().startsWith("```")) {
        index += 1;
      }
      output.push(
        <CodeBlock key={`codeblock-${index}`} code={codeLines.join("\n")} lang={lang} />
      );
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = parseTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length) {
        const candidate = lines[index].trim();
        if (!candidate || !candidate.includes("|")) break;
        const cells = parseTableRow(candidate);
        if (cells.length < 2 || isTableDivider(candidate)) break;
        rows.push(cells);
        index += 1;
      }
      output.push(
        <div className="message-table-wrap" key={`table-${index}`}>
          <table className="message-table">
            <thead>
              <tr>{headers.map((cell, cellIndex) => <th key={`head-${cellIndex}`}>{renderInlineText(cell, `head-${cellIndex}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((cells, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`cell-${rowIndex}-${cellIndex}`}>{renderInlineText(cells[cellIndex] || "", `cell-${rowIndex}-${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (line === "---" || line === "***" || line === "___") {
      output.push(<hr key={`hr-${index}`} className="message-hr" />);
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
  const [voiceLang, setVoiceLang] = useState(preferredVoiceLanguage);
  const [isMuted, setIsMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [userTranscript, setUserTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [assistantReply, setAssistantReply] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [fallbackRecording, setFallbackRecording] = useState(false);
  const [fallbackTranscribing, setFallbackTranscribing] = useState(false);
  const [isBargingIn, setIsBargingIn] = useState(false);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const fallbackStreamRef = useRef(null);
  const fallbackChunksRef = useRef([]);
  const bargeInActiveRef = useRef(false);
  const isComponentMounted = useRef(true);
  const recognitionSupported = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const microphoneSupported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const voiceInputSupported = recognitionSupported && microphoneSupported;

  const unsupportedVoiceMessage = voiceLang === "bn-BD"
    ? "এই in-app browser-এ microphone speech recognition নেই। লিংকটি Chrome বা Edge-এ খুলে Voice Mode ব্যবহার করুন।"
    : "This in-app browser does not provide microphone speech recognition. Open this link in Chrome or Edge to use Voice Mode.";

  useEffect(() => {
    isComponentMounted.current = true;
    return () => {
      isComponentMounted.current = false;
    };
  }, []);

  // Main SpeechRecognition handling loop
  useEffect(() => {
    if (!isOpen) return;
    isComponentMounted.current = true;

    const SpeechRecognition = typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;

    if (!SpeechRecognition) {
      setErrorMessage(unsupportedVoiceMessage);
      setVoiceStatus("idle");
      return;
    }

    if (!microphoneSupported) {
      setErrorMessage(unsupportedVoiceMessage);
      setVoiceStatus("idle");
      return;
    }

    if ((voiceStatus !== "listening" && voiceStatus !== "speaking") || isMuted) {
      recognitionRef.current?.abort();
      return;
    }

    let recognition = null;
    let silenceTimer = null;
    let restartTimer = null;
    const clearSilenceTimer = () => { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; } };

    try {
      recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.lang = voiceLang;
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.maxAlternatives = 3;

      let finalCaptured = "";
      let latestInterim = "";
      let recognitionFailed = false;

      const startSilenceTimer = () => {
        clearSilenceTimer();
        silenceTimer = setTimeout(() => {
          if (finalCaptured.trim() || latestInterim.trim()) {
            try { recognition.stop(); } catch {}
          }
        }, voiceLang === "en-US" ? 2800 : 2200);
      };

      recognition.onstart = () => {
        recognitionFailed = false;
        setErrorMessage("");
        setAudioLevel(0.28);
        startSilenceTimer();
      };

      recognition.onresult = (event) => {
        let currentInterim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            finalCaptured = `${finalCaptured} ${bestRecognitionTranscript(res, voiceLang)}`.trim();
          } else {
            currentInterim = `${currentInterim} ${bestRecognitionTranscript(res, voiceLang)}`.trim();
          }
        }
        latestInterim = currentInterim;
        const heardText = (finalCaptured || currentInterim).trim();
        if (voiceStatus === "speaking" && heardText.length >= 2 && !bargeInActiveRef.current) {
          bargeInActiveRef.current = true;
          setIsBargingIn(true);
          window.speechSynthesis?.cancel();
        }
        const confidence = event.results[event.results.length - 1]?.[0]?.confidence || 0.45;
        setAudioLevel(Math.min(0.9, Math.max(0.32, confidence)));
        setInterimTranscript(currentInterim);
        if (finalCaptured) {
          setUserTranscript(finalCaptured.trim());
        }
        startSilenceTimer();
      };

      recognition.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") {
          // Normal during pauses — continuous mode handles this automatically
          return;
        } else if (e.error === "not-allowed") {
          recognitionFailed = true;
          clearSilenceTimer();
          setErrorMessage(
            voiceLang === "bn-BD"
              ? "মাইক্রোফোনের অনুমতি দেওয়া হয়নি। অনুগ্রহ করে ব্রাউজার সেটিংসে মাইক অ্যাক্সেস অ্যালাউ করুন।"
              : "Microphone access was not allowed. Please enable microphone access in your browser settings.",
          );
          setVoiceStatus("idle");
        } else if (e.error === "network" || e.error === "service-not-allowed" || e.error === "audio-capture") {
          recognitionFailed = true;
          clearSilenceTimer();
          setErrorMessage(
            voiceLang === "bn-BD"
              ? "Browser speech service কাজ করছে না। নিচের Record বাটন দিয়ে fallback voice input ব্যবহার করুন।"
              : "The browser speech service is unavailable. Use the Record button below for fallback voice input.",
          );
          setVoiceStatus("idle");
        } else {
          recognitionFailed = true;
          clearSilenceTimer();
          setErrorMessage(
            voiceLang === "bn-BD"
              ? "কথা শনাক্ত করা যায়নি। আবার চেষ্টা করুন।"
              : "I couldn't recognize the speech. Please try again.",
          );
          setVoiceStatus("idle");
        }
      };

      recognition.onend = () => {
        clearSilenceTimer();
        setAudioLevel(0);
        setInterimTranscript("");
        if (recognitionFailed) return;
        const query = (finalCaptured || latestInterim).trim();
        if (query && (voiceStatus === "listening" || bargeInActiveRef.current)) {
          handleUserVoiceQuery(query);
        } else if ((voiceStatus === "listening" || voiceStatus === "speaking") && !isMuted && isComponentMounted.current) {
          finalCaptured = "";
          restartTimer = setTimeout(() => {
            if (!isComponentMounted.current) return;
            try {
              recognition.start();
            } catch {
              setErrorMessage(
                voiceLang === "bn-BD"
                  ? "মাইক্রোফোন চালু করা যায়নি। Microphone permission Allow করে আবার চেষ্টা করুন।"
                  : "The microphone could not start. Allow microphone permission and try again.",
              );
              setVoiceStatus("idle");
            }
          }, 180);
        }
      };

      recognition.start();
    } catch {
      // Ignore start errors
    }

    return () => {
      clearSilenceTimer();
      if (restartTimer) clearTimeout(restartTimer);
      setAudioLevel(0);
      recognition?.abort();
    };
  }, [isOpen, voiceStatus, voiceLang, isMuted, microphoneSupported]);

  async function handleUserVoiceQuery(text) {
    if (!text) return;
    bargeInActiveRef.current = false;
    setIsBargingIn(false);
    setVoiceStatus("thinking");
    setInterimTranscript("");
    setUserTranscript(text);
    setAssistantReply("");
    try {
      const result = await onSendMessage(text);
      if (result && result.text) {
        setAssistantReply(result.text);
        setVoiceStatus("speaking");
        speakUtterance(result.text, {
          lang: detectSpeechLanguage(result.text),
          isVoiceMode: true,
          onEnd: () => {
            if (isComponentMounted.current && !bargeInActiveRef.current) {
              setVoiceStatus("listening");
            }
          },
          onError: () => {
            if (isComponentMounted.current && !bargeInActiveRef.current) {
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

  async function startFallbackRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setErrorMessage(unsupportedVoiceMessage);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      fallbackStreamRef.current = stream;
      fallbackChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) fallbackChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(fallbackChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        fallbackStreamRef.current?.getTracks().forEach((track) => track.stop());
        fallbackStreamRef.current = null;
        setFallbackRecording(false);
        if (!blob.size) return;
        setFallbackTranscribing(true);
        setErrorMessage(voiceLang === "bn-BD" ? "কথা থেকে লেখা তৈরি হচ্ছে..." : "Transcribing your speech...");
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const response = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audio: dataUrl, mimeType: blob.type, language: voiceLang }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Voice transcription failed");
          setErrorMessage("");
          await handleUserVoiceQuery(data.text);
        } catch (error) {
          setErrorMessage(error.message || "Voice transcription failed. Please try again.");
          setVoiceStatus("idle");
        } finally {
          setFallbackTranscribing(false);
        }
      };
      recorder.start();
      setFallbackRecording(true);
      setErrorMessage(voiceLang === "bn-BD" ? "রেকর্ড হচ্ছে... কথা বলা শেষে Stop চাপুন।" : "Recording... press Stop when you finish speaking.");
    } catch {
      setErrorMessage(voiceLang === "bn-BD" ? "Microphone permission Allow করুন।" : "Allow microphone permission to record your voice.");
    }
  }

  function stopFallbackRecording() {
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
  }

  function handleInterrupt() {
    bargeInActiveRef.current = true;
    setIsBargingIn(true);
    window.speechSynthesis?.cancel();
    setVoiceStatus("listening");
    setAssistantReply("");
  }

  function toggleLanguage() {
    bargeInActiveRef.current = false;
    setIsBargingIn(false);
    window.speechSynthesis?.cancel();
    setVoiceLang((prev) => {
      const next = prev === "bn-BD" ? "en-US" : "bn-BD";
      window.localStorage?.setItem(VOICE_LANGUAGE_KEY, next);
      return next;
    });
    setUserTranscript("");
    setInterimTranscript("");
    setAssistantReply("");
    setErrorMessage("");
    setVoiceStatus("listening");
  }

  function handleClose() {
    isComponentMounted.current = false;
    bargeInActiveRef.current = false;
    window.speechSynthesis?.cancel();
    recognitionRef.current?.abort();
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    fallbackStreamRef.current?.getTracks().forEach((track) => track.stop());
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
    };
  }, [voiceStatus]);

  if (!isOpen) return null;
  const visibleVoiceStatus = isBargingIn ? "listening" : voiceStatus;

  return (
    <div className="voice-mode-overlay" role="dialog" aria-modal="true" aria-label="ChatGPT Voice Mode">
      <header className="voice-mode-header">
        <div className="voice-mode-brand">
          <img src={GB_LOGO_URL} alt="Gono Bishwabidyalay logo" className="voice-mode-logo" />
          <div className="voice-mode-title-wrap">
            <span className="voice-mode-title">GB Voice Mode</span>
            <span className={`voice-mode-status-badge ${visibleVoiceStatus}`}>
              <span className="voice-status-dot" />
              <span>
                {visibleVoiceStatus === "listening"
                  ? voiceLang === "bn-BD" ? "শুনছি... বলুন" : "Listening..."
                  : visibleVoiceStatus === "thinking"
                  ? voiceLang === "bn-BD" ? "ভাবছি..." : "Thinking..."
                  : visibleVoiceStatus === "speaking"
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
          className={`voice-orb-container ${visibleVoiceStatus}`}
          onClick={visibleVoiceStatus === "speaking" ? handleInterrupt : undefined}
          title={visibleVoiceStatus === "speaking" ? "Click to interrupt and speak" : ""}
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
          {(visibleVoiceStatus === "listening" || visibleVoiceStatus === "speaking") && (
            <>
              <div className="voice-orb-wave wave-1" />
              <div className="voice-orb-wave wave-2" />
            </>
          )}

          {/* The Central Glowing Orb */}
          <div
            className={`voice-orb ${visibleVoiceStatus}`}
            style={{
              transform: `scale(${1 + audioLevel * (visibleVoiceStatus === "listening" ? 0.35 : 0.15)})`,
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
          ) : voiceStatus === "speaking" && !isBargingIn && assistantReply ? (
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

          {fallbackRecording ? (
            <button type="button" className="voice-dock-btn interrupt-btn" onClick={stopFallbackRecording} aria-label="Stop recording">
              <Square size={18} />
              <span>Stop recording</span>
            </button>
          ) : fallbackTranscribing ? (
            <button type="button" className="voice-dock-btn disabled-btn" disabled aria-label="Transcribing">
              <Loader2 className="spin" size={20} />
              <span>Transcribing</span>
            </button>
          ) : errorMessage && voiceStatus === "idle" && microphoneSupported ? (
            <button type="button" className="voice-dock-btn listening-pill" onClick={startFallbackRecording} aria-label="Record with fallback microphone">
              <Mic size={18} />
              <span>{voiceLang === "bn-BD" ? "Record করুন" : "Record"}</span>
            </button>
          ) : voiceStatus === "speaking" && !isBargingIn ? (
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
              className={`voice-dock-btn ${voiceInputSupported ? "listening-pill" : "disabled-btn"}`}
              onClick={() => {
                if (voiceInputSupported && voiceStatus === "idle") setVoiceStatus("listening");
              }}
              disabled={!voiceInputSupported}
              title={voiceInputSupported ? "Listening to your voice" : "Voice input requires Chrome or Edge"}
              aria-label={voiceInputSupported ? "Listening" : "Voice input unavailable"}
            >
              {voiceInputSupported ? <span className="voice-pulsing-circle" /> : <MicOff size={18} />}
              <span>
                {voiceInputSupported
                  ? voiceLang === "bn-BD" ? "কথা শুনছি..." : "Listening..."
                  : voiceLang === "bn-BD" ? "এই ব্রাউজারে নেই" : "Unsupported browser"}
              </span>
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
