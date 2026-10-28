// ===========================================================================
//  app.js — интерфейс. Данные живут только в этом браузере (localStorage).
// ===========================================================================
(function () {
'use strict';
const {
  STORAGE_KEY, colorFor, computeScores, countByOption, dateTimeOf, defaultPollOptions,
  emptyState, esc, exportLeadersRows, exportRoundsRows, fetchAvatar, fetchMessages, fetchProfile,
  formatDuration, loadState, makeCsv, makeTxt, makeXlsx, modeLabel, normalizeChannelInput,
  migrateRound, normalizeMode, normalizePollOptions, normalizeSettings, parseWords, pickWinner, plural,
  probeProxies, proxyStatus, resetProxyOrder, roundEntryWords, roundMode, roundOptions, roundPhase,
  roundDeadline, roundTimeLeft, roundTimerSeconds, saveState, tallyVotes, timeOf, uid, voteKeyFor, votesEnd,
  wordsToText, clampTimerSeconds, clearProxyHealth, looksLikeUserId, preferredProxyId,
  globalProxy, setGlobalProxy, proxyStatus: proxyStatusOf, setProxyEnabled, resetEverything,
  MAX_POLL_OPTIONS, pollLeader, clampPoints, roundPoints,
} = window.WVote;

const $ = (id) => document.getElementById(id);
const LAST_CHANNEL_KEY = 'wtv_vote_last_channel';
const MAX_MESSAGES = 800; // сколько сообщений чата запоминаем в браузере

// Цвета вариантов опроса. Первые шесть — «фирменные», дальше подбираем
// оттенок по золотому углу, чтобы 100 вариантов тоже различались.
const POLL_COLORS = ['#5b9dff', '#ffb454', '#b98cff', '#4fd1c5', '#ff8fa3', '#9fd356'];
function pollColor(index) {
  const i = Math.max(0, Number(index) || 0);
  if (i < POLL_COLORS.length) return POLL_COLORS[i];
  const hue = Math.round(((i - POLL_COLORS.length) * 137.508 + 18) % 360);
  return `hsl(${hue} 70% 63%)`;
}
const MODE_INFO = {
  poll: 'Опрос',
  roll: 'Рулетка',
  classic: 'Победа / поражение', // только у раундов, сделанных до обновления
};
const MODE_DESC = {
  poll: 'свои варианты, очки — угадавшим',
  roll: 'случайный ник из написавших слово',
  classic: 'прежний режим — остался только в истории',
};

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
// «текущий» раунд — ещё не завершённый (идёт приём или ждём итог)
const openRound = () => (app.state.rounds || []).find((r) => roundPhase(r) !== 'finished') || null;
const lastFinished = () => [...(app.state.rounds || [])].reverse().find((r) => roundPhase(r) === 'finished') || null;
const votingRound = () => {
  const r = openRound();
  return r && roundPhase(r) === 'voting' ? r : null;
};
const awaitingRound = () => {
  const r = openRound();
  return r && roundPhase(r) === 'awaiting' ? r : null;
};
const settingsMode = () => normalizeMode(app.state?.settings?.mode);
const pointsPerWin = () => clampPoints(app.state?.settings?.pointsPerWin);
const pollAutoWinner = () => !!app.state?.settings?.pollAutoWinner;
const pollOptions = () =>
  app.state?.settings?.pollOptions?.length ? app.state.settings.pollOptions : defaultPollOptions();
const rollWords = () => (app.state?.settings?.rollWords?.length ? app.state.settings.rollWords : ['+']);

/** цвет варианта: у старой классики — зелёный/красный, у опроса — из палитры */
function optionColor(round, key) {
  if (round && roundMode(round) === 'classic') return key === 'lose' ? 'var(--lose)' : 'var(--win)';
  const index = round ? roundOptions(round).findIndex((o) => o.key === key) : -1;
  return pollColor(index < 0 ? 0 : index);
}

/** первые варианты списком: «да · нет · … и ещё 94» — чтобы 100 не растягивали карточку */
function optionsSummary(round, limit = 6) {
  const options = roundOptions(round);
  const labels = options.slice(0, limit).map((o) => o.label);
  const rest = options.length - labels.length;
  return labels.join(' · ') + (rest > 0 ? ` · и ещё ${rest}` : '');
}

/** подпись варианта по ключу (для истории, чата и таблицы) */
function optionLabel(round, key) {
  const found = roundOptions(round).find((o) => o.key === key);
  return found ? found.label : String(key || '');
}

/** снимок настроек для демо-сообщений, когда раунда ещё нет */
function demoRoundConfig() {
  const round = openRound();
  if (round) return round;
  const mode = settingsMode();
  if (mode === 'roll') return { mode, entryWords: rollWords() };
  return { mode: 'poll', options: pollOptions() };
}

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
      content: Math.random() < 0.6 ? randomVoteText() : randomOf(DEMO_CHATTER),
    });
  }
}

/** случайное «правильное» сообщение под текущий режим — для демо */
function randomVoteText() {
  const config = demoRoundConfig();
  const mode = roundMode(config);
  if (mode === 'roll') return randomOf(roundEntryWords(config));
  const options = roundOptions(config);
  if (!options.length) return randomOf(DEMO_CHATTER);
  const word = randomOf(randomOf(options).words);
  // в демо специально мешаем разные записи, включая формат :слово:
  return randomOf([word, word, word.toUpperCase(), `${word}!`, `:${word}:`]);
}

function demoTick() {
  // в демо-режиме накидываем несколько сообщений за раз — так нагляднее
  const count = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const nick = randomOf(DEMO_NICKS);
    const content = Math.random() < 0.7 ? randomVoteText() : randomOf(DEMO_CHATTER);
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
/** «Новый раунд»: только готовим раунд, приём начнётся по кнопке */
function newRound() {
  const s = app.state;
  if (openRound()) return toast('Сначала заверши текущий раунд', true);
  const index = s.rounds.reduce((max, r) => Math.max(max, r.index || 0), 0) + 1;
  const settings = s.settings;
  const mode = settingsMode();
  s.rounds.push({
    id: uid(),
    index,
    mode,
    createdAt: new Date().toISOString(),
    openedAt: null, // появится, когда нажмут «Начать приём»
    timerSeconds: settings.timerEnabled ? clampTimerSeconds(settings.timerSeconds) : 0,
    timerStartedAt: null,
    votesClosedAt: null,
    outcome: null,
    decidedAt: null,
    allowRevote: !!settings.allowRevote,
    points: clampPoints(settings.pointsPerWin),
    autoWinner: mode === 'poll' && !!settings.pollAutoWinner,
    options:
      mode === 'poll'
        ? pollOptions().map((o) => ({ key: o.key, label: o.label, words: [...o.words] }))
        : [],
    entryWords: mode === 'roll' ? [...rollWords()] : [],
    awardWinner: settings.rollAward !== false,
    winner: null,
    votes: [],
    ownerUserId: s.channelUserId,
  });
  persist();
  render();
  toast(
    `Раунд №${index} готов (${MODE_INFO[mode].toLowerCase()}). Нажми «Начать приём ${
      mode === 'roll' ? 'участия' : 'голосов'
    }»`
  );
}

/** настройки поменялись, пока раунд ждал старта — переносим их в раунд */
function syncReadyRound() {
  const round = openRound();
  if (!round || roundPhase(round) !== 'ready') return;
  const s = app.state.settings;
  const mode = settingsMode();
  round.mode = mode;
  round.allowRevote = !!s.allowRevote;
  round.points = clampPoints(s.pointsPerWin);
  round.autoWinner = mode === 'poll' && !!s.pollAutoWinner;
  round.options =
    mode === 'poll' ? pollOptions().map((o) => ({ key: o.key, label: o.label, words: [...o.words] })) : [];
  round.entryWords = mode === 'roll' ? [...rollWords()] : [];
  round.awardWinner = s.rollAward !== false;
  round.timerSeconds = s.timerEnabled ? clampTimerSeconds(s.timerSeconds) : 0;
  round.timerStartedAt = null;
}

/** «Начать приём»: с этой секунды сообщения из чата считаются */
function startVoting() {
  const round = openRound();
  if (!round) return newRound();
  if (roundPhase(round) !== 'ready') return;
  round.openedAt = new Date().toISOString();
  round.timerStartedAt = roundTimerSeconds(round) ? round.openedAt : null;
  persist();
  render();
  const mode = roundMode(round);
  const seconds = roundTimerSeconds(round);
  const unit = mode === 'roll' ? 'приём участия' : 'приём голосов';
  if (seconds) {
    toast(`Раунд №${round.index}: ${unit} начат, ${formatDuration(seconds * 1000)} — таймер пошёл`);
  } else if (mode === 'roll') {
    toast(`Раунд №${round.index}: пиши «${roundEntryWords(round).join(' / ')}» в чат, чтобы участвовать`);
  } else {
    toast(`Раунд №${round.index}: приём голосов начат — зрители могут писать в чат`);
  }
}

/** остановить приём голосов и зафиксировать, кто что написал */
function stopVoting(options = {}) {
  const round = votingRound();
  if (!round) {
    if (!options.byTimer) toast('Приём голосов уже остановлен', true);
    return;
  }
  const mode = roundMode(round);
  // если приём закрыл таймер, границей считаем дедлайн, а не «сейчас»:
  // иначе голоса, написанные после конца раунда, попали бы в подсчёт
  const deadline = roundDeadline(round);
  const timerExpired = options.byTimer && deadline != null && deadline <= Date.now();
  round.votesClosedAt = new Date(timerExpired ? deadline : Date.now()).toISOString();
  round.votes = tallyVotes(app.state.messages, round);
  persist();
  render();
  const prefix = options.byTimer ? '⏱ Время вышло: ' : '';
  const total = round.votes.length;

  // «победитель — самый популярный вариант»: объявляем итог сразу
  if (mode === 'poll' && round.autoWinner) {
    const lead = pollLeader(round.votes, roundOptions(round));
    if (lead.key) {
      // итог объявится сам: плашка, анимация и очки — как при ручном выборе
      finishRound(lead.key);
      return;
    }
    if (lead.tied.length > 1) {
      toast(
        `${prefix}ничья: ${lead.tied
          .map((key) => `«${optionLabel(round, key)}»`)
          .join(' и ')} — выбери победивший вариант вручную`,
        true
      );
      return;
    }
  }

  if (mode === 'roll') {
    toast(
      total
        ? `${prefix}участников ${total}. Жми «Крутить» — выберем случайный ник.`
        : `${prefix}никто не написал слово участия. Можно возобновить приём или отменить раунд.`
    );
    return;
  }
  const counts = countByOption(round.votes);
  const parts = roundOptions(round)
    .map((o) => `${o.label} — ${counts[o.key] || 0}`)
    .join(', ');
  toast(`${prefix}приём голосов остановлен: ${parts}. Ждём итог.`);
}

/** вернуть приём голосов, если поспешил */
function resumeVoting() {
  const round = awaitingRound();
  if (!round) return;
  round.votesClosedAt = null;
  round.votes = [];
  round.winner = null;
  // таймер истёк — даём свежее окно, а не закрываем раунд снова через секунду
  if (roundTimerSeconds(round)) round.timerStartedAt = new Date().toISOString();
  persist();
  render();
  toast('Приём снова открыт');
}

/** объявить итог: 'win'/'lose' у классики, ключ варианта у опроса */
function finishRound(outcome) {
  const round = openRound();
  if (!round) return toast('Нет активного раунда', true);
  const mode = roundMode(round);
  if (mode === 'roll') return;
  const allowed = roundOptions(round).map((o) => o.key);
  if (!allowed.includes(outcome)) return;
  if (!round.votesClosedAt) {
    // если ещё не остановили приём — останавливаем и сразу объявляем исход
    round.votesClosedAt = new Date().toISOString();
    round.votes = tallyVotes(app.state.messages, round);
  }
  round.outcome = outcome;
  round.decidedAt = new Date().toISOString();
  const guessed = round.votes.filter((v) => v.vote === outcome);
  persist();
  render();
  celebrate(mode === 'poll' ? 'poll' : outcome, optionColor(round, outcome));
  flashWinners(guessed.map((v) => v.userId));
  const label = optionLabel(round, outcome);
  const pts = roundPoints(round);
  const award = pts
    ? `по +${pts} ${plural(pts, 'очку', 'очка', 'очков')}`
    : 'очки не начисляются';
  toast(
    `Раунд №${round.index}: ${label}. ` + `Угадали ${guessed.length} из ${round.votes.length} — ${award}`
  );
}

function cancelRound() {
  const round = openRound();
  if (!round) return;
  const kind = roundMode(round) === 'roll' ? 'рулетку' : roundPhase(round) === 'voting' ? 'голосование' : 'раунд';
  if (!confirm(`Отменить ${kind} №${round.index}? Этот раунд не будет засчитан.`)) return;
  app.state.rounds = app.state.rounds.filter((r) => r.id !== round.id);
  persist();
  render();
}

// --- рулетка ---------------------------------------------------------------
let spinning = false;

// Варианты анимации прокрутки. Выбираются случайно: каждый розыгрыш
// выглядит по-своему, но длится примерно одинаково.
const SPIN_STYLES = ['slot', 'blur', 'flip', 'zoom', 'shake'];
const SPIN_COLORS = ['#ffd166', '#ffb454', '#ffe29a', '#9fd356', '#b98cff'];

/** случайный победитель среди участников; крутим ники, пока не «остановится» */
async function rollWinner() {
  const round = awaitingRound();
  if (!round || roundMode(round) !== 'roll' || spinning) return;
  const votes = (round.votes || []).filter((v) => v && v.userId);
  if (!votes.length) return toast('Никто не участвовал — крутить некого', true);

  spinning = true;
  const card = $('round-card');
  const btn = card.querySelector('[data-act="roll"]');
  const stage = card.querySelector('.roll-stage');
  const slot = card.querySelector('[data-roll-slot]');
  const calm = prefersReducedMotion();
  const style = calm ? 'calm' : randomOf(SPIN_STYLES);
  if (btn) {
    btn.disabled = true;
    btn.classList.add('spinning');
  }
  if (stage) {
    stage.classList.add('spinning', `spin-${style}`);
    stage.style.setProperty('--spin-tone', randomOf(SPIN_COLORS));
  }
  if (slot) slot.classList.add('spinning', `spin-${style}`);

  let winner = null;
  try {
    // у каждого стиля свой ритм перебора ников
    const rhythm = {
      slot: [55, 210, 1300],
      blur: [45, 150, 1250],
      flip: [140, 260, 1450],
      zoom: [60, 190, 1150],
      shake: [40, 120, 1200],
      calm: [200, 300, 700],
    }[style] || [55, 210, 1300];
    let delay = rhythm[0];
    const started = Date.now();
    while (Date.now() - started < rhythm[2]) {
      if (slot) slot.textContent = votes[Math.floor(Math.random() * votes.length)].nickname;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(rhythm[1], delay * 1.16);
    }
    winner = pickWinner(votes);
    if (winner && slot) {
      slot.textContent = winner.nickname;
      slot.classList.add('settled');
      if (stage) stage.classList.add('settled');
      // даём анимации «остановки» доиграть, прежде чем показать итог
      await new Promise((resolve) => setTimeout(resolve, calm ? 0 : 460));
    }
  } finally {
    if (stage) stage.classList.remove('spinning', `spin-${style}`, 'settled');
    if (slot) slot.classList.remove('spinning', `spin-${style}`, 'settled');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  }
  spinning = false;
  if (!winner) {
    render();
    return toast('Не получилось выбрать победителя — попробуй ещё раз', true);
  }
  round.winner = {
    userId: winner.userId,
    nickname: winner.nickname,
    rolledAt: new Date().toISOString(),
  };
  persist();
  render();
  celebrate('roll', randomOf(SPIN_COLORS));
  if (round.awardWinner !== false) flashWinners([winner.userId]);
  const pts = roundPoints(round);
  toast(
    `🎲 Раунд №${round.index}: победил ${winner.nickname}` +
      (round.awardWinner === false
        ? ' (без очков)'
        : pts
        ? ` (+${pts} ${plural(pts, 'очко', 'очка', 'очков')})`
        : '')
  );
}

/** перекрутить уже завершённый раунд (очки пересчитаются на нового победителя) */
function rerollRound(id) {
  const round = (app.state.rounds || []).find((r) => r.id === id);
  if (!round || roundMode(round) !== 'roll') return;
  round.winner = null;
  round.outcome = null;
  persist();
  render();
  rollWinner();
}

// --- таймер раунда ---------------------------------------------------------
let timerHandle = null;

/** включаем/выключаем тиканье в зависимости от открытого раунда */
function syncTimerTicker() {
  const round = votingRound();
  const active = !!round && roundTimerSeconds(round) > 0;
  if (!active) {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
    return;
  }
  if (!timerHandle) timerHandle = setInterval(tickTimer, 500);
  tickTimer();
}

function tickTimer() {
  const round = votingRound();
  if (!round) {
    syncTimerTicker();
    return;
  }
  const left = roundTimeLeft(round);
  if (left == null) return;
  const card = $('round-card');
  const box = card.querySelector('[data-timer]');
  const text = card.querySelector('[data-timer-text]');
  const fill = card.querySelector('[data-timer-fill]');
  if (!box || !text || !fill) return;
  const total = roundTimerSeconds(round) * 1000;
  text.textContent = formatDuration(left);
  fill.style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
  box.classList.toggle('warn', left <= 10000);
  if (left <= 0) stopVoting({ byTimer: true });
}

/** таймер включили/выключили — применяем к текущему раунду (или к готовому) */
function applyTimerToOpenRound(enabled) {
  const round = openRound();
  if (!round) return;
  const phase = roundPhase(round);
  if (phase === 'ready') {
    round.timerSeconds = enabled ? clampTimerSeconds(app.state.settings.timerSeconds) : 0;
    round.timerStartedAt = null;
    return;
  }
  if (phase !== 'voting') return;
  if (enabled) {
    round.timerSeconds = clampTimerSeconds(app.state.settings.timerSeconds);
    round.timerStartedAt = new Date().toISOString();
  } else {
    round.timerSeconds = 0;
    round.timerStartedAt = null;
  }
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
  const round = openRound();
  const voting = roundPhase(round) === 'voting';
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
  const delta = value - (player.points - player.adjust);
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
  setPoints(userId, (player?.points || 0) + (Number.isFinite(points) ? points : 0));
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
  if (spinning) return; // идёт прокрутка рулетки — не подменяем слот под рукой
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
  syncModeLock();
  syncTimerTicker();
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
  const fin = s.rounds.filter((r) => roundPhase(r) === 'finished');
  const players = scoreboard();
  const round = openRound();
  const liveCount = liveVotes().length;
  const liveWord = round && roundMode(round) === 'roll' ? 'участвуют' : 'голосуют';
  $('stats-line').textContent =
    `${fin.length} ${plural(fin.length, 'раунд', 'раунда', 'раундов')} · ` +
    `${players.length} ${plural(players.length, 'участник', 'участника', 'участников')}` +
    (liveCount ? ` · сейчас ${liveWord} ${liveCount}` : '');
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

// --- текущий раунд ---------------------------------------------------------
function modeBadge(mode, always = false) {
  // normalizeMode() здесь не подходит: она годится только для настроек и
  // превратила бы старый раунд классики в «опрос»
  const id = mode === 'roll' || mode === 'classic' ? mode : 'poll';
  // у классики режим по умолчанию, поэтому в карточке раунда его не дублируем
  if (!always && id === 'classic') return '';
  return `<span class="badge mode">${esc(MODE_INFO[id])}</span>`;
}

function timerBlock(round, phase) {
  if (phase !== 'voting') return '';
  const seconds = roundTimerSeconds(round);
  if (!seconds) return '';
  const total = seconds * 1000;
  const leftMs = roundTimeLeft(round);
  const left = leftMs == null ? total : Math.max(0, Math.min(total, leftMs));
  const percent = total ? (left / total) * 100 : 0;
  // Ширину ставим сразу настоящую: иначе при каждой перерисовке (например,
  // из-за нового сообщения в чате) полоска стартовала бы со 100% и «догоняла»
  // прежнее значение.
  return `<div class="round-timer${left <= 10000 ? ' warn' : ''}" data-timer>
      <div class="rt-row">
        <span class="rt-clock">⏱</span>
        <b data-timer-text>${formatDuration(left)}</b>
        <span class="rt-note">до конца приёма голосов</span>
      </div>
      <div class="rt-bar"><i data-timer-fill style="width:${percent.toFixed(3)}%"></i></div>
    </div>`;
}

function votersHtml(round, votes) {
  const mode = roundMode(round);
  if (!votes.length) {
    return `<div class="empty">${
      mode === 'roll' ? 'Пока никто не написал слово участия.' : 'Пока никто не написал слово-голос в чат.'
    }</div>`;
  }
  return `<div class="voters">${votes
    .map((v) => {
      if (mode === 'roll') return `<span class="voter">${esc(v.nickname)}</span>`;
      const color = optionColor(round, v.vote);
      return `<span class="voter" style="border-color:${color};color:${color}">${esc(v.nickname)}</span>`;
    })
    .join('')}</div>`;
}

function activeRoundBody(round, phase) {
  const mode = roundMode(round);
  const voting = phase === 'voting';
  const votes = liveVotes();
  const total = votes.length;
  const counts = countByOption(votes);
  const options = roundOptions(round);

  const badge = voting
    ? `<span class="badge live">${mode === 'roll' ? 'приём участия' : 'приём голосов'}</span>`
    : '<span class="badge await">приём остановлен</span>';

  let sub;
  if (mode === 'roll') {
    sub = voting
      ? `с ${timeOf(round.openedAt)} · пиши «${esc(roundEntryWords(round).join(' / '))}» в чат, чтобы участвовать`
      : `участие закрыто ${timeOf(round.votesClosedAt)} · ${total} ${plural(
          total,
          'участник',
          'участника',
          'участников'
        )} · теперь жми «Крутить»`;
  } else {
    const summary =
      mode === 'poll'
        ? optionsSummary(round)
        : options.map((o) => o.words.join(' / ')).join(' и ');
    sub = voting
      ? `с ${timeOf(round.openedAt)} · ${
          round.allowRevote ? 'можно переголосовать' : 'считается первое слово'
        } · ${mode === 'poll' ? `вариантов ${options.length}` : 'слова'}: ${esc(summary)}`
      : `голоса приняты до ${timeOf(round.votesClosedAt)} · ${total} ${plural(
          total,
          'голос',
          'голоса',
          'голосов'
        )} · теперь ждём итог`;
  }

  const bar =
    mode === 'roll'
      ? ''
      : `<div class="vote-bar">
          ${options
            .map((o) =>
              counts[o.key]
                ? `<div class="seg" style="width:${(counts[o.key] / Math.max(total, 1)) * 100}%;background:${optionColor(
                    round,
                    o.key
                  )}"></div>`
                : ''
            )
            .join('')}
          ${!total ? '<div class="seg-empty"></div>' : ''}
        </div>`;

  const pts = roundPoints(round);
  const reward = pts ? `+${pts} ${plural(pts, 'очко', 'очка', 'очков')}` : 'без очков';
  const rewardNote = pts ? `${reward} за верный` : 'очки не начисляются';
  const counters =
    mode === 'roll'
      ? `<div class="vote-counts"><span class="vc">🎲 ${total} ${plural(
          total,
          'участник',
          'участника',
          'участников'
        )} · ${reward}</span></div>`
      : `<div class="vote-counts${options.length > 8 ? ' many' : ''}">${options
          .map(
            (o) =>
              `<span class="vc" style="color:${optionColor(round, o.key)}">${esc(o.label)} — ${
                counts[o.key] || 0
              }</span>`
          )
          .join('')}<span class="vc muted">${esc(rewardNote)}</span></div>`;

  let controls;
  if (voting) {
    controls = `<button class="btn primary" data-act="stop">⏸ ${
      mode === 'roll' ? 'Остановить приём участия' : 'Остановить приём голосов'
    }</button>
      <button class="btn" data-act="cancel">Отменить раунд</button>`;
  } else if (mode === 'roll') {
    controls = `<button class="btn roll-btn" data-act="roll">🎲 Крутить</button>
      <button class="btn" data-act="resume">↩ Возобновить приём</button>
      <button class="btn" data-act="cancel">Отменить раунд</button>`;
  } else if (mode === 'poll') {
    controls =
      `<div class="controls-label">какой вариант победил? ${
        pts ? `очки получат те, кто его выбрал (+${pts})` : 'очки не начисляются'
      }</div>` +
      `<div class="outcome-list${options.length > 8 ? ' many' : ''}">` +
      options
        .map(
          (o) =>
            `<button class="btn opt" data-act="finish" data-outcome="${esc(o.key)}" style="--opt:${optionColor(
              round,
              o.key
            )}">${esc(o.label)}</button>`
        )
        .join('') +
      `</div>` +
      `<button class="btn" data-act="resume">↩ Возобновить приём</button>
       <button class="btn" data-act="cancel">Отменить раунд</button>`;
  } else {
    controls = `<button class="btn win" data-act="finish" data-outcome="win">🏆 Была победа</button>
      <button class="btn lose" data-act="finish" data-outcome="lose">💀 Было поражение</button>
      <button class="btn" data-act="resume">↩ Возобновить приём голосов</button>
      <button class="btn" data-act="cancel">Отменить раунд</button>`;
  }

  const stage =
    mode === 'roll' && !voting
      ? `<div class="roll-stage">
          <div class="roll-slot" data-roll-slot>?</div>
          <div class="muted small">нажми «Крутить» — победитель выбирается случайно</div>
        </div>`
      : '';

  return `<div class="round-top">
      <div>
        <div class="round-title">Раунд №${round.index} ${badge} ${modeBadge(mode)}</div>
        <div class="round-sub">${sub}</div>
      </div>
      ${counters}
    </div>
    ${timerBlock(round, phase)}
    ${bar}
    ${stage}
    <div class="controls">${controls}</div>
    ${votersHtml(round, votes)}`;
}

function finishedRoundBody(round) {
  const mode = roundMode(round);
  const votes = round.votes || [];
  const total = votes.length;
  const title = `<div class="round-title">Раунд №${round.index} ${modeBadge(mode)}</div>`;

  if (mode === 'roll') {
    const winner = round.winner;
    const award = round.awardWinner !== false;
    const pts = roundPoints(round);
    const awardNote = !award
      ? 'без очков'
      : pts
      ? `+${pts} ${plural(pts, 'очко', 'очка', 'очков')} в таблицу`
      : 'очки не начисляются';
    return `<div class="round-top">
        <div>
          ${title}
          <div class="round-sub">${total} ${plural(
            total,
            'участник',
            'участника',
            'участников'
          )} · победитель выбран случайно</div>
        </div>
        <button class="btn primary" data-act="new">▶ Новый раунд</button>
      </div>
      <div class="result-banner roll" style="--tone:var(--gold)">
        <span class="result-kicker">победитель рулетки</span>
        <span class="result-name">🎲 ${esc(winner?.nickname || '—')}</span>
        <span class="result-note">${esc(awardNote)}</span>
      </div>
      <div class="controls">
        <button class="btn" data-act="reroll" data-round="${esc(round.id || '')}">🎲 Перевыбрать</button>
      </div>
      ${
        votes.length
          ? `<div class="voters">${votes
              .map(
                (v) =>
                  `<span class="voter${winner && v.userId === winner.userId ? ' winner' : ''}">${esc(
                    v.nickname
                  )}</span>`
              )
              .join('')}</div>`
          : ''
      }`;
  }

  const guessed = votes.filter((v) => v.vote === round.outcome);
  const label = optionLabel(round, round.outcome);
  const color = optionColor(round, round.outcome);
  const pts = roundPoints(round);
  const per = pts ? `по +${pts} ${plural(pts, 'очку', 'очка', 'очков')}` : 'без очков';
  const headline =
    mode === 'poll' ? label || '—' : round.outcome === 'win' ? 'Победа' : 'Поражение';
  const kicker = mode === 'poll' ? 'победивший вариант' : 'итог раунда';
  const note =
    mode === 'poll'
      ? guessed.length
        ? `угадали ${guessed.length} из ${total} · ${per}`
        : 'в этом раунде никто не угадал'
      : `слово «${label}» · угадали ${guessed.length} из ${total} · ${per}`;

  return `<div class="round-top">
      <div>
        ${title}
        <div class="round-sub">${total} ${plural(
          total,
          'голос',
          'голоса',
          'голосов'
        )} · раунд завершён, очки начислены</div>
      </div>
      <button class="btn primary" data-act="new">▶ Новый раунд</button>
    </div>
    <div class="result-banner" style="--tone:${color}">
      <span class="result-kicker">${esc(kicker)}</span>
      <span class="result-name">${esc(headline)}</span>
      <span class="result-note">${esc(note)}</span>
    </div>
    ${
      guessed.length
        ? `<div class="voters">${guessed
            .map(
              (v) =>
                `<span class="voter" style="border-color:${color};color:${color}">${
                  pts ? `+${pts} ` : ''
                }${esc(v.nickname)}</span>`
            )
            .join('')}</div>`
        : ''
    }`;
}

function idleRoundBody() {
  const mode = settingsMode();
  let hint;
  if (mode === 'roll') {
    hint = `Зрители пишут «${esc(rollWords().join(' / '))}» — сайт выберет случайный ник.`;
  } else {
    const list = pollOptions();
    hint = `Варианты (${list.length}): ${esc(optionsSummary({ mode: 'poll', options: list }))}.`;
  }
  return `<div class="round-top">
      <div>
        <div class="round-title">Всё готово к старту ${modeBadge(mode, true)}</div>
        <div class="round-sub">${hint} Нажми «Новый раунд» — приём начнётся отдельной кнопкой.</div>
      </div>
      <button class="btn primary" data-act="new">▶ Новый раунд</button>
    </div>`;
}

/** раунд создан, но приём ещё не начат: показываем, что именно будем считать */
function readyRoundBody(round) {
  const mode = roundMode(round);
  const options = roundOptions(round);
  const pts = roundPoints(round);
  const reward = pts ? `+${pts} ${plural(pts, 'очко', 'очка', 'очков')} победителям` : 'без очков';
  const timer = roundTimerSeconds(round);
  const timerNote = timer ? ` · таймер ${formatDuration(timer * 1000)}` : '';
  const chips =
    mode === 'roll'
      ? `<div class="voters"><span class="voter">${esc(roundEntryWords(round).join(' / '))}</span></div>`
      : `<div class="voters${options.length > 8 ? ' many' : ''}">${options
          .map(
            (o) =>
              `<span class="voter" style="border-color:${optionColor(round, o.key)};color:${optionColor(
                round,
                o.key
              )}">${esc(o.label)}</span>`
          )
          .join('')}</div>`;
  return `<div class="round-top">
      <div>
        <div class="round-title">Раунд №${round.index} <span class="badge ready">готов к старту</span> ${modeBadge(
    mode,
    true
  )}</div>
        <div class="round-sub">${
          mode === 'roll'
            ? `Участие: напиши «${esc(roundEntryWords(round).join(' / '))}» в чат`
            : `Вариантов ${options.length}: ${esc(optionsSummary(round))}`
        }</div>
      </div>
      <button class="btn primary" data-act="start">▶ Начать приём ${
        mode === 'roll' ? 'участия' : 'голосов'
      }</button>
    </div>
    <div class="ready-box">
      <div class="muted small">${reward}${timerNote} · сообщения из чата начнут считаться после старта</div>
      ${chips}
    </div>
    <div class="controls">
      <button class="btn" data-act="cancel">Отменить раунд</button>
    </div>`;
}

function renderRound() {
  const card = $('round-card');
  const round = openRound();
  const phase = roundPhase(round);
  const finished = lastFinished();
  card.classList.toggle('open', phase === 'voting');
  card.classList.toggle('awaiting', phase === 'awaiting');
  card.classList.toggle('ready', phase === 'ready');

  if (round && phase === 'ready') {
    card.dataset.mode = roundMode(round);
    card.innerHTML = readyRoundBody(round);
  } else if (round && (phase === 'voting' || phase === 'awaiting')) {
    card.dataset.mode = roundMode(round);
    card.innerHTML = activeRoundBody(round, phase);
  } else if (finished) {
    card.dataset.mode = roundMode(finished);
    card.innerHTML = finishedRoundBody(finished);
  } else {
    card.dataset.mode = settingsMode();
    card.innerHTML = idleRoundBody();
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
  const round = openRound();
  el.innerHTML = rows
    .map((p, i) => {
      const place = i + 1;
      const cls = place <= 3 ? ` top${place}` : '';
      const streak = p.streak >= 2 ? ` · 🔥 ${p.streak} подряд` : '';
      const roll = p.rollWins ? ` · 🎲 ${p.rollWins}` : '';
      const manual = p.adjust ? ` · правка ${p.adjust > 0 ? '+' : ''}${p.adjust}` : '';
      let cur = '';
      if (p.currentVote && round) {
        if (roundMode(round) === 'roll') {
          cur = ' · <span class="muted">участвует</span>';
        } else {
          cur = ` · <span style="color:${optionColor(round, p.currentVote)}">сейчас ${esc(
            optionLabel(round, p.currentVote)
          )}</span>`;
        }
      }
      return `<div class="sb-row${cls}" data-user="${esc(p.userId)}">
        <div class="sb-place">${place}</div>
        <div class="sb-name">
          ${
            isDemo() || p.userId.startsWith('manual-')
              ? esc(p.nickname)
              : `<a href="https://w.tv/${encodeURIComponent(p.nickname)}" target="_blank" rel="noopener">${esc(
                  p.nickname
                )}</a>`
          }
          <div class="sb-sub">угадал ${p.guessed} из ${p.voted}${roll}${streak}${manual}${cur}</div>
        </div>
        <button class="sb-points" data-points="${esc(p.userId)}" title="Нажми, чтобы поставить точное число">${
        p.points
      }<small>очк.</small></button>
        <div class="sb-edit">
          <button data-minus="${esc(p.userId)}" title="−1 очко">−</button>
          <button data-plus="${esc(p.userId)}" title="+1 очко">+</button>
        </div>
      </div>`;
    })
    .join('');
}

/** полоса и числа для строки истории */
function historyBar(round, votes, phase) {
  const total = votes.length || 1;
  if (phase === 'ready') {
    return { bar: '<div class="hist-bar"></div>', nums: '—', hint: 'раунд создан, приём ещё не начат' };
  }
  if (roundMode(round) === 'roll') {
    return {
      bar: `<div class="hist-bar">${
        votes.length ? '<i style="width:100%;background:var(--gold)"></i>' : ''
      }</div>`,
      nums: `${votes.length} уч.`,
      hint: 'участники рулетки',
    };
  }
  const counts = countByOption(votes);
  if (phase === 'finished') {
    const guessed = votes.filter((v) => v.vote === round.outcome).length;
    return {
      bar: `<div class="hist-bar">${
        guessed
          ? `<i style="width:${(guessed / total) * 100}%;background:${optionColor(
              round,
              round.outcome
            )}"></i>`
          : ''
      }${
        votes.length - guessed
          ? `<i style="width:${((votes.length - guessed) / total) * 100}%;background:#3a4657"></i>`
          : ''
      }</div>`,
      nums: `${guessed}/${votes.length}`,
      hint: `угадали ${guessed} из ${votes.length}`,
    };
  }
  const options = roundOptions(round);
  const many = options.length > 6;
  return {
    bar: `<div class="hist-bar">${options
      .map((o) =>
        counts[o.key]
          ? `<i style="width:${(counts[o.key] / total) * 100}%;background:${optionColor(round, o.key)}"></i>`
          : ''
      )
      .join('')}</div>`,
    nums: many ? `${votes.length} голос.` : options.map((o) => counts[o.key] || 0).join('/'),
    hint: many
      ? `вариантов ${options.length}, голосов ${votes.length}`
      : options.map((o) => `${o.label} ${counts[o.key] || 0}`).join(' · '),
  };
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
      const mode = roundMode(r);
      const votes = r === current && phase === 'voting' ? liveVotes() : r.votes || [];
      let badge;
      if (phase === 'finished') {
        if (mode === 'roll') {
          badge = `<span class="badge roll">🎲 ${esc(r.winner?.nickname || '—')}</span>`;
        } else {
          const color = optionColor(r, r.outcome);
          badge = `<span class="badge tone" style="--tone:${color}">${esc(
            optionLabel(r, r.outcome) || '—'
          )}</span>`;
        }
      } else if (phase === 'awaiting') {
        badge =
          mode === 'roll'
            ? '<span class="badge await">ждём розыгрыш</span>'
            : '<span class="badge await">ждём итог</span>';
      } else if (phase === 'ready') {
        badge = '<span class="badge ready">готов</span>';
      } else {
        badge = '<span class="badge live">идёт</span>';
      }
      const info = historyBar(r, votes, phase);
      return `<div class="hist-row">
        <div class="idx">№${r.index}</div>
        <div>${badge}</div>
        ${info.bar}
        <div class="hist-nums" title="${esc(info.hint)}">${info.nums} · ${votes.length}</div>
      </div>`;
    })
    .join('');
}

/** какие сообщения учтены в раунде: id -> ключ варианта */
function countedMessages(round) {
  const out = new Map();
  if (!round || !round.openedAt) return out;
  const cutoff = votesEnd(round);
  const perUser = new Map();
  for (const m of app.state.messages) {
    if (!m.ts || m.ts < round.openedAt) continue;
    if (cutoff && m.ts > cutoff) continue;
    if (round.ownerUserId && m.userId === round.ownerUserId) continue;
    if ((m.tags || []).includes('TAG_OWNER')) continue;
    const vote = voteKeyFor(m.content, round);
    if (!vote) continue;
    const rec = perUser.get(m.userId);
    if (!rec) perUser.set(m.userId, { ids: [m.id], vote });
    else {
      rec.ids.push(m.id);
      if (round.allowRevote) rec.vote = vote;
    }
  }
  for (const rec of perUser.values()) {
    const id = round.allowRevote ? rec.ids[rec.ids.length - 1] : rec.ids[0];
    out.set(id, rec.vote);
  }
  return out;
}

function renderChat() {
  const el = $('chat');
  const s = app.state;
  const messages = (s.messages || []).slice(-90);
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  const round = openRound();
  const phase = roundPhase(round);
  const counted = countedMessages(round);
  const cutoff = round ? votesEnd(round) : null;
  const started = !!(round && round.openedAt);

  el.innerHTML = messages
    .map((m) => {
      const isOwner = (m.tags || []).includes('TAG_OWNER');
      const vote = round ? voteKeyFor(m.content, round) : null;
      const countedVote = counted.get(m.id);
      let cls = 'msg';
      let tag = '';
      let style = '';
      if (countedVote) {
        cls += ' vote-counted';
        style = ` style="box-shadow:inset 3px 0 0 ${optionColor(round, countedVote)}"`;
        tag = `<span class="tag counted">${
          roundMode(round) === 'roll' ? 'участвует' : 'учтён'
        }</span>`;
      } else if (
        vote &&
        started &&
        phase !== 'none' &&
        phase !== 'ready' &&
        !isOwner &&
        m.ts >= round.openedAt &&
        !(cutoff && m.ts > cutoff)
      ) {
        cls += ' vote-ignored';
        tag = '<span class="tag ignored">не учтён</span>';
      }
      return `<div class="${cls}"${style}>
        <div><span class="nick" style="color:${colorFor(m.nickname)}">${esc(
          m.nickname
        )}</span><span class="txt">${esc(m.content)}</span>${tag}${
        isOwner ? '<span class="tag owner">стример</span>' : ''
      }</div>
        <div class="time">${timeOf(m.ts)}</div>
      </div>`;
    })
    .join('');

  if (nearBottom) el.scrollTop = el.scrollHeight;
  $('chat-status').textContent = s.messages.length
    ? `${s.messages.length} сообщений в памяти`
    : 'ждём сообщения…';
}

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
  $('words-roll').value = wordsToText(rollWords());
  $('roll-award').checked = s.settings.rollAward !== false;
  $('revote-toggle').checked = !!s.settings.allowRevote;
  $('poll-input').value = s.settings.pollSeconds || 5;
  if ($('points-per-win')) $('points-per-win').value = pointsPerWin();
  if ($('poll-auto')) $('poll-auto').checked = pollAutoWinner();
  renderPollOptionsEditor();
  syncModeUI();
  updateRollHint();
  updatePointsHint();
  updateTimerControls();
}

/** подсветить поле, если в нём проблема */
function markField(el, bad) {
  if (!el) return;
  el.classList.toggle('invalid', !!bad);
  el.setAttribute('aria-invalid', bad ? 'true' : 'false');
}

function updatePointsHint() {
  const el = $('points-hint');
  if (!el) return;
  const pts = pointsPerWin();
  el.innerHTML = pts
    ? `Каждый, кто выбрал победивший вариант, получит <b>+${pts}</b> ${plural(
        pts,
        'очко',
        'очка',
        'очков'
      )}. Победитель рулетки — столько же, если начисление включено.`
    : 'Очки за раунды не начисляются — останутся только ручные правки в таблице.';
}

function updateRollHint() {
  const list = rollWords();
  const round = openRound();
  const note =
    round && roundMode(round) === 'roll'
      ? ' Изменения применятся к текущему раунду, если в нём ещё нет участников.'
      : '';
  $('roll-hint').innerHTML =
    `Зритель пишет <b>${esc(list.join(' / '))}</b> в чат — и попадает в список участников. ` +
    `Победитель выбирается случайно.${note}`;
}

function applyRollWords(options = {}) {
  const input = $('words-roll');
  const list = parseWords(input.value);
  markField(input, !list.length);
  if (!list.length) {
    if (!options.silent) toast('Нужно хотя бы одно слово для участия', true);
    return false;
  }
  const current = rollWords();
  const same = list.length === current.length && list.every((w, i) => w === current[i]);
  app.state.settings.rollWords = list;
  const round = openRound();
  if (round && roundMode(round) === 'roll' && !tallyVotes(app.state.messages, round).length) {
    round.entryWords = [...list];
  }
  persist();
  if (document.activeElement !== input) input.value = wordsToText(list);
  updateRollHint();
  render();
  if (!options.silent && !same) toast('Слово участия сохранено');
  return true;
}

// --- режим ----------------------------------------------------------------
function modeDescription(mode) {
  return `${MODE_INFO[mode]} — ${MODE_DESC[mode]}`;
}

/** блокировка переключения режима, пока идёт приём (режим уже зафиксирован в раунде) */
function syncModeLock() {
  const locked = !!votingRound();
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.disabled = locked;
    tab.title = locked ? 'Пока идёт приём голосов, режим менять нельзя' : '';
  });
  if ($('mode-lock')) $('mode-lock').hidden = !locked;
  document.querySelectorAll('.mode-card').forEach((card) => card.classList.toggle('locked', locked));
}

function syncModeUI() {
  const mode = settingsMode();
  syncModeLock();
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-mode-body]').forEach((body) => {
    body.hidden = body.dataset.modeBody !== mode;
  });
  if ($('mode-desc')) $('mode-desc').textContent = modeDescription(mode);
  if ($('revote-row')) $('revote-row').hidden = mode === 'roll';
  updateTimerControls();
}

function setSettingsMode(next) {
  const mode = normalizeMode(next);
  if (settingsMode() === mode) return;
  if (votingRound()) {
    return toast('Пока идёт приём голосов, режим менять нельзя — сначала останови приём', true);
  }
  if (openRound()) toast('Режим применится к этому раунду — он ещё не начался');
  app.state.settings.mode = mode;
  syncReadyRound();
  persist();
  syncModeUI();
  render();
}

// --- варианты опроса -------------------------------------------------------
let pollTimer = null;

function pollRows() {
  return [...$('poll-options').querySelectorAll('[data-poll-input]')];
}

function readPollRows() {
  return pollRows().map((el) => parseWords(el.value));
}

function refreshPollButtons() {
  const rows = pollRows();
  const add = $('poll-add');
  if (add) add.disabled = rows.length >= MAX_POLL_OPTIONS;
  const counter = $('poll-count');
  if (counter) counter.textContent = `${rows.length} из ${MAX_POLL_OPTIONS}`;
  $('poll-options').querySelectorAll('[data-poll-remove]').forEach((btn) => {
    btn.disabled = rows.length <= 2;
  });
}

function pollRowElement(value, index) {
  const row = document.createElement('div');
  row.className = 'poll-opt';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = index === 0 ? 'да' : index === 1 ? 'нет' : `вариант ${index + 1}`;
  input.spellcheck = false;
  input.dataset.pollInput = String(index);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn';
  del.dataset.pollRemove = String(index);
  del.title = 'Удалить вариант';
  del.textContent = '×';
  row.append(input, del);
  return row;
}

function renderPollOptionsEditor() {
  const box = $('poll-options');
  if (!box) return;
  box.innerHTML = '';
  pollOptions().forEach((option, i) => box.appendChild(pollRowElement(wordsToText(option.words), i)));
  refreshPollButtons();
  updatePollHint();
}

function updatePollHint() {
  const el = $('poll-hint');
  if (!el) return;
  const opts = pollOptions();
  const shown = opts.slice(0, 8);
  const rest = opts.length - shown.length;
  el.innerHTML =
    `Голос — сообщение целиком, равное названию или синониму: ` +
    shown.map((o) => `<b>${esc(o.words.join(' / '))}</b>`).join(', ') +
    (rest > 0 ? ` и ещё ${rest} ${plural(rest, 'вариант', 'варианта', 'вариантов')}` : '') +
    `. Победивший вариант даёт очки всем, кто его выбрал. ` +
    (pollAutoWinner()
      ? 'Итог объявится сам: побеждает вариант с наибольшим числом голосов.'
      : 'Итог объявляешь ты — кнопкой с нужным вариантом.');
}

function applyPollFromInputs(options = {}) {
  const rows = readPollRows();
  const empty = rows.some((row) => !row.length);
  let duplicate = '';
  const seen = new Set();
  for (const row of rows) {
    for (const word of row) {
      if (seen.has(word)) {
        duplicate = word;
        break;
      }
      seen.add(word);
    }
    if (duplicate) break;
  }
  const problem =
    rows.length < 2
      ? 'Нужно хотя бы два варианта'
      : empty
      ? 'У каждого варианта должно быть слово'
      : duplicate
      ? `Слово «${duplicate}» уже есть в другом варианте`
      : '';
  pollRows().forEach((el, i) => markField(el, rows[i] ? !rows[i].length : true));
  if (problem) {
    if (!options.silent) toast(problem, true);
    return false;
  }
  const next = normalizePollOptions(rows.map((words) => ({ words })));
  const same = JSON.stringify(next) === JSON.stringify(pollOptions());
  app.state.settings.pollOptions = next;
  // варианты можно менять и в идущем опросе — если там ещё никто не голосовал
  const round = openRound();
  if (round && roundMode(round) === 'poll' && !tallyVotes(app.state.messages, round).length) {
    round.options = next.map((o) => ({ key: o.key, label: o.label, words: [...o.words] }));
  }
  persist();
  updatePollHint();
  syncReadyRound();
  if (!same) render();
  return true;
}

// --- таймер ---------------------------------------------------------------
function updateTimerControls() {
  const s = app.state.settings;
  if ($('timer-toggle')) $('timer-toggle').checked = !!s.timerEnabled;
  if ($('timer-row')) $('timer-row').hidden = !s.timerEnabled;
  if ($('timer-seconds')) $('timer-seconds').value = clampTimerSeconds(s.timerSeconds);
  updateTimerHint();
}

function updateTimerHint() {
  const el = $('timer-hint');
  if (!el) return;
  const s = app.state.settings;
  const seconds = clampTimerSeconds(s.timerSeconds);
  if (!s.timerEnabled) {
    el.innerHTML = 'Таймер выключен — раунд идёт, пока ты не нажмёшь «Остановить приём голосов».';
    return;
  }
  el.innerHTML =
    `Раунд продлится <b>${formatDuration(seconds * 1000)}</b> с момента старта, потом приём ` +
    `голосов закроется сам. Останется объявить итог (в рулетке — «Крутить»).`;
}

function setTimerSeconds(value, options = {}) {
  const seconds = clampTimerSeconds(value, 60);
  app.state.settings.timerSeconds = seconds;
  if ($('timer-seconds')) $('timer-seconds').value = seconds;
  const round = openRound();
  if (round && roundPhase(round) === 'ready' && app.state.settings.timerEnabled) {
    round.timerSeconds = seconds;
    round.timerStartedAt = null;
  } else if (round && roundPhase(round) === 'voting' && roundTimerSeconds(round) && app.state.settings.timerEnabled) {
    // поменяли длительность на ходу — отсчитываем заново
    round.timerSeconds = seconds;
    round.timerStartedAt = new Date().toISOString();
  }
  persist();
  updateTimerHint();
  render();
  if (!options.silent) toast(`Таймер раунда: ${formatDuration(seconds * 1000)}`);
}

function setTimerEnabled(enabled) {
  app.state.settings.timerEnabled = !!enabled;
  applyTimerToOpenRound(!!enabled);
  persist();
  updateTimerControls();
  render();
  toast(
    enabled
      ? `Таймер включён: ${formatDuration(clampTimerSeconds(app.state.settings.timerSeconds) * 1000)} на раунд`
      : 'Таймер выключен — раунд не ограничен по времени'
  );
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
  const rounds = exportRoundsRows(sortedRounds);
  const channel = s.channelName || s.channel || 'канал';
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `w-vote-${channel}-${stamp}`;
  const finished = sortedRounds.filter((r) => roundPhase(r) === 'finished');
  const wonAll = finished.filter((r) => roundMode(r) === 'roll').length;
  const guessedAll = scores.reduce((sum, p) => sum + p.guessed, 0);
  const rollAll = scores.reduce((sum, p) => sum + (p.rollWins || 0), 0);

  const txtHeader = [
    ['Канал', channel],
    ['Дата выгрузки', new Date().toLocaleString('ru-RU')],
    ['Режим', modeLabel(settingsMode())],
    ['Проведено раундов', finished.length],
    ['из них рулеток', wonAll],
    ['Участников', scores.length],
    ['Всего угаданных исходов', guessedAll],
    ['Побед в рулетке', rollAll],
  ];
  if (settingsMode() === 'poll') {
    txtHeader.push(['Варианты', pollOptions().map((o) => o.words.join('/')).join(' · ')]);
  } else {
    txtHeader.push(['Слово участия', rollWords().join('/')]);
  }
  txtHeader.push(['Очков за раунд', pointsPerWin()]);
  if (settingsMode() === 'poll') {
    txtHeader.push(['Победитель по голосам', pollAutoWinner() ? 'да' : 'объявляется вручную']);
  }

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
    app.state.settings = normalizeSettings({ ...app.state.settings, ...(incoming.settings || {}) });
    app.state.messages = incoming.messages || app.state.messages;
    app.state.rounds = app.state.rounds.map(migrateRound).filter(Boolean);
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
// Праздничные эффекты: короткие, без звука, с уважением к prefers-reduced-motion
// ---------------------------------------------------------------------------
function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Короткое «подтверждение» исхода: вспышка цвета, лёгкий масштаб и горсть искр.
 * @param {'win'|'lose'|'poll'|'roll'} kind
 * @param {string} color
 */
function celebrate(kind, color) {
  const card = $('round-card');
  if (!card) return;
  card.style.setProperty('--reveal', color || 'var(--win)');
  const cls = 'reveal-' + kind;
  card.classList.remove('reveal-win', 'reveal-lose', 'reveal-poll', 'reveal-roll');
  void card.offsetWidth; // перезапуск анимации, даже если класс уже был
  card.classList.add('reveal', cls);
  setTimeout(() => card.classList.remove('reveal', cls), 1900);

  if (prefersReducedMotion()) return;
  const burst = document.createElement('div');
  burst.className = 'burst';
  for (let i = 0; i < 18; i++) {
    const spark = document.createElement('i');
    const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.4;
    const distance = 60 + Math.random() * 110;
    spark.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    spark.style.setProperty('--dy', `${Math.sin(angle) * distance * 0.7 - 30}px`);
    spark.style.setProperty('--rot', `${Math.random() * 320 - 160}deg`);
    spark.style.setProperty('--dur', `${0.55 + Math.random() * 0.5}s`);
    spark.style.setProperty('--delay', `${Math.random() * 0.12}s`);
    burst.appendChild(spark);
  }
  card.appendChild(burst);
  setTimeout(() => burst.remove(), 1500);
}

/** короткая подсветка строк тех, кто получил очко */
function flashWinners(userIds) {
  if (!userIds || !userIds.length) return;
  requestAnimationFrame(() => {
    document.querySelectorAll('.sb-row').forEach((row) => {
      if (!userIds.includes(row.dataset.user)) return;
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1700);
    });
  });
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
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  if (act === 'new') newRound();
  if (act === 'start') startVoting();
  if (act === 'stop') stopVoting();
  if (act === 'resume') resumeVoting();
  if (act === 'finish') finishRound(btn.dataset.outcome);
  if (act === 'cancel') cancelRound();
  if (act === 'roll') rollWinner();
  if (act === 'reroll') rerollRound(btn.dataset.round);
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

// слово участия в рулетке (можно и символы: «+», «++»)
let rollTimer = null;
$('words-roll').addEventListener('input', () => {
  clearTimeout(rollTimer);
  rollTimer = setTimeout(() => applyRollWords({ silent: true }), 500);
});
$('words-roll').addEventListener('change', () => {
  clearTimeout(rollTimer);
  applyRollWords();
});

$('roll-award').addEventListener('change', (e) => {
  app.state.settings.rollAward = e.target.checked;
  const round = openRound();
  if (round && roundMode(round) === 'roll' && !round.winner) round.awardWinner = e.target.checked;
  persist();
  render();
  const pts = pointsPerWin();
  toast(
    e.target.checked
      ? pts
        ? `Победитель рулетки будет получать +${pts} ${plural(pts, 'очко', 'очка', 'очков')}`
        : 'Начисление включено, но очков за раунд сейчас 0'
      : 'Рулетка без очков: победитель просто объявляется'
  );
});

// режим раунда
document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => setSettingsMode(tab.dataset.mode));
});

// сколько очков получает победитель раунда
let pointsTimer = null;
function applyPoints(options = {}) {
  const input = $('points-per-win');
  if (!input) return true;
  if (!String(input.value).trim()) {
    // пустое поле не превращаем в «0 очков»: просто возвращаем прежнее значение
    if (!options.silent) {
      input.value = pointsPerWin();
      toast('Очки за раунд не могут быть пустыми', true);
    }
    return false;
  }
  const value = clampPoints(input.value);
  app.state.settings.pointsPerWin = value;
  const round = openRound();
  if (round && roundPhase(round) === 'ready') round.points = value;
  persist();
  updatePointsHint();
  if (document.activeElement !== input) input.value = value;
  if (!options.silent) {
    render();
    toast(value ? `Победитель раунда получает +${value}` : 'Очки за раунды отключены');
  }
  return true;
}
$('points-per-win').addEventListener('input', () => {
  clearTimeout(pointsTimer);
  pointsTimer = setTimeout(() => applyPoints({ silent: true }), 500);
});
$('points-per-win').addEventListener('change', () => {
  clearTimeout(pointsTimer);
  applyPoints();
});

// «победитель — самый популярный вариант»
$('poll-auto').addEventListener('change', (e) => {
  app.state.settings.pollAutoWinner = e.target.checked;
  syncReadyRound();
  persist();
  updatePollHint();
  render();
  toast(
    e.target.checked
      ? 'Итог опроса будет объявляться автоматически по большинству голосов'
      : 'Итог опроса снова объявляешь ты вручную'
  );
});

// варианты опроса: добавляем и убираем строки прямо в интерфейсе
$('poll-add').addEventListener('click', () => {
  const box = $('poll-options');
  const rows = pollRows();
  if (rows.length >= MAX_POLL_OPTIONS) {
    return toast(`Больше ${MAX_POLL_OPTIONS} вариантов не поместится`, true);
  }
  const row = pollRowElement('', rows.length);
  box.appendChild(row);
  refreshPollButtons();
  row.querySelector('input').focus();
});

$('poll-options').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-poll-remove]');
  if (!btn) return;
  if (pollRows().length <= 2) return toast('Должно остаться хотя бы два варианта', true);
  btn.closest('.poll-opt').remove();
  refreshPollButtons();
  applyPollFromInputs({ silent: true });
});

$('poll-options').addEventListener('input', () => {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => applyPollFromInputs({ silent: true }), 500);
});
$('poll-options').addEventListener('change', () => {
  clearTimeout(pollTimer);
  applyPollFromInputs();
});

// таймер раунда
$('timer-toggle').addEventListener('change', (e) => setTimerEnabled(e.target.checked));
$('timer-seconds').addEventListener('change', (e) => setTimerSeconds(e.target.value));
document.querySelectorAll('[data-timer-preset]').forEach((btn) => {
  btn.addEventListener('click', () => setTimerSeconds(btn.dataset.timerPreset));
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
  const keep = {
    channel: app.channel,
    channelName: app.state.channelName,
    channelUserId: app.state.channelUserId,
    channelById: app.state.channelById,
    avatarUrl: app.state.avatarUrl,
    avatarFor: app.state.avatarFor,
    demo: app.state.demo,
  };
  app.state = emptyState();
  Object.assign(app.state, keep);
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
