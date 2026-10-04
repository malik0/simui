// Compresses the splats SHARP produced (.sharp/ply/*.ply, about 66 MB each) into SPZ files in splats/ (about 12 MB each).
// splats/ is committed to git and sits outside database-news/, so `npm run news` (which rebuilds that folder) never deletes it.
//
//   node scripts/compress-splats.mjs [--force] [--bits=N] [--only=<name>]
//
// Skips splats that already have an .spz unless --force. SPZ stores positions as fixed-point numbers: --bits is how many
// fractional bits (default 12, a step of 1/4096 of a scene unit). Fewer bits means smaller files but visibly blocky, stair-stepped
// detail close to the camera, where the Gaussians are tiny: 8 bits (12 MB) looked clearly worse than 12 bits (15 MB).
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { transcodeSpz } from '@sparkjsdev/spark';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = path.join(ROOT, '.sharp', 'ply');
const OUT = path.join(ROOT, 'splats');
const FORCE = process.argv.includes('--force');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const OPTIONS = { maxSh: 0, fractionalBits: Number(arg('bits') ?? 12), opacityThreshold: 0.05 };
const ONLY = arg('only');

await mkdir(OUT, { recursive: true });
const plys = existsSync(IN) ? (await readdir(IN)).filter((f) => f.endsWith('.ply') && (!ONLY || f.startsWith(ONLY))).sort() : [];
let done = 0, skipped = 0, before = 0, after = 0;
for (const file of plys) {
  const target = path.join(OUT, file.replace(/\.ply$/, '.spz'));
  if (!FORCE && existsSync(target)) { skipped++; continue; }
  const bytes = new Uint8Array(await readFile(path.join(IN, file)));
  const { fileBytes } = await transcodeSpz({ inputs: [{ fileBytes: bytes, fileType: 'ply' }], ...OPTIONS });
  await writeFile(target, fileBytes);
  before += bytes.length; after += fileBytes.length; done++;
  console.log(`${file}  ${(bytes.length / 1e6).toFixed(0)} MB -> ${(fileBytes.length / 1e6).toFixed(1)} MB`);
}
console.log(`${done} compressed (${(before / 1e6).toFixed(0)} MB -> ${(after / 1e6).toFixed(0)} MB), ${skipped} already done, ${plys.length} PLYs in total`);
