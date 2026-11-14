import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, digest } from './store.mjs';

const steam = 's_STEAM_0:1:1234';
const fake = 'n_STEAM_0:1:1234';
const nick = 'Дозор';
const hex = Buffer.from(nick).toString('hex');
const now = Math.floor(Date.now() / 1000);
const code = '000111222333444555';

test('journal keeps Steam and Non-Steam progress separate and publishes the ban lifecycle',() => {
  const store = openStore(':memory:');
  try {
    const ban = `ban|${fake}|${hex}|${now}|${now + 300}|vote|3|4`;
    store.ingest([
      `player|${steam}|${hex}|1|70|5|3|1`,
      `player|${fake}|${hex}|0|40|4|2|0`,
      ban,ban,`status|${now}|$2000$|5|32|2|4|1`,
    ],190);
    assert.equal(store.offset(),190);
    assert.deepEqual(store.ranks().map(row => row.xp),[70,40]);
    assert.equal(store.bans('ДОЗ',true).length,1);
    assert.equal(store.bans('',false)[0].eligible,4);
    assert.equal(store.status().round,4);
    assert.equal(store.status().map,'$2000$');
    const pending = store.pendingBans();
    assert.equal(pending.length,1);
    store.ingest([`unban|${fake}|${now + 1}`],250);
    assert.equal(store.bans('дозор',true).length,0);
    assert.equal(store.bans('',false)[0].lifted,now + 1);
    store.confirmBanSync(pending);
    const [unban] = store.pendingBans();
    assert.equal(unban.lifted,now + 1);
    store.confirmBanSync([unban]);
    assert.equal(store.hasPendingBans(),false);
    store.ingest([ban,`unban|${fake}|${now + 1}`],300);
    assert.equal(store.hasPendingBans(),false);
  } finally {
    store.close();
  }
});

test('VIP is linked to the in-game Steam account and applied once after verified payment',() => {
  const store = openStore(':memory:');
  try {
    store.ingest([`claim|${fake}|${hex}|${digest(code)}|${now + 600}`],80);
    assert.equal(store.getOrCreateOrder(nick,code,'149.00'),null);
    store.ingest([`claim|${steam}|${hex}|${digest(code)}|${now + 600}`],160);
    assert.equal(store.getOrCreateOrder('Другой ник',code,'149.00'),null);
    const order = store.getOrCreateOrder('ДОЗОР',code,'149.00');
    assert.equal(order.player,steam);
    assert.equal(store.getOrCreateOrder(nick,code,'179.00').id,order.id);
    store.rememberProvider(order.id,'payment-test','https://example.invalid');
    const payment = {
      id:'payment-test',metadata:{order_id:order.id},status:'succeeded',paid:true,amount:{value:'1.00',currency:'RUB'},
    };
    assert.equal(store.complete(order.id,payment).state,'pending');
    assert.deepEqual(store.grants(),[]);
    payment.amount.value = '149.00';
    const paid = store.complete(order.id,payment);
    assert.equal(paid.state,'paid');
    assert.ok(paid.vip_until >= now + 7 * 86400);
    assert.equal(store.complete(order.id,payment).vip_until,paid.vip_until);
    assert.equal(store.grants()[0].expires,paid.vip_until);
  } finally {
    store.close();
  }
});
