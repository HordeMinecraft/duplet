import { writeFile } from 'node:fs/promises';

const [endpoint, output] = process.argv.slice(2);
if (!endpoint || !output) {
  throw new Error('Usage: node tools/export-pages-data.mjs http://127.0.0.1:8787 PUBLIC_JSON');
}
const origin = new URL(endpoint);
async function fetchData(route) {
  const response = await fetch(new URL('/api/' + route, origin), {signal:AbortSignal.timeout(10_000)});
  if (!response.ok) throw new Error(`API ${route}: HTTP ${response.status}`);
  return response.json();
}

const [status, ranks, bans] = await Promise.all(['status','ranks','bans'].map(fetchData));
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key,row[key]]));
const snapshot = {
  updatedAt: Math.floor(Date.now() / 1000),
  status: {
    lastSeen: status.lastSeen,
    address: status.address,
    connected: status.connected && pick(status.connected,['at','map','players','slots','phase','round','warmup']),
  },
  ranks: ranks.map(row => pick(row,['nick','xp','kills','deaths'])),
  bans: bans.map(row => pick(row,['id','nick','issued','expires','source','yes','eligible','lifted'])),
};
await writeFile(output, JSON.stringify(snapshot) + '\n');
console.log(`Saved public data: ${snapshot.ranks.length} ranks, ${snapshot.bans.length} bans`);
