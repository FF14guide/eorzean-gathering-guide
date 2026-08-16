import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const OUTPUT = path.join(ROOT, 'tools', 'upstream-state.json');
const SOURCE_FILES = [
  'nodes.json',
  'items.json',
  'places.json',
  'aetherytes.json',
  'maps.json',
  'collectables.json',
  'reverse-reduction.json',
  'item-patch.json',
  'patch-names.json',
  'Achievement_ja.csv',
  'Item_ja.csv',
  'GatheringPoint.csv',
  'GatheringPointBonus.csv',
  'GatheringPointBonusType_ja.csv',
  'GatheringPointBonusType_en.csv',
  'GatheringPointBonusType_de.csv',
  'GatheringPointBonusType_fr.csv',
  'GatheringCondition_ja.csv',
  'GatheringCondition_en.csv',
  'GatheringCondition_de.csv',
  'GatheringCondition_fr.csv',
  'ExportedGatheringPoint.csv',
  'GatheringPointBase.csv',
  'GatheringItem.csv',
];

async function digest(file) {
  const data = await readFile(path.join(CACHE, file));
  const info = await stat(path.join(CACHE, file));
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: info.size };
}

const sources = {};
for (const file of SOURCE_FILES) sources[file] = await digest(file);
const itemPatch = JSON.parse(await readFile(path.join(CACHE, 'item-patch.json'), 'utf8'));
const patchNames = JSON.parse(await readFile(path.join(CACHE, 'patch-names.json'), 'utf8'));
const patches = [...new Set(Object.values(itemPatch).map((patchId) => {
  const name = patchNames[patchId]?.en || patchNames[patchId]?.ja || '';
  return name.match(/(\d+\.\d+)/)?.[1] || '';
}).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
const state = {
  schema: 1,
  sourceCount: SOURCE_FILES.length,
  latestPatch: patches.at(-1) || null,
  previousPatch: patches.at(-2) || null,
  patches,
  sources,
};
await writeFile(OUTPUT, `${JSON.stringify(state, null, 2)}\n`);
console.log(`上流データ状態を記録: ${state.latestPatch || 'unknown'}（${SOURCE_FILES.length}ソース）`);
console.log(`最新パッチ: ${state.latestPatch || 'unknown'} / 準最新: ${state.previousPatch || 'unknown'}`);
