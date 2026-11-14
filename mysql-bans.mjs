import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { normalizeNick } from './store.mjs';

export async function openMysqlBans(env) {
  if (!env.SHOROH_BANS_MYSQL_HOST) return null;
  const { SHOROH_BANS_MYSQL_HOST: host, SHOROH_BANS_MYSQL_DATABASE: database,
    SHOROH_BANS_MYSQL_USER: user, SHOROH_BANS_MYSQL_PASSWORD: password,
    SHOROH_BANS_MYSQL_TLS_CERT: certFile, SHOROH_BANS_MYSQL_TLS_FINGERPRINT: fingerprint } = env;
  if (!database || !user || !password || Boolean(certFile) !== Boolean(fingerprint)) {
    throw new Error('MySQL bans require database, user and password, and both settings if pinning a TLS certificate');
  }
  const ssl = { rejectUnauthorized: true, verifyIdentity: true };
  if (certFile) {
    const cert = new X509Certificate(await readFile(certFile));
    if (cert.fingerprint256 !== fingerprint.toUpperCase() || !cert.verify(cert.publicKey)) {
      throw new Error('MySQL TLS certificate does not match the configured self-signed certificate fingerprint');
    }
    ssl.ca = cert.toString();
    ssl.verifyIdentity = false;
  }
  const { createPool } = await import('mysql2/promise');
  const pool = createPool({
    host, port: Number(env.SHOROH_BANS_MYSQL_PORT ?? 3306), database, user, password, ssl,
    connectionLimit: 2, queueLimit: 4, connectTimeout: 6000, charset: 'UTF8MB4_UNICODE_CI',
  });
  const query = (sql, values = []) => pool.query({sql, timeout: 6000}, values);
  let initialized = false;

  return {
    async sync(store) {
      if (!initialized) {
        await query(`CREATE TABLE IF NOT EXISTS duplet_bans (
          id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
          nick VARCHAR(128) NOT NULL,
          nick_search TEXT COLLATE utf8mb4_bin NOT NULL,
          issued BIGINT UNSIGNED NOT NULL,
          expires BIGINT UNSIGNED NOT NULL,
          source VARCHAR(5) NOT NULL,
          yes INT UNSIGNED NOT NULL,
          eligible INT UNSIGNED NOT NULL,
          lifted BIGINT UNSIGNED NULL,
          KEY bans_issued (issued)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        initialized = true;
      }
      const rows = store.pendingBans();
      if (!rows.length) return;
      const values = rows.map(row => [row.id, row.nick, normalizeNick(row.nick), row.issued, row.expires,
        row.source, row.yes, row.eligible, row.lifted]);
      await query(`INSERT INTO duplet_bans (id,nick,nick_search,issued,expires,source,yes,eligible,lifted)
        VALUES ? ON DUPLICATE KEY UPDATE lifted=COALESCE(lifted,VALUES(lifted))`, [values]);
      store.confirmBanSync(rows);
    },
    async list(search, onlyActive) {
      if (!initialized) return null;
      const [rows] = await query(`SELECT id,nick,issued,expires,source,yes,eligible,lifted FROM duplet_bans
        WHERE (?=0 OR (expires>? AND lifted IS NULL)) AND LOCATE(?,nick_search)>0
        ORDER BY issued DESC,id DESC LIMIT 100`,
      [Number(onlyActive), Math.floor(Date.now() / 1000), normalizeNick(search)]);
      return rows;
    },
    close: () => pool.end(),
  };
}

export function startMysqlBanSync(mysql, store) {
  let stopped = false;
  let timer;
  let pending;
  let lastError;
  const run = () => {
    pending = mysql.sync(store).then(() => {
      if (lastError) console.log('MySQL ban sync reconnected');
      lastError = undefined;
    }, error => {
      const code = error.code ?? error.name;
      if (code !== lastError) console.error('MySQL ban sync:', code);
      lastError = code;
    }).finally(() => {
      if (!stopped) timer = setTimeout(run, lastError ? 15_000 : 3_000);
    });
  };
  run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
    await mysql.close();
  };
}
