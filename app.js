// ===========================================================================
//  app.js — интерфейс. Данные живут только в этом браузере (localStorage).
// ===========================================================================
(function () {
'use strict';
const {
  DEFAULT_WORDS, STORAGE_KEY, colorFor, computeScores, dateTimeOf, detectVote, emptyState, esc,
  exportLeadersRows, exportRoundsRows, fetchAvatar, fetchMessages, fetchProfile, loadState,
  makeCsv, makeTxt, makeXlsx, normalizeChannelInput, parseWords, plural, resetProxyOrder,
  roundPhase, saveState, tallyVotes, timeOf, uid, votesEnd, wordsToText,
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
// свой прокси: из настроек страницы, иначе из config.js
const proxyOf = (state) => (state?.settings?.proxy || window.WTV_DEFAULT_PROXY || '').trim();
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
async function connect(rawInput) {
  const name = normalizeChannelInput(rawInput);
  if (!name) throw Object.assign(new Error('empty'), { code: 'empty' });
  resetProxyOrder();
  const profile = await fetchProfile(name, proxyOf(app.state));
  app.channel = profile.nickname.toLowerCase();
  app.state = loadState(storageKey());
  app.state.channel = app.channel;
  app.state.channelUserId = profile.userId;
  app.state.channelName = profile.nickname;
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
  const variants = [win, win, lose, win.toUpperCase(), lose, `${win}!`];
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
  $('channel-link').href = s.demo ? '#' : `https://w.tv/${s.channelName || s.channel}`;
  paintAvatar();
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
  else parts.push('чат читается');
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
    `Можно перечислить несколько вариантов через запятую.`;
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
    toast('Нужно хотя бы одно слово в каждом поле', true);
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
// События интерфейса
// ---------------------------------------------------------------------------
$('channel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('landing-error');
  errEl.hidden = true;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Подключаюсь…';
  try {
    await connect($('channel-input').value);
  } catch (err) {
    const name = normalizeChannelInput($('channel-input').value);
    errEl.innerHTML =
      err.code === 'channel_not_found'
        ? `Канал «${esc(name)}» не найден на w.tv. Проверь ник — он виден в адресе канала.`
        : err.code === 'empty'
          ? 'Введи ник или ссылку на канал.'
          : `Не удалось получить данные канала.<br>Проверь интернет и попробуй ещё раз.<br><span class="muted small">Ответ: ${esc(err.message)}</span>`;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Подключить чат';
  }
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

$('proxy-input').addEventListener('change', (e) => {
  const value = e.target.value.trim();
  if (value === (app.state.settings.proxy || '')) return;
  app.state.settings.proxy = value;
  resetProxyOrder();
  persist();
  toast(app.state.settings.proxy ? 'Прокси сохранён' : 'Использую публичный прокси');
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
    $('channel-form').dispatchEvent(new Event('submit', { cancelable: true }));
    return;
  }
  if (last === 'demo') {
    connectDemo();
    return;
  }
  if (last) {
    $('channel-input').value = `https://w.tv/${last}`;
    $('channel-form').dispatchEvent(new Event('submit', { cancelable: true }));
    return;
  }
  $('channel-input').focus();
})();

})();
