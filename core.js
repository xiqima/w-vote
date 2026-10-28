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

const EMOTE_RE = /:[a-zA-Z0-9_]{2,}:/g; // :KEKwAIT:
const EDGE_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu; // пунктуация по краям
const FULL_EMOTE_RE = /^:([^:]+):$/; // слово целиком в «эмоутных» двоеточиях: :win:

/** сообщение без лишних пробелов и в нижнем регистре, но СИМВОЛЫ сохраняются */
function rawMessage(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * приводит слово-голос к тому же виду, что и сообщение: ":Победа!" -> "победа".
 * Слова из одних символов («+», «++», «?!») не должны исчезать: если после
 * чистки от слова ничего не осталось, оставляем его как есть.
 */
function normalizeWord(word) {
  const raw = rawMessage(word);
  if (!raw) return '';
  const emote = raw.match(FULL_EMOTE_RE);
  const inner = emote ? rawMessage(emote[1]) : raw;
  if (!inner) return '';
  return normalizeMessage(inner) || inner;
}

/** "win, победа ,  ВИН, :луз:, +" -> ["win","победа","вин","луз","+"] */
function parseWords(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const word = normalizeWord(part);
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

function wordsToText(list) {
  return (list || []).join(', ');
}

/**
 * ":pugPls: Win!" -> "win"
 * ":win:"         -> "win"  (если убрать эмоут целиком ничего не осталось,
 *                            пробуем прочитать сообщение без двоеточий —
 *                            иначе слово-голос в формате :слово: терялся)
 */
function normalizeMessage(text) {
  const raw = rawMessage(text);
  if (!raw) return '';
  const withoutEmotes = raw.replace(EMOTE_RE, ' ').replace(/\s+/g, ' ').trim().replace(EDGE_RE, '');
  if (withoutEmotes) return withoutEmotes;
  return raw.replace(EDGE_RE, '');
}

/**
 * Все варианты прочтения сообщения: «WIN!» -> win, «:KEKwAIT: lose» -> lose,
 * «+» -> + (слово-символ), «:+:» -> + и :+:.
 * Нужно, чтобы слова-голоса могли состоять из одних символов.
 */
function voteCandidates(text) {
  const raw = rawMessage(text);
  if (!raw) return [];
  const out = [];
  const push = (value) => {
    if (value && !out.includes(value)) out.push(value);
  };
  push(normalizeMessage(raw));
  push(raw);
  const emote = raw.match(FULL_EMOTE_RE);
  if (emote) push(rawMessage(emote[1]));
  return out;
}

/** сообщение целиком совпало с одним из слов списка */
function matchesWord(text, list) {
  const words = (list || []).filter(Boolean);
  if (!words.length) return false;
  return voteCandidates(text).some((candidate) => words.includes(candidate));
}

/**
 * Голос — это сообщение ЦЕЛИКОМ, равное одному из слов.
 * "Win", "WIN!", ":KEKwAIT: lose", "+" — да. "я за win" — нет (иначе болтовня считается).
 * @param options [{key, words}]
 * @returns {string|null} ключ варианта
 */
function matchOption(text, options) {
  const candidates = voteCandidates(text);
  if (!candidates.length) return null;
  for (const option of options || []) {
    const list = (option && option.words) || [];
    if (candidates.some((candidate) => list.includes(candidate))) return option.key;
  }
  return null;
}

/**
 * Голос в режиме «победа / поражение».
 * @returns {'win'|'lose'|null}
 */
function detectVote(text, words = DEFAULT_WORDS) {
  const w = words || DEFAULT_WORDS;
  return matchOption(text, [
    { key: 'win', words: w.win || [] },
    { key: 'lose', words: w.lose || [] },
  ]);
}
// ---------------------------------------------------------------------------
// 3. Режимы раунда
//    poll — опрос: 2–100 вариантов, очки тем, кто выбрал победивший
//    roll — рулетка: случайный ник из тех, кто написал слово-участие
//    classic — прежний режим «победа / поражение». Из настроек он убран,
//              но старые раунды продолжают читаться, считаться и выгружаться.
// ---------------------------------------------------------------------------
const MODES = ['poll', 'roll'];

/** режим из настроек: всё, что не рулетка, — опрос */
function normalizeMode(mode) {
  return mode === 'roll' ? 'roll' : 'poll';
}

/** режим раунда (у старых раундов поля mode нет — это классика) */
function roundMode(round) {
  if (!round) return 'classic';
  if (round.mode === 'poll' || round.mode === 'roll') return round.mode;
  return 'classic';
}

function defaultPollOptions() {
  return [
    { key: 'p1', label: 'да', words: ['да'] },
    { key: 'p2', label: 'нет', words: ['нет'] },
  ];
}

/** сколько вариантов опроса разрешаем */
const MAX_POLL_OPTIONS = 100;

/**
 * Настройки опроса -> аккуратный список вариантов.
 * Ключи всегда p1..pN: по ним считаются голоса раунда.
 */
function normalizePollOptions(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    let words = Array.isArray(item && item.words)
      ? item.words.map((w) => normalizeWord(w)).filter(Boolean)
      : parseWords(item && (item.text || item.label || ''));
    words = [...new Set(words)];
    if (!words.length) continue;
    out.push({ key: 'p' + (out.length + 1), label: words[0], words });
    if (out.length >= MAX_POLL_OPTIONS) break;
  }
  return out.length >= 2 ? out : defaultPollOptions();
}

/** варианты классики: победа / поражение (первое слово — подпись) */
function classicOptions(words) {
  const w = words || DEFAULT_WORDS;
  const win = (w.win && w.win.length ? w.win : ['win']).slice();
  const lose = (w.lose && w.lose.length ? w.lose : ['lose']).slice();
  return [
    { key: 'win', label: win[0], words: win, tone: 'win' },
    { key: 'lose', label: lose[0], words: lose, tone: 'lose' },
  ];
}

/**
 * За кого можно голосовать в этом раунде.
 * У рулетки вариантов нет — там важен сам факт участия.
 */
function roundOptions(round) {
  if (!round) return [];
  const mode = roundMode(round);
  if (mode === 'roll') return [];
  if (mode === 'poll') {
    const raw = Array.isArray(round.options) ? round.options : [];
    const opts = raw
      .filter((o) => o && Array.isArray(o.words) && o.words.length)
      .map((o, i) => ({
        key: String(o.key || 'p' + (i + 1)),
        label: o.label || o.words[0],
        words: o.words.slice(),
      }));
    return opts.length >= 2 ? opts : classicOptions(round.words);
  }
  return classicOptions(round.words);
}

/** слово участия в рулетке (по умолчанию «+») */
function roundEntryWords(round) {
  const list = Array.isArray(round && round.entryWords)
    ? round.entryWords.map((w) => normalizeWord(w)).filter(Boolean)
    : [];
  return list.length ? list : ['+'];
}

/** что написал зритель: ключ варианта, 'enter' для рулетки или null */
function voteKeyFor(text, round) {
  if (!round) return null;
  if (roundMode(round) === 'roll') return matchesWord(text, roundEntryWords(round)) ? 'enter' : null;
  return matchOption(text, roundOptions(round));
}

// ---------------------------------------------------------------------------
// 4. Фазы раунда
//    ready    — раунд создан («Новый раунд»), приём ещё не начался
//    voting   — приём голосов идёт
//    awaiting — приём остановлен, ждём исход (можно ещё передумать)
//    finished — исход объявлен, очки начислены
// ---------------------------------------------------------------------------
/** момент, после которого голоса не считаются */
function votesEnd(round) {
  return round.votesClosedAt || round.closedAt || null;
}

function roundPhase(round) {
  if (!round) return 'none';
  if (round.outcome) return 'finished';
  if (roundMode(round) === 'roll' && round.winner && round.winner.userId) return 'finished';
  if (votesEnd(round)) return 'awaiting';
  if (!round.openedAt) return 'ready';
  return 'voting';
}

// --- таймер раунда ---------------------------------------------------------
/** длительность раунда в секундах (0 — без таймера) */
function roundTimerSeconds(round) {
  const n = Math.round(Number(round && round.timerSeconds) || 0);
  return n > 0 ? Math.min(n, 3600) : 0;
}

/**
 * Когда закончится раунд (метка времени, мс) или null.
 * Отсчёт идёт от timerStartedAt (если таймер включили посреди раунда) или от openedAt.
 */
function roundDeadline(round) {
  const seconds = roundTimerSeconds(round);
  if (!seconds || !round) return null;
  const from = round.timerStartedAt || round.openedAt;
  if (!from) return null;
  const start = Date.parse(from);
  if (!Number.isFinite(start)) return null;
  return start + seconds * 1000;
}

/** сколько осталось до конца раунда, мс (null — таймера нет) */
function roundTimeLeft(round, now = Date.now()) {
  const deadline = roundDeadline(round);
  if (deadline == null) return null;
  return Math.max(0, deadline - now);
}

/** 0:45 / 12:30 / 1:02:00 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

// ---------------------------------------------------------------------------
// 5. Подсчёт голосов раунда
// ---------------------------------------------------------------------------
/**
 * @param messages [{id, ts, userId, nickname, tags, content}]
 * @param round    {mode, openedAt, votesClosedAt, allowRevote, words|options|entryWords, ownerUserId}
 * @returns [{userId, nickname, vote, ts, votes}]
 */
function tallyVotes(messages, round) {
  const byUser = new Map();
  if (!round || !round.openedAt) return [];
  const end = votesEnd(round);
  for (const m of messages) {
    if (!m.ts || m.ts < round.openedAt) continue;
    if (end && m.ts > end) continue;
    if (round.ownerUserId && m.userId === round.ownerUserId) continue; // стример не голосует
    if ((m.tags || []).includes('TAG_OWNER')) continue;
    const vote = voteKeyFor(m.content, round);
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

/** случайный участник рулетки; rng можно подменить в тестах */
function pickWinner(votes, rng) {
  const list = (votes || []).filter((v) => v && v.userId);
  if (!list.length) return null;
  const r = typeof rng === 'function' ? rng() : Math.random();
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(r * list.length)));
  return list[index];
}

/** сколько голосов за каждый вариант: {key: число} */
function countByOption(votes) {
  const out = {};
  for (const v of votes || []) out[v.vote] = (out[v.vote] || 0) + 1;
  return out;
}

/**
 * Лидер опроса: вариант, за который больше всего голосов.
 * Если первое место делят несколько — key: null, а ключи лежат в tied.
 * @returns {{key: string|null, count: number, tied: string[]}}
 */
function pollLeader(votes, options) {
  const counts = countByOption(votes);
  const list = (options || []).map((o) => ({ key: o.key, count: counts[o.key] || 0 }));
  list.sort((a, b) => b.count - a.count);
  const best = list.length ? list[0].count : 0;
  const tied = best > 0 ? list.filter((o) => o.count === best).map((o) => o.key) : [];
  return { key: tied.length === 1 ? tied[0] : null, count: best, tied };
}

// ---------------------------------------------------------------------------
// 6. Очки
// ---------------------------------------------------------------------------
/** сколько очков даём за раунд: 0…100, пустое и мусор → 1 */
function clampPoints(value, fallback = 1) {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw == null) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

/** очки конкретного раунда (у старых раундов поля points нет — было 1) */
function roundPoints(round) {
  return clampPoints(round && round.points, 1);
}

/**
 * Итоговые очки = угаданные раунды + победы в рулетке + ручная правка (adjust).
 * За каждый угаданный раунд начисляется столько очков, сколько было в его
 * настройке points (по умолчанию 1), поэтому старые раунды считаются как раньше.
 * @param rounds   [{index, mode, outcome, winner, votes:[{userId,nickname,vote}]}]
 * @param adjust   {userId: число}
 * @param extra    [{userId, nickname}] — кого показать, даже если 0 очков
 */
function computeScores(rounds, adjust = {}, extra = []) {
  const map = new Map();
  const touch = (userId, nickname) => {
    if (!map.has(userId)) {
      map.set(userId, {
        userId,
        nickname,
        guessed: 0,
        rollWins: 0,
        earned: 0, // очки за раунды (без ручной правки)
        voted: 0,
        adjust: 0,
        streak: 0,
        bestStreak: 0,
      });
    }
    const p = map.get(userId);
    if (nickname) p.nickname = nickname;
    return p;
  };

  // завершённый раунд: объявлен исход (опрос, классика) или выбран победитель рулетки
  const finished = rounds.filter((r) => roundPhase(r) === 'finished').sort((a, b) => a.index - b.index);

  for (const r of finished) {
    const points = roundPoints(r);
    if (roundMode(r) === 'roll') {
      for (const v of r.votes || []) touch(v.userId, v.nickname).voted += 1;
      const winner = r.winner;
      if (winner && winner.userId && r.awardWinner !== false) {
        const p = touch(winner.userId, winner.nickname);
        p.rollWins += 1;
        p.earned += points;
      }
      continue;
    }
    for (const v of r.votes || []) {
      const p = touch(v.userId, v.nickname);
      p.voted += 1;
      if (v.vote === r.outcome) {
        p.guessed += 1;
        p.earned += points;
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

  const list = [...map.values()].map((p) => ({ ...p, points: p.earned + p.adjust }));
  return list.sort(
    (a, b) =>
      b.points - a.points ||
      b.guessed - a.guessed ||
      b.rollWins - a.rollWins ||
      (a.nickname > b.nickname ? 1 : -1)
  );
}
// ---------------------------------------------------------------------------
// 7. Хранилище: только этот браузер, переживает обновление страницы
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'wtv_vote_v2';
const STORAGE_PREFIX = 'wtv_vote'; // все наши ключи начинаются с этого

/** 5…3600 секунд; 0 и мусор превращаются в fallback */
function clampTimerSeconds(value, fallback = 60) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(5, Math.min(3600, n));
}

/** варианты опроса, уже сохранённые в раунде: ключи не пересчитываем, по ним лежат голоса */
function migratePollRoundOptions(options) {
  const raw = Array.isArray(options) ? options : [];
  const out = raw
    .filter((o) => o && Array.isArray(o.words) && o.words.length)
    .map((o, i) => ({ key: String(o.key || 'p' + (i + 1)), label: o.label || o.words[0], words: o.words.slice() }));
  return out.length >= 2 ? out : defaultPollOptions();
}

function migrateRound(r) {
  if (!r || typeof r !== 'object') return null;
  const round = { ...r };
  if (round.votesClosedAt === undefined) {
    // старый формат: приём голосов и объявление исхода были одним моментом
    round.votesClosedAt = round.closedAt || null;
  }
  if (round.decidedAt === undefined) round.decidedAt = round.outcome ? round.closedAt || null : null;
  delete round.closedAt;

  // старые раунды без mode — классика; её не переводим в опрос, чтобы
  // история, очки и выгрузки выглядели точно как раньше
  if (round.mode !== 'poll' && round.mode !== 'roll') round.mode = 'classic';
  round.votes = Array.isArray(round.votes) ? round.votes : [];
  round.allowRevote = !!round.allowRevote;
  round.timerSeconds = roundTimerSeconds(round);
  round.points = roundPoints(round);
  round.autoWinner = round.mode === 'poll' && !!round.autoWinner;
  round.words = {
    win: Array.isArray(round.words?.win) && round.words.win.length ? round.words.win.slice() : ['win'],
    lose: Array.isArray(round.words?.lose) && round.words.lose.length ? round.words.lose.slice() : ['lose'],
  };
  if (round.mode === 'poll') {
    round.options = migratePollRoundOptions(round.options);
  } else {
    delete round.options;
  }
  if (round.mode === 'roll') {
    round.entryWords = roundEntryWords(round);
    round.awardWinner = round.awardWinner !== false;
    if (!round.winner || !round.winner.userId) round.winner = null;
  } else {
    round.winner = null;
  }
  return round;
}

function defaultSettings() {
  return {
    mode: 'poll', // poll — опрос, roll — рулетка
    pollOptions: defaultPollOptions(), // варианты следующего опроса
    pollAutoWinner: false, // победителем становится самый популярный вариант
    pointsPerWin: 1, // сколько очков получает победитель раунда
    rollWords: ['+'], // слово участия в рулетке (символы разрешены)
    rollAward: true, // победитель рулетки получает очки
    allowRevote: false, // считается последнее слово зрителя
    timerEnabled: false, // таймер раунда выключен по умолчанию
    timerSeconds: 60,
    proxy: '', // свой прокси (необязательно)
    pollSeconds: 5,
  };
}

/** настройки из чего угодно -> рабочий набор (нужно и при загрузке копии) */
function normalizeSettings(settings) {
  const raw = settings || {};
  const s = { ...defaultSettings(), ...raw };
  s.mode = normalizeMode(raw.mode);

  // Старый режим «победа / поражение» убран. Его два набора слов становятся
  // двумя вариантами опроса — так у обновившихся ничего не меняется,
  // включая привычные win/lose.
  const legacyWin = Array.isArray(raw.words?.win)
    ? raw.words.win.map((w) => normalizeWord(w)).filter(Boolean)
    : [];
  const legacyLose = Array.isArray(raw.words?.lose)
    ? raw.words.lose.map((w) => normalizeWord(w)).filter(Boolean)
    : [];
  if (raw.mode === 'classic' || !raw.mode) {
    s.pollOptions = normalizePollOptions([
      { words: legacyWin.length ? legacyWin : ['win'] },
      { words: legacyLose.length ? legacyLose : ['lose'] },
    ]);
  } else {
    s.pollOptions = normalizePollOptions(s.pollOptions);
  }
  delete s.words;

  s.pollAutoWinner = !!s.pollAutoWinner;
  s.pointsPerWin = clampPoints(s.pointsPerWin);
  const rollWords = Array.isArray(s.rollWords) ? s.rollWords.map((w) => normalizeWord(w)).filter(Boolean) : [];
  s.rollWords = rollWords.length ? [...new Set(rollWords)] : ['+'];
  s.rollAward = s.rollAward !== false;
  s.allowRevote = !!s.allowRevote;
  s.timerEnabled = !!s.timerEnabled;
  s.timerSeconds = clampTimerSeconds(s.timerSeconds);
  s.pollSeconds = Math.max(3, Math.min(30, Number(s.pollSeconds) || 5));
  return s;
}

function emptyState() {
  return {
    version: 2,
    channel: '',
    channelUserId: null,
    channelName: null,
    settings: defaultSettings(),
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
      rounds: (Array.isArray(raw.rounds) ? raw.rounds : []).map(migrateRound).filter(Boolean),
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      extraPlayers: Array.isArray(raw.extraPlayers) ? raw.extraPlayers : [],
      adjust: raw.adjust && typeof raw.adjust === 'object' ? raw.adjust : {},
    };
    state.settings = normalizeSettings(state.settings);
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
// 8. Чтение чата w.tv
//    CORS у w.tv разрешён только для https://w.tv, поэтому браузер может
//    получить данные только через посредника. Посредников несколько, и они
//    нестабильны, поэтому:
//      • способы пробуются ПАРАЛЛЕЛЬНО — побеждает первый валидный ответ
//        (последовательный перебор на плохой сети растягивался на минуты);
//      • удачный способ запоминается в localStorage и в следующий раз идёт
//        первым и без гонки (экономим лимиты посредников);
//      • если все способы в «паузе» после ошибок — всё равно пробуем, иначе
//        сайт сам себя запирал и не мог восстановиться;
//      • каждая ошибка объясняется человеческим текстом, чтобы в интерфейсе
//        было видно, что именно не работает.
// ---------------------------------------------------------------------------
const BROWSER_UA_NEEDED = 'нужен браузерный User-Agent — прокси его подставляют сами';

const PROFILES_API = 'https://profiles-service.w.tv/api/v1';
const CHATS_API = 'https://chats-service.w.tv/api/v1';
const NET_KEY = 'wtv_vote_net_v1'; // какой способ связи работает + их «здоровье»

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

/**
 * ПОЛНЫЙ список способов добраться до API w.tv — без учёта галочек в настройках.
 * Порядок не важен для скорости (все пробуются одновременно), но важен для
 * диагностики: сверху — самые надёжные. «Свой прокси» всегда первый.
 */
function proxyCatalog(customProxy) {
  const list = [];
  if (customProxy && String(customProxy).trim()) {
    const template = String(customProxy).trim();
    list.push({
      id: 'custom',
      label: 'свой прокси',
      build: (url) =>
        template.includes('{url}') ? template.replace('{url}', encodeURIComponent(url)) : template + encodeURIComponent(url),
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
    id: 'allorigins',
    label: 'allorigins',
    build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    extract: (text) => text,
    slow: true,
  });
  list.push({
    id: 'allorigins_json',
    label: 'allorigins (json)',
    build: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    extract: (text) => {
      const box = rawJson(text);
      return box && typeof box.contents === 'string' ? box.contents : text;
    },
    slow: true,
  });
  list.push({
    id: 'corslol',
    label: 'cors.lol',
    build: (url) => `https://api.cors.lol/?url=${encodeURIComponent(url)}`,
    extract: (text) => text,
  });
  list.push({
    id: 'codetabs',
    label: 'codetabs',
    build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    extract: (text) => text,
    slow: true,
  });
  // последний шанс: если w.tv когда-нибудь разрешит наш origin — сработает сразу
  list.push({
    id: 'direct',
    label: 'напрямую',
    build: (url) => url,
    extract: (text) => text,
  });
  return list;
}

/**
 * Способы, РАЗРЕШЁННЫЕ галочками в настройках.
 * По умолчанию включены все (в настройках хранятся только выключенные),
 * поэтому новые посредники появляются у людей сами.
 */
function proxies(customProxy) {
  // свой прокси берём из аргумента, а если его нет — из настроек браузера
  const own = String(customProxy || '').trim() || globalProxy();
  return proxyCatalog(own).filter((p) => isProxyEnabled(p.id));
}

// --- состояние сети: рабочий способ + «здоровье» каждого -------------------
let netState = null;

function netLoad() {
  if (netState) return netState;
  netState = { preferred: null, health: {}, proxy: '', enabled: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(NET_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      if (typeof raw.preferred === 'string') netState.preferred = raw.preferred;
      if (typeof raw.proxy === 'string') netState.proxy = raw.proxy;
      if (raw.enabled && typeof raw.enabled === 'object') {
        // храним только выключенные: enabled[id] === false
        for (const id of Object.keys(raw.enabled)) if (raw.enabled[id] === false) netState.enabled[id] = false;
      }
      if (raw.health && typeof raw.health === 'object') {
        for (const id of Object.keys(raw.health)) {
          const h = raw.health[id] || {};
          netState.health[id] = { fails: Number(h.fails) || 0, coolUntil: Number(h.coolUntil) || 0 };
        }
      }
    }
  } catch {}
  return netState;
}

function netSave() {
  try {
    localStorage.setItem(NET_KEY, JSON.stringify(netLoad()));
  } catch {}
}

function proxyHealth(id) {
  return netLoad().health[id] || { fails: 0, coolUntil: 0 };
}

/** способ ошибся: после 2 сбоев — пауза, чтобы не тратить на него время */
function markProxyFail(id) {
  const net = netLoad();
  const h = net.health[id] || { fails: 0, coolUntil: 0 };
  h.fails += 1;
  if (h.fails >= 2) h.coolUntil = Date.now() + Math.min(h.fails * 15000, 120000);
  net.health[id] = h;
  // один сбой — ещё не приговор: снимаем «проверенный» статус только после второго
  if (net.preferred === id && h.fails >= 2) net.preferred = null;
  netSave();
}

function markProxyOk(id) {
  const net = netLoad();
  net.health[id] = { fails: 0, coolUntil: 0 };
  net.preferred = id;
  netSave();
}

function proxyCooling(id) {
  return proxyHealth(id).coolUntil > Date.now();
}

/** какой способ сработал в прошлый раз (переживает перезагрузку страницы) */
function preferredProxyId() {
  return netLoad().preferred;
}

/** забыть удачный способ, но оставить статистику ошибок */
function resetProxyOrder() {
  const net = netLoad();
  net.preferred = null;
  netSave();
}

/** полный сброс статистики: «проверить связь» и «Повторить» начинают с чистого листа */
function clearProxyHealth() {
  const net = netLoad();
  net.preferred = null;
  net.health = {};
  netSave();
}

// --- настройки подключения: свой прокси и галочки «какие способы использовать»
// Они общие для всего браузера (это свойство сети, а не канала), поэтому лежат
// в NET_KEY, а не в состоянии канала.

/** адрес своего прокси, заданный в настройках (без учёта config.js и ссылки) */
function globalProxy() {
  return String(netLoad().proxy || '').trim();
}

function setGlobalProxy(text) {
  const net = netLoad();
  net.proxy = String(text || '').trim();
  netSave();
}

/** включён ли способ связи (по умолчанию — да) */
function isProxyEnabled(id) {
  return netLoad().enabled[id] !== false;
}

function setProxyEnabled(id, enabled) {
  const net = netLoad();
  if (enabled) delete net.enabled[id];
  else net.enabled[id] = false;
  if (!enabled && net.preferred === id) net.preferred = null;
  netSave();
}

/**
 * «Сбросить всё» — как будто сайт открыли впервые: стираем ВСЕ свои ключи
 * localStorage (каналы, раунды, кэш профилей, настройки связи).
 * Чужие ключи других сайтов не трогаем: localStorage у каждого сайта свой.
 * @returns {number} сколько ключей удалено
 */
function resetEverything() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
  netState = null; // сбрасываем и кэш в памяти
  return keys.length;
}

/** ошибка связи с понятным текстом и списком подробностей по каждому способу */
function netError(message, kind, details) {
  const err = new Error(message);
  err.code = 'network';
  err.kind = kind || 'network';
  err.details = details || [];
  return err;
}

// w.tv иногда отвечает 403 (CloudFront) или прокси отдаёт HTML-страницу —
// это НЕ данные, такой ответ нельзя считать успешным
const BLOCKED_RE =
  /Request blocked|403 ERROR|Target URL returned error|Rate limit|Too Many Requests|Just a moment|Attention Required|error code: (?:4\d\d|5\d\d)/i;

/** w.tv штатно отвечает {errors:[{code:'NICKNAME_NOT_FOUND'}]} — это ответ, а не сбой связи */
function isKnownApiError(entry) {
  const text = typeof entry === 'string' ? entry : JSON.stringify(entry || {});
  return /NICKNAME_NOT_FOUND/i.test(text);
}

function parseProxyPayload(proxy, text) {
  if (BLOCKED_RE.test(String(text).slice(0, 800))) {
    throw netError(`${proxy.label}: посредник отклонил запрос`, 'blocked');
  }
  const data = rawJson(proxy.extract(text));
  if (!data) throw netError(`${proxy.label}: ответ не JSON`, 'notjson');
  if (data.error) {
    const reason = String((data.error && data.error.message) || data.error).slice(0, 90);
    throw netError(`${proxy.label}: ${reason}`, 'api');
  }
  if (Array.isArray(data.errors) && data.errors.length && !data.errors.every(isKnownApiError)) {
    const reason = String((data.errors[0] && (data.errors[0].code || data.errors[0].message)) || '').slice(0, 90);
    throw netError(`${proxy.label}: w.tv ответил ошибкой${reason ? ` (${reason})` : ''}`, 'api');
  }
  return data;
}

/** один запрос через один способ, с таймаутом и разбором ответа */
async function attemptProxy(proxy, targetUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(proxy.build(targetUrl), { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) {
      const kind = res.status === 429 ? 'ratelimit' : res.status === 403 ? 'blocked' : 'http';
      throw netError(`${proxy.label}: HTTP ${res.status}`, kind);
    }
    const text = await res.text();
    const data = parseProxyPayload(proxy, text);
    return { data, proxy, ms: Date.now() - started };
  } catch (err) {
    if (err && err.kind) throw err;
    if (err && err.name === 'AbortError') {
      throw netError(`${proxy.label}: не ответил за ${Math.round(timeoutMs / 1000)} с`, 'timeout');
    }
    const message = String((err && err.message) || err).slice(0, 120);
    // «Failed to fetch» — типично для CORS/блокировки у пользователя
    throw netError(`${proxy.label}: ${/Failed to fetch|NetworkError/i.test(message) ? 'недоступен' : message}`, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Гонка: запускаем способы лесенкой (чтобы не бить всех сразу) и берём первый
 * валидный ответ. Остальные запросы обрываем, как только победитель определён.
 */
function raceProxies(list, targetUrl, timeoutMs, staggerMs = 250) {
  return new Promise((resolve, reject) => {
    if (!list.length) {
      reject(netError('нет доступных способов связи', 'network', []));
      return;
    }
    const details = [];
    const timers = [];
    let left = list.length;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      fn(value);
    };
    list.forEach((proxy, index) => {
      timers.push(
        setTimeout(async () => {
          if (done) return;
          try {
            const out = await attemptProxy(proxy, targetUrl, timeoutMs);
            if (done) return;
            markProxyOk(proxy.id);
            finish(resolve, out);
          } catch (err) {
            if (done) return;
            markProxyFail(proxy.id);
            details.push(String((err && err.message) || err));
            left -= 1;
            if (left === 0) {
              finish(reject, netError(details.join('; ') || 'все способы недоступны', 'network', details));
            }
          }
        }, index * staggerMs)
      );
    });
  });
}

/**
 * Запрос к w.tv: сначала быстрый путь через уже проверенный способ, затем —
 * гонка всех остальных. Возвращает разобранный JSON.
 */
async function requestViaProxy(targetUrl, customProxy, timeoutMs = 12000) {
  const all = proxies(customProxy);
  if (!all.length) {
    throw netError(
      'все способы связи выключены в настройках — включи хотя бы один (или задай свой прокси)',
      'no-proxies',
      ['все способы связи выключены в настройках — включи хотя бы один (или задай свой прокси)']
    );
  }
  const net = netLoad();
  const preferred = net.preferred ? all.find((p) => p.id === net.preferred) : null;
  const healthy = all.filter((p) => !proxyCooling(p.id));
  // если всё в «паузе» — не сдаёмся, а всё равно пробуем (иначе сайт запирал сам себя)
  const pool = healthy.length ? healthy : all;
  const details = [];

  if (preferred) {
    try {
      const out = await attemptProxy(preferred, targetUrl, Math.min(timeoutMs, 9000));
      markProxyOk(preferred.id);
      return out.data;
    } catch (err) {
      markProxyFail(preferred.id);
      details.push(String((err && err.message) || err));
    }
  }

  let rest = pool.filter((p) => !preferred || p.id !== preferred.id);
  // проверенный способ оказался единственным в пуле — добираем из общего списка
  if (!rest.length) rest = all.filter((p) => !preferred || p.id !== preferred.id);
  if (!rest.length) throw netError(details.join('; ') || 'все способы недоступны', 'network', details);

  try {
    const out = await raceProxies(rest, targetUrl, timeoutMs);
    markProxyOk(out.proxy.id);
    return out.data;
  } catch (err) {
    const merged = details.concat((err && err.details) || []);
    throw netError(merged.join('; ') || 'все способы недоступны', (err && err.kind) || 'network', merged);
  }
}

/**
 * Повтор запроса несколько раз с паузой — спасает от случайных сбоев посредника.
 * budgetMs — общий лимит времени, чтобы интерфейс не «висел» минутами.
 */
async function requestWithRetry(targetUrl, customProxy, attempts = 2, budgetMs = 18000) {
  const deadline = Date.now() + budgetMs;
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await requestViaProxy(targetUrl, customProxy);
    } catch (err) {
      lastError = err;
      if (err && err.code === 'channel_not_found') throw err;
      if (Date.now() >= deadline) break;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastError || netError('все способы недоступны', 'network', []);
}

/**
 * Диагностика: проверяем все способы сразу и показываем, что происходит.
 * Нужна, когда «не подключается» — сразу видно, что именно не работает.
 */
async function probeProxies(targetUrl, customProxy, timeoutMs = 12000) {
  const list = proxies(customProxy);
  const results = await Promise.all(
    list.map(async (proxy) => {
      const started = Date.now();
      try {
        const out = await attemptProxy(proxy, targetUrl, timeoutMs);
        markProxyOk(proxy.id);
        // ответ получен — значит канал связи рабочий (даже если ника не существует)
        return { id: proxy.id, label: proxy.label, ok: true, ms: out.ms || Date.now() - started, noNick: !!out.data.errors };
      } catch (err) {
        markProxyFail(proxy.id);
        const kind = (err && err.kind) || 'network';
        // в сообщении ошибки уже есть название способа — в отчёте оно лишнее
        const full = String((err && err.message) || err);
        const raw = full.startsWith(proxy.label + ': ') ? full.slice(proxy.label.length + 2) : full;
        const friendly =
          kind === 'timeout'
            ? 'слишком медленно'
            : kind === 'ratelimit'
            ? 'лимит запросов'
            : kind === 'notjson'
            ? 'ответ не JSON'
            : kind === 'blocked'
            ? 'запрос отклонён'
            : raw;
        return { id: proxy.id, label: proxy.label, ok: false, ms: Date.now() - started, error: friendly, kind };
      }
    })
  );
  return results.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));
}

/** все способы связи и их состояние — для галочек и диагностики в интерфейсе */
function proxyStatus(customProxy) {
  const net = netLoad();
  const own = String(customProxy || '').trim() || globalProxy();
  return proxyCatalog(own).map((p) => ({
    id: p.id,
    label: p.label,
    enabled: isProxyEnabled(p.id),
    cooling: proxyCooling(p.id),
    preferred: net.preferred === p.id,
    fails: proxyHealth(p.id).fails,
  }));
}

// --- три сетевые функции, которыми пользуется интерфейс ---------------------
// ID канала в w.tv — UUID (v7) или ULID. Если человек вставил его вместо ника,
// profiles-service не нужен: чат читается сразу по ID (запасной путь, когда
// сервис профилей недоступен).
const USER_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;

function looksLikeUserId(value) {
  return USER_ID_RE.test(String(value || '').trim());
}

function profileUrl(nickname) {
  return `${PROFILES_API}/profiles/by-nickname/${encodeURIComponent(nickname)}?user_lang=ru&platform=web&_=${Date.now()}`;
}

function messagesUrl(userId) {
  return `${CHATS_API}/chats/${encodeURIComponent(userId)}/messages?user_lang=ru&platform=web&_=${Date.now()}`;
}

function avatarUrl(userId) {
  return `${PROFILES_API}/users/${encodeURIComponent(userId)}/profile/images?user_lang=ru&platform=web&_=${Date.now()}`;
}

/** Ник -> { userId, nickname } */
async function fetchProfile(nickname, customProxy = '') {
  const asked = String(nickname || '').trim();
  if (!asked) throw Object.assign(new Error('empty'), { code: 'empty' });
  if (looksLikeUserId(asked)) return { userId: asked, nickname: asked, byId: true };

  // w.tv у некоторых ников различает регистр — если не нашли, пробуем строчными
  const variants = [asked];
  if (asked.toLowerCase() !== asked) variants.push(asked.toLowerCase());

  for (const nick of variants) {
    const data = await requestWithRetry(profileUrl(nick), customProxy, 2, 18000);
    if (data?.profile?.userId) {
      return { userId: data.profile.userId, nickname: data.profile.nickname || nick };
    }
    if (data?.errors) continue; // NICKNAME_NOT_FOUND — пробуем другой вариант написания
    throw netError('профиль не получен: посредник вернул не то', 'notjson');
  }
  throw Object.assign(new Error('channel_not_found'), { code: 'channel_not_found' });
}

/** Аватар канала (null, если его нет) — необязательная вещь, ошибки глотаем */
async function fetchAvatar(userId, customProxy = '') {
  try {
    const data = await requestWithRetry(avatarUrl(userId), customProxy, 1, 12000);
    const img = (data?.images || []).find((i) => i.type === 'avatar');
    return img?.imageUrl || null;
  } catch {
    return null; // без аватарки тоже нормально
  }
}

/** Последние ~50 сообщений чата (новые первыми, как отдаёт API) */
async function fetchMessages(userId, customProxy = '') {
  const data = await requestWithRetry(messagesUrl(userId), customProxy, 2, 16000);
  if (!Array.isArray(data?.messages)) throw netError('сообщения не получены: посредник вернул не то', 'notjson');
  return data.messages
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
// 9. Экспорт итоговой таблицы: Excel (.xlsx), CSV, TXT
// ---------------------------------------------------------------------------
const EXPORT_HEAD = ['Место', 'Ник', 'Очки', 'Угадал', 'Рулетка', 'Голосовал', 'Серия подряд', 'Правка вручную'];

/** строки для листа «Лидеры» */
function exportLeadersRows(scores) {
  return [
    EXPORT_HEAD,
    ...scores.map((p, i) => [
      i + 1,
      p.nickname,
      p.points,
      p.guessed,
      p.rollWins || 0,
      p.voted,
      p.streak || 0,
      p.adjust || 0,
    ]),
  ];
}

function modeLabel(mode) {
  return mode === 'poll' ? 'опрос' : mode === 'roll' ? 'рулетка' : 'победа/поражение';
}

/** «win — 5 · lose — 3» или «+ — 12 участников» */
function votesBreakdown(round) {
  const votes = round.votes || [];
  if (roundMode(round) === 'roll') return `${roundEntryWords(round).join(' / ')} — ${votes.length}`;
  const counts = countByOption(votes);
  return roundOptions(round)
    .map((o) => `${o.label} — ${counts[o.key] || 0}`)
    .join(' · ');
}

/** итог раунда человеческим текстом */
function outcomeLabel(round) {
  if (roundMode(round) === 'roll') {
    return round.winner && round.winner.nickname ? `рулетка: ${round.winner.nickname}` : 'не разыгран';
  }
  if (!round.outcome) return 'не объявлен';
  if (roundMode(round) === 'poll') {
    const option = roundOptions(round).find((o) => o.key === round.outcome);
    return option ? option.label : round.outcome;
  }
  return round.outcome === 'win' ? 'победа' : round.outcome === 'lose' ? 'поражение' : String(round.outcome);
}

/** строки для листа «Раунды» */
function exportRoundsRows(rounds, words) {
  const head = ['№', 'Режим', 'Начало', 'Голоса до', 'Итог', 'Голоса по вариантам', 'Всего голосов', 'Угадали'];
  // раунд, который ещё не начинали, в выгрузку не попадает — у него нет ни голосов, ни времени
  const started = (rounds || []).filter((r) => roundPhase(r) !== 'ready');
  const rows = started.map((r) => {
    const votes = r.votes || [];
    const mode = roundMode(r);
    const guessed = r.outcome ? votes.filter((v) => v.vote === r.outcome).length : 0;
    return [
      r.index,
      modeLabel(mode),
      dateTimeOf(r.openedAt) || '—',
      r.votesClosedAt ? dateTimeOf(r.votesClosedAt) : '—',
      outcomeLabel({ ...r, words: r.words || words }),
      votesBreakdown({ ...r, words: r.words || words }),
      votes.length,
      mode === 'roll' ? '—' : r.outcome ? guessed : '—',
    ];
  });
  return [head, ...rows];
}

/** CSV (открывается в Excel, Google Таблицах, «Таблицах Яндекса») */
function makeCsv(rows, delimiter) {
  const d = delimiter || ';';
  const esc1 = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + rows.map((r) => r.map(esc1).join(d)).join('\r\n') + '\r\n';
}

/** аккуратный текстовый отчёт */
function makeTxt(sections) {
  const width = (rows) => {
    const w = [];
    for (const row of rows) row.forEach((cell, i) => (w[i] = Math.max(w[i] || 0, String(cell ?? '').length)));
    return w;
  };
  const block = (rows) => {
    const w = width(rows);
    return rows
      .map((row, ri) => {
        const line = row.map((cell, i) => String(cell ?? '').padEnd(w[i])).join('  ').trimEnd();
        if (ri === 0) return line + '\n' + row.map((_, i) => '─'.repeat(w[i])).join('  ');
        return line;
      })
      .join('\n');
  };
  return sections
    .map((s) => (s.title ? `${s.title}\n${'='.repeat(Math.max(s.title.length, 12))}\n` : '') + block(s.rows))
    .join('\n\n\n') + '\n';
}

// --- сборка .xlsx «с нуля» (без библиотек) ---------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(list) {
  const total = list.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of list) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

/** zip без сжатия — xlsx из нескольких XML-файлов */
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, a) => sum + a.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concatBytes([...parts, ...central, end]);
}

function xmlEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetXml(rows) {
  const widths = [];
  rows.forEach((row) => row.forEach((cell, i) => (widths[i] = Math.max(widths[i] || 6, String(cell ?? '').length + 2))));
  const cols = widths.length
    ? `<cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(w, 6), 60)}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';
  const body = rows
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          const ref = columnName(ci) + (ri + 1);
          const style = ri === 0 ? ' s="1"' : '';
          if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}"${style}><v>${cell}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(cell)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

/**
 * Готовый .xlsx (несколько листов) как Uint8Array.
 * @param sheets [{name, rows:[[...]]}]
 */
function makeXlsx(sheets) {
  const enc = new TextEncoder();
  const files = [];
  const sheetParts = sheets.map((sheet, i) => `/xl/worksheets/sheet${i + 1}.xml`);
  files.push({
    name: '[Content_Types].xml',
    data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetParts
  .map(
    (p) =>
      `<Override PartName="${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join('\n')}
</Types>`),
  });
  files.push({
    name: '_rels/.rels',
    data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
  });
  files.push({
    name: 'xl/workbook.xml',
    data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets
      .map((s, i) => `<sheet name="${xmlEsc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets>
</workbook>`),
  });
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (s, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
  });
  files.push({
    name: 'xl/styles.xml',
    data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="0"/>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`),
  });
  sheets.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(sheet.rows || [])) });
  });
  return zipStore(files);
}

// ---------------------------------------------------------------------------
// 10. Мелкие утилиты
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
  if (!iso) return '';
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
  probeProxies,
  proxyStatus,
  proxyCatalog,
  globalProxy,
  setGlobalProxy,
  isProxyEnabled,
  setProxyEnabled,
  resetEverything,
  preferredProxyId,
  clearProxyHealth,
  looksLikeUserId,
  netError,
  normalizeWord,
  rawMessage,
  voteCandidates,
  matchesWord,
  matchOption,
  voteKeyFor,
  votesEnd,
  roundPhase,
  roundMode,
  roundOptions,
  roundEntryWords,
  normalizeMode,
  normalizeSettings,
  defaultSettings,
  migrateRound,
  normalizePollOptions,
  defaultPollOptions,
  classicOptions,
  MAX_POLL_OPTIONS,
  pollLeader,
  clampPoints,
  roundPoints,
  roundTimerSeconds,
  roundDeadline,
  roundTimeLeft,
  formatDuration,
  clampTimerSeconds,
  pickWinner,
  countByOption,
  MODES,
  exportLeadersRows,
  exportRoundsRows,
  modeLabel,
  outcomeLabel,
  votesBreakdown,
  makeCsv,
  makeTxt,
  makeXlsx,
  fetchAvatar,
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
