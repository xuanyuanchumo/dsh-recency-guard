import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const asarPath = 'D:/DSH/DeepSeek Harness/resources/app.asar';
const buf = readFileSync(asarPath);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
const dataBase = 16 + headerSize;
function walk(node, path, out) {
  if (!node.files) return;
  for (const [name, ent] of Object.entries(node.files)) {
    const p = path ? path + '/' + name : name;
    if (ent.files) walk(ent, p, out);
    else out.push([p, ent]);
  }
}
const all = [];
walk(header, '', all);
const prefix = 'dsh/node_modules/@deepseek-ai/';
const wanted = all.filter(([p]) => p.startsWith(prefix));
let count = 0;
for (const [p, ent] of wanted) {
  const rel = p.slice(prefix.length);
  const out = join('runtime', ...rel.split('/'));
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf.subarray(dataBase + Number(ent.offset), dataBase + Number(ent.offset) + ent.size));
    count++;
  } catch {}
}
console.log('extracted', count, 'files');
