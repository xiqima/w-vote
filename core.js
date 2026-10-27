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
// 3. Фазы раунда
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
  if (votesEnd(round)) return 'awaiting';
  return 'voting';
}

// ---------------------------------------------------------------------------
// 4. Подсчёт голосов раунда
// ---------------------------------------------------------------------------
/**
 * @param messages [{id, ts, userId, nickname, tags, content}]
 * @param round    {openedAt, closedAt, allowRevote, words, ownerUserId}
 * @returns [{userId, nickname, vote, ts, votes}]
 */
function tallyVotes(messages, round) {
  const words = round.words || DEFAULT_WORDS;
  const byUser = new Map();
  const end = votesEnd(round);
  for (const m of messages) {
    if (!m.ts || m.ts < round.openedAt) continue;
    if (end && m.ts > end) continue;
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
// 5. Очки
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
    .filter((r) => r.outcome) // исход объявлен — неважно, останавливали приём отдельно или нет
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
// 6. Хранилище: только этот браузер, переживает обновление страницы
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'wtv_vote_v2';

function migrateRound(r) {
  if (!r || typeof r !== 'object') return null;
  const round = { ...r };
  if (round.votesClosedAt === undefined) {
    // старый формат: приём голосов и объявление исхода были одним моментом
    round.votesClosedAt = round.closedAt || null;
  }
  if (round.decidedAt === undefined) round.decidedAt = round.outcome ? round.closedAt || null : null;
  delete round.closedAt;
  round.votes = Array.isArray(round.votes) ? round.votes : [];
  return round;
}

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
      rounds: (Array.isArray(raw.rounds) ? raw.rounds : []).map(migrateRound),
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
// 7. Чтение чата w.tv
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

/** Аватар канала (null, если его нет) */
async function fetchAvatar(userId, customProxy = '') {
  try {
    const url = `${PROFILES_API}/users/${encodeURIComponent(userId)}/profile/images?user_lang=ru&platform=web&_=${Date.now()}`;
    const data = await requestViaProxy(url, customProxy);
    const img = (data?.images || []).find((i) => i.type === 'avatar');
    return img?.imageUrl || null;
  } catch {
    return null; // без аватарки тоже нормально
  }
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
// 8. Экспорт итоговой таблицы: Excel (.xlsx), CSV, TXT
// ---------------------------------------------------------------------------
const EXPORT_HEAD = ['Место', 'Ник', 'Очки', 'Угадал', 'Голосовал', 'Серия подряд', 'Правка вручную'];

/** строки для листа «Лидеры» */
function exportLeadersRows(scores) {
  return [
    EXPORT_HEAD,
    ...scores.map((p, i) => [
      i + 1,
      p.nickname,
      p.points,
      p.guessed,
      p.voted,
      p.streak || 0,
      p.adjust || 0,
    ]),
  ];
}

/** строки для листа «Раунды» */
function exportRoundsRows(rounds, words) {
  const w = words || DEFAULT_WORDS;
  const head = ['№', 'Начало', 'Голоса до', 'Итог', `Голосов «${w.win[0]}»`, `Голосов «${w.lose[0]}»`, 'Всего голосов', 'Угадали'];
  const rows = rounds.map((r) => {
    const votes = r.votes || [];
    const winVotes = votes.filter((v) => v.vote === 'win').length;
    const loseVotes = votes.filter((v) => v.vote === 'lose').length;
    const guessed = r.outcome ? votes.filter((v) => v.vote === r.outcome).length : 0;
    return [
      r.index,
      dateTimeOf(r.openedAt),
      r.votesClosedAt ? dateTimeOf(r.votesClosedAt) : '—',
      r.outcome === 'win' ? 'победа' : r.outcome === 'lose' ? 'поражение' : 'не объявлен',
      winVotes,
      loseVotes,
      votes.length,
      r.outcome ? guessed : '—',
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
// 9. Мелкие утилиты
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
  votesEnd,
  roundPhase,
  exportLeadersRows,
  exportRoundsRows,
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
