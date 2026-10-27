// ===========================================================================
//  tests/core.test.js — проверки логики core.js.  Запуск: node tests/core.test.js
//  Без зависимостей: core.js грузится в песочницу vm, fetch подменяется.
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
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        () => {
          passed++;
          console.log(`  ✓ ${name}`);
        },
        (err) => {
          failures.push({ name, err });
          console.log(`  ✗ ${name}\n    ${err && err.message}`);
        }
      );
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n    ${err && err.message}`);
  }
  return Promise.resolve();
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'условие не выполнено');
}
function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'не равно'}: получено ${a}, ожидалось ${b}`);
}

/** загружает core.js в отдельную песочницу с подставными fetch и localStorage */
function loadCore(fetchImpl) {
  const store = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: fetchImpl || (async () => { throw new Error('нет сети'); }),
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CORE, ctx, { filename: 'core.js' });
  return { WV: sandbox.window.WVote, store };
}

const PROFILE_OK = JSON.stringify({ profile: { userId: 'user-1', nickname: 'Anakq' }, tags: [] });
const PROFILE_404 = JSON.stringify({ errors: [{ code: 'NICKNAME_NOT_FOUND' }] });
const MSG_OK = JSON.stringify({
  messages: [
    {
      messageId: 'm1',
      type: 'MESSAGE',
      sender: { userId: 'u1', nickname: 'noxir', tags: [] },
      content: 'win',
      createdAt: '2026-10-27T18:00:00.000Z',
    },
  ],
});

/** простой ответ на fetch */
function reply(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

(async function run() {
  console.log('\ncore.js: разбор сообщений и голоса');
  {
    const { WV } = loadCore();
    await check('normalizeMessage убирает эмоуты, регистр и пунктуацию', () => {
      eq(WV.normalizeMessage(':KEKwAIT: WIN!'), 'win');
      eq(WV.normalizeMessage('  Win  '), 'win');
      eq(WV.normalizeMessage('я за win'), 'я за win');
    });
    await check('normalizeMessage читает голос в формате :слово:', () => {
      eq(WV.normalizeMessage(':win:'), 'win');
      eq(WV.normalizeMessage(':Победа!'), 'победа');
      // настоящий эмоут голосом не становится: его «имя» не совпадает со словами-голосами
      eq(WV.detectVote(':KEKwAIT:'), null);
      eq(WV.detectVote(':win:'), 'win');
    });
    await check('detectVote: голос — только сообщение целиком', () => {
      eq(WV.detectVote('WIN!'), 'win');
      eq(WV.detectVote(':KEKwAIT: lose'), 'lose');
      eq(WV.detectVote('я за win'), null);
      eq(WV.detectVote('winwin'), null);
      eq(WV.detectVote('lose', { win: ['win'], lose: ['луз'] }), null);
    });
    await check('parseWords нормализует слова и убирает дубли', () => {
      eq(WV.parseWords('Win, :победа!, ВИН, win'), ['win', 'победа', 'вин']);
      eq(WV.wordsToText(['win', 'победа']), 'win, победа');
    });
    await check('normalizeChannelInput понимает ссылку, @ник и мусор', () => {
      eq(WV.normalizeChannelInput('https://w.tv/anakq?x=1'), 'anakq');
      eq(WV.normalizeChannelInput('www.w.tv/Anakq/'), 'Anakq');
      eq(WV.normalizeChannelInput('@anakq'), 'anakq');
      eq(WV.normalizeChannelInput('  '), '');
    });
  }

  console.log('\ncore.js: раунды, голоса, очки');
  {
    const { WV } = loadCore();
    const round = {
      openedAt: '2026-10-27T18:00:00.000Z',
      votesClosedAt: '2026-10-27T18:10:00.000Z',
      allowRevote: false,
      words: { win: ['win'], lose: ['lose'] },
      ownerUserId: 'owner',
    };
    const msgs = [
      { userId: 'owner', nickname: 'Anakq', tags: [], content: 'win', ts: '2026-10-27T18:01:00.000Z' },
      { userId: 'u1', nickname: 'noxir', tags: [], content: 'win', ts: '2026-10-27T18:01:00.000Z' },
      { userId: 'u2', nickname: 'dyson', tags: [], content: 'lose', ts: '2026-10-27T18:02:00.000Z' },
      { userId: 'u2', nickname: 'dyson', tags: [], content: 'win', ts: '2026-10-27T18:03:00.000Z' },
      { userId: 'u3', nickname: 'late', tags: [], content: 'win', ts: '2026-10-27T18:20:00.000Z' },
      { userId: 'u4', nickname: 'early', tags: [], content: 'win', ts: '2026-10-27T17:59:00.000Z' },
    ];
    await check('tallyVotes: стример, опоздавшие и ранние не считаются', () => {
      const votes = WV.tallyVotes(msgs, round);
      eq(votes.map((v) => v.nickname).sort(), ['dyson', 'noxir']);
      eq(votes.find((v) => v.nickname === 'dyson').vote, 'lose'); // первый голос
    });
    await check('tallyVotes: при переголосовании считается последнее слово', () => {
      const votes = WV.tallyVotes(msgs, { ...round, allowRevote: true });
      eq(votes.find((v) => v.nickname === 'dyson').vote, 'win');
    });
    await check('computeScores: очки = угаданные + правка', () => {
      const rounds = [
        { index: 1, outcome: 'win', votes: [{ userId: 'u1', nickname: 'noxir', vote: 'win' }, { userId: 'u2', nickname: 'dyson', vote: 'lose' }] },
        { index: 2, outcome: 'lose', votes: [{ userId: 'u1', nickname: 'noxir', vote: 'lose' }] },
      ];
      const list = WV.computeScores(rounds, { u2: 2 });
      eq(list[0].nickname, 'noxir');
      eq(list[0].points, 2);
      eq(list.find((p) => p.nickname === 'dyson').points, 2);
      eq(list.find((p) => p.nickname === 'dyson').guessed, 0);
    });
    await check('computeScores: раунд без отдельной остановки приёма тоже даёт очки', () => {
      const rounds = [{ index: 1, outcome: 'win', closedAt: '2026-10-27T18:10:00.000Z', votes: [{ userId: 'u1', nickname: 'noxir', vote: 'win' }] }];
      eq(WV.computeScores(rounds)[0].points, 1);
    });
    await check('migrateRound переносит старый формат closedAt', () => {
      const { WV: W2 } = loadCore();
      W2.saveState(
        { ...W2.emptyState(), rounds: [{ index: 1, outcome: 'win', closedAt: '2026-10-27T18:10:00.000Z', votes: [] }] },
        'k'
      );
      const loaded = W2.loadState('k');
      eq(loaded.rounds[0].votesClosedAt, '2026-10-27T18:10:00.000Z');
      eq(loaded.rounds[0].decidedAt, '2026-10-27T18:10:00.000Z');
      eq(loaded.rounds[0].closedAt, undefined);
    });
    await check('пустое хранилище даёт состояние по умолчанию', () => {
      const st = WV.loadState('нет-такого-ключа');
      eq(st.version, 2);
      eq(st.settings.words, { win: ['win'], lose: ['lose'] });
      assert(Array.isArray(st.rounds));
    });
  }

  console.log('\ncore.js: сеть к w.tv (fetch подменён)');
  {
    // только allorigins отвечает, остальные «падают»
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      if (url.includes('allorigins.win/raw')) return reply(PROFILE_OK);
      throw new Error('Failed to fetch');
    };
    const { WV, store } = loadCore(fakeFetch);

    await check('proxies: свой прокси первым, публичные + direct на месте', () => {
      const list = WV.proxies('https://my.workers.dev/?url={url}');
      eq(list[0].id, 'custom');
      assert(list.some((p) => p.id === 'jina'), 'нет jina');
      assert(list.some((p) => p.id === 'allorigins'), 'нет allorigins');
      assert(list.some((p) => p.id === 'direct'), 'нет direct');
      eq(list[0].build('https://x/y'), 'https://my.workers.dev/?url=' + encodeURIComponent('https://x/y'));
    });

    await check('fetchProfile находит ник, когда отвечает только один посредник', async () => {
      const profile = await WV.fetchProfile('anakq');
      eq(profile, { userId: 'user-1', nickname: 'Anakq' });
    });

    await check('рабочий способ запомнен в localStorage и идёт первым', async () => {
      const saved = JSON.parse(store.get('wtv_vote_net_v1'));
      eq(saved.preferred, 'allorigins');
      eq(WV.preferredProxyId(), 'allorigins');
      // второй запрос — короткий путь: один запрос вместо гонки
      calls.length = 0;
      await WV.fetchProfile('anakq');
      eq(calls.length, 1);
      assert(calls[0].includes('allorigins.win/raw'), 'пошёл не через запомненный способ');
    });

    await check('гонка: неверные способы не мешают верному (порядок не важен)', async () => {
      // jina отвечает HTML-заглушкой, codetabs таймаутом, allorigins — данными
      const { WV: W2 } = loadCore(async (url) => {
        if (url.includes('r.jina.ai')) return reply('<html>Request blocked</html>');
        if (url.includes('codetabs')) return new Promise(() => {}); // «висит»
        if (url.includes('allorigins')) return reply(MSG_OK);
        throw new Error('Failed to fetch');
      });
      const messages = await W2.fetchMessages('user-1');
      eq(messages.length, 1);
      eq(messages[0].nickname, 'noxir');
      eq(messages[0].ts, '2026-10-27T18:00:00.000Z');
    });

    await check('HTML вместо JSON не считается успехом', async () => {
      const { WV: W2 } = loadCore(async () => reply('<html><body>403 ERROR</body></html>'));
      let error = null;
      try {
        await W2.fetchProfile('anakq');
      } catch (err) {
        error = err;
      }
      assert(error, 'ошибка не возникла');
      eq(error.code, 'network');
      assert(Array.isArray(error.details) && error.details.length > 0, 'нет подробностей');
      assert(/отклонил|не JSON/.test(error.details.join(' ')), 'непонятная причина: ' + error.details.join('; '));
    });

    await check('«все способы в паузе» всё равно пробуем', async () => {
      let attempts = 0;
      const { WV: W2, store: st2 } = loadCore(async () => {
        attempts += 1;
        throw new Error('Failed to fetch');
      });
      for (let i = 0; i < 2; i++) {
        try {
          await W2.fetchProfile('anakq');
        } catch {}
      }
      const cooling = JSON.parse(st2.get('wtv_vote_net_v1')).health;
      assert(Object.values(cooling).every((h) => h.coolUntil > Date.now()), 'способы не ушли в паузу');
      attempts = 0;
      try {
        await W2.fetchProfile('anakq');
      } catch {}
      assert(attempts > 0, 'после паузы запросы не выполнялись вовсе');
    });

    await check('NICKNAME_NOT_FOUND — это ответ, а не сбой связи', async () => {
      const { WV: W2 } = loadCore(async () => reply(PROFILE_404));
      let error = null;
      try {
        await W2.fetchProfile('нет-такого-ника');
      } catch (err) {
        error = err;
      }
      assert(error, 'ошибка не возникла');
      eq(error.code, 'channel_not_found');
    });

    await check('ник в другом регистре: пробуем строчными', async () => {
      const seen = [];
      const { WV: W2 } = loadCore(async (url) => {
        seen.push(url);
        return url.includes('/Anakq?') ? reply(PROFILE_404) : reply(PROFILE_OK);
      });
      const profile = await W2.fetchProfile('Anakq');
      eq(profile.userId, 'user-1');
      assert(seen.some((u) => u.includes('/anakq?')), 'строчный вариант не пробовали');
    });

    await check('ID канала (UUID) принимается без сервиса профилей', async () => {
      let called = 0;
      const { WV: W2 } = loadCore(async () => {
        called += 1;
        return reply(MSG_OK);
      });
      eq(W2.looksLikeUserId('019faa83-197b-7400-8c49-28c8a8d16346'), true);
      eq(W2.looksLikeUserId('anakq'), false);
      const profile = await W2.fetchProfile('019faa83-197b-7400-8c49-28c8a8d16346');
      eq(profile, { userId: '019faa83-197b-7400-8c49-28c8a8d16346', nickname: '019faa83-197b-7400-8c49-28c8a8d16346', byId: true });
      eq(called, 0);
    });

    await check('probeProxies объясняет причину по каждому способу', async () => {
      const { WV: W2 } = loadCore(async (url) => {
        if (url.includes('r.jina.ai')) return reply(PROFILE_OK);
        if (url.includes('allorigins.win/get')) return reply('не json вовсе');
        if (url.includes('cors.lol')) return reply('slow down', 429);
        throw new Error('Failed to fetch');
      });
      const results = await W2.probeProxies('https://x/y');
      const jina = results.find((r) => r.id === 'jina');
      assert(jina && jina.ok, 'jina не отмечен рабочим');
      eq(results[0].ok, true); // рабочие сверху
      const cl = results.find((r) => r.id === 'corslol');
      eq(cl.error, 'лимит запросов');
      const ao = results.find((r) => r.id === 'allorigins_json');
      eq(ao.error, 'ответ не JSON');
    });

    await check('свой прокси имеет приоритет и получает шаблон {url}', async () => {
      const seen = [];
      const { WV: W2 } = loadCore(async (url) => {
        seen.push(url);
        return reply(PROFILE_OK);
      });
      await W2.fetchProfile('anakq', 'https://me.workers.dev/?url={url}');
      assert(seen[0].startsWith('https://me.workers.dev/?url='), 'свой прокси не первый: ' + seen[0]);
    });
  }

  console.log(`\n${passed} проверок пройдено, ${failures.length} провалено`);
  if (failures.length) {
    for (const f of failures) console.log(`\n✗ ${f.name}\n${f.err && f.err.stack}`);
    process.exit(1);
  }
})();
