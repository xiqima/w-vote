// ===========================================================================
//  worker.js — свой посредник для чтения публичных данных w.tv.
//
//  Зачем: у w.tv CORS разрешён только для https://w.tv, поэтому браузер не
//  может читать их API с нашего сайта. Этот воркер работает на Cloudflare
//  (бесплатно) и добавляет нужный заголовок.
//
//  Как поставить (2 минуты, без установки программ):
//   1. https://dash.cloudflare.com/sign-up — регистрация.
//   2. Workers & Pages → Create → Worker → имя → Deploy.
//   3. Edit code → вставить этот файл целиком → Deploy.
//   4. Получится адрес https://имя.аккаунт.workers.dev
//   5. На сайте w-vote: «Данные и подключение» → «Свой прокси для чата»
//      вставить: https://имя.аккаунт.workers.dev/?url={url}
//
//  Формат модуля (export default) — так Cloudflare Workers работают по
//  умолчанию. Старый вариант с addEventListener('fetch') в модульных воркерах
//  НЕ работает: воркер разворачивается, но на каждый запрос отдаёт ошибку.
// ===========================================================================

const ALLOWED = ['profiles-service.w.tv', 'chats-service.w.tv'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('нужен параметр ?url=', { status: 400, headers: CORS });

    let url;
    try {
      url = new URL(target);
    } catch {
      return new Response('плохой адрес', { status: 400, headers: CORS });
    }
    if (!ALLOWED.includes(url.hostname)) {
      return new Response('домен не разрешён', { status: 403, headers: CORS });
    }

    let upstream;
    try {
      upstream = await fetch(url.toString(), {
        headers: {
          'User-Agent': UA, // без браузерного UA CloudFront отдаёт 403
          Origin: 'https://w.tv',
          Referer: 'https://w.tv/',
          Accept: 'application/json',
        },
        cf: { cacheTtl: 0 },
      });
    } catch (err) {
      return new Response(`w.tv не ответил: ${String((err && err.message) || err)}`, {
        status: 502,
        headers: CORS,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS,
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  },
};
