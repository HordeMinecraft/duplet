const $ = selector => document.querySelector(selector);
const rankScale = [
  [0,'Новичок'],[100,'Дозорный'],[300,'Следопыт'],[700,'Разведчик'],[1500,'Ветеран'],[3000,'Легенда'],
];
const warmups = ['Ножи','Диглы','Скауты','Гранаты'];
const date = new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'});
const time = seconds => date.format(new Date(seconds * 1000));
const currency = new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'});
let address = $('#address-note').textContent;
let checkoutAvailable = false;
let currentOrder = new URLSearchParams(location.search).get('order');
let orderTimer;
const configuredApi = document.querySelector('meta[name="duplet-api"]')?.content;
const apiBase = configuredApi ? new URL(configuredApi).origin : location.origin;
const snapshotUrl = document.querySelector('meta[name="duplet-snapshot"]')?.content;
let snapshotRequest;

async function api(path,options) {
  if (snapshotUrl && !configuredApi && !options) {
    const url = new URL(path,location.origin);
    const route = url.pathname.split('/').at(-1);
    if (['status','bans','ranks'].includes(route)) {
      snapshotRequest ??= fetch(new URL(snapshotUrl,document.baseURI),{cache:'no-store'})
        .then(response => {
          if (!response.ok) throw new Error('Не удалось получить данные сервера.');
          return response.json();
        }).finally(() => { snapshotRequest = undefined; });
      const snapshot = await snapshotRequest;
      for (const label of document.querySelectorAll('.snapshot-note')) {
        label.hidden = false;
        label.textContent = 'Снимок данных на ' + time(snapshot.updatedAt) + ' МСК';
      }
      if (route === 'status') {
        const status = snapshot.status;
        return {...status, checkout:false, price:null, snapshot:true};
      }
      if (route === 'ranks') return snapshot.ranks;
      const normalize = value => value.normalize('NFKC').trim().toLocaleLowerCase('ru-RU');
      const nick = normalize(url.searchParams.get('q') ?? '');
      const activeOnly = url.searchParams.get('active') === '1';
      return snapshot.bans.filter(ban => normalize(ban.nick).includes(nick) &&
        (!activeOnly || (!ban.lifted && ban.expires * 1000 > Date.now())));
    }
  }
  const response = await fetch(new URL(path,apiBase),options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Сайт не ответил. Обнови страницу.');
  return value;
}

function text(selector,value) { $(selector).textContent = value; }
function row(body,cells) {
  const tr = body.insertRow();
  cells.forEach(value => { tr.insertCell().textContent = value; });
  return tr;
}
function empty(body,columns,message) {
  body.replaceChildren();
  row(body,[message]).cells[0].colSpan = columns;
}

async function refreshStatus() {
  try {
    const state = await api('/api/status');
    const game = state.connected;
    if (state.address && state.address !== address) {
      address = state.address;
      $('#join-game').href = 'steam://connect/' + address;
      text('#connect-command','connect ' + address);
      text('#address-note',address);
    }
    $('#status-dot').classList.toggle('online',Boolean(game) && !state.snapshot);
    text('#status-label',state.snapshot ? 'Последний снимок' : game ? 'Сервер на связи' :
      state.lastSeen ? 'Нет свежих данных' : 'Ждём данные игры');
    text('#status-map',game?.map ?? '—');
    text('#status-phase',!game ? '—' : game.phase === 2 ? 'Раунд ' + game.round :
      game.phase === 1 ? 'Смена режима' : 'Разминка · ' + (warmups[game.warmup] ?? 'подготовка'));
    text('#status-players',game ? game.players + ' / ' + game.slots : '— / —');
    checkoutAvailable = state.checkout;
    $('#pay').disabled = !checkoutAvailable;
    if (!currentOrder) {
      text('#pay',state.price ? 'Оплатить ' + currency.format(Number(state.price)) : 'Перейти к оплате');
      text('#checkout-note',checkoutAvailable ? 'VIP привяжется к твоему Steam-профилю.' : 'Онлайн-оплата пока закрыта.');
    }
  } catch {
    $('#status-dot').classList.remove('online');
    text('#status-label','Статус временно недоступен');
    if (!currentOrder) text('#checkout-note','Не удалось проверить доступность оплаты.');
    for (const field of ['map','players','phase']) text('#status-' + field,'—');
  }
}

async function ranks() {
  const body = $('#rank-rows');
  try {
    const result = await api('/api/ranks');
    if (!result.length) return empty(body,6,'Статистика появится после первых сыгранных раундов.');
    body.replaceChildren();
    result.forEach((player,index) => row(body,[
      index+1,player.nick,rankScale.findLast(([xp]) => player.xp >= xp)[1],player.xp,player.kills,player.deaths,
    ]));
  } catch {
    empty(body,6,'Не удалось загрузить статистику.');
  }
}

async function bans() {
  const body = $('#ban-rows');
  const form = $('#ban-filter');
  const params = new URLSearchParams({q:form.elements.nick.value,active:form.elements.active.checked ? '1' : '0'});
  try {
    const result = await api('/api/bans?' + params);
    if (!result.length) return empty(body,5,'Банов по этому запросу нет.');
    body.replaceChildren();
    result.forEach(ban => {
      const active = !ban.lifted && ban.expires * 1000 > Date.now();
      const reason = ban.source === 'vote' ? 'Голосование · ' + ban.yes + '/' + ban.eligible : 'Бан администратором';
      const tr = row(body,[ban.nick,reason,time(ban.issued),time(ban.expires),ban.lifted ? 'Снят' : active ? 'Активен' : 'Истёк']);
      const badge = document.createElement('span');
      badge.className = 'ban-status';
      badge.textContent = tr.cells[4].textContent;
      if (active) badge.setAttribute('data-active','');
      tr.cells[4].replaceChildren(badge);
    });
  } catch {
    empty(body,5,'Не удалось загрузить бан-лист.');
  }
}

function renderOrder(order) {
  clearTimeout(orderTimer);
  if (order.state === 'paid') {
    text('#checkout-note','Оплата подтверждена. VIP до ' + time(order.vipUntil) + ' МСК. Сервер получит доступ при синхронизации.');
  } else if (order.state === 'canceled') {
    text('#checkout-note','Платёж отменён. Для нового заказа получи новый код в игре.');
  } else {
    text('#checkout-note','Ждём подтверждение оплаты.');
    orderTimer = setTimeout(checkOrder,9000);
  }
}

async function checkOrder() {
  if (!currentOrder) return;
  try {
    renderOrder(await api('/api/orders/' + encodeURIComponent(currentOrder)));
  } catch (error) {
    text('#checkout-note',error.message);
  }
}

function navigate() {
  const target = location.hash.slice(1);
  const page = ['ranks','bans','vip'].includes(target) ? target : 'main';
  document.querySelectorAll('[data-page]').forEach(section => { section.hidden = section.id !== page; });
  document.querySelectorAll('nav a').forEach(link => {
    if (link.hash === '#' + page) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
  if (['maps','animations','weapon-inspect','bandage'].includes(target)) {
    requestAnimationFrame(() => document.getElementById(target).scrollIntoView());
  }
  else if (target !== 'content') window.scrollTo(0,0);
  if (page === 'ranks') ranks();
  if (page === 'bans') bans();
  if (page === 'vip') checkOrder();
}

for (const [xp,label] of rankScale) {
  const entry = document.createElement('div');
  const name = document.createElement('dt');
  const threshold = document.createElement('dd');
  name.textContent = label;
  threshold.textContent = xp + ' XP';
  entry.append(name,threshold);
  $('#rank-scale').append(entry);
}
$('#copy-address').addEventListener('click',async () => {
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    text('#address-note','Скопировано · ' + address);
  } catch {
    text('#address-note','Введи в консоли: connect ' + address);
  }
});
$('#ban-filter').addEventListener('submit',event => { event.preventDefault(); bans(); });
$('[data-refresh="ranks"]').addEventListener('click',ranks);
$('[data-refresh="bans"]').addEventListener('click',bans);
$('#checkout').addEventListener('submit',async event => {
  event.preventDefault();
  if (!checkoutAvailable) return;
  const form = new FormData(event.currentTarget);
  $('#pay').disabled = true;
  text('#checkout-note','Создаём заказ…');
  try {
    const order = await api('/api/orders',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({nick:form.get('nick'),code:form.get('code')}),
    });
    currentOrder = order.id;
    const orderUrl = new URL(location.href);
    orderUrl.searchParams.set('order',order.id);
    orderUrl.hash = 'vip';
    history.replaceState(null,'',orderUrl);
    if (order.redirect) location.assign(order.redirect);
    else renderOrder(order);
  } catch (error) {
    text('#checkout-note',error.message);
  } finally {
    $('#pay').disabled = !checkoutAvailable;
  }
});
window.addEventListener('hashchange',navigate);
if (currentOrder && !location.hash) location.hash = '#vip';
navigate();
refreshStatus();
setInterval(refreshStatus,20000);
