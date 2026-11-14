import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const steamPattern = /^s_STEAM_[0-9]+:[0-9]+:[0-9]+$/;
const playerPattern = /^(?:s_STEAM|n_STEAM|n_VALVE)_[0-9]+:[0-9]+:[0-9]+$/;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const validInteger = value => /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value));
export const digest = value => createHash('sha256').update(value).digest('hex');
const nickFromHex = hex => /^(?:[a-f\d]{2}){1,64}$/i.test(hex ?? '')
  ? Buffer.from(hex, 'hex').toString('utf8').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  : '';
export const normalizeNick = nick => nick.normalize('NFKC').trim().toLocaleLowerCase('ru-RU');

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.function('nick_contains',{deterministic:true},(nick,query) => Number(normalizeNick(nick).includes(query)));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS players (
      key TEXT PRIMARY KEY, nick TEXT NOT NULL, steam INTEGER NOT NULL,
      xp INTEGER NOT NULL, kills INTEGER NOT NULL, deaths INTEGER NOT NULL, loot INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bans (
      id TEXT PRIMARY KEY, player TEXT NOT NULL, nick TEXT NOT NULL, issued INTEGER NOT NULL,
      expires INTEGER NOT NULL, source TEXT NOT NULL, yes INTEGER NOT NULL, eligible INTEGER NOT NULL,
      lifted INTEGER
    );
    CREATE INDEX IF NOT EXISTS bans_player ON bans(player, issued);
    CREATE TABLE IF NOT EXISTS ban_sync (
      id TEXT PRIMARY KEY REFERENCES bans(id), revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TRIGGER IF NOT EXISTS enqueue_ban AFTER INSERT ON bans BEGIN
      INSERT INTO ban_sync(id) VALUES (NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS enqueue_unban AFTER UPDATE OF lifted ON bans BEGIN
      INSERT INTO ban_sync(id) VALUES (NEW.id)
        ON CONFLICT(id) DO UPDATE SET revision=revision+1;
    END;
    BEGIN IMMEDIATE;
    INSERT OR IGNORE INTO ban_sync(id) SELECT id FROM bans
      WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='ban_sync_initialized');
    INSERT OR IGNORE INTO meta VALUES ('ban_sync_initialized','1');
    COMMIT;
    CREATE TABLE IF NOT EXISTS claims (
      hash TEXT PRIMARY KEY, player TEXT NOT NULL UNIQUE, nick TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, player TEXT NOT NULL, nick TEXT NOT NULL, amount TEXT NOT NULL,
      claim_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'created',
      provider_id TEXT UNIQUE, redirect TEXT, vip_until INTEGER, payment_checked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vip (player TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  `);
  const metaGet = db.prepare('SELECT value FROM meta WHERE key=?');
  const metaSet = db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const playerUpsert = db.prepare(`INSERT INTO players VALUES (?,?,?,?,?,?,?) ON CONFLICT(key)
    DO UPDATE SET nick=excluded.nick, steam=excluded.steam, xp=excluded.xp,
      kills=excluded.kills, deaths=excluded.deaths, loot=excluded.loot`);
  const banInsert = db.prepare('INSERT OR IGNORE INTO bans (id,player,nick,issued,expires,source,yes,eligible) VALUES (?,?,?,?,?,?,?,?)');
  const banLift = db.prepare('UPDATE bans SET lifted=? WHERE player=? AND issued<=? AND expires>? AND lifted IS NULL');
  const clearClaim = db.prepare('DELETE FROM claims WHERE player=? OR expires<=?');
  const claimInsert = db.prepare('INSERT OR IGNORE INTO claims VALUES (?,?,?,?)');
  const rankList = db.prepare(`SELECT nick,steam,xp,kills,deaths,loot FROM players
    WHERE xp>0 OR kills>0 OR deaths>0 ORDER BY xp DESC,kills DESC,deaths,key LIMIT 100`);
  const banList = db.prepare(`SELECT id,nick,issued,expires,source,yes,eligible,lifted FROM bans
    WHERE (?=0 OR (expires>? AND lifted IS NULL)) AND nick_contains(nick,?)
    ORDER BY issued DESC,rowid DESC LIMIT 100`);
  const pendingBans = db.prepare(`SELECT b.id,nick,issued,expires,source,yes,eligible,lifted,revision
    FROM ban_sync AS q JOIN bans AS b USING(id) ORDER BY b.rowid LIMIT 100`);
  const finishBanSync = db.prepare(`DELETE FROM ban_sync WHERE id=? AND revision=?
    AND (SELECT lifted FROM bans WHERE bans.id=ban_sync.id) IS ?`);
  const hasPendingBans = db.prepare('SELECT 1 FROM ban_sync LIMIT 1');
  const claimByHash = db.prepare('SELECT * FROM claims WHERE hash=? AND expires>?');
  const orderByClaim = db.prepare('SELECT * FROM orders WHERE claim_hash=? AND created>?');
  const orderById = db.prepare('SELECT * FROM orders WHERE id=?');
  const orderByPayment = db.prepare('SELECT * FROM orders WHERE provider_id=?');
  const orderInsert = db.prepare('INSERT INTO orders (id,player,nick,amount,claim_hash,created) VALUES (?,?,?,?,?,?)');
  const saveProvider = db.prepare(`UPDATE orders SET provider_id=?,redirect=?,state='pending'
    WHERE id=? AND state='created'`);
  const setChecked = db.prepare('UPDATE orders SET payment_checked=? WHERE id=?');
  const cancel = db.prepare(`UPDATE orders SET state='canceled' WHERE id=? AND state='pending'`);
  const markPaid = db.prepare(`UPDATE orders SET state='paid', vip_until=? WHERE id=? AND state='pending'`);
  const vipGet = db.prepare('SELECT expires FROM vip WHERE player=?');
  const vipSet = db.prepare('INSERT INTO vip VALUES (?,?) ON CONFLICT(player) DO UPDATE SET expires=excluded.expires');
  const vipList = db.prepare('SELECT player,expires FROM vip WHERE expires>? ORDER BY player');

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function acceptEvent(line) {
    const [type, a, b, c, d, e, f, g] = line.split('|');
    if (type === 'status') {
      if (![a,c,d,e,f,g].every(validInteger) || !/^[a-z0-9_$-]{1,31}$/i.test(b ?? '')) return;
      const current = JSON.parse(metaGet.get('status')?.value ?? 'null');
      if (current?.at > Number(a)) return;
      metaSet.run('status', JSON.stringify({
        at:Number(a), map:b, players:Number(c), slots:Number(d),
        phase:Number(e), round:Number(f), warmup:Number(g),
      }));
      return;
    }
    if (!playerPattern.test(a ?? '')) return;
    const nick = nickFromHex(b);
    switch (type) {
      case 'player':
        if (nick && /^[01]$/.test(c) && (c === '1') === steamPattern.test(a) &&
            [d,e,f,g].every(validInteger)) {
          playerUpsert.run(a,nick,Number(c),Number(d),Number(e),Number(f),Number(g));
        }
        break;
      case 'ban':
        if (nick && [c,d,f,g].every(validInteger) && Number(d)>Number(c) && ['vote','admin'].includes(e)) {
          banInsert.run(digest(line).slice(0,24),a,nick,Number(c),Number(d),e,Number(f),Number(g));
        }
        break;
      case 'unban':
        if (validInteger(b)) banLift.run(Number(b),a,Number(b),Number(b));
        break;
      case 'claim':
        if (steamPattern.test(a) && nick && /^[a-f0-9]{64}$/i.test(c ?? '') &&
            validInteger(d) && Number(d)>nowSeconds()) {
          clearClaim.run(a,nowSeconds());
          claimInsert.run(c.toLowerCase(),a,normalizeNick(nick),Number(d));
        }
        break;
    }
  }

  return {
    close: () => db.close(),
    offset: () => Number(metaGet.get('offset')?.value ?? 0),
    ingest(lines, offset) {
      transaction(() => {
        for (const line of lines) acceptEvent(line);
        metaSet.run('offset', String(offset));
      });
    },
    status: () => JSON.parse(metaGet.get('status')?.value ?? 'null'),
    ranks: () => rankList.all(),
    bans: (query,onlyActive) => banList.all(Number(onlyActive),nowSeconds(),normalizeNick(query)),
    pendingBans: () => pendingBans.all(),
    hasPendingBans: () => Boolean(hasPendingBans.get()),
    confirmBanSync(rows) {
      transaction(() => {
        for (const { id, revision, lifted } of rows) finishBanSync.run(id,revision,lifted);
      });
    },
    order: id => orderById.get(id),
    paymentOrder: id => orderByPayment.get(id),
    rememberProvider(id, providerId, redirect) { saveProvider.run(providerId,redirect,id); },
    checked(id) { setChecked.run(nowSeconds(),id); },
    getOrCreateOrder(nick, code, amount) {
      const hash = digest(code);
      const now = nowSeconds();
      return transaction(() => {
        const found = orderByClaim.get(hash,now - 1800);
        if (found && found.nick === normalizeNick(nick)) return found;
        const claim = claimByHash.get(hash,now);
        if (!claim || claim.nick !== normalizeNick(nick)) return null;
        const id = randomUUID();
        orderInsert.run(id,claim.player,claim.nick,amount,hash,now);
        clearClaim.run(claim.player,now);
        return orderById.get(id);
      });
    },
    complete(id, payment) {
      return transaction(() => {
        const order = orderById.get(id);
        if (!order || order.state !== 'pending' || order.provider_id !== payment.id ||
            payment.metadata?.order_id !== id || payment.amount?.value !== order.amount ||
            payment.amount?.currency !== 'RUB') return order;
        if (payment.status === 'canceled') cancel.run(id);
        if (payment.status === 'succeeded' && payment.paid === true) {
          const expiry = Math.max(nowSeconds(),vipGet.get(order.player)?.expires ?? 0) + 7 * 86400;
          vipSet.run(order.player,expiry);
          markPaid.run(expiry,id);
        }
        return orderById.get(id);
      });
    },
    grants: () => vipList.all(nowSeconds()),
  };
}
