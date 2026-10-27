// ===========================================================================
//  tests/phases-export.test.js — фазы раунда и экспорт (.xlsx/.csv/.txt).
//  Запуск: node tests/phases-export.test.js
// ===========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8');

let passed = 0;
const failures = [];
let queue = Promise.resolve();

function check(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  ✗ ${name}\n    ${err && err.message}`);
    }
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'условие не выполнено');
}
function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'не равно'}: получено ${a}, ожидалось ${b}`);
}

const store = new Map();
const sandbox = {
  window: {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
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
const WV = sandbox.window.WVote;

const T = (min) => new Date(Date.UTC(2026, 9, 27, 18, min, 0)).toISOString();

console.log('\nфазы раунда');
check('none → voting → awaiting → finished', () => {
  eq(WV.roundPhase(null), 'none');
  const r = { openedAt: T(0), votesClosedAt: null, outcome: null };
  eq(WV.roundPhase(r), 'voting');
  r.votesClosedAt = T(10);
  eq(WV.roundPhase(r), 'awaiting');
  r.outcome = 'win';
  r.decidedAt = T(20);
  eq(WV.roundPhase(r), 'finished');
});
check('старый формат: closedAt считается концом приёма голосов', () => {
  eq(WV.votesEnd({ closedAt: T(10) }), T(10));
  eq(WV.votesEnd({ votesClosedAt: T(12), closedAt: T(10) }), T(12));
  eq(WV.votesEnd({}), null);
});
check('возобновление приёма: votesClosedAt = null снова даёт фазу voting', () => {
  const r = { openedAt: T(0), votesClosedAt: null, outcome: null, decidedAt: null };
  eq(WV.roundPhase(r), 'voting');
  r.votesClosedAt = T(5);
  eq(WV.roundPhase(r), 'awaiting');
  r.votesClosedAt = null;
  eq(WV.roundPhase(r), 'voting');
});

console.log('\nэкспорт: строки и текст');
const rounds = [
  {
    index: 1,
    openedAt: T(0),
    votesClosedAt: T(10),
    outcome: 'win',
    votes: [
      { userId: 'u1', nickname: 'noxir', vote: 'win' },
      { userId: 'u2', nickname: 'dyson', vote: 'lose' },
      { userId: 'u3', nickname: 'Orio', vote: 'win' },
    ],
  },
  { index: 2, openedAt: T(20), votesClosedAt: null, outcome: null, votes: [] },
];
const scores = WV.computeScores(rounds);

check('лист «Лидеры»: шапка и строки по очкам', () => {
  const rows = WV.exportLeadersRows(scores);
  eq(rows[0], ['Место', 'Ник', 'Очки', 'Угадал', 'Голосовал', 'Серия подряд', 'Правка вручную']);
  eq(rows.slice(1).map((r) => r[0]), [1, 2, 3]);
  eq(rows.slice(1).map((r) => r[2]), [1, 1, 0]);
  // при равных очках — по нику (Orio раньше noxir), никто не теряется
  eq(rows.slice(1).map((r) => r[1]), ['Orio', 'noxir', 'dyson']);
});
check('лист «Раунды»: голоса по словам и исход', () => {
  const rows = WV.exportRoundsRows(rounds, { win: ['win'], lose: ['lose'] });
  eq(rows[0].slice(0, 3), ['№', 'Начало', 'Голоса до']);
  eq(rows[1].slice(4, 8), [2, 1, 3, 2]); // win / lose / всего / угадали
  eq(rows[1][8], 'победа/поражение'); // режим
  eq(rows[1].length, rows[0].length, 'ширина строк не совпадает с шапкой');
  eq(rows[2][3], 'не объявлен');
});
check('CSV: BOM, «;» и экранирование кавычек', () => {
  const csv = WV.makeCsv([
    ['Ник', 'Текст'],
    ['п "кавычками"', 'a;b'],
  ]);
  assert(csv.startsWith('\uFEFF'), 'нет BOM');
  assert(csv.includes('"п ""кавычками"""'), 'кавычки не экранированы: ' + csv);
  assert(csv.includes('"a;b"'), 'точка с запятой не экранирована: ' + csv);
});
check('TXT: читаемый отчёт с заголовками', () => {
  const txt = WV.makeTxt([
    { title: 'Таблица лидеров', rows: WV.exportLeadersRows(scores) },
    { title: 'Раунды', rows: WV.exportRoundsRows(rounds, { win: ['win'], lose: ['lose'] }) },
  ]);
  assert(/noxir/.test(txt), 'нет ника');
  assert(/Раунды/.test(txt), 'нет раздела раундов');
  assert(txt.includes('─'), 'нет подчёркивания шапки');
  assert(txt.endsWith('\n'), 'нет перевода строки в конце');
});

console.log('\nэкспорт: .xlsx (zip собирается вручную)');
const bytes = WV.makeXlsx([
  { name: 'Лидеры', rows: WV.exportLeadersRows(scores) },
  { name: 'Раунды', rows: WV.exportRoundsRows(rounds, { win: ['win'], lose: ['lose'] }) },
  { name: 'Сводка', rows: [['Показатель', 'Значение'], ['Раундов', 2], ['Участников', scores.length]] },
]);
const text = Buffer.from(bytes).toString('utf8');

check('файл начинается с сигнатуры ZIP и содержит все части', () => {
  eq(bytes[0], 0x50); // P
  eq(bytes[1], 0x4b); // K
  for (const name of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
    'xl/worksheets/sheet3.xml',
  ]) {
    assert(text.includes(name), `нет части ${name}`);
  }
});
check('три листа с правильными именами', () => {
  const wb = text.slice(text.indexOf('<workbook'), text.indexOf('</workbook>'));
  for (const name of ['Лидеры', 'Раунды', 'Сводка']) assert(wb.includes(`name="${name}"`), `нет листа ${name}`);
  eq((wb.match(/<sheet /g) || []).length, 3);
});
check('числа — числами, текст — inlineStr, амперсанды экранированы', () => {
  const sheet = text.slice(text.indexOf('<worksheet'), text.indexOf('</worksheet>'));
  assert(/<c r="A2"[^>]*><v>1<\/v><\/c>/.test(sheet), 'число не записано как число');
  assert(sheet.includes('t="inlineStr"'), 'нет текстовых ячеек');
  const esc = WV.makeXlsx([{ name: 'Тест', rows: [['a & b < c']] }]);
  const escText = Buffer.from(esc).toString('utf8');
  assert(escText.includes('a &amp; b &lt; c'), 'нет экранирования XML');
});
check('zip: корректные записи центрального каталога', () => {
  const buf = Buffer.from(bytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(eocd > 0, 'нет end-of-central-directory');
  const entries = buf.readUInt16LE(eocd + 10);
  eq(entries, 8, 'неверное число файлов в zip');
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert(cdOffset + cdSize <= eocd, 'центральный каталог выходит за файл');
  assert(buf.slice(cdOffset, cdOffset + 4).equals(Buffer.from([0x50, 0x4b, 0x01, 0x02])), 'плохая сигнатура каталога');
});

console.log('\nрежимы: колесо и опрос');
check('tallyVotes: колесо берёт только тех, кто написал слово-вход', () => {
  const r = {
    mode: 'wheel',
    entries: ['+'],
    openedAt: T(0),
    votesClosedAt: null,
    ownerUserId: 'owner',
  };
  const votes = WV.tallyVotes(
    [
      { id: '1', ts: T(1), userId: 'u1', nickname: 'a', content: '+' },
      { id: '2', ts: T(2), userId: 'u2', nickname: 'b', content: '+' },
      { id: '3', ts: T(3), userId: 'u3', nickname: 'c', content: 'привет' },
      { id: '4', ts: T(4), userId: 'owner', nickname: 'o', content: '+' },
    ],
    r
  );
  eq(votes.map((v) => v.nickname), ['b', 'a']);
  eq(votes[0].vote, '+');
});
check('tallyVotes: опрос понимает вариант словом и номером', () => {
  const r = { mode: 'poll', options: ['да', 'нет'], openedAt: T(0), votesClosedAt: null };
  const votes = WV.tallyVotes(
    [
      { id: '1', ts: T(1), userId: 'u1', nickname: 'a', content: 'ДА' },
      { id: '2', ts: T(2), userId: 'u2', nickname: 'b', content: '2' },
      { id: '3', ts: T(3), userId: 'u3', nickname: 'c', content: '3' },
      { id: '4', ts: T(4), userId: 'u4', nickname: 'd', content: 'ага' },
    ],
    r
  );
  eq(votes.map((v) => v.vote), [1, 0]);
  eq(WV.detectOption('2', ['да', 'нет']), 1);
  eq(WV.detectOption('нет!', ['да', 'нет']), 1);
  eq(WV.detectOption('3', ['да', 'нет']), -1);
});
check('pickWinner: одинаковый seed — одинаковый победитель', () => {
  const list = [{ userId: 'u1', nickname: 'a' }, { userId: 'u2', nickname: 'b' }];
  eq(WV.pickWinner(list, 'round:1'), WV.pickWinner(list, 'round:1'));
  eq(WV.pickWinner([], 'x'), null);
  // разные seed — победитель бывает разный (не всегда один и тот же)
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(WV.pickWinner(list, 'round:' + i).nickname);
  eq([...seen].sort(), ['a', 'b']);
});
check('computeScores: в колесе очко только победителю, опрос не даёт очков', () => {
  const wheelRounds = [
    {
      index: 1,
      mode: 'wheel',
      outcome: 'wheel',
      winner: { userId: 'u2', nickname: 'b' },
      votes: [
        { userId: 'u1', nickname: 'a', vote: '+' },
        { userId: 'u2', nickname: 'b', vote: '+' },
      ],
    },
    { index: 2, mode: 'poll', outcome: 'poll', votes: [{ userId: 'u1', nickname: 'a', vote: 0 }] },
  ];
  const scores = WV.computeScores(wheelRounds);
  eq(scores.map((p) => [p.nickname, p.points]), [['b', 1], ['a', 0]]);
});
check('roundDeadline / roundRemaining работают, 0 — без таймера', () => {
  const r = { openedAt: T(0), durationSec: 60 };
  eq(WV.roundDeadline(r), T(1));
  eq(WV.roundRemaining(r, new Date(T(0)).getTime()), 60);
  eq(WV.roundRemaining(r, new Date(T(2)).getTime()), 0);
  eq(WV.roundDeadline({ openedAt: T(0), durationSec: 0 }), null);
  eq(WV.clockText(65), '1:05');
  eq(WV.clockText(0), '0:00');
});
check('экспорт раундов: колесо и опрос попадают в отдельные строки', () => {
  const rows = WV.exportRoundsRows([
    { index: 1, mode: 'wheel', openedAt: T(0), votesClosedAt: T(5), outcome: 'wheel', winner: { userId: 'u2', nickname: 'dyson' }, votes: [{ userId: 'u1', nickname: 'a', vote: '+' }, { userId: 'u2', nickname: 'dyson', vote: '+' }] },
    { index: 2, mode: 'poll', question: 'Что дальше?', options: ['да', 'нет'], openedAt: T(10), votesClosedAt: T(20), outcome: 'poll', votes: [{ userId: 'u1', nickname: 'a', vote: 0 }, { userId: 'u2', nickname: 'b', vote: 0 }, { userId: 'u3', nickname: 'c', vote: 1 }] },
  ]);
  eq(rows[1][8], 'колесо');
  assert(/dyson/.test(rows[1][9]), 'нет победителя колеса');
  eq(rows[2][8], 'опрос');
  assert(/да: 2; нет: 1/.test(rows[2][9]), 'нет результатов опроса: ' + rows[2][9]);
  eq(rows.every((r) => r.length === rows[0].length), true, 'разная ширина строк');
});

queue.then(() => {
  console.log(`\n${passed} проверок пройдено, ${failures.length} провалено`);
  if (failures.length) {
    for (const f of failures) console.log(`\n✗ ${f.name}\n${f.err && f.err.stack}`);
    process.exit(1);
  }
});
