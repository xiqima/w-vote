// ===========================================================================
//  core.js — вся «математика» и работа с чатом w.tv (обычный скрипт, не модуль,
//  чтобы сайт открывался даже двойным щелчком по index.html).
// ===========================================================================
(function () {
'use strict';
//  core.js — вся «математика» и работа с чатом w.tv.
//  Здесь нет ничего про интерфейс: только разбор сообщений, очки и запросы.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Разбор ссылки на канал
// ---------------------------------------------------------------------------
function normalizeChannelInput(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/^www\./i, '');
  s = s.replace(/^(w\.tv|wasd\.tv)\//i, '');
  s = s.replace(/^@/, '');
  s = s.split(/[\/?#]/)[0].trim();
  return s;
}

// ---------------------------------------------------------------------------
// 2. Слова-голоса
// ---------------------------------------------------------------------------
const DEFAULT_WORDS = { win: ['win'], lose: ['lose'] };

/** "win, победа ,  ВИН" -> ["win","победа","вин"] */
function parseWords(text) {
  return String(text || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

function wordsToText(list) {
  return (list || []).join(', ');
}

const EMOTE_RE = /:[a-zA-Z0-9_]{2,}:/g; // :KEKwAIT:
const EDGE_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu; // пунктуация по краям

/** ":pugPls: Win!" -> "win" */
function normalizeMessage(text) {
  return String(text || '')
    .replace(EMOTE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(EDGE_RE, '');
}

/**
 * Голос — это сообщение ЦЕЛИКОМ, равное одному из слов.
 * "Win", "WIN!", ":KEKwAIT: lose" — да. "я за win" — нет (иначе болтовня считается).
 * @returns {'win'|'lose'|null}
 */
function detectVote(text, words = DEFAULT_WORDS) {
  const n = normalizeMessage(text);
  if (!n) return null;
  if ((words.win || []).includes(n)) return 'win';
  if ((words.lose || []).includes(n)) return 'lose';
  return null;
}

// ---------------------------------------------------------------------------
// 3. Подсчёт голосов раунда
// ---------------------------------------------------------------------------
/**
 * @param messages [{id, ts, userId, nickname, tags, content}]
 * @param round    {openedAt, closedAt, allowRevote, words, ownerUserId}
 * @returns [{userId, nickname, vote, ts, votes}]
 */
function tallyVotes(messages, round) {
  const words = round.words || DEFAULT_WORDS;
  const byUser = new Map();
  for (const m of messages) {
    if (!m.ts || m.ts < round.openedAt) continue;
    if (round.closedAt && m.ts > round.closedAt) continue;
    if (round.ownerUserId && m.userId === round.ownerUserId) continue; // стример не голосует
    if ((m.tags || []).includes('TAG_OWNER')) continue;
    const vote = detectVote(m.content, words);
    if (!vote) continue;
    const rec = byUser.get(m.userId);
    if (!rec) {
      byUser.set(m.userId, { userId: m.userId, nickname: m.nickname, vote, ts: m.ts, votes: 1 });
    } else {
      rec.votes += 1;
      rec.nickname = m.nickname;
      if (round.allowRevote) {
        rec.vote = vote;
        rec.ts = m.ts;
      }
    }
  }
  return [...byUser.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

// ---------------------------------------------------------------------------
// 4. Очки
// ---------------------------------------------------------------------------
/**
 * Итоговые очки = угаданные раунды + ручная правка (adjust).
 * @param rounds   [{index, outcome, closedAt, votes:[{userId,nickname,vote}]}]
 * @param adjust   {userId: число}
 * @param extra    [{userId, nickname}] — кого показать, даже если 0 очков
 */
function computeScores(rounds, adjust = {}, extra = []) {
  const map = new Map();
  const touch = (userId, nickname) => {
    if (!map.has(userId)) {
      map.set(userId, { userId, nickname, guessed: 0, voted: 0, adjust: 0, streak: 0, bestStreak: 0 });
    }
    const p = map.get(userId);
    if (nickname) p.nickname = nickname;
    return p;
  };

  const finished = rounds
    .filter((r) => r.outcome && r.closedAt)
    .sort((a, b) => a.index - b.index);

  for (const r of finished) {
    for (const v of r.votes || []) {
      const p = touch(v.userId, v.nickname);
      p.voted += 1;
      if (v.vote === r.outcome) {
        p.guessed += 1;
        p.streak += 1;
        p.bestStreak = Math.max(p.bestStreak, p.streak);
      } else {
        p.streak = 0;
      }
    }
  }

  for (const userId of Object.keys(adjust || {})) {
    if (!adjust[userId]) continue;
    touch(userId, null).adjust = Number(adjust[userId]) || 0;
  }
  for (const e of extra || []) touch(e.userId, e.nickname);

  const list = [...map.values()].map((p) => ({ ...p, points: p.guessed + p.adjust }));
  return list.sort(
    (a, b) => b.points - a.points || b.guessed - a.guessed || (a.nickname > b.nickname ? 1 : -1)
  );
}

// ---------------------------------------------------------------------------
// 5. Хранилище: только этот браузер, переживает обновление страницы
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'wtv_vote_v2';

function emptyState() {
  return {
    version: 2,
    channel: '',
    channelUserId: null,
    channelName: null,
    settings: {
      words: { win: ['win'], lose: ['lose'] },
      allowRevote: false,
      proxy: '', // свой прокси (необязательно)
      pollSeconds: 5,
    },
    rounds: [],
    adjust: {}, // userId -> число
    extraPlayers: [], // [{userId, nickname}]
    messages: [], // последние сообщения чата (чтобы не потерять голоса при обновлении)
    lastMessageTs: null,
  };
}

function loadState(key = STORAGE_KEY) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || typeof raw !== 'object') return emptyState();
    const base = emptyState();
    const state = {
      ...base,
      ...raw,
      settings: { ...base.settings, ...(raw.settings || {}) },
      rounds: Array.isArray(raw.rounds) ? raw.rounds : [],
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      extraPlayers: Array.isArray(raw.extraPlayers) ? raw.extraPlayers : [],
      adjust: raw.adjust && typeof raw.adjust === 'object' ? raw.adjust : {},
    };
    state.settings.words = {
      win: state.settings.words?.win?.length ? state.settings.words.win : ['win'],
      lose: state.settings.words?.lose?.length ? state.settings.words.lose : ['lose'],
    };
    return state;
  } catch {
    return emptyState();
  }
}

function saveState(state, key = STORAGE_KEY) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    return true;
  } catch (err) {
    // переполнение localStorage — подрежем историю сообщений
    try {
      state.messages = state.messages.slice(-200);
      localStorage.setItem(key, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Чтение чата w.tv
//    CORS у w.tv разрешён только для https://w.tv, поэтому запрос идёт
//    через цепочку публичных прокси. Первый рабочий запоминается.
// ---------------------------------------------------------------------------
const BROWSER_UA_NEEDED = 'нужен браузерный User-Agent — прокси его подставляют сами';

const PROFILES_API = 'https://profiles-service.w.tv/api/v1';
const CHATS_API = 'https://chats-service.w.tv/api/v1';

function rawJson(text) {
  // иногда прокси оборачивают ответ в текст — вытаскиваем объект
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    return null;
  }
}

/** Список способов добраться до API (по порядку) */
function proxies(customProxy) {
  const list = [];
  if (customProxy && customProxy.trim()) {
    const template = customProxy.trim();
    list.push({
      id: 'custom',
      label: 'свой прокси',
      build: (url) => (template.includes('{url}') ? template.replace('{url}', encodeURIComponent(url)) : template + encodeURIComponent(url)),
      extract: (text) => text,
    });
  }
  list.push({
    id: 'jina',
    label: 'r.jina.ai',
    build: (url) => `https://r.jina.ai/${url}`,
    extract: (text) => {
      const marker = 'Markdown Content:';
      const i = text.indexOf(marker);
      return i >= 0 ? text.slice(i + marker.length) : text;
    },
  });
  list.push({
    id: 'corslol',
    label: 'cors.lol',
    build: (url) => `https://api.cors.lol/?url=${encodeURIComponent(url)}`,
    extract: (text) => text,
  });
  list.push({
    id: 'direct',
    label: 'напрямую',
    build: (url) => url,
    extract: (text) => text,
  });
  return list;
}

let preferredProxy = null; // какой способ сработал последним
let proxyOrder = null;

function resetProxyOrder() {
  preferredProxy = null;
  proxyOrder = null;
}

async function requestViaProxy(targetUrl, customProxy, timeoutMs = 12000) {
  const all = proxies(customProxy);
  if (!proxyOrder) proxyOrder = all.map((p) => p.id);
  // ставим последний удачный способ первым
  const ordered = [...all].sort((a, b) => {
    const ia = a.id === preferredProxy ? -1 : proxyOrder.indexOf(a.id);
    const ib = b.id === preferredProxy ? -1 : proxyOrder.indexOf(b.id);
    return ia - ib;
  });

  let lastError = null;
  for (const proxy of ordered) {
    const url = proxy.build(targetUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`${proxy.label}: HTTP ${res.status}`);
      const text = await res.text();
      // w.tv иногда отвечает 403 (защита CloudFront), а прокси отдаёт это как
      // обычный текст — такой ответ нельзя считать успешным
      if (/Request blocked|403 ERROR|Target URL returned error|Rate limit|Too Many Requests/i.test(text.slice(0, 600))) {
        throw new Error(`${proxy.label}: запрос заблокирован w.tv`);
      }
      const data = rawJson(proxy.extract(text));
      if (!data) throw new Error(`${proxy.label}: не JSON`);
      if (data.error || data.errors) throw new Error(`${proxy.label}: ${JSON.stringify(data.error || data.errors).slice(0, 80)}`);
      preferredProxy = proxy.id;
      return data;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('все способы недоступны');
}

/** Ник -> { userId, nickname } */
async function fetchProfile(nickname, customProxy = '') {
  const url = `${PROFILES_API}/profiles/by-nickname/${encodeURIComponent(nickname)}?user_lang=ru&platform=web&_=${Date.now()}`;
  const data = await requestViaProxy(url, customProxy);
  if (!data?.profile?.userId) {
    // «ник не найден» w.tv сообщает отдельным полем, всё остальное — сбой связи
    if (data?.errors) {
      const err = new Error('channel_not_found');
      err.code = 'channel_not_found';
      throw err;
    }
    throw new Error('профиль не получен (прокси вернул не то)');
  }
  return { userId: data.profile.userId, nickname: data.profile.nickname || nickname };
}

/** Последние ~50 сообщений чата (новые первыми, как отдаёт API) */
async function fetchMessages(userId, customProxy = '') {
  const url = `${CHATS_API}/chats/${encodeURIComponent(userId)}/messages?user_lang=ru&platform=web&_=${Date.now()}`;
  const data = await requestViaProxy(url, customProxy);
  if (!Array.isArray(data?.messages)) throw new Error('сообщения не получены (прокси вернул не то)');
  const list = data.messages;
  return list
    .filter((m) => m && m.content != null)
    .map((m) => ({
      id: m.messageId,
      ts: m.createdAt,
      userId: m.sender?.userId || '',
      nickname: m.sender?.nickname || 'аноним',
      tags: m.sender?.tags || [],
      content: m.content,
      type: m.type || 'MESSAGE',
    }));
}

// ---------------------------------------------------------------------------
// 7. Мелкие утилиты
// ---------------------------------------------------------------------------
function uid() {
  return 'r' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeOf(iso) {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function dateTimeOf(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function colorFor(nick) {
  let h = 0;
  const s = String(nick || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 62%, 70%)`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ---------------------------------------------------------------------------
// Публичный набор функций для app.js и тестов
// ---------------------------------------------------------------------------
window.WVote = {
  BROWSER_UA_NEEDED,
  CHATS_API,
  DEFAULT_WORDS,
  EDGE_RE,
  EMOTE_RE,
  PROFILES_API,
  STORAGE_KEY,
  colorFor,
  computeScores,
  dateTimeOf,
  detectVote,
  emptyState,
  esc,
  fetchMessages,
  fetchProfile,
  loadState,
  normalizeChannelInput,
  normalizeMessage,
  parseWords,
  plural,
  proxies,
  rawJson,
  requestViaProxy,
  resetProxyOrder,
  saveState,
  tallyVotes,
  timeOf,
  uid,
  wordsToText
};
})();
