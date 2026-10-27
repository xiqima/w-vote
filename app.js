// ===========================================================================
//  app.js — интерфейс. Данные живут только в этом браузере (localStorage).
// ===========================================================================
(function () {
'use strict';
const {
  DEFAULT_WORDS, STORAGE_KEY, colorFor, computeScores, dateTimeOf, detectVote, emptyState, esc,
  exportLeadersRows, exportRoundsRows, fetchAvatar, fetchMessages, fetchProfile, loadState,
  makeCsv, makeTxt, makeXlsx, normalizeChannelInput, parseWords, plural, probeProxies, proxyStatus, resetProxyOrder,
  roundPhase, saveState, tallyVotes, timeOf, uid, votesEnd, wordsToText,
  clearProxyHealth, looksLikeUserId, preferredProxyId,
  globalProxy, setGlobalProxy, proxyStatus: proxyStatusOf, setProxyEnabled, resetEverything,
} = window.WVote;

const $ = (id) => document.getElementById(id);
const LAST_CHANNEL_KEY = 'wtv_vote_last_channel';
const MAX_MESSAGES = 800; // сколько сообщений чата запоминаем в браузере

const app = {
  channel: '', // ключ хранилища (ник в нижнем регистре или 'demo')
  state: null,
  timer: null,
  polling: false,
  errors: 0,
  lastError: '',
  proxyNote: '',
};

const isDemo = () => app.channel === 'demo';

// --- кэш данных канала: позволяет подключаться, даже если прокси сейчас лежит ---
const PROFILE_CACHE_PREFIX = 'wtv_vote_profile:';
function readProfileCache(nick) {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILE_CACHE_PREFIX + String(nick).toLowerCase()) || 'null');
    if (!raw || !raw.userId) return null;
    return raw;
  } catch {
    return null;
  }
}
function writeProfileCache(nick, data) {
  try {
    localStorage.setItem(
      PROFILE_CACHE_PREFIX + String(nick).toLowerCase(),
      JSON.stringify({ ...data, savedAt: new Date().toISOString() })
    );
  } catch {}
}
function forgetProfileCache(nick) {
  try {
    localStorage.removeItem(PROFILE_CACHE_PREFIX + String(nick).toLowerCase());
  } catch {}
}
// свой прокси: из ссылки (?proxy=...), иначе из настроек канала, иначе из config.js.
// Ссылка важна: стример настраивает прокси один раз и передаёт зрителям готовый
// адрес — у них посредник подхватится сам, без всяких настроек.
function proxyFromUrl() {
  try {
    const value = new URLSearchParams(location.search).get('proxy');
    return value ? value.trim() : '';
  } catch {
    return '';
  }
}
// порядок: ссылка (?proxy=) → настройки браузера → старые настройки канала → config.js
const proxyOf = (state) =>
  (proxyFromUrl() || globalProxy() || state?.settings?.proxy || window.WTV_DEFAULT_PROXY || '').trim();
const storageKey = () => `${STORAGE_KEY}:${app.channel || 'default'}`;
// «текущий» раунд — тот, у которого ещё нет исхода (голосование или ожидание итога)
const openRound = () => (app.state.rounds || []).find((r) => !r.outcome) || null;
const votingRound = () => {
  const r = openRound();
  return r && roundPhase(r) === 'voting' ? r : null;
};
const awaitingRound = () => {
  const r = openRound();
  return r && roundPhase(r) === 'awaiting' ? r : null;
};
const words = () => app.state.settings.words || DEFAULT_WORDS;

function persist() {
  if (!saveState(app.state, storageKey())) toast('Не получилось сохранить: память браузера переполнена', true);
}

// ---------------------------------------------------------------------------
// Подключение канала
// ---------------------------------------------------------------------------
async function connect(rawInput, options = {}) {
  const name = normalizeChannelInput(rawInput);
  if (!name) throw Object.assign(new Error('empty'), { code: 'empty' });

  // если этот канал уже подключался — берём его данные из памяти браузера
  // и не зависим от прокси при повторном заходе
  // вставили ID канала (UUID/ULID) вместо ника — сервис профилей не нужен
  const byId = looksLikeUserId(name);
  const cached = byId ? null : readProfileCache(name);
  let profile = cached;
  let usedCache = false;
  if (cached && !options.refresh) {
    profile = { userId: cached.userId, nickname: cached.nickname || name };
    usedCache = true;
  } else {
    profile = await fetchProfile(name, proxyOf(app.state));
    if (!profile.byId) writeProfileCache(name, { userId: profile.userId, nickname: profile.nickname });
  }
  app.usedCache = usedCache;
  app.channel = String(profile.nickname || name).toLowerCase();
  app.state = loadState(storageKey());
  app.state.channel = app.channel;
  app.state.channelUserId = profile.userId;
  app.state.channelById = !!profile.byId;
  app.state.channelName = profile.byId ? `ID ${profile.userId.slice(0, 8)}…` : profile.nickname || name;
  app.state.demo = false;
  if (app.state.avatarFor !== profile.userId) {
    app.state.avatarFor = profile.userId;
    app.state.avatarUrl = null;
    persist();
    fetchAvatar(profile.userId, proxyOf(app.state)).then((url) => {
      if (!url || !app.state || app.state.avatarFor !== profile.userId) return;
      app.state.avatarUrl = url;
      persist();
      renderHeader();
    });
  }
  localStorage.setItem(LAST_CHANNEL_KEY, app.channel);
  const url = new URL(location.href);
  url.searchParams.set('c', profile.nickname);
  history.replaceState(null, '', url);
  persist();
  showApp();
  syncSettingsInputs();
  render();
  await pollNow();
  startPolling();

  // фоном уточняем данные канала (если сейчас взяли из памяти) — интерфейс не ждёт
  if (usedCache) {
    fetchProfile(name, proxyOf(app.state))
      .then((fresh) => {
        if (!app.state || app.channel !== fresh.nickname.toLowerCase()) return;
        if (fresh.userId !== app.state.channelUserId) {
          app.state.channelUserId = fresh.userId;
          app.state.avatarUrl = null;
          persist();
          pollNow();
        }
        writeProfileCache(name, { userId: fresh.userId, nickname: fresh.nickname });
        app.usedCache = false;
        renderStatus();
      })
      .catch(() => {});
  }
}

function connectDemo() {
  app.channel = 'demo';
  app.state = loadState(storageKey());
  app.state.channel = 'demo';
  app.state.demo = true;
  app.state.channelName = 'демо-канал';
  app.state.channelUserId = 'demo-owner';
  if (!app.state.messages.length) seedDemoMessages();
  localStorage.setItem(LAST_CHANNEL_KEY, 'demo');
  persist();
  showApp();
  syncSettingsInputs();
  render();
  startPolling();
}

function showApp() {
  $('landing').hidden = true;
  $('app').hidden = false;
}

function showLanding() {
  stopPolling();
  app.channel = '';
  app.state = null;
  $('app').hidden = true;
  $('landing').hidden = false;
  const url = new URL(location.href);
  url.searchParams.delete('c');
  url.searchParams.delete('demo');
  history.replaceState(null, '', url);
  $('channel-input').value = '';
  $('channel-input').focus();
}

// ---------------------------------------------------------------------------
// Демо-режим: имитация живого чата, чтобы посмотреть механику
// ---------------------------------------------------------------------------
const DEMO_NICKS = [
  'noxsir', 'NikLite', 'grilol', 'dyson', 'Ctepa', 'Astis', 'Orio', 'Sareff', 'RIZZZA',
  'sacrin', 'vortex06', 'Masamune', 'Scratch_', 'galaxyofbeer', 'Krysstallinne', 'infiren',
];
const DEMO_CHATTER = [
  'ну что, погнали', 'готов', 'а сегодня надолго?', 'классный стрим', 'удачи!',
  'давай ещё раунд', 'я поставил на победу', 'хм, спорно', 'погнали дальше',
];

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function seedDemoMessages() {
  const now = Date.now();
  for (let i = 12; i > 0; i--) {
    pushMessage({
      id: `demo-seed-${i}`,
      ts: new Date(now - i * 7000).toISOString(),
      userId: `demo-user-${randomOf(DEMO_NICKS)}`,
      nickname: randomOf(DEMO_NICKS),
      tags: [],
      content: Math.random() < 0.6 ? randomWinLose() : randomOf(DEMO_CHATTER),
    });
  }
}

function randomWinLose() {
  const w = words();
  const win = w.win[0] || 'win';
  const lose = w.lose[0] || 'lose';
  // в демо специально мешаем разные записи, включая формат :слово:
  const variants = [win, win, lose, win.toUpperCase(), lose, `${win}!`, `:${win}:`, `:${lose}:`];
  return randomOf(variants);
}

function demoTick() {
  // в демо-режиме накидываем несколько сообщений за раз — так нагляднее
  const count = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const nick = randomOf(DEMO_NICKS);
    const content = Math.random() < 0.7 ? randomWinLose() : randomOf(DEMO_CHATTER);
    pushMessage({
      id: `demo-${uid()}-${i}`,
      ts: new Date().toISOString(),
      userId: `demo-user-${nick}`,
      nickname: nick,
      tags: [],
      content,
    });
  }
  render();
}

// ---------------------------------------------------------------------------
// Опрос чата
// ---------------------------------------------------------------------------
function pushMessage(msg) {
  if (!msg || !msg.id) return false;
  if (app.state.messages.some((m) => m.id === msg.id)) return false;
  app.state.messages.push(msg);
  app.state.messages.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (app.state.messages.length > MAX_MESSAGES) app.state.messages = app.state.messages.slice(-MAX_MESSAGES);
  app.state.lastMessageTs = msg.ts;
  return true;
}

async function pollNow() {
  if (!app.state || isDemo() || app.polling) return;
  app.polling = true;
  try {
    const fresh = await fetchMessages(app.state.channelUserId, proxyOf(app.state));
    let added = 0;
    for (const m of fresh) if (pushMessage(m)) added += 1;
    app.errors = 0;
    app.lastError = '';
    if (added) {
      persist();
      render(); // показать новые сообщения и пересчитать голоса
    }
  } catch (err) {
    app.errors += 1;
    app.lastError = String((err && err.message) || err);
    if (app.errors === 1) resetProxyOrder(); // дать шанс другому прокси
    // сохранённый ID канала мог устареть — один раз пробуем получить актуальный
    if (app.errors === 3 && app.state?.channel && !app.refreshedProfile) {
      app.refreshedProfile = true;
      try {
        const fresh = await fetchProfile(app.state.channel, proxyOf(app.state));
        if (fresh.userId !== app.state.channelUserId) {
          app.state.channelUserId = fresh.userId;
          writeProfileCache(app.state.channel, { userId: fresh.userId, nickname: fresh.nickname });
          persist();
        }
      } catch {}
    }
  } finally {
    app.polling = false;
    renderStatus();
  }
}

function startPolling() {
  stopPolling();
  pollLoop();
}

async function pollLoop() {
  if (!app.state) return;
  if (!document.hidden) {
    if (isDemo()) demoTick();
    else await pollNow();
  }
  const base = Math.max(3, Number(app.state.settings.pollSeconds) || 5) * 1000;
  // при сбоях пробуем реже, но продолжаем пытаться сами
  const delay = app.errors
    ? Math.min(base * Math.pow(2, Math.min(app.errors, 4)), 45000)
    : base;
  app.timer = setTimeout(pollLoop, delay);
}

function stopPolling() {
  clearInterval(app.timer);
  app.timer = null;
}

// ---------------------------------------------------------------------------
// Действия с раундом
// ---------------------------------------------------------------------------
function startRound() {
  const s = app.state;
  if (openRound()) return toast('Сначала заверши текущий раунд', true);
  const index = s.rounds.reduce((max, r) => Math.max(max, r.index || 0), 0) + 1;
  s.rounds.push({
    id: uid(),
    index,
    openedAt: new Date().toISOString(),
    votesClosedAt: null,
    outcome: null,
    decidedAt: null,
    allowRevote: !!s.settings.allowRevote,
    words: { win: [...words().win], lose: [...words().lose] },
    votes: [],
    ownerUserId: s.channelUserId,
  });
  persist();
  render();
  toast(`Раунд №${index}: приём голосов начат — зрители могут писать в чат`);
}

/** остановить приём голосов и зафиксировать, кто что написал */
function stopVoting() {
  const round = votingRound();
  if (!round) return toast('Приём голосов уже остановлен', true);
  round.votesClosedAt = new Date().toISOString();
  round.votes = tallyVotes(app.state.messages, round);
  persist();
  render();
  const win = round.votes.filter((v) => v.vote === 'win').length;
  const lose = round.votes.filter((v) => v.vote === 'lose').length;
  toast(`Приём голосов остановлен: ${round.words.win[0]} — ${win}, ${round.words.lose[0]} — ${lose}. Ждём исход матча.`);
}

/** вернуть приём голосов, если поспешил */
function resumeVoting() {
  const round = awaitingRound();
  if (!round) return;
  round.votesClosedAt = null;
  round.votes = [];
  persist();
  render();
  toast('Приём голосов снова открыт');
}

function finishRound(outcome) {
  const round = openRound();
  if (!round) return toast('Нет активного раунда', true);
  if (!round.votesClosedAt) {
    // если ещё не остановили приём — останавливаем и сразу объявляем исход
    round.votesClosedAt = new Date().toISOString();
    round.votes = tallyVotes(app.state.messages, round);
  }
  round.outcome = outcome;
  round.decidedAt = new Date().toISOString();
  const guessed = round.votes.filter((v) => v.vote === outcome).length;
  persist();
  render();
  toast(
    `Раунд №${round.index}: ${outcome === 'win' ? 'победа' : 'поражение'}. ` +
      `Угадали ${guessed} из ${round.votes.length} — очки начислены`
  );
}

function cancelRound() {
  const round = openRound();
  if (!round) return;
  const what = roundPhase(round) === 'voting' ? 'голосование' : 'раунд';
  if (!confirm(`Отменить ${what} №${round.index}? Голоса этого раунда не будут засчитаны.`)) return;
  app.state.rounds = app.state.rounds.filter((r) => r.id !== round.id);
  persist();
  render();
}

/** голоса текущего раунда: у открытого считаем на лету, у закрытого берём зафиксированные */
function liveVotes() {
  const round = openRound();
  if (!round) return [];
  if (roundPhase(round) === 'awaiting') return round.votes || [];
  return tallyVotes(app.state.messages, round);
}

// ---------------------------------------------------------------------------
// Очки
// ---------------------------------------------------------------------------
function scoreboard() {
  const s = app.state;
  const voting = roundPhase(openRound()) === 'voting';
  const live = voting ? liveVotes() : [];
  const extra = [
    ...(s.extraPlayers || []),
    ...live.map((v) => ({ userId: v.userId, nickname: v.nickname })),
  ];
  const current = new Map(live.map((v) => [v.userId, v.vote]));
  return computeScores(s.rounds, s.adjust, extra).map((p) => ({
    ...p,
    currentVote: current.get(p.userId) || null,
  }));
}

function setPoints(userId, desired) {
  const s = app.state;
  const player = scoreboard().find((p) => p.userId === userId);
  if (!player) return;
  const value = Math.max(-9999, Math.min(99999, Math.round(Number(desired) || 0)));
  const delta = value - player.guessed;
  if (delta === 0) delete s.adjust[userId];
  else s.adjust[userId] = delta;
  if (!s.extraPlayers.some((p) => p.userId === userId)) {
    s.extraPlayers.push({ userId, nickname: player.nickname });
  }
  persist();
  render();
}

function addPlayerManually() {
  const nickname = (prompt('Ник, которому нужно поставить очки:') || '').trim();
  if (!nickname) return;
  const points = Number((prompt(`Сколько очков поставить «${nickname}»?`, '1') || '').trim());
  const userId = `manual-${nickname.toLowerCase()}`;
  const s = app.state;
  if (!s.extraPlayers.some((p) => p.userId === userId)) s.extraPlayers.push({ userId, nickname });
  const player = scoreboard().find((p) => p.userId === userId);
  setPoints(userId, (player?.guessed || 0) + (Number.isFinite(points) ? points : 0));
}

// ---------------------------------------------------------------------------
// Рендер
// ---------------------------------------------------------------------------
let pointerBusy = false; // палец/мышь зажаты — не подменяем узлы под курсором
let renderPending = false;

document.addEventListener('pointerdown', () => { pointerBusy = true; }, true);
document.addEventListener('pointerup', () => {
  pointerBusy = false;
  if (renderPending) {
    renderPending = false;
    render();
  }
}, true);
document.addEventListener('pointercancel', () => { pointerBusy = false; }, true);

function render() {
  if (!app.state) return;
  if (pointerBusy) {
    // перерисуем сразу после отпускания кнопки мыши, иначе браузер
    // не засчитает клик (кнопка успеет замениться)
    renderPending = true;
    return;
  }
  renderHeader();
  renderRound();
  renderScoreboard();
  renderHistory();
  renderChat();
  renderStatus();
}

function paintAvatar() {
  const av = $('channel-avatar');
  const s = app.state;
  const name = s.demo ? 'Д' : s.channelName || s.channel || '?';
  av.style.backgroundImage = '';
  av.textContent = (name[0] || '?').toUpperCase();
  const url = s.avatarUrl;
  if (!url) return;
  const probe = new Image();
  probe.onload = () => {
    if (app.state && app.state.avatarUrl === url) {
      av.style.backgroundImage = `url("${url}")`;
      av.textContent = '';
    }
  };
  probe.src = url;
}

function renderHeader() {
  const s = app.state;
  $('channel-name').textContent = s.demo ? 'Демо-режим' : s.channelName || s.channel;
  $('channel-link').href = s.demo || s.channelById ? '#' : `https://w.tv/${s.channelName || s.channel}`;
  paintAvatar();
  renderChannelId();
  const fin = s.rounds.filter((r) => r.outcome);
  const players = scoreboard();
  const liveCount = liveVotes().length;
  $('stats-line').textContent =
    `${fin.length} ${plural(fin.length, 'раунд', 'раунда', 'раундов')} · ` +
    `${players.length} ${plural(players.length, 'участник', 'участника', 'участников')}` +
    (liveCount ? ` · сейчас голосуют ${liveCount}` : '');
}

function renderStatus() {
  const el = $('channel-status');
  const s = app.state;
  if (!s) return;
  const last = s.messages[s.messages.length - 1];
  const parts = [];
  if (s.demo) parts.push('демо-режим: сообщения придумываются');
  else if (app.errors >= 3) parts.push('связь с чатом пропала — продолжаю пробовать');
  else if (app.lastError) parts.push('обновляю чат с задержкой…');
  else parts.push(app.usedCache ? 'чат читается (данные канала из памяти)' : 'чат читается');
  const via = s.demo ? '' : proxyLabel(preferredProxyId());
  if (via && !app.lastError) parts.push(`через ${via}`);
  if (last?.ts) parts.push(`последнее сообщение ${timeOf(last.ts)}`);
  el.textContent = parts.join(' · ');
  el.classList.toggle('live', !app.lastError);
  if (app.errors === 4 && !s.demo) {
    toast('Публичный прокси занят. Подожди немного — сайт продолжит попытки сам.', true);
  }
}

function renderRound() {
  const card = $('round-card');
  const s = app.state;
  const round = openRound();
  const phase = roundPhase(round);
  const lastFinished = [...s.rounds].reverse().find((r) => r.outcome);
  card.classList.toggle('open', phase === 'voting');
  card.classList.toggle('awaiting', phase === 'awaiting');

  if (phase === 'voting' || phase === 'awaiting') {
    const votes = liveVotes();
    const w = votes.filter((v) => v.vote === 'win').length;
    const l = votes.filter((v) => v.vote === 'lose').length;
    const total = w + l;
    const pw = total ? (w / total) * 100 : 0;
    const badge =
      phase === 'voting'
        ? '<span class="badge live">приём голосов</span>'
        : '<span class="badge await">приём остановлен</span>';
    const sub =
      phase === 'voting'
        ? `с ${timeOf(round.openedAt)} · ${round.allowRevote ? 'можно переголосовать' : 'считается первое слово'} ·
           слова: ${esc(round.words.win.join(' / '))} и ${esc(round.words.lose.join(' / '))}`
        : `голоса приняты до ${timeOf(round.votesClosedAt)} · ${total} ${plural(total, 'голос', 'голоса', 'голосов')} ·
           теперь ждём конца матча и объявляем исход`;
    const controls =
      phase === 'voting'
        ? `<button class="btn primary" data-act="stop">⏸ Остановить приём голосов</button>
           <button class="btn" data-act="cancel">Отменить раунд</button>`
        : `<button class="btn win" data-act="finish" data-outcome="win">🏆 Была победа</button>
           <button class="btn lose" data-act="finish" data-outcome="lose">💀 Было поражение</button>
           <button class="btn" data-act="resume">↩ Возобновить приём голосов</button>
           <button class="btn" data-act="cancel">Отменить раунд</button>`;

    card.innerHTML = `
      <div class="round-top">
        <div>
          <div class="round-title">Раунд №${round.index} ${badge}</div>
          <div class="round-sub">${sub}</div>
        </div>
        <div class="vote-counts">
          <span class="w">${esc(round.words.win[0])} — ${w}</span>
          <span class="l">${esc(round.words.lose[0])} — ${l}</span>
        </div>
      </div>
      <div class="vote-bar">
        ${w ? `<div class="seg-win" style="width:${pw}%"></div>` : ''}
        ${l ? `<div class="seg-lose" style="width:${100 - pw}%"></div>` : ''}
        ${!total ? '<div class="seg-empty"></div>' : ''}
      </div>
      <div class="controls">${controls}</div>
      ${
        votes.length
          ? `<div class="voters">${votes
              .map((v) => `<span class="voter ${v.vote === 'win' ? 'w' : 'l'}">${esc(v.nickname)}</span>`)
              .join('')}</div>`
          : `<div class="empty">Пока никто не написал слово-голос в чат.</div>`
      }
    `;
  } else if (lastFinished) {
    const r = lastFinished;
    const guessed = (r.votes || []).filter((v) => v.vote === r.outcome);
    card.innerHTML = `
      <div class="round-top">
        <div>
          <div class="round-title">Раунд №${r.index}
            <span class="badge ${r.outcome}">${r.outcome === 'win' ? 'победа' : 'поражение'}</span>
          </div>
          <div class="round-sub">угадали ${guessed.length} из ${(r.votes || []).length} · очки начислены</div>
        </div>
        <button class="btn primary" data-act="start">▶ Начать новое голосование</button>
      </div>
      ${
        guessed.length
          ? `<div class="voters">${guessed
              .map((v) => `<span class="voter ${r.outcome === 'win' ? 'w' : 'l'}">+1 ${esc(v.nickname)}</span>`)
              .join('')}</div>`
          : '<div class="empty">В этом раунде никто не угадал.</div>'
      }
    `;
  } else {
    card.innerHTML = `
      <div class="round-top">
        <div>
          <div class="round-title">Всё готово к старту</div>
          <div class="round-sub">Нажми кнопку — и слова из чата начнут считаться с этой секунды.</div>
        </div>
        <button class="btn primary" data-act="start">▶ Начать голосование</button>
      </div>`;
  }
}

function renderScoreboard() {
  const rows = scoreboard();
  const el = $('scoreboard');
  if (!rows.length) {
    el.innerHTML = `<div class="empty">
      Пока никого нет. Участники появляются здесь, как только напишут слово-голос в чат.
    </div>`;
    return;
  }
  el.innerHTML = rows
    .map((p, i) => {
      const place = i + 1;
      const cls = place <= 3 ? ` top${place}` : '';
      const streak = p.streak >= 2 ? ` · 🔥 ${p.streak} подряд` : '';
      const manual = p.adjust ? ` · правка ${p.adjust > 0 ? '+' : ''}${p.adjust}` : '';
      const cur = p.currentVote
        ? ` · <span class="${p.currentVote === 'win' ? 'win' : 'lose'}">сейчас ${esc((p.currentVote === 'win' ? words().win[0] : words().lose[0]) || p.currentVote)}</span>`
        : '';
      return `<div class="sb-row${cls}" data-user="${esc(p.userId)}">
        <div class="sb-place">${place}</div>
        <div class="sb-name">
          ${isDemo() || p.userId.startsWith('manual-') ? esc(p.nickname) : `<a href="https://w.tv/${encodeURIComponent(p.nickname)}" target="_blank" rel="noopener">${esc(p.nickname)}</a>`}
          <div class="sb-sub">угадал ${p.guessed} из ${p.voted}${streak}${manual}${cur}</div>
        </div>
        <button class="sb-points" data-points="${esc(p.userId)}" title="Нажми, чтобы поставить точное число">${p.points}<small>очк.</small></button>
        <div class="sb-edit">
          <button data-minus="${esc(p.userId)}" title="−1 очко">−</button>
          <button data-plus="${esc(p.userId)}" title="+1 очко">+</button>
        </div>
      </div>`;
    })
    .join('');
}

function renderHistory() {
  const rounds = [...(app.state.rounds || [])].reverse();
  const el = $('history');
  if (!rounds.length) {
    el.innerHTML = `<div class="empty">История пуста — здесь появятся завершённые раунды.</div>`;
    return;
  }
  const current = openRound();
  el.innerHTML = rounds
    .map((r) => {
      const phase = roundPhase(r);
      const votes = phase === 'voting' && r === current && !r.outcome ? liveVotes() : r.votes || [];
      const w = votes.filter((v) => v.vote === 'win').length;
      const l = votes.filter((v) => v.vote === 'lose').length;
      const total = votes.length;
      let badge;
      if (phase === 'finished') {
        badge = `<span class="badge ${r.outcome}">${r.outcome === 'win' ? 'победа' : 'поражение'}</span>`;
      } else if (phase === 'awaiting') {
        badge = '<span class="badge await">приём остановлен</span>';
      } else {
        badge = '<span class="badge live">идёт</span>';
      }
      // полоса: у завершённого раунда — доля угадавших, у открытого — распределение голосов
      let greenPart;
      let redPart;
      let numbers;
      let hint;
      if (phase === 'finished') {
        const guessed = votes.filter((v) => v.vote === r.outcome).length;
        greenPart = guessed;
        redPart = total - guessed;
        numbers = `${guessed}/${total}`;
        hint = `угадали ${guessed} из ${total}`;
      } else {
        greenPart = w;
        redPart = l;
        numbers = `${w}/${l}`;
        hint = `за победу ${w} · за поражение ${l}`;
      }
      const scale = total || 1;
      return `<div class="hist-row">
        <div class="idx">№${r.index}</div>
        <div>${badge}</div>
        <div class="hist-bar" title="${hint}">
          ${greenPart ? `<i style="width:${(greenPart / scale) * 100}%;background:var(--win)"></i>` : ''}
          ${redPart ? `<i style="width:${(redPart / scale) * 100}%;background:var(--lose)"></i>` : ''}
        </div>
        <div class="hist-nums" title="${hint}">${numbers} · ${total}</div>
      </div>`;
    })
    .join('');
}

function renderChat() {
  const el = $('chat');
  const s = app.state;
  const messages = (s.messages || []).slice(-90);
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  const round = openRound();
  const phase = roundPhase(round);

  // какие сообщения учтены в текущем раунде (для открытого — до текущей секунды)
  const counted = new Map();
  if (round) {
    const cutoff = votesEnd(round);
    const byUser = new Map();
    for (const m of s.messages) {
      if (m.ts < round.openedAt) continue;
      if (cutoff && m.ts > cutoff) continue;
      if ((m.tags || []).includes('TAG_OWNER')) continue;
      const vote = detectVote(m.content, round.words);
      if (!vote) continue;
      byUser.set(m.userId, { id: m.id, vote });
    }
    for (const [userId, last] of byUser) {
      if (round.allowRevote) {
        counted.set(last.id, last.vote);
      } else {
        for (const m of s.messages) {
          if (m.userId !== userId || m.ts < round.openedAt) continue;
          if (cutoff && m.ts > cutoff) continue;
          const vote = detectVote(m.content, round.words);
          if (vote) {
            counted.set(m.id, vote);
            break;
          }
        }
      }
    }
  }

  el.innerHTML = messages
    .map((m) => {
      const isOwner = (m.tags || []).includes('TAG_OWNER');
      const vote = detectVote(m.content, round?.words || words());
      const countedVote = counted.get(m.id);
      let cls = 'msg';
      let tag = '';
      if (countedVote) {
        cls += countedVote === 'win' ? ' vote-win' : ' vote-lose';
        tag = '<span class="tag counted">учтён</span>';
      } else if (vote && phase !== 'none' && !isOwner && m.ts >= round.openedAt && !(votesEnd(round) && m.ts > votesEnd(round))) {
        cls += ' vote-ignored';
        tag = '<span class="tag ignored">не учтён</span>';
      }
      return `<div class="${cls}">
        <div><span class="nick" style="color:${colorFor(m.nickname)}">${esc(m.nickname)}</span><span class="txt">${esc(m.content)}</span>${tag}${isOwner ? '<span class="tag owner">стример</span>' : ''}</div>
        <div class="time">${timeOf(m.ts)}</div>
      </div>`;
    })
    .join('');

  if (nearBottom) el.scrollTop = el.scrollHeight;
  $('chat-status').textContent = s.messages.length ? `${s.messages.length} сообщений в памяти` : 'ждём сообщения…';
}

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
function syncSettingsInputs() {
  const s = app.state;
  renderProxyStatus();
  renderChannelId();
  renderProxyChoices();
  const own = proxyOf(s);
  if ($('proxy-input')) $('proxy-input').value = own;
  if ($('landing-proxy-input')) $('landing-proxy-input').value = own;
  $('words-win').value = wordsToText(words().win);
  $('words-lose').value = wordsToText(words().lose);
  $('revote-toggle').checked = !!s.settings.allowRevote;
  $('proxy-input').value = s.settings.proxy || '';
  $('poll-input').value = s.settings.pollSeconds || 5;
  updateWordsHint();
}

function updateWordsHint() {
  const w = words();
  $('words-hint').innerHTML =
    `Голосом считается сообщение целиком: <b>${esc(w.win[0] || 'win')}</b>, <b>${esc((w.win[0] || 'win').toUpperCase())}!</b>, ` +
    `<b>:KEKwAIT: ${esc(w.lose[0] || 'lose')}</b>. Фраза «я за ${esc(w.win[0] || 'win')}» голосом не считается. ` +
    `Можно перечислить несколько вариантов через запятую. ` +
    `Голосом может быть и символ, и эмодзи: <b>+</b>, <b>🔥</b>, <b>!</b> — повтор подряд (<b>+++</b>) считается тем же голосом.`;
}

function applyWordsFromInputs() {
  const win = parseWords($('words-win').value);
  const lose = parseWords($('words-lose').value);
  const current = words();
  const same =
    win.length === current.win.length && lose.length === current.lose.length &&
    win.every((w, i) => w === current.win[i]) && lose.every((w, i) => w === current.lose[i]);
  if (same) return; // ничего не поменялось — нечего перерисовывать
  if (!win.length || !lose.length) {
    toast('В каждом поле нужен хотя бы один голос — слово, символ или эмодзи', true);
    syncSettingsInputs();
    return;
  }
  const overlap = win.filter((w) => lose.includes(w));
  if (overlap.length) {
    toast(`Слово «${overlap[0]}» не может быть сразу за победу и за поражение`, true);
    syncSettingsInputs();
    return;
  }
  app.state.settings.words = { win, lose };
  const round = openRound();
  if (round) round.words = { win: [...win], lose: [...lose] }; // применяем к текущему раунду
  persist();
  // показываем в полях то, что реально будет использоваться
  // (":Победа!" -> "победа", лишние пробелы и повторы убираются)
  $('words-win').value = wordsToText(win);
  $('words-lose').value = wordsToText(lose);
  updateWordsHint();
  render();
  toast('Слова сохранены');
}

// ---------------------------------------------------------------------------
// Экспорт итоговой таблицы: Excel / CSV / TXT / в буфер обмена
// ---------------------------------------------------------------------------
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportData(kind) {
  const s = app.state;
  const scores = scoreboard();
  const sortedRounds = [...s.rounds].sort((a, b) => a.index - b.index);
  const leaders = exportLeadersRows(scores);
  const rounds = exportRoundsRows(sortedRounds, words());
  const channel = s.channelName || s.channel || 'канал';
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `w-vote-${channel}-${stamp}`;
  const finished = sortedRounds.filter((r) => r.outcome);
  const guessedAll = scores.reduce((sum, p) => sum + p.guessed, 0);

  const txtHeader = [
    ['Канал', channel],
    ['Дата выгрузки', new Date().toLocaleString('ru-RU')],
    ['Проведено раундов', finished.length],
    ['Участников', scores.length],
    ['Всего угаданных исходов', guessedAll],
    ['Слова-голоса', `${words().win.join('/')} и ${words().lose.join('/')}`],
  ];

  if (kind === 'xlsx') {
    const bytes = makeXlsx([
      { name: 'Лидеры', rows: leaders },
      { name: 'Раунды', rows: rounds },
      { name: 'Сводка', rows: txtHeader },
    ]);
    downloadBlob(
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `${base}.xlsx`
    );
    toast('Таблица сохранена в Excel (.xlsx)');
    return;
  }
  if (kind === 'csv') {
    downloadBlob(new Blob([makeCsv(leaders)], { type: 'text/csv;charset=utf-8' }), `${base}.csv`);
    toast('Таблица сохранена в CSV — открывается в Excel и Google Таблицах');
    return;
  }
  const text = makeTxt([
    { title: `Голосование в чате — ${channel}`, rows: txtHeader },
    { title: 'Таблица лидеров', rows: leaders },
    { title: 'Раунды', rows: rounds },
  ]);
  if (kind === 'copy') {
    navigator.clipboard
      .writeText(text)
      .then(() => toast('Таблица скопирована — можно вставить в чат или заметки'))
      .catch(() => toast('Браузер не дал доступ к буферу обмена', true));
    return;
  }
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
  toast('Таблица сохранена в текстовом файле (.txt)');
}

// ---------------------------------------------------------------------------
// Резервная копия
// ---------------------------------------------------------------------------
function exportBackup() {
  const payload = { exportedAt: new Date().toISOString(), channel: app.channel, state: app.state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `w-vote-${app.channel}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const incoming = data.state || data;
    if (!incoming || !Array.isArray(incoming.rounds)) throw new Error('не похоже на резервную копию');
    if (!confirm('Заменить текущие очки, раунды и настройки данными из файла?')) return;
    app.state.rounds = incoming.rounds || [];
    app.state.adjust = incoming.adjust || {};
    app.state.extraPlayers = incoming.extraPlayers || [];
    app.state.settings = { ...app.state.settings, ...(incoming.settings || {}) };
    app.state.messages = incoming.messages || app.state.messages;
    persist();
    syncSettingsInputs();
    render();
    toast('Копия загружена');
  } catch (err) {
    toast(`Не получилось загрузить файл: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Всплывающие сообщения
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3600);
}

// ---------------------------------------------------------------------------
// Диагностика связи: понятный текст ошибки + отчёт по каждому посреднику
// ---------------------------------------------------------------------------
function proxyLabel(id) {
  if (!id) return '';
  const found = proxyStatus(proxyOf(app.state)).find((p) => p.id === id);
  return found ? found.label : '';
}

/** человеческое объяснение, почему не подключилось */
function networkHint(err) {
  const details = (err && err.details) || [];
  const text = details.join(' ; ');
  const blocked = /HTTP 403|отклонил|отклонён|недоступен|Failed to fetch/i.test(text);
  const slow = /не ответил|слишком медленно|timeout/i.test(text);
  if (blocked && slow) {
    return 'Часть посредников не пускает, часть не успела ответить. Чаще всего помогает VPN: включи его и нажми «Повторить».';
  }
  if (blocked) {
    return 'Похоже, твоя сеть (или провайдер) не пропускает запросы к посредникам. Включи VPN и нажми «Повторить» — либо подними свой прокси, это 2 минуты.';
  }
  if (slow) {
    return 'Посредники не успели ответить за 12 секунд. Нажми «Повторить» — или включи VPN: с ним посредники обычно отвечают быстрее.';
  }
  return 'Публичные посредники сейчас перегружены — это не ошибка в ссылке. Нажми «Повторить»: обычно помогает со второй попытки.';
}

function probeResultsHtml(results) {
  return results
    .map(
      (r) =>
        `<div>${r.ok ? '<span class="win">✓</span>' : '<span class="lose">✗</span>'} ${esc(r.label)} — ${r.ms} мс${
          r.noNick ? ' <span class="muted small">(канал связи ок)</span>' : ''
        }${r.ok ? '' : ` <span class="muted small">(${esc(r.error)})</span>`}</div>`
    )
    .join('');
}

/** проверяем все способы связи и рисуем отчёт в указанный блок */
async function probeInto(container, nick) {
  if (!container) return [];
  container.hidden = false;
  container.innerHTML = '<div class="muted small">Проверяю посредников — это занимает до 12 секунд…</div>';
  clearProxyHealth(); // начинаем с чистого листа, иначе «пауза» искажает картину
  const name = normalizeChannelInput(nick || app.state?.channel || '');
  const url = `${window.WVote.PROFILES_API}/profiles/by-nickname/${encodeURIComponent(
    name || 'w'
  )}?user_lang=ru&platform=web`;
  let results = [];
  try {
    results = await probeProxies(url, proxyOf(app.state));
  } catch (err) {
    container.innerHTML = `<div class="muted small">Проверка не удалась: ${esc(String(err && err.message))}</div>`;
    return results;
  }
  const anyOk = results.some((r) => r.ok);
  container.innerHTML =
    probeResultsHtml(results) +
    (anyOk
      ? '<div class="muted small" style="margin-top:6px">Связь есть — жми «Повторить», чат должен подтянуться.</div>'
      : '<div class="muted small" style="margin-top:6px">Ни один посредник не ответил с твоего подключения. Поможет VPN или свой прокси — инструкция в блоке «Что делать?».</div>');
  renderProxyStatus();
  renderProxyChoices();
  return results;
}

// ---------------------------------------------------------------------------
// События интерфейса
// ---------------------------------------------------------------------------
async function submitChannel(inputValue, options = {}) {
  const errEl = $('landing-error');
  const btn = $('channel-form').querySelector('button');
  errEl.hidden = true;
  btn.disabled = true;
  const restore = btn.textContent;
  btn.textContent = 'Подключаюсь…';
  $('proxy-hint-line').hidden = true;
  try {
    await connect(inputValue, options);
    return true;
  } catch (err) {
    if (options.silent) return false; // тихая попытка автоподключения — ошибку покажет следующая
    const name = normalizeChannelInput(inputValue);
    if (err.code === 'channel_not_found') {
      errEl.innerHTML = `Канал «${esc(name)}» не найден на w.tv. Проверь ник — он виден в адресе канала.`;
    } else if (err.code === 'empty') {
      errEl.innerHTML = 'Введи ник или ссылку на канал.';
    } else {
      errEl.innerHTML = `
        <b>Не удалось получить данные канала.</b>
        <div class="small" style="margin-top:6px">${esc(networkHint(err))}</div>
        <div class="row" style="margin-top:10px">
          <button type="button" id="retry-connect" class="ghost-btn">Повторить</button>
          <button type="button" id="probe-connect" class="ghost-btn">Проверить связь</button>
          <button type="button" id="toggle-proxy-help" class="ghost-btn">Что делать, если не помогает?</button>
        </div>
        <div id="connect-probe" class="probe-result" hidden></div>
        <details class="small" style="margin-top:10px">
          <summary class="muted">Подробности для диагностики</summary>
          <div class="muted small" style="margin-top:6px;word-break:break-word">${
            (err.details && err.details.length
              ? err.details
              : [String(err.message || err)]
            )
              .slice(0, 8)
              .map((line) => esc(String(line).slice(0, 200)))
              .join('<br>')
          }</div>
          <div class="muted small">Страница: ${esc(location.origin || 'файл')} · ${esc(new Date().toLocaleString('ru-RU'))}</div>
        </details>`;
      errEl.hidden = false;
      // «Повторить» сбрасывает статистику сбоев: иначе все способы могут
      // оказаться в «паузе» и попытка закончится, даже не начавшись
      const retry = $('retry-connect');
      if (retry) retry.addEventListener('click', () => {
        clearProxyHealth();
        submitChannel(inputValue);
      });
      const probeBtn = $('probe-connect');
      if (probeBtn) probeBtn.addEventListener('click', async () => {
        probeBtn.disabled = true;
        probeBtn.textContent = 'проверяю…';
        await probeInto($('connect-probe'), name);
        probeBtn.disabled = false;
        probeBtn.textContent = 'Проверить связь';
      });
      const toggle = $('toggle-proxy-help');
      if (toggle) toggle.addEventListener('click', () => {
        const help = $('proxy-help');
        const show = help.hidden;
        help.hidden = !show;
        help.open = show;
        $('proxy-hint-line').hidden = !show;
        if (show) help.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      $('proxy-hint-line').hidden = false;
    }
    errEl.hidden = false;
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = restore;
  }
}

// страница подключения: свой прокси и проверка связи доступны до подключения канала
$('landing-proxy-input').addEventListener('change', (e) => applyProxyInput(e.target.value));

$('landing-probe-btn').addEventListener('click', async () => {
  const btn = $('landing-probe-btn');
  applyProxyInput($('landing-proxy-input').value);
  btn.disabled = true;
  const restore = btn.textContent;
  btn.textContent = 'проверяю…';
  await probeInto($('landing-probe-result'), normalizeChannelInput($('channel-input').value) || 'w');
  btn.disabled = false;
  btn.textContent = restore;
});

$('channel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await submitChannel($('channel-input').value);
});

// копирование ID канала (запасной способ подключения)
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy-id]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copyId);
    toast('ID канала скопирован');
  } catch {
    toast('Браузер не дал доступ к буферу — скопируй вручную', true);
  }
});

// копирование кода своего прокси
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy-proxy]');
  if (!btn) return;
  const code = $('proxy-worker-code').textContent.trim();
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = 'Код скопирован ✓';
  } catch {
    toast('Браузер не дал доступ к буферу — выдели код вручную', true);
  }
  setTimeout(() => (btn.textContent = 'Скопировать код прокси'), 2500);
});

$('round-card').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'start') startRound();
  if (btn.dataset.act === 'stop') stopVoting();
  if (btn.dataset.act === 'resume') resumeVoting();
  if (btn.dataset.act === 'finish') finishRound(btn.dataset.outcome);
  if (btn.dataset.act === 'cancel') cancelRound();
});

$('scoreboard').addEventListener('click', (e) => {
  const minus = e.target.closest('[data-minus]');
  const plus = e.target.closest('[data-plus]');
  const points = e.target.closest('[data-points]');
  if (minus) {
    const id = minus.dataset.minus;
    const p = scoreboard().find((x) => x.userId === id);
    setPoints(id, p.points - 1);
  } else if (plus) {
    const id = plus.dataset.plus;
    const p = scoreboard().find((x) => x.userId === id);
    setPoints(id, p.points + 1);
  } else if (points) {
    const id = points.dataset.points;
    const p = scoreboard().find((x) => x.userId === id);
    const answer = prompt(`Сколько очков поставить «${p.nickname}»?`, String(p.points));
    if (answer !== null) setPoints(id, answer);
  }
});

$('add-player').addEventListener('click', addPlayerManually);

$('clear-history').addEventListener('click', () => {
  if (!app.state.rounds.length) return toast('История и так пустая');
  if (!confirm('Удалить всю историю раундов? Очки, начисленные вручную, тоже обнулятся.')) return;
  app.state.rounds = [];
  app.state.adjust = {};
  persist();
  render();
});

// применяем, как только пользователь перестал печатать (и на потерю фокуса)
let wordsTimer = null;
const scheduleWords = () => {
  clearTimeout(wordsTimer);
  wordsTimer = setTimeout(applyWordsFromInputs, 600);
};
['words-win', 'words-lose'].forEach((id) => {
  $(id).addEventListener('input', scheduleWords);
  $(id).addEventListener('change', () => {
    clearTimeout(wordsTimer);
    applyWordsFromInputs();
  });
});

$('revote-toggle').addEventListener('change', (e) => {
  app.state.settings.allowRevote = e.target.checked;
  const round = openRound();
  if (round) round.allowRevote = e.target.checked;
  persist();
  render();
  toast(
    e.target.checked
      ? 'Переголосование включено: считается последнее слово зрителя'
      : 'Включён подсчёт по первому слову зрителя'
  );
});

/** ID канала нужен как запасной путь подключения (когда сервис профилей недоступен) */
function renderChannelId() {
  const el = $('channel-id-line');
  if (!el || !app.state) return;
  const id = app.state.channelUserId;
  if (!id || isDemo()) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    `ID канала: <code>${esc(id)}</code> ` +
    `<button type="button" class="link-btn" data-copy-id="${esc(id)}">копировать</button> ` +
    `<span class="muted">— с ним сайт подключается, даже если сервис профилей не отвечает</span>`;
}

/**
 * Галочки «какие способы связи использовать». Один и тот же список рисуется
 * и на странице подключения, и в настройках канала: настройки общие для браузера.
 */
function renderProxyChoices() {
  const own = proxyOf(app.state);
  const list = proxyStatusOf(own);
  const html = list
    .map(
      (p) =>
        `<label class="choice${p.enabled ? '' : ' off'}" title="${esc(p.label)}">` +
        `<input type="checkbox" data-proxy-id="${esc(p.id)}"${p.enabled ? ' checked' : ''}> ` +
        `<span>${esc(p.label)}</span>` +
        (p.cooling ? '<span class="muted small"> · пауза</span>' : '') +
        (p.preferred && p.enabled ? '<span class="win small"> · работает</span>' : '') +
        (p.id === 'direct' ? '<span class="muted small"> · без посредника, обычно блокируется CORS</span>' : '') +
        '</label>'
    )
    .join('');
  const enabledCount = list.filter((p) => p.enabled).length;
  const note =
    enabledCount === 0
      ? '<div class="lose small" style="margin-top:6px">Все способы выключены — включи хотя бы один, иначе чат читать нечем.</div>'
      : '';
  document.querySelectorAll('[data-proxy-choices]').forEach((el) => {
    el.innerHTML = html + note;
  });
}

/** полный сброс: как будто сайт открыли впервые */
function resetAll() {
  if (
    !confirm(
      'Стереть ВСЁ: каналы, очки, раунды, настройки связи, кэш канала и запомненных посредников?\n' +
        'Сайт станет как при первом заходе. Отменить будет нельзя.'
    )
  )
    return;
  resetEverything();
  // чистим адрес от ?c=, ?proxy=, ?demo= — иначе сайт сразу попробует подключиться заново
  try {
    const url = new URL(location.href);
    url.searchParams.delete('c');
    url.searchParams.delete('proxy');
    url.searchParams.delete('demo');
    history.replaceState(null, '', url.pathname + url.search);
  } catch {}
  app.errors = 0;
  app.lastError = '';
  app.usedCache = false;
  app.refreshedProfile = false;
  showLanding(); // останавливает опрос и показывает экран подключения
  $('landing-error').hidden = true;
  $('proxy-help').hidden = true;
  $('proxy-hint-line').hidden = true;
  $('landing-proxy-input').value = '';
  $('proxy-input').value = '';
  $('landing-probe-result').hidden = true;
  renderProxyStatus();
  renderProxyChoices();
  toast('Всё стёрто — сайт как при первом заходе');
}

function renderProxyStatus() {
  const el = $('proxy-state');
  if (!el) return;
  const list = proxyStatus(proxyOf(app.state));
  const via = proxyLabel(preferredProxyId());
  const own = proxyOf(app.state);
  el.innerHTML =
    (via ? `Сейчас работает: <span class="win">${esc(via)}</span><br>` : '') +
    (own
      ? `<span class="muted">Свой посредник: настроен${proxyFromUrl() ? ' (из ссылки)' : ''}</span><br>`
      : '') +
    'Способы связи: ' +
    list
      .map(
        (p) =>
          `<span class="${p.cooling ? 'lose' : p.preferred ? 'win' : ''}">${esc(p.label)}${
            p.cooling ? ' (пауза)' : ''
          }</span>`
      )
      .join(' · ') +
    ' · <button type="button" id="probe-btn" class="link-btn">проверить связь</button>' +
    ' · <button type="button" id="net-reset-btn" class="link-btn">сбросить выбор</button>' +
    (own ? ' · <button type="button" id="share-btn" class="link-btn">ссылка для зрителей</button>' : '');
  const share = $('share-btn');
  if (share) share.addEventListener('click', () => {
    const url = new URL(location.href);
    if (app.state?.channel) url.searchParams.set('c', app.state.channel);
    url.searchParams.set('proxy', own);
    const link = url.toString();
    navigator.clipboard
      .writeText(link)
      .then(() => toast('Ссылка скопирована — по ней твой посредник подхватится у зрителей сам'))
      .catch(() => toast('Браузер не дал доступ к буферу — скопируй адрес из строки браузера', true));
  });
  const btn = $('probe-btn');
  if (btn) btn.addEventListener('click', runProbe);
  const reset = $('net-reset-btn');
  if (reset) reset.addEventListener('click', () => {
    clearProxyHealth();
    renderProxyStatus();
    toast('Связь будет проверена заново, со всех способов сразу');
    pollNow();
  });
}

async function runProbe() {
  const btn = $('probe-btn');
  const out = $('probe-result');
  if (!app.state || !btn) return;
  btn.disabled = true;
  btn.textContent = 'проверяю…';
  out.hidden = false;
  await probeInto(out, app.state.channel);
  btn.disabled = false;
  btn.textContent = 'проверить связь';
}

/**
 * Поле «свой прокси»: значение общее для браузера (страница входа и панель
 * показывают одно и то же). В настройках канала дублируем — для старых данных.
 */
function applyProxyInput(value) {
  const clean = String(value || '').trim();
  if (clean === proxyOf(app.state)) return;
  setGlobalProxy(clean);
  if (app.state) {
    app.state.settings.proxy = clean;
    persist();
  }
  resetProxyOrder();
  clearProxyHealth();
  // поля на странице входа и в панели показывают одно и то же значение
  for (const id of ['proxy-input', 'landing-proxy-input']) {
    const field = $(id);
    if (field && field !== document.activeElement) field.value = clean;
  }
  renderProxyStatus();
  renderProxyChoices();
  toast(clean ? 'Свой прокси сохранён' : 'Использую публичные посредники');
}

$('proxy-input').addEventListener('change', (e) => applyProxyInput(e.target.value));

// галочки посредников (общий обработчик: список рисуется в двух местах)
document.addEventListener('change', (e) => {
  const box = e.target.closest('input[data-proxy-id]');
  if (!box) return;
  const id = box.dataset.proxyId;
  const label = (proxyStatusOf(proxyOf(app.state)).find((p) => p.id === id) || {}).label || id;
  setProxyEnabled(id, box.checked);
  resetProxyOrder();
  renderProxyChoices();
  renderProxyStatus();
  toast(box.checked ? `«${label}» включён` : `«${label}» выключен`);
  if (box.checked && app.state) pollNow();
});

// кнопки «Сбросить всё» (страница входа и настройки канала)
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-reset-everything]')) resetAll();
});

$('poll-input').addEventListener('change', (e) => {
  const seconds = Math.max(3, Math.min(30, Number(e.target.value) || 5));
  if (seconds === app.state.settings.pollSeconds) return;
  app.state.settings.pollSeconds = seconds;
  e.target.value = seconds;
  persist();
  startPolling();
  toast(`Чат будет проверяться каждые ${seconds} с`);
});

$('export-xlsx').addEventListener('click', () => exportData('xlsx'));
$('export-csv').addEventListener('click', () => exportData('csv'));
$('export-txt').addEventListener('click', () => exportData('txt'));
$('export-copy').addEventListener('click', () => exportData('copy'));

$('export-btn').addEventListener('click', exportBackup);
$('import-btn').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importBackup(file);
  e.target.value = '';
});

$('reset-all').addEventListener('click', () => {
  if (!confirm('Стереть все раунды, очки и настройки этого канала? Отменить будет нельзя.')) return;
  const keepChannel = app.channel;
  const keepName = app.state.channelName;
  app.state = emptyState();
  app.state.channel = keepChannel;
  app.state.channelName = keepName;
  persist();
  syncSettingsInputs();
  render();
  toast('Всё сброшено');
});

$('change-channel').addEventListener('click', showLanding);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && app.state && !isDemo()) pollNow();
});

window.addEventListener('beforeunload', () => persist());

// ---------------------------------------------------------------------------
// Старт
// ---------------------------------------------------------------------------
(function boot() {
  // настройки связи (посредники, свой прокси, сброс) нужны ещё до подключения канала
  $('landing-proxy-input').value = proxyOf(null);
  renderProxyChoices();

  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('c');
  const last = localStorage.getItem(LAST_CHANNEL_KEY);

  // скрытый демо-режим для проверки интерфейса: index.html?demo=1
  if (params.get('demo') === '1') {
    connectDemo();
    return;
  }

  if (fromUrl) {
    $('channel-input').value = fromUrl;
    // автоподключение по ссылке: пробуем несколько раз, прежде чем показать ошибку
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        clearProxyHealth(); // каждая попытка — с чистого листа, без «пауз»
        const ok = await submitChannel(fromUrl, { silent: attempt === 0 });
        if (ok) return;
        await new Promise((r) => setTimeout(r, 800));
      }
    })();
    return;
  }
  if (last === 'demo') {
    connectDemo();
    return;
  }
  if (last) {
    $('channel-input').value = `https://w.tv/${last}`;
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        clearProxyHealth();
        const ok = await submitChannel(`https://w.tv/${last}`, { silent: attempt === 0 });
        if (ok) return;
        await new Promise((r) => setTimeout(r, 800));
      }
    })();
    return;
  }
  $('channel-input').focus();
})();

})();
