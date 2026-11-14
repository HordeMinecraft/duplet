import { rename, stat, writeFile, open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const batchSize = 1024 * 1024;
const journal = 'shoroh-events.log';
const grants = 'shoroh-vip.ini';
const noFile = error => error.code === 'ENOENT' || error.code === 2;

async function syncGame(store, files, syncVip, state) {
  const info = await files.stat(journal).catch(error => {
    if (noFile(error)) return null;
    throw error;
  });
  if (info) {
    let offset = store.offset();
    if (info.size < offset) {
      // A truncated file starts a new journal. Replayed events are idempotent.
      store.ingest([],0);
      offset = 0;
    }
    for (let step = 0; step < 5 && offset < info.size; step++) {
      const buffer = await files.read(journal,offset,Math.min(batchSize,info.size - offset));
      const end = buffer.lastIndexOf(10);
      if (end < 0) {
        if (buffer.length === batchSize) throw new Error('Invalid game event journal line');
        break;
      }
      offset += end + 1;
      store.ingest(buffer.subarray(0,end).toString('utf8').split(/\r?\n/),offset);
    }
  }
  if (syncVip) {
    const content = store.grants().map(row => row.player + ' ' + row.expires + '\n').join('');
    if (state.lastGrants !== content) {
      await files.write(grants,content);
      state.lastGrants = content;
    }
  }
}

function localFiles(directory) {
  return {
    stat: name => stat(join(directory,name)),
    async read(name, offset, length) {
      const file = await open(join(directory,name),'r');
      try {
        const buffer = Buffer.alloc(length);
        const result = await file.read(buffer,0,length,offset);
        return buffer.subarray(0,result.bytesRead);
      } finally {
        await file.close();
      }
    },
    async write(name, content) {
      const target = join(directory,name);
      const temporary = target + '.' + randomUUID();
      await writeFile(temporary,content);
      await rename(temporary,target);
    },
  };
}

async function withSftp(config, work) {
  const { Client } = await import('ssh2');
  const client = new Client();
  client.on('error',()=>{});
  try {
    const fingerprint = config.fingerprint.replace(/^SHA256:/,'').replace(/=+$/,'');
    await new Promise((resolve,reject) => client.once('ready',resolve).once('error',reject).connect({
      host:config.host, port:config.port, username:config.user, password:config.password,
      readyTimeout:17000, keepaliveInterval:3000, keepaliveCountMax:2,
      hostVerifier: key => createHash('sha256').update(key).digest('base64').replace(/=+$/,'') === fingerprint,
    }));
    const sftp = await new Promise((resolve,reject) => client.sftp((error,value) => error ? reject(error) : resolve(value)));
    const call = (method,...args) => new Promise((resolve,reject) =>
      sftp[method](...args,(error,value) => error ? reject(error) : resolve(value)));
    const target = name => posix.join(config.directory,name);
    return await work({
      stat: name => call('stat',target(name)),
      read: (name,offset,length) => new Promise((resolve,reject) => {
        const chunks = [];
        sftp.createReadStream(target(name),{start:offset,end:offset + length - 1})
          .on('data',part => chunks.push(part)).on('end',() => resolve(Buffer.concat(chunks))).on('error',reject);
      }),
      async write(name,content) {
        const current = target(name);
        const temporary = current + '.' + randomUUID();
        await call('writeFile',temporary,content);
        try {
          await call('ext_openssh_rename',temporary,current);
        } catch {
          try {
            await call('rename',temporary,current);
          } catch (error) {
            if (![4,11].includes(error.code)) throw error;
            await call('unlink',current).catch(failure => { if (!noFile(failure)) throw failure; });
            await call('rename',temporary,current);
          }
        }
      },
    });
  } finally {
    client.end();
  }
}

export function startBridge(store, config) {
  const state = {};
  let stopped = false;
  let timer;
  let pending;
  let failed = false;
  const poll = async () => {
    if (stopped) return;
    try {
      const sync = files => syncGame(store,files,config.syncVip,state);
      if (config.local) await sync(localFiles(config.local));
      else await withSftp(config,sync);
      if (failed) console.log('Game sync reconnected');
      failed = false;
    } catch (error) {
      if (!failed) console.error('Game sync:',error.message);
      failed = true;
    } finally {
      if (!stopped) timer = setTimeout(run,failed ? 25000 : 8000);
    }
  };
  const run = () => { pending = poll(); };
  run();
  return async () => { stopped = true; clearTimeout(timer); await pending; };
}

export function bridgeConfig(env, paymentsEnabled) {
  const syncVip = paymentsEnabled && env.SHOROH_SYNC_VIP === '1';
  if (env.SHOROH_GAME_DATA_DIR) return {local:env.SHOROH_GAME_DATA_DIR,syncVip};
  if (!env.SHOROH_SFTP_HOST) return null;
  const config = {
    host:env.SHOROH_SFTP_HOST, port:Number(env.SHOROH_SFTP_PORT ?? 2022),
    user:env.SHOROH_SFTP_USER, password:env.SHOROH_SFTP_PASSWORD, fingerprint:env.SHOROH_SFTP_FINGERPRINT,
    directory:env.SHOROH_SFTP_DATA_DIR ?? '/cstrike/addons/amxmodx/data', syncVip,
  };
  if (!config.user || !config.password || !config.fingerprint) throw new Error('SFTP user, password and verified host fingerprint are required');
  return config;
}
