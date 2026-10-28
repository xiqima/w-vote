// ===========================================================================
//  tests/modes-timer.test.js — режимы (опрос, рулетка), фазы раунда, очки,
//  слова из символов и таймер.  Запуск: node tests/modes-timer.test.js
// ===========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n    ${err && err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'условие не выполнено');
}
function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'не равно'}: получено ${a}, ожидалось ${b}`);
}

function loadCore() {
  const store = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
    fetch: async () => {
      throw new Error('в этих тестах сеть не нужна');
    },
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(CORE, vm.createContext(sandbox), { filename: 'core.js' });
  return { WV: sandbox.window.WVote, store };
}

const { WV } = loadCore();
const T = (min, sec = 0) => new Date(Date.UTC(2026, 9, 27, 18, min, sec)).toISOString();

console.log('\nслова-символы');
check('parseWords сохраняет «+», «++», «?!» и не теряет обычные слова', () => {
  eq(WV.parseWords('+, ++, ?!, win'), ['+', '++', '?!', 'win']);
  eq(WV.parseWords('  ,  ,'), []);
  eq(WV.parseWords('Win, :победа!, ВИН, win'), ['win', 'победа', 'вин']);
});
check('normalizeWord не съедает символы, но чистит пунктуацию', () => {
  eq(WV.normalizeWord('+'), '+');
  eq(WV.normalizeWord('  Победа!  '), 'победа');
  eq(WV.normalizeWord(':луз:'), 'луз');
  eq(WV.normalizeWord(':win:'), 'win');
});
check('detectVote ловит символьные слова', () => {
  const words = { win: ['+'], lose: ['-'] };
  eq(WV.detectVote('+', words), 'win');
  eq(WV.detectVote(' + ', words), 'win');
  eq(WV.detectVote(':+:', words), 'win');
  eq(WV.detectVote('-', words), 'lose');
  eq(WV.detectVote('++', words), null); // сообщение целиком не совпало
  eq(WV.detectVote('я за +', words), null);
});
check('старое поведение не сломалось', () => {
  eq(WV.detectVote('WIN!'), 'win');
  eq(WV.detectVote(':KEKwAIT: lose'), 'lose');
  eq(WV.detectVote(':win:'), 'win');
  eq(WV.detectVote(':KEKwAIT:'), null);
  eq(WV.detectVote('winwin'), null);
});

console.log('\nварианты раунда');
check('у классики два варианта с ключами win/lose', () => {
  const opts = WV.roundOptions({ words: { win: ['win', 'вин'], lose: ['lose'] } });
  eq(opts.map((o) => o.key), ['win', 'lose']);
  eq(opts.map((o) => o.label), ['win', 'lose']);
  eq(opts[0].words, ['win', 'вин']);
});
check('у опроса свои варианты и ключи', () => {
  const round = {
    mode: 'poll',
    options: [
      { key: 'p1', label: 'да', words: ['да', 'конечно'] },
      { key: 'p2', label: 'нет', words: ['нет'] },
    ],
  };
  eq(WV.roundOptions(round).map((o) => o.key), ['p1', 'p2']);
  eq(WV.matchOption('конечно', WV.roundOptions(round)), 'p1');
  eq(WV.matchOption('НЕТ!', WV.roundOptions(round)), 'p2');
  eq(WV.matchOption('может', WV.roundOptions(round)), null);
});
check('у рулетки вариантов нет, есть слово участия', () => {
  eq(WV.roundOptions({ mode: 'roll' }), []);
  eq(WV.roundEntryWords({ mode: 'roll', entryWords: ['+'] }), ['+']);
  eq(WV.roundEntryWords({ mode: 'roll' }), ['+']); // по умолчанию «+»
  eq(WV.voteKeyFor('+', { mode: 'roll', entryWords: ['+'] }), 'enter');
  eq(WV.voteKeyFor('++', { mode: 'roll', entryWords: ['+'] }), null);
});
check('normalizePollOptions: минимум два, максимум 100, без повторов', () => {
  const one = WV.normalizePollOptions([{ words: ['да'] }]);
  eq(one.length, 2); // одного мало — берём значения по умолчанию
  const nine = WV.normalizePollOptions(
    Array.from({ length: 9 }, (_, i) => ({ words: ['в' + i] }))
  );
  eq(nine.length, 9);
  eq(nine.map((o) => o.key).slice(0, 3), ['p1', 'p2', 'p3']);
  const hundred = WV.normalizePollOptions(
    Array.from({ length: 130 }, (_, i) => ({ words: ['в' + i] }))
  );
  eq(hundred.length, 100);
  eq(hundred[99].key, 'p100');
  const dup = WV.normalizePollOptions([{ words: ['да', 'да', 'ДА'] }, { words: ['нет'] }]);
  eq(dup[0].words, ['да']);
});

console.log('\nфазы раунда');
check('новый раунд ждёт старта: ready, а не voting', () => {
  const round = { mode: 'poll', openedAt: null, votesClosedAt: null, outcome: null };
  eq(WV.roundPhase(round), 'ready');
  eq(WV.roundPhase({ ...round, openedAt: T(0) }), 'voting');
  eq(WV.roundPhase({ ...round, openedAt: T(0), votesClosedAt: T(5) }), 'awaiting');
  eq(WV.roundPhase({ ...round, openedAt: T(0), votesClosedAt: T(5), outcome: 'p1' }), 'finished');
  eq(WV.roundPhase(null), 'none');
});
check('у готового раунда голоса не считаются', () => {
  const round = { mode: 'poll', openedAt: null, options: [{ key: 'p1', words: ['да'] }, { key: 'p2', words: ['нет'] }] };
  const chat = [{ userId: 'u1', nickname: 'noxir', tags: [], content: 'да', ts: T(1) }];
  eq(WV.tallyVotes(chat, round), []);
});
check('normalizeMode: в настройках только опрос и рулетка', () => {
  eq(WV.normalizeMode('poll'), 'poll');
  eq(WV.normalizeMode('roll'), 'roll');
  eq(WV.normalizeMode('classic'), 'poll'); // старая настройка становится опросом
  eq(WV.normalizeMode('мусор'), 'poll');
  eq(WV.roundMode({ mode: 'classic' }), 'classic'); // а старый раунд остаётся собой
  eq(WV.roundMode({}), 'classic');
  eq(WV.roundMode({ mode: 'poll' }), 'poll');
});

console.log('\nочки за раунд');
check('clampPoints/roundPoints держат коридор 0…100', () => {
  eq(WV.clampPoints(3), 3);
  eq(WV.clampPoints('5'), 5);
  eq(WV.clampPoints(-2), 0);
  eq(WV.clampPoints(999), 100);
  eq(WV.clampPoints('abc'), 1);
  eq(WV.clampPoints(''), 1); // пустое поле — не «0 очков»
  eq(WV.clampPoints(null), 1);
  eq(WV.roundPoints({}), 1); // у старых раундов было 1 очко
  eq(WV.roundPoints({ points: 0 }), 0);
  eq(WV.roundPoints({ points: 7 }), 7);
});
check('computeScores начисляет очки раунда, а не фиксированное 1', () => {
  const rounds = [
    {
      index: 1,
      mode: 'poll',
      openedAt: T(0),
      votesClosedAt: T(10),
      outcome: 'p1',
      points: 3,
      options: [{ key: 'p1', words: ['да'] }, { key: 'p2', words: ['нет'] }],
      votes: [
        { userId: 'u1', nickname: 'noxir', vote: 'p1' },
        { userId: 'u2', nickname: 'dyson', vote: 'p2' },
      ],
    },
    {
      index: 2,
      mode: 'roll',
      openedAt: T(20),
      votesClosedAt: T(25),
      points: 5,
      awardWinner: true,
      winner: { userId: 'u2', nickname: 'dyson' },
      votes: [
        { userId: 'u1', nickname: 'noxir', vote: 'enter' },
        { userId: 'u2', nickname: 'dyson', vote: 'enter' },
      ],
    },
    {
      index: 3,
      mode: 'poll',
      openedAt: T(30),
      votesClosedAt: T(35),
      outcome: 'p1',
      points: 0,
      options: [{ key: 'p1', words: ['да'] }, { key: 'p2', words: ['нет'] }],
      votes: [{ userId: 'u1', nickname: 'noxir', vote: 'p1' }],
    },
  ];
  const scores = WV.computeScores(rounds);
  const by = Object.fromEntries(scores.map((p) => [p.nickname, p]));
  eq(by.noxir.points, 3); // 3 + 0
  eq(by.noxir.guessed, 2); // угаданных раундов два, но третий был за 0
  eq(by.dyson.points, 5);
  eq(by.dyson.rollWins, 1);
  eq(scores.map((p) => p.nickname), ['dyson', 'noxir']);
});
check('ручная правка очков считается поверх заработанных', () => {
  const rounds = [
    {
      index: 1,
      mode: 'poll',
      openedAt: T(0),
      votesClosedAt: T(10),
      outcome: 'p1',
      points: 4,
      options: [{ key: 'p1', words: ['да'] }, { key: 'p2', words: ['нет'] }],
      votes: [{ userId: 'u1', nickname: 'noxir', vote: 'p1' }],
    },
  ];
  const [player] = WV.computeScores(rounds, { u1: -2 });
  eq(player.points, 2);
  eq(player.adjust, -2);
});

console.log('\nголоса по режимам');
const msgs = [
  { userId: 'u1', nickname: 'noxir', tags: [], content: 'да', ts: T(1) },
  { userId: 'u2', nickname: 'dyson', tags: [], content: 'нет', ts: T(2) },
  { userId: 'u2', nickname: 'dyson', tags: [], content: 'да', ts: T(3) },
  { userId: 'u3', nickname: 'Orio', tags: [], content: '+', ts: T(4) },
  { userId: 'owner', nickname: 'Anakq', tags: [], content: '+', ts: T(5) },
  { userId: 'u4', nickname: 'late', tags: [], content: '+', ts: T(30) },
];
check('опрос: голоса считаются по ключам вариантов', () => {
  const round = {
    mode: 'poll',
    openedAt: T(0),
    votesClosedAt: T(10),
    options: [
      { key: 'p1', label: 'да', words: ['да'] },
      { key: 'p2', label: 'нет', words: ['нет'] },
    ],
    ownerUserId: 'owner',
  };
  const votes = WV.tallyVotes(msgs, round);
  eq(votes.map((v) => v.nickname).sort(), ['dyson', 'noxir']);
  eq(votes.find((v) => v.nickname === 'dyson').vote, 'p2'); // первое слово
  const revote = WV.tallyVotes(msgs, { ...round, allowRevote: true });
  eq(revote.find((v) => v.nickname === 'dyson').vote, 'p1');
});
check('рулетка: участники — только написавшие слово участия', () => {
  const round = { mode: 'roll', openedAt: T(0), votesClosedAt: T(10), entryWords: ['+'], ownerUserId: 'owner' };
  const votes = WV.tallyVotes(msgs, round);
  eq(votes.map((v) => v.nickname), ['Orio']); // dyson/noxir писали слова опроса, late — после закрытия
  eq(votes[0].vote, 'enter');
});
check('pickWinner выбирает из участников и не падает на пустом списке', () => {
  const list = [
    { userId: '1', nickname: 'a' },
    { userId: '2', nickname: 'b' },
    { userId: '3', nickname: 'c' },
  ];
  eq(WV.pickWinner(list, () => 0).nickname, 'a');
  eq(WV.pickWinner(list, () => 0.5).nickname, 'b');
  eq(WV.pickWinner(list, () => 0.999).nickname, 'c');
  eq(WV.pickWinner([], () => 0.5), null);
});

console.log('\nочки по режимам');
check('опрос: очко за победивший вариант', () => {
  const rounds = [
    {
      index: 1,
      mode: 'poll',
      outcome: 'p2',
      options: [
        { key: 'p1', label: 'да', words: ['да'] },
        { key: 'p2', label: 'нет', words: ['нет'] },
      ],
      votes: [
        { userId: 'u1', nickname: 'noxir', vote: 'p1' },
        { userId: 'u2', nickname: 'dyson', vote: 'p2' },
      ],
    },
  ];
  const list = WV.computeScores(rounds);
  eq(list[0].nickname, 'dyson');
  eq(list[0].points, 1);
  eq(list[1].guessed, 0);
});
check('рулетка: победитель получает +1, участники — нет', () => {
  const round = {
    index: 1,
    mode: 'roll',
    awardWinner: true,
    winner: { userId: 'u2', nickname: 'dyson' },
    votes: [
      { userId: 'u1', nickname: 'noxir', vote: 'enter' },
      { userId: 'u2', nickname: 'dyson', vote: 'enter' },
    ],
  };
  const list = WV.computeScores([round]);
  eq(list[0].nickname, 'dyson');
  eq(list[0].points, 1);
  eq(list[0].rollWins, 1);
  eq(list[0].guessed, 0);
  eq(list.find((p) => p.nickname === 'noxir').points, 0);
});
check('рулетка без очков: победитель есть, очков нет', () => {
  const round = {
    index: 1,
    mode: 'roll',
    awardWinner: false,
    winner: { userId: 'u2', nickname: 'dyson' },
    votes: [{ userId: 'u2', nickname: 'dyson', vote: 'enter' }],
  };
  const list = WV.computeScores([round]);
  eq(list[0].points, 0);
  eq(list[0].rollWins, 0);
});
check('фазы: рулетка завершена, когда выбран победитель', () => {
  const round = { mode: 'roll', openedAt: T(0), votesClosedAt: T(10), winner: null };
  eq(WV.roundPhase(round), 'awaiting');
  round.winner = { userId: 'u1', nickname: 'noxir' };
  eq(WV.roundPhase(round), 'finished');
});
check('старые раунды без mode остаются классикой', () => {
  const { WV: W2, store } = loadCore();
  W2.saveState(
    {
      ...W2.emptyState(),
      rounds: [{ index: 1, outcome: 'win', closedAt: T(10), votes: [{ userId: 'u1', nickname: 'noxir', vote: 'win' }] }],
    },
    'k'
  );
  const loaded = W2.loadState('k');
  eq(loaded.rounds[0].mode, 'classic');
  eq(loaded.rounds[0].votesClosedAt, T(10));
  eq(W2.computeScores(loaded.rounds)[0].points, 1);
  assert(store.size >= 0);
});

console.log('\nтаймер раунда');
check('roundTimerSeconds: 0 — таймера нет, мусор не ломает', () => {
  eq(WV.roundTimerSeconds({}), 0);
  eq(WV.roundTimerSeconds({ timerSeconds: 0 }), 0);
  eq(WV.roundTimerSeconds({ timerSeconds: 'abc' }), 0);
  eq(WV.roundTimerSeconds({ timerSeconds: 90 }), 90);
  eq(WV.roundTimerSeconds({ timerSeconds: 99999 }), 3600);
});
check('roundDeadline/roundTimeLeft считают от старта раунда', () => {
  const round = { openedAt: T(0), timerSeconds: 60 };
  eq(WV.roundDeadline(round), Date.parse(T(0)) + 60000);
  eq(WV.roundTimeLeft(round, Date.parse(T(0)) + 15000), 45000);
  eq(WV.roundTimeLeft(round, Date.parse(T(0)) + 90000), 0);
  eq(WV.roundTimeLeft({ openedAt: T(0) }, Date.parse(T(0))), null);
});
check('таймер, включённый посреди раунда, считается от timerStartedAt', () => {
  const round = { openedAt: T(0), timerStartedAt: T(5), timerSeconds: 60 };
  eq(WV.roundDeadline(round), Date.parse(T(5)) + 60000);
});
check('formatDuration: 0:05 / 12:30 / 1:02:00', () => {
  eq(WV.formatDuration(5000), '0:05');
  eq(WV.formatDuration(750000), '12:30');
  eq(WV.formatDuration(3720000), '1:02:00');
  eq(WV.formatDuration(0), '0:00');
});
check('clampTimerSeconds держит коридор 5…3600', () => {
  eq(WV.clampTimerSeconds(1), 5);
  eq(WV.clampTimerSeconds(99999), 3600);
  eq(WV.clampTimerSeconds('abc'), 60);
  eq(WV.clampTimerSeconds(0), 60);
  eq(WV.clampTimerSeconds(-5), 60);
});

console.log('\nнастройки');
check('emptyState: по умолчанию опрос, очко за раунд, таймер выключен', () => {
  const st = WV.emptyState();
  eq(st.settings.mode, 'poll');
  eq(st.settings.timerEnabled, false);
  eq(st.settings.rollWords, ['+']);
  eq(st.settings.pollOptions.length, 2);
  eq(st.settings.pointsPerWin, 1);
  eq(st.settings.pollAutoWinner, false);
});
check('normalizeSettings: очки классики переносятся в варианты опроса', () => {
  const s = WV.normalizeSettings({ mode: 'classic', words: { win: ['победа'], lose: ['луз'] } });
  eq(s.mode, 'poll');
  eq(s.words, undefined);
  eq(s.pollOptions.map((o) => o.words), [['победа'], ['луз']]);
});
check('normalizeSettings: таймер, режим и очки по умолчанию', () => {
  const s = WV.normalizeSettings({ allowRevote: true });
  eq(s.mode, 'poll');
  eq(s.timerEnabled, false);
  eq(s.timerSeconds, 60);
  eq(s.allowRevote, true);
  eq(s.rollAward, true);
  eq(s.pointsPerWin, 1);
});
check('normalizeSettings: битые значения не ломают интерфейс', () => {
  const s = WV.normalizeSettings({
    mode: 'нечто',
    words: { win: [], lose: [''] },
    pollOptions: 'мусор',
    rollWords: ['  '],
    timerSeconds: -3,
    pollSeconds: 999,
    pointsPerWin: 'много',
  });
  eq(s.mode, 'poll');
  eq(s.pollOptions.length, 2);
  eq(s.rollWords, ['+']);
  eq(s.timerSeconds, 60);
  eq(s.pollSeconds, 30);
  eq(s.pointsPerWin, 1);
});
check('нормализация символьных слов в настройках', () => {
  const s = WV.normalizeSettings({ mode: 'classic', words: { win: ['+'], lose: ['-'] }, rollWords: ['+', '++'] });
  eq(s.pollOptions.map((o) => o.words), [['+'], ['-']]);
  eq(s.rollWords, ['+', '++']);
});

console.log('\nпобедитель по большинству');
check('pollLeader: явный лидер', () => {
  const options = [{ key: 'p1', words: ['да'] }, { key: 'p2', words: ['нет'] }, { key: 'p3', words: ['может'] }];
  const votes = [
    { userId: 'u1', vote: 'p2' },
    { userId: 'u2', vote: 'p2' },
    { userId: 'u3', vote: 'p1' },
  ];
  const lead = WV.pollLeader(votes, options);
  eq(lead.key, 'p2');
  eq(lead.count, 2);
  eq(lead.tied, ['p2']);
});
check('pollLeader: ничья и пустой опрос', () => {
  const options = [{ key: 'p1', words: ['да'] }, { key: 'p2', words: ['нет'] }];
  const tie = WV.pollLeader([{ userId: 'u1', vote: 'p1' }, { userId: 'u2', vote: 'p2' }], options);
  eq(tie.key, null);
  eq(tie.tied, ['p1', 'p2']);
  const empty = WV.pollLeader([], options);
  eq(empty.key, null);
  eq(empty.tied, []);
});

console.log('\nподписи для экспорта');
check('modeLabel/outcomeLabel', () => {
  eq(WV.modeLabel('classic'), 'победа/поражение'); // только старые раунды
  eq(WV.modeLabel('poll'), 'опрос');
  eq(WV.modeLabel('roll'), 'рулетка');
  eq(WV.outcomeLabel({ outcome: 'win' }), 'победа');
  eq(WV.outcomeLabel({ outcome: 'lose' }), 'поражение');
  eq(WV.outcomeLabel({ mode: 'poll', outcome: 'p2', options: [{ key: 'p1', words: ['да'] }, { key: 'p2', words: ['нет'] }] }), 'нет');
  eq(WV.outcomeLabel({ mode: 'roll', winner: { nickname: 'Orio' } }), 'рулетка: Orio');
  eq(WV.outcomeLabel({ mode: 'roll', winner: null }), 'не разыгран');
});

console.log(`\n${passed} проверок пройдено, ${failures.length} провалено`);
if (failures.length) {
  for (const f of failures) console.log(`\n✗ ${f.name}\n${f.err && f.err.stack}`);
  process.exit(1);
}
