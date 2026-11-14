import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GIFEncoder } = require(process.env.SHOROH_GIFENC_PATH || 'gifenc');
const web = fileURLToPath(new URL('..',import.meta.url));
const game = fileURLToPath(new URL('../../game/overlay/cstrike/',import.meta.url));
const palette = [
  [20,23,22],[33,40,35],[71,70,54],[133,102,63],
  [191,134,70],[240,183,101],[255,215,147],[246,239,220],
];

function draw(width,height,size,frame,frameCount,scale) {
  const buffer = new Uint8Array(width * height * scale * scale);
  const ox = Math.floor((width - size) / 2);
  const oy = Math.floor((height - size) / 2);
  const unit = size / 24;
  const loop = frame / frameCount;
  const wave = Math.round(3 + 3 * Math.sin(Math.PI * loop));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = (x - ox) / unit;
    const b = (y - oy) / unit;
    const corner = Math.min(a + b, 23 - a + b, 23 - b + a, 46 - a - b);
    let color = 0;
    if (a >= 0 && a <= 23 && b >= 0 && b <= 23 && corner >= 4) {
      const edge = a < 1 || a > 22 || b < 1 || b > 22 || corner < 5;
      color = edge ? wave : 1;
      if (a >= 6 && a < 19 && b >= 6 && b < 18 &&
          (a < 9 || (a >= 11 && a < 14) || a >= 16 || b >= 15)) {
        const glow = 18 * loop - 1;
        color = Math.abs(b - glow) < 2 ? 7 : 5;
      }
      if (a >= 19 && a < 21 && b >= 4 && b < 6) color = frame % 3 ? 5 : 2;
    } else if (size > 25 && Math.abs(b - 12) < 1 &&
        (a < -2 || a > 25) && Math.round(Math.abs(a - 12) + frame / 2) % 6 < 3) {
      color = 2;
    }
    const rowWidth = width * scale;
    for (let dy = 0; dy < scale; dy++) {
      const index = (y * scale + dy) * rowWidth + x * scale;
      buffer.fill(color,index,index + scale);
    }
  }
  return buffer;
}

function animation(width,height,size,scale,count,delay) {
  const gif = GIFEncoder();
  for (let frame = 0; frame < count; frame++) {
    gif.writeFrame(draw(width,height,size,frame,count,scale),width * scale,height * scale,{
      palette,repeat:0,delay,
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

const full = animation(72,48,32,6,16,85);
const compact = animation(28,28,22,1,4,200);
const inline = 'data:image/gif;base64,' + compact.toString('base64');
const motd = '<html><head><meta charset="utf-8"></head><body bgcolor="#141716" text="#f3efe5">' +
  '<center><br><img width="128" height="128" alt="Шорох" src="' + inline +
  '"><h1>Шорох</h1><p>Разминка · три пистолетки · полный закуп</p></center></body></html>';
if (Buffer.byteLength(motd) >= 1536) throw new Error('GoldSrc MOTD exceeds 1535 bytes');
mkdirSync(join(game,'gfx','shoroh'),{recursive:true});
writeFileSync(join(web,'public','emblem.gif'),full);
writeFileSync(join(game,'gfx','shoroh','emblem.gif'),full);
writeFileSync(join(game,'motd.txt'),motd);
console.log('GIF',full.length,'bytes, embedded GIF',compact.length,'bytes, MOTD',Buffer.byteLength(motd),'bytes');
