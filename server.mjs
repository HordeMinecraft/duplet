import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { bridgeConfig, startBridge } from './bridge.mjs';
import { openMysqlBans, startMysqlBanSync } from './mysql-bans.mjs';

const here = fileURLToPath(new URL('.',import.meta.url));
const publicDir = join(here,'public');
const env = process.env;
const data = resolve(env.SHOROH_WEB_DATA ?? join(here,'data'));
const billingEnabled = ['SHOROH_SHOP_ID','SHOROH_SHOP_KEY','SHOROH_PUBLIC_ORIGIN','SHOROH_VIP_RUB']
  .every(key => Boolean(env[key]));
const origin = billingEnabled ? new URL(env.SHOROH_PUBLIC_ORIGIN).origin : '';
const frontendOrigin = env.SHOROH_FRONTEND_ORIGIN ? new URL(env.SHOROH_FRONTEND_ORIGIN).origin : '';
const price = billingEnabled ? env.SHOROH_VIP_RUB : '';
const bridge = bridgeConfig(env,billingEnabled);
const payments = billingEnabled && bridge?.syncVip === true;
if (billingEnabled && (!origin.startsWith('https://') || !/^\d{1,6}\.\d{2}$/.test(price) || Number(price) <= 0)) {
  throw new Error('Payments require an HTTPS public origin and a positive RUB price with two decimals');
}
const address = env.SHOROH_GAME_ADDRESS ?? '';
if (address && !/^[a-z\d.-]+:\d{1,5}$/i.test(address)) throw new Error('Game address must use host:port');
const demo = env.SHOROH_PREVIEW === '1';
await mkdir(data,{recursive:true});
const mysqlBans = await openMysqlBans(env);
const store = openStore(join(data,'shoroh.sqlite'));
const stopBridge = bridge ? startBridge(store,bridge) : null;
const stopMysqlBans = mysqlBans ? startMysqlBanSync(mysqlBans,store) : null;
const staticFiles = new Map([
  ['/', 'index.html'], ['/app.css','app.css'], ['/app.js','app.js'], ['/duplet-hero.jpg','duplet-hero.jpg'],
  ['/favicon.svg','favicon.svg'], ['/welcome','welcome.html'], ['/emblem.gif','emblem.gif'],
]);
for (const file of ['rifles','pistols','other-rifles','bandage']) {
  for (const ext of ['jpg','gif']) {
    const path = 'animations/' + file + '.' + ext;
    staticFiles.set('/' + path,path);
  }
}
staticFiles.set('/animations/deagle-spin.gif','animations/deagle-spin.gif');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml'};
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const rateLimits = new Map();
const pendingCreates = new Map();
const pendingChecks = new Map();

function json(response, status, body) {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(body));
}

function limited(request, bucket, maximum) {
  const now = Date.now();
  const ip = request.socket.remoteAddress ?? 'unknown';
  const key = bucket + ':' + ip;
  let record = rateLimits.get(key);
  if (!record || record.until < now) record = {hits:0,until:now + 60_000};
  if (rateLimits.size > 4000) {
    for (const [entry,value] of rateLimits) if (value.until < now) rateLimits.delete(entry);
    if (rateLimits.size > 8000 && !rateLimits.has(key)) return true;
  }
  rateLimits.set(key,record);
  return ++record.hits > maximum;
}

async function requestJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw Object.assign(new Error('Ожидается JSON.'),{status:415});
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw Object.assign(new Error('Запрос слишком большой.'),{status:413});
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Не удалось прочитать запрос.'),{status:400});
  }
}

async function yookassa(endpoint, options = {}) {
  const result = await fetch('https://api.yookassa.ru/v3/payments' + endpoint,{
    method:options.method ?? 'GET',
    headers:{
      Authorization:'Basic ' + Buffer.from(env.SHOROH_SHOP_ID + ':' + env.SHOROH_SHOP_KEY).toString('base64'),
      ...(options.body ? {'Content-Type':'application/json','Idempotence-Key':options.key} : {}),
    },
    body:options.body ? JSON.stringify(options.body) : undefined,
    signal:AbortSignal.timeout(9000),
  });
  if (!result.ok) {
    console.error('YooKassa HTTP',result.status);
    throw Object.assign(new Error('Платёжный сервис временно недоступен. Повтори запрос.'),{status:502});
  }
  return result.json();
}

async function createPayment(order) {
  if (order.state !== 'created') return order;
  const existing = pendingCreates.get(order.id);
  if (existing) return existing;
  const pending = (async () => {
    const payment = await yookassa('',{
      method:'POST',key:order.id,
      body:{
        amount:{value:order.amount,currency:'RUB'},
        capture:true,
        confirmation:{type:'redirect',return_url:origin + '/?order=' + order.id + '#vip'},
        description:'Дуплет · Steam VIP на 7 дней',
        metadata:{order_id:order.id},
      },
    });
    const redirect = new URL(payment.confirmation?.confirmation_url);
    if (redirect.protocol !== 'https:' || !idPattern.test(payment.id) ||
        payment.metadata?.order_id !== order.id || payment.amount?.value !== order.amount ||
        payment.amount?.currency !== 'RUB') throw new Error('Unexpected payment provider response');
    store.rememberProvider(order.id,payment.id,redirect.href);
    return store.complete(order.id,payment);
  })();
  pendingCreates.set(order.id,pending);
  try { return await pending; } finally { pendingCreates.delete(order.id); }
}

async function checkPayment(order, force = false) {
  if (order.state !== 'pending') return order;
  const existing = pendingChecks.get(order.id);
  if (existing) return existing;
  if (!force && order.payment_checked > Math.floor(Date.now() / 1000) - 8) return order;
  const pending = (async () => {
    const payment = await yookassa('/' + order.provider_id);
    store.checked(order.id);
    return store.complete(order.id,payment);
  })();
  pendingChecks.set(order.id,pending);
  try { return await pending; } finally { pendingChecks.delete(order.id); }
}

const orderResult = order => ({
  id:order.id, state:order.state, vipUntil:order.vip_until,
  redirect:order.state === 'pending' ? order.redirect : null,
});

async function handle(request,response) {
  response.setHeader('X-Content-Type-Options','nosniff');
  response.setHeader('Referrer-Policy','no-referrer');
  const url = new URL(request.url,'http://localhost');
  const {pathname} = url;
  const publicData = pathname === '/api/status' || pathname === '/api/ranks' || pathname === '/api/bans';
  if (publicData && request.method === 'GET' && frontendOrigin) {
    response.setHeader('Vary','Origin');
    if (request.headers.origin === frontendOrigin) response.setHeader('Access-Control-Allow-Origin',frontendOrigin);
  }
  if (request.method === 'GET' && staticFiles.has(pathname)) {
    const name = staticFiles.get(pathname);
    const file = await readFile(join(publicDir,name)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!file) return json(response,404,{error:'Страница не найдена.'});
    response.writeHead(200,{'Content-Type':types[extname(name)],'Cache-Control':name.endsWith('.html') ? 'no-store' : 'public, max-age=300'});
    return response.end(file);
  }
  if (request.method === 'GET' && pathname === '/api/status') {
    const status = store.status();
    return json(response,200,{
      connected: status && status.at > Math.floor(Date.now() / 1000) - 80 ? status : null,
      lastSeen:status?.at ?? null,address,price:payments ? price : null,checkout:payments,preview:demo,
    });
  }
  if (request.method === 'GET' && pathname === '/api/ranks') return json(response,200,store.ranks());
  if (request.method === 'GET' && pathname === '/api/bans') {
    const query = (url.searchParams.get('q') ?? '').slice(0,64);
    const active = url.searchParams.get('active') === '1';
    const rows = mysqlBans && !store.hasPendingBans() ? await mysqlBans.list(query,active).catch(() => null) : null;
    return json(response,200,rows ?? store.bans(query,active));
  }
  if (request.method === 'POST' && pathname === '/api/orders') {
    if (!payments) return json(response,503,{error:'Онлайн-оплата пока закрыта.'});
    if (request.headers.origin !== origin) return json(response,403,{error:'Открой форму на сайте Дуплета.'});
    if (limited(request,'orders',8)) return json(response,429,{error:'Слишком много попыток. Подожди минуту.'});
    const body = await requestJson(request);
    const nick = typeof body?.nick === 'string' ? body.nick.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!nick || Buffer.byteLength(nick) > 64 || !/^\d{18}$/.test(code)) {
      return json(response,400,{error:'Введи игровой ник и 18 цифр из команды /code.'});
    }
    const order = store.getOrCreateOrder(nick,code,price);
    if (!order) return json(response,400,{error:'Ник и код не совпали, либо код истёк. Новый код можно взять в игре.'});
    return json(response,200,orderResult(await createPayment(order)));
  }
  if (request.method === 'GET' && pathname.startsWith('/api/orders/')) {
    const id = pathname.split('/').at(-1);
    if (!payments || !idPattern.test(id)) return json(response,404,{error:'Заказ не найден.'});
    if (limited(request,'status',24)) return json(response,429,{error:'Подожди минуту перед повторной проверкой.'});
    const order = store.order(id);
    if (!order) return json(response,404,{error:'Заказ не найден.'});
    return json(response,200,orderResult(await checkPayment(order)));
  }
  if (request.method === 'POST' && pathname === '/api/payments/yookassa') {
    if (!payments) return json(response,503,{error:'Payments are not configured'});
    if (limited(request,'notifications',120)) return json(response,429,{error:'Retry later'});
    const body = await requestJson(request);
    if (!['payment.succeeded','payment.canceled'].includes(body?.event) ||
        !idPattern.test(body?.object?.id ?? '')) return json(response,200,{ok:true});
    const order = store.paymentOrder(body.object.id);
    // The webhook only triggers a lookup. Grant VIP using the authenticated API response.
    if (order) await checkPayment(order,true);
    else return json(response,409,{error:'Payment not recorded yet. Retry later.'});
    return json(response,200,{ok:true});
  }
  return json(response,404,{error:'Страница не найдена.'});
}

const server = createServer({requestTimeout:20_000,headersTimeout:10_000},(request,response) => {
  handle(request,response).catch(error => {
    if (!error.status) console.error(error.name,error.message);
    if (!response.headersSent && !response.destroyed) {
      json(response,error.status ?? 500,{error:error.status ? error.message : 'Временная ошибка сервера.'});
    }
  });
});
server.listen(Number(env.PORT ?? 8787),env.HOST ?? '127.0.0.1',() => {
  const {address:host,port} = server.address();
  console.log('Дуплет http://' + host + ':' + port);
});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => {
  server.close(async () => {
    await Promise.all([stopBridge?.(),stopMysqlBans?.()]);
    store.close();
    process.exit(0);
  });
});
