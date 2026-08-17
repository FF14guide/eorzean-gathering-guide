#!/usr/bin/env node
/**
 * エオルゼア採集手帳 — データビルダー
 *
 * コミュニティが公開しているオープンデータを取得し、サイトが読む単一の JSON に正規化して
 * dist/ を書き出す。釣り図鑑（eorzeanfishing.com）と同じ作法：外部データは毎回取り直し、
 * 生成物はリポジトリに置かない。
 *
 *   node tools/build.mjs            通常ビルド（キャッシュがあれば使う）
 *   node tools/build.mjs --refresh  ソースを再ダウンロード
 *
 * 取得元（すべて raw.githubusercontent 経由。XIVAPI を直接叩かなくてよい）:
 *   - FFXIV Teamcraft (MIT)        時間限定ノードの出現ET・座標・取得物、アイテム名、地名、
 *                                  エーテライト、収集品、精選対象、アイテム実装パッチ
 *   - xivapi/ffxiv-datamining      Achievement シート（日本語の名称・条件文）
 *
 * パッチ後はこれを流すだけで採取ポイントとアイテムが追従する。
 */

import { mkdir, readFile, writeFile, rm, readdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const REFRESH = process.argv.includes('--refresh');

// 公開先URL（OGP・canonical・sitemap に使う）。env SITE_URL で上書き可。
const CANONICAL_SITE_URL = 'https://eorzean-gathering-guide.pages.dev';
const _envSiteUrl = (process.env.SITE_URL ?? '').replace(/\/$/, '');
const SITE_URL = _envSiteUrl || CANONICAL_SITE_URL;

const TC = 'https://raw.githubusercontent.com/ffxiv-teamcraft/ffxiv-teamcraft/staging/libs/data/src/lib/json';
const DM = 'https://raw.githubusercontent.com/xivapi/ffxiv-datamining/master/csv';

const SOURCES = {
  'nodes.json':            `${TC}/nodes.json`,
  'items.json':            `${TC}/items.json`,
  'places.json':           `${TC}/places.json`,
  'aetherytes.json':       `${TC}/aetherytes.json`,
  'maps.json':             `${TC}/maps.json`,
  'collectables.json':     `${TC}/collectables.json`,
  'reverse-reduction.json': `${TC}/reverse-reduction.json`,
  'item-patch.json':       `${TC}/item-patch.json`,
  'patch-names.json':      `${TC}/patch-names.json`,
  'Achievement_ja.csv':    `${DM}/ja/Achievement.csv`,
  'Item_ja.csv':           `${DM}/ja/Item.csv`,
  'GatheringPoint.csv':     `${DM}/en/GatheringPoint.csv`,
  'GatheringPointBonus.csv': `${DM}/en/GatheringPointBonus.csv`,
  'GatheringPointBonusType_ja.csv': `${DM}/ja/GatheringPointBonusType.csv`,
  'GatheringPointBonusType_en.csv': `${DM}/en/GatheringPointBonusType.csv`,
  'GatheringPointBonusType_de.csv': `${DM}/de/GatheringPointBonusType.csv`,
  'GatheringPointBonusType_fr.csv': `${DM}/fr/GatheringPointBonusType.csv`,
  'GatheringCondition_ja.csv': `${DM}/ja/GatheringCondition.csv`,
  'GatheringCondition_en.csv': `${DM}/en/GatheringCondition.csv`,
  'GatheringCondition_de.csv': `${DM}/de/GatheringCondition.csv`,
  'GatheringCondition_fr.csv': `${DM}/fr/GatheringCondition.csv`,
  'ExportedGatheringPoint.csv': `${DM}/en/ExportedGatheringPoint.csv`,
  'GatheringPointBase.csv': `${DM}/en/GatheringPointBase.csv`,
  'GatheringItem.csv':      `${DM}/en/GatheringItem.csv`,
};

// 採集系アチーブメントを名称で絞る語彙（DoL のみ拾う）
const ACH_KEYWORD = /採集|採掘|園芸|収集|刻限|伝説|エオルゼア|名匠|ギャザ|マイスター|大地|自然|カーマ|土地神|恵み/;

const log = (...a) => console.log('·', ...a);
const sz = (t) => `${(t.length / 1024).toFixed(0)} KB`;

async function fetchSource(name, url) {
  const dest = path.join(CACHE, name);
  if (!REFRESH && existsSync(dest)) { log(`cache  ${name}`); return readFile(dest, 'utf8'); }
  log(`fetch  ${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  await mkdir(CACHE, { recursive: true });
  await writeFile(dest, text);
  return text;
}

/** 1行目がヘッダの CSV を、引用符を尊重して行オブジェクトの配列にする */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => {
    const o = {}; head.forEach((h, i) => (o[h] = r[i])); return o;
  });
}

async function main() {
  const raw = {};
  await Promise.all(Object.entries(SOURCES).map(async ([n, u]) => { raw[n] = await fetchSource(n, u); }));

  const nodes  = JSON.parse(raw['nodes.json']);
  const items  = JSON.parse(raw['items.json']);
  const places = JSON.parse(raw['places.json']);
  const aeth   = JSON.parse(raw['aetherytes.json']);
  const gameMaps = JSON.parse(raw['maps.json']);
  const coll   = JSON.parse(raw['collectables.json']);
  const rrev   = JSON.parse(raw['reverse-reduction.json']);
  const ipatch = JSON.parse(raw['item-patch.json']);
  const gpRows = parseCsv(raw['GatheringPoint.csv']);
  const gpBonusRows = new Map(parseCsv(raw['GatheringPointBonus.csv']).map((r) => [r['#'], r]));
  const readLocalizedSheet = (prefix) => {
    const tables = Object.fromEntries(['ja', 'en', 'de', 'fr'].map((lang) => [lang, new Map(parseCsv(raw[`${prefix}_${lang}.csv`]).map((r) => [r['#'], r.Text || '']))]));
    return (id) => ({ ja: tables.ja.get(String(id)) || '', en: tables.en.get(String(id)) || tables.ja.get(String(id)) || '', de: tables.de.get(String(id)) || tables.en.get(String(id)) || tables.ja.get(String(id)) || '', fr: tables.fr.get(String(id)) || tables.en.get(String(id)) || tables.ja.get(String(id)) || '' });
  };
  const bonusTypeText = readLocalizedSheet('GatheringPointBonusType');
  const conditionText = readLocalizedSheet('GatheringCondition');
  const exportedGp = new Map(parseCsv(raw['ExportedGatheringPoint.csv']).map((r) => [r['#'], r]));
  const pnames = JSON.parse(raw['patch-names.json']);

  const localized = (dict, id, fallback = '') => ({
    ja: (dict[id]?.ja || dict[id]?.en || fallback).trim(),
    en: (dict[id]?.en || dict[id]?.ja || fallback).trim(),
    de: (dict[id]?.de || dict[id]?.en || dict[id]?.ja || fallback).trim(),
    fr: (dict[id]?.fr || dict[id]?.en || dict[id]?.ja || fallback).trim(),
  });
  const placeNames = (id) => localized(places, id);
  const itemNames  = (id) => localized(items, id, `#${id}`);
  const fillBonusText = (text, value) => String(text || '').replace(/UNKNOWN/g, String(value)).trim();
  const bonusForId = (id) => {
    const row = gpBonusRows.get(String(id));
    if (!row) return null;
    return {
      id: Number(id),
      effect: Object.fromEntries(Object.entries(bonusTypeText(row.BonusType)).map(([lang, text]) => [lang, fillBonusText(text, row.BonusValue)])),
      condition: Object.fromEntries(Object.entries(conditionText(row.Condition)).map(([lang, text]) => [lang, fillBonusText(text, row.ConditionValue)])),
    };
  };
  const bonusesForBase = (baseId) => {
    const ids = new Set();
    gpRows.filter((r) => String(r.GatheringPointBase || '') === String(baseId)).forEach((r) => {
      for (const key of ['GatheringPointBonus[0]', 'GatheringPointBonus[1]']) if (r[key] && r[key] !== '0') ids.add(r[key]);
    });
    return [...ids].map(bonusForId).filter(Boolean);
  };
  // ディアデム諸島の第二次・第三次復興用アイテムは、現在は採取・使用対象外。
  // 日本語名を主判定にしつつ、4言語のデータ差異にも対応する。
  const isObsoleteDiademItem = (id) => {
    const n = itemNames(id);
    return /第二次復興用|第三次復興用/.test(n.ja)
      || /Grade [23].*Skybuilders|Skybuilders.*Grade [23]/i.test(n.en)
      || /\((2e|3e) phase\)/i.test(n.fr)
      || /Stufe [23].*Skybuilders|Skybuilders.*Stufe [23]/i.test(n.de);
  };
  const placeJa = (id) => placeNames(id).ja;
  const itemJa  = (id) => itemNames(id).ja;

  // ─── 最寄りエーテライト（type0＝テレポ可、同 map で最短） ───────────
  const mains = Object.values(aeth).filter((a) => a.type === 0);
  const nearestAeth = (n) => {
    const dist = (a) => (a.x - n.x) ** 2 + (a.y - n.y) ** 2;
    let pool = mains.filter((a) => a.map === n.map);
    if (!pool.length) pool = mains.filter((a) => a.zoneid === n.zoneid);
    if (!pool.length) pool = mains;
    return pool.reduce((b, a) => (b && dist(b) <= dist(a) ? b : a), null);
  };

  // spawns(ET開始) + duration(分) → windows "開始-終了"（日跨ぎ対応）
  const windows = (n) => {
    const dur = Math.round((n.duration || 0) / 60);
    return (n.spawns || []).map((s) => { let e = s + dur; if (e > 24) e -= 24; return `${s}-${e}`; });
  };
  const nodeType = (n) => (n.ephemeral ? 'ephemeral' : n.folklore ? 'legendary' : 'unspoiled');
  const classOf = (t) => (t <= 1 ? 'MIN' : 'BTN');
  // ゲーム本来の採集手帳の4分類。0=採掘(主道具) 1=砕岩(副道具) 2=伐採(主道具) 3=草刈(副道具)
  const TOOL_LABEL = { 0: '採掘', 1: '砕岩', 2: '伐採', 3: '草刈' };
  const TOOL_MAIN  = { 0: true, 1: false, 2: true, 3: false }; // true=主道具 false=副道具
  // 各分類に対応するゲーム内の初期道具アイコン。アイテムアイコンと同じXIVAPI v2アセット経路を使う。
  // 0: ウェザードピック / 1: ウェザードモール / 2: ウェザードハチェット / 3: ウェザードサイズ
  const TOOL_ICON = {
    0: 'https://v2.xivapi.com/api/asset?path=ui/icon/038000/038003.tex&format=png',
    1: 'https://v2.xivapi.com/api/asset?path=ui/icon/038000/038051.tex&format=png',
    2: 'https://v2.xivapi.com/api/asset?path=ui/icon/038000/038103.tex&format=png',
    3: 'https://v2.xivapi.com/api/asset?path=ui/icon/038000/038151.tex&format=png',
  };
  const toolOf = (t) => ({ id: t, label: TOOL_LABEL[t], main: TOOL_MAIN[t], icon: TOOL_ICON[t] });

  // ─── 用途タグ（精選 / スクリップ色）を外部データから導出 ───────────
  const useLabels = {};
  const usesFor = (itemId) => {
    const tags = new Set();
    if (rrev[itemId]) { tags.add('精選'); useLabels['精選'] = '精選用'; }
    const c = coll[itemId];
    if (c && c.reward) {
      const rn = itemJa(c.reward);            // 例 "ギャザラースクリップ:橙貨"
      if (rn.includes('スクリップ')) {
        const color = rn.split(':').pop().trim();
        tags.add(color); useLabels[color] = color + 'スクリップ';
      }
    }
    if (!tags.size) { tags.add('素材'); useLabels['素材'] = '素材用'; }
    return [...tags];
  };

  // ─── アイテムの実装パッチ "X.Y" ───────────────────────────────
  const itemVersion = (itemId) => {
    const nm = (pnames[ipatch[itemId]] && (pnames[ipatch[itemId]].en || pnames[ipatch[itemId]].ja)) || '';
    const m = nm.match(/(\d+\.\d+)/); return m ? parseFloat(m[1]) : null;
  };
    const nodePatch = (ids) => { const vs = ids.map(itemVersion).filter((v) => v != null); return vs.length ? Math.max(...vs).toFixed(1) : ''; };
  // 7.4伝説ノードの場所単位ブレイクポイント。公式GatheringPointBonusに独立行がない条件は、
  // Teamcraft / Icy Veinsの7.4ノード基準を採取場所単位で保持する。
  const PATCH74_LOCATION_BONUSES = [
    { id: 'patch74-visible', effect: { ja: '採取場が表示される', en: 'Node becomes visible', de: 'Sammelstelle wird sichtbar', fr: 'Point de récolte visible' }, condition: { ja: '技術力 5090以上', en: 'Perception ≥ 5090', de: 'Expertise min. 5090', fr: 'Savoir-faire ≧ 5090' }, source: 'patch74-breakpoint' },
    { id: 'patch74-yield', effect: { ja: '獲得数＋1', en: 'Gathering Yield +1', de: 'Sammelertrag +1', fr: 'Rendement de récolte +1' }, condition: { ja: '獲得力 5400以上', en: 'Gathering ≥ 5400', de: 'Sammelgeschick min. 5400', fr: 'Collecte ≧ 5400' }, source: 'patch74-breakpoint' },
    { id: 'patch74-integrity', effect: { ja: '採取回数・耐久＋1', en: 'Gathering Attempts / Integrity +1', de: 'Sammelversuche / Ausdauer +1', fr: 'Tentatives / intégrité de récolte +1' }, condition: { ja: 'GP 960以上', en: 'Max GP ≥ 960', de: 'Max. GP min. 960', fr: 'GP max. ≧ 960' }, source: 'patch74-breakpoint' },
  ];
  const bonusesForNode = (baseId, patch, type) => [
    ...bonusesForBase(baseId),
    ...(patch === '7.4' && type === 'legendary' ? PATCH74_LOCATION_BONUSES : []),
  ];
  // ─── アイテムアイコン（xivapi-datamining Item.csv の Icon列 → XIVAPI v2アセットURL） ───
  const itemCsv = parseCsv(raw['Item_ja.csv']);
  const iconIdByItem = new Map(itemCsv.map((r) => [r['#'], r.Icon]).filter(([, i]) => i && i !== '0'));
  const iconUrl = (id) => {
    const iid = iconIdByItem.get(String(id));
    if (!iid) return null;
    const n = parseInt(iid, 10);
    const folder = String(Math.floor(n / 1000) * 1000).padStart(6, '0');
    const file = String(n).padStart(6, '0');
    return `https://v2.xivapi.com/api/asset?path=ui/icon/${folder}/${file}.tex&format=png`;
  };

  // ─── 採取枠の位置（ゲーム本来の8枠構造） ───
  // GatheringPointBase.Item[0..7] は GatheringItem 行への参照（0=空き枠）。
  // GatheringItem.Item が実アイテムID。位置(枠番号)を保持したまま復元する。
  const gpBase = new Map(parseCsv(raw['GatheringPointBase.csv']).map((r) => [r['#'], r]));
  const gItem  = new Map(parseCsv(raw['GatheringItem.csv']).map((r) => [r['#'], r]));
  // GatheringItemLevel は一般素材ではアイテムレベルであり、採取手帳のレベルではない。
  // シャード・クリスタル・クラスターだけはゲーム内の固定採取レベルとして扱う。
  const ELEMENTAL_GATHERING_LEVELS = new Map([
    [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1],
    [8, 26], [9, 26], [10, 26], [11, 26], [12, 26], [13, 26],
    [14, 50], [15, 50], [16, 50], [17, 50], [18, 50], [19, 50],
    [10099, 50], [10335, 50],
  ]);
  const itemGatheringLevel = (itemId, fallbackLevel) => ELEMENTAL_GATHERING_LEVELS.get(Number(itemId)) || Number(fallbackLevel) || null;

  const resolveSlotDetails = (baseId) => {
    const b = gpBase.get(String(baseId));
    if (!b) return null;
    const slots = [];
    for (let i = 0; i < 8; i++) {
      const giId = b[`Item[${i}]`];
      if (!giId || giId === '0') { slots.push(null); continue; }
      const gi = gItem.get(giId);
      const itemId = gi?.Item;
      const parsedId = itemId && itemId !== '0' ? parseInt(itemId, 10) : null;
      slots.push(parsedId != null && !isObsoleteDiademItem(parsedId) ? {
        itemId: parsedId,
        gatheringLevel: itemGatheringLevel(parsedId, b.GatheringLevel),
      } : null);
    }
    return slots;
  };
  const resolveSlots = (baseId) => resolveSlotDetails(baseId)?.map((slot) => slot?.itemId ?? null) || null;

  // ─── ノード正規化 ─────────────────────────────────────────────
  const LABEL = {
    node_type: { normal: '通常', unspoiled: '未知', legendary: '伝説', ephemeral: '刻限', folklore: '伝承' },
    use: useLabels,
    class: { MIN: '採掘師', BTN: '園芸師' },
  };
  const itemInfo = new Map();
  const runtimeNodes = [];
  for (const id in nodes) {
    const n = nodes[id];
    if (!n.limited || n.type > 3) continue;        // 時間限定の陸ノードのみ（漁除外）
    const cls = classOf(n.type);
    const tool = toolOf(n.type);
    const a = nearestAeth(n);
    // Teamcraft側で zoneid/map が 0（未設定）のノードが稀にある。
    // 最寄りエーテライト自身の zoneid/map で補う（対象は現行データで6件）。
    const effZoneId = n.zoneid || a?.zoneid;
    const effMapId = (n.map != null && n.map !== 0) ? n.map : a?.map;
    const gm = effMapId != null ? gameMaps[effMapId] : null;
    // ゲーム内座標(1-41付近)→画像上の%位置。釣り図鑑と同じ変換式。
    const mapPct = (coord) => (((coord - 1) * ((gm?.size_factor ?? 100) / 100)) / 41) * 100;
    const visibleIds = (n.items || []).filter((it) => !isObsoleteDiademItem(it));
    const hiddenIds  = (n.hiddenItems || []).filter((it) => !isObsoleteDiademItem(it));
    const allIds = visibleIds.concat(hiddenIds);
    if (!allIds.length) continue;
    for (const it of allIds) {
      if (!itemInfo.has(it)) itemInfo.set(it, { jobs: new Set() });
      itemInfo.get(it).jobs.add(cls);
    }
    const rawSlotDetails = resolveSlotDetails(n.base);
    const nodeKind = nodeType(n);
    const patch = nodePatch(n.items || []);
    const nodeBonuses = bonusesForNode(n.base, patch, nodeKind);
    const levelByItem = new Map((rawSlotDetails || []).filter(Boolean).map((slot) => [slot.itemId, slot.gatheringLevel]));
    const rawSlots = rawSlotDetails?.map((slot) => slot?.itemId ?? null) || null;
    const makeItem = (itemId, extra = {}) => ({
      id: `it_${itemId}`, name: itemJa(itemId), names: itemNames(itemId), collectable: !!coll[itemId], use: usesFor(itemId), icon: iconUrl(itemId),
      gatheringLevel: itemGatheringLevel(itemId, n.level), ...extra,
    });
    const slots = rawSlots ? rawSlots.map((itemId) => itemId == null ? null : makeItem(itemId)) : null;
    runtimeNodes.push({
      id: `nd_${id}`, class: cls, tool: tool.id, toolLabel: tool.label, toolMain: tool.main, toolIcon: tool.icon, node_type: nodeKind, level: n.level,
      area: gm ? placeJa(gm.placename_id) : placeJa(effZoneId), areaNames: gm ? placeNames(gm.placename_id) : placeNames(effZoneId),
      map: gm ? { image: gm.image, px: mapPct(n.x), py: mapPct(n.y), id: effMapId, names: placeNames(gm.placename_id) } : null,
      aetheryte: a ? placeJa(a.nameid) : '', aetheryteNames: a ? placeNames(a.nameid) : {ja:'',en:'',de:'',fr:''},
      x: n.x, y: n.y,
      windows: windows(n).map((w) => { const [s, e] = w.split('-').map(Number); return [s, e]; }),
      patch,
      folklore: n.folklore ? itemJa(n.folklore) : '',
      slots,
      items: visibleIds.map((it) => makeItem(it, { hidden: false }))
        .concat(hiddenIds.map((it, i) => makeItem(it, { hidden: true, stars: i + 1 }))),
      use: [...new Set(allIds.flatMap((it) => usesFor(it)))],
      bonuses: nodeBonuses,
      achievements: [],
    });
  }

  // ─── 常時採取ノード（シャード・クリスタル・種など） ───────────────
  // Teamcraft の nodes.json は時間限定ノードを中心に収録しているため、
  // 通常ノードは公式 GatheringPoint / GatheringPointBase から補完する。
  const limitedBases = new Set(Object.values(nodes).filter(n => n.limited && n.base != null).map(n => String(n.base)));
  const mapByTerritory = new Map();
  for (const gm of Object.values(gameMaps)) {
    if (gm.territory_id == null || gm.dungeon || !gm.image) continue;
    const key = String(gm.territory_id);
    const old = mapByTerritory.get(key);
    if (!old || (gm.index ?? 0) < (old.index ?? 0) || (gm.priority_ui ?? 999) < (old.priority_ui ?? 999)) mapByTerritory.set(key, gm);
  }
  const normalRows = new Map();
  for (const r of gpRows) {
    const baseId = String(r.GatheringPointBase || '');
    if (!baseId || baseId === '0' || r.PlaceName === '0') continue;
    const b = gpBase.get(baseId);
    const gatheringType = Number(b?.GatheringType);
    if (!b || !Number.isInteger(gatheringType) || gatheringType < 0 || gatheringType > 3 || limitedBases.has(baseId)) continue;
    const gm = mapByTerritory.get(String(r.TerritoryType));
    const ep = exportedGp.get(baseId);
    if (!gm || !ep || ep.X === '' || ep.Y === '') continue;
    const key = `${r.TerritoryType}:${r.PlaceName}:${gatheringType}:${baseId}`;
    if (!normalRows.has(key)) normalRows.set(key, { r, b, gm, ep, gatheringType });
  }
  const normalMapPct = (coord, gm) => (((coord - 1) * ((gm?.size_factor ?? 100) / 100)) / 41) * 100;
  for (const [key, row] of normalRows) {
    const { r, b, gm, ep, gatheringType } = row;
    const worldX = Number(ep.X), worldY = Number(ep.Y);
    // ExportedGatheringPoint はワールド座標。ゲーム内マップ座標へ変換する。
    const x = 21.5 + worldX / 50;
    const y = 21.5 + worldY / 50;
    const a = nearestAeth({ map: gm.id, x, y, zoneid: gm.placename_id });
    const itemDetails = (resolveSlotDetails(String(r.GatheringPointBase)) || []).filter((slot) => slot && items[slot.itemId] && !isObsoleteDiademItem(slot.itemId));
    const itemIds = itemDetails.map((slot) => slot.itemId);
    if (!itemIds.length) continue;
    for (const it of itemIds) {
      if (!itemInfo.has(it)) itemInfo.set(it, { jobs: new Set() });
      itemInfo.get(it).jobs.add(gatheringType <= 1 ? 'MIN' : 'BTN');
    }
    const tool = toolOf(gatheringType);
    const nodeBonuses = bonusesForBase(r.GatheringPointBase);
    const names = itemDetails.map((slot) => ({ id: `it_${slot.itemId}`, name: itemJa(slot.itemId), names: itemNames(slot.itemId), collectable: !!coll[slot.itemId], use: usesFor(slot.itemId), hidden: false, icon: iconUrl(slot.itemId), gatheringLevel: itemGatheringLevel(slot.itemId, b.GatheringLevel) }));
    const patch = nodePatch(itemIds);
    runtimeNodes.push({
      id: `nd_normal_${key.replace(/[^a-zA-Z0-9_:-]/g, '_')}`, class: gatheringType <= 1 ? 'MIN' : 'BTN', tool: tool.id, toolLabel: tool.label, toolMain: tool.main, toolIcon: tool.icon,
      node_type: 'normal', normal: true, limited: false, level: Number(b.GatheringLevel) || 1,
      area: placeJa(gm.placename_id), areaNames: placeNames(gm.placename_id),
      map: { image: gm.image, px: normalMapPct(x, gm), py: normalMapPct(y, gm), id: gm.id, names: placeNames(gm.placename_id) },
      aetheryte: a ? placeJa(a.nameid) : '', aetheryteNames: a ? placeNames(a.nameid) : {ja:'',en:'',de:'',fr:''},
      x, y, windows: [], patch, folklore: '', slots: names, items: names, bonuses: nodeBonuses, use: [...new Set(itemIds.flatMap(it => usesFor(it)))], achievements: [],
    });
  }

  // ─── アイテム辞書 / 逆引き ─────────────────────────────────────
  const runtimeItems = [...itemInfo.entries()].map(([id, info]) => ({
    id: `it_${id}`, name: itemJa(id), job: info.jobs.size === 1 ? [...info.jobs][0] : 'BOTH',
    collectable: !!coll[id], use: usesFor(id),
  }));
  const itemToNodes = {};
  for (const n of runtimeNodes) for (const it of n.items) (itemToNodes[it.id] ??= []).push(n.id);

  // ─── アチーブメント（名称＋条件文を datamining CSV から） ───────────
  const achCsv = parseCsv(raw['Achievement_ja.csv']);
  const achDefs = new Map();
  for (const r of achCsv) {
    const rid = r['#']; const name = (r.Name || '').trim();
    if (!rid || !name || !ACH_KEYWORD.test(name)) continue;
    achDefs.set(`ac_${rid}`, { id: `ac_${rid}`, name, condition: (r.Description || '').trim(), tip: '', link_type: '', link_ids: [] });
  }

  // 手動リンク/攻略（data/achievement-links.json）。ノード紐付けと攻略メモだけ。
  const nodeIds = new Set(runtimeNodes.map((n) => n.id));
  const itemIds = new Set(runtimeItems.map((i) => i.id));
  const areaSet = new Set(runtimeNodes.map((n) => n.area));
  const nodeById = new Map(runtimeNodes.map((n) => [n.id, n]));
  let links = [];
  try { links = JSON.parse(await readFile(path.join(ROOT, 'data', 'achievement-links.json'), 'utf8')).links ?? []; }
  catch { /* 無くてよい */ }
  let linked = 0;
  for (const lk of links) {
    const rec = achDefs.get(lk.ach_id);
    if (!rec) { log(`ach    リンク先が未収録: ${lk.ach_id}`); continue; }
    const ids = lk.link_ids ?? [];
    rec.tip = lk.tip || ''; rec.link_type = lk.link_type || ''; rec.link_ids = ids;
    const targets = new Set();
    if (lk.link_type === 'node') ids.forEach((id) => nodeIds.has(id) && targets.add(id));
    if (lk.link_type === 'item') ids.forEach((id) => (itemToNodes[id] || []).forEach((nd) => targets.add(nd)));
    if (lk.link_type === 'zone') runtimeNodes.filter((n) => ids.includes(n.area)).forEach((n) => targets.add(n.id));
    targets.forEach((id) => nodeById.get(id)?.achievements.push(rec.id));
    if (targets.size) linked++;
  }
  // 自動リンク: 地域別・レベル帯別の採掘名人系は、条件に合う全ノードへ紐付ける。
  // 手動リンクは攻略メモを保持しつつ、対象ノードだけ自動リンクで補完する。
  const addAchievementTargets = (rec, targets) => {
    const ids = [...new Set(targets.map((n) => n.id))];
    if (!ids.length) return;
    const existing = new Set(rec.link_ids || []);
    ids.forEach((id) => existing.add(id));
    rec.link_ids = [...existing];
    if (!rec.link_type) rec.link_type = 'node';
    ids.forEach((id) => {
      const node = nodeById.get(id);
      if (node && !node.achievements.includes(rec.id)) node.achievements.push(rec.id);
    });
  };
  const regionMatchers = [
    ['ラノシア', (n) => n.area.includes('ラノシア')],
    ['黒衣森', (n) => n.area.includes('黒衣森')],
    ['ザナラーン', (n) => n.area.includes('ザナラーン')],
  ];
  for (const rec of achDefs.values()) {
    const regional = rec.name.match(/^(ラノシア|黒衣森|ザナラーン)の採掘(名人|王)/);
    if (regional) {
      const [, region, kind] = regional;
      const matcher = regionMatchers.find(([prefix]) => prefix === region)?.[1];
      const grade = rec.name.match(/グレード(\d+)/);
      const minLevel = grade ? (Number(grade[1]) - 1) * 10 + 1 : 1;
      const maxLevel = grade ? minLevel + 9 : 50;
      addAchievementTargets(rec, runtimeNodes.filter((n) => matcher?.(n) && n.class === 'MIN' && n.level >= minLevel && n.level <= maxLevel));
      continue;
    }
    if (/採掘名人$/.test(rec.name)) {
      const range = rec.condition.match(/レベル(\d+)-(\d+)/);
      if (range) {
        const minLevel = Number(range[1]); const maxLevel = Number(range[2]);
        addAchievementTargets(rec, runtimeNodes.filter((n) => n.class === 'MIN' && n.level >= minLevel && n.level <= maxLevel));
      }
    }
  }
  const runtimeAchs = [...achDefs.values()];

  // ─── 出力データ ───────────────────────────────────────────────
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      eorzea_multiplier: 3600 / 175,
      labels: LABEL,
      counts: {
        nodes: runtimeNodes.length, items: runtimeItems.length,
        achievements: runtimeAchs.length,
        byType: runtimeNodes.reduce((o, n) => ((o[n.node_type] = (o[n.node_type] || 0) + 1), o), {}),
      },
      sources: [
        'FFXIV Teamcraft (MIT) — 採取ポイントの出現ET・座標・取得物、アイテム名、地名、収集品、精選、実装パッチ',
        'xivapi/ffxiv-datamining — アチーブメントの名称・条件文（日本語）',
      ],
    },
    nodes: runtimeNodes,
    items: runtimeItems,
    achievements: runtimeAchs,
    index: { itemToNodes },
  };

  // ─── dist 生成（釣り図鑑と同じ構成） ─────────────────────────────
  const tpl = await readFile(path.join(ROOT, 'app', 'index.html'), 'utf8');
  const MARK_DATA = '/*__DATA__*/null';
  const MARK_URLS = '/*__URLS__*/null';
  if (!tpl.includes(MARK_DATA) || !tpl.includes(MARK_URLS)) throw new Error('app/index.html に差し込み位置がありません');

  const DIST = path.join(ROOT, 'dist');
  await rm(DIST, { recursive: true, force: true });
  await mkdir(path.join(DIST, 'data'), { recursive: true });

  const json = JSON.stringify(out);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 10);
  const coreName = `core.${hash}.json`;
  await writeFile(path.join(DIST, 'data', coreName), json);

  // 静的ファイル（app/static/* → dist/ 直下）
  const STATIC = path.join(ROOT, 'app', 'static');
  let staticFiles = [];
  try { staticFiles = (await readdir(STATIC, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name); } catch {}
  for (const name of staticFiles) await cp(path.join(STATIC, name), path.join(DIST, name));
  const hasOgp = staticFiles.includes('ogp.png');
  const og = (t) => (hasOgp ? t : t
    .replace(/^<meta property="og:image"[^\n]*\n/m, '')
    .replace('<meta name="twitter:card" content="summary_large_image">', '<meta name="twitter:card" content="summary">'));

  // shell（データは別ファイルから読む）
  const shell = og(tpl.replaceAll('__SITE_URL__', SITE_URL)
    .replace(MARK_URLS, JSON.stringify({ core: `data/${coreName}` })));
  await writeFile(path.join(DIST, 'index.html'), shell);

  // standalone（全部埋め込み。file:// で直接開ける）
  const standalone = og(tpl.replaceAll('__SITE_URL__', SITE_URL)).replace(MARK_DATA, json);
  await writeFile(path.join(DIST, 'standalone.html'), standalone);

  await writeFile(path.join(DIST, '.nojekyll'), '');
  await writeFile(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  await writeFile(path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>\n</urlset>\n`);
  await writeFile(path.join(DIST, '_headers'),
    `/data/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/\n  Cache-Control: public, max-age=600\n`);

  log(`書き出し dist/index.html            ${sz(shell)}`);
  log(`         dist/data/${coreName}  ${sz(json)}`);
  log(`         dist/standalone.html         ${(standalone.length / 1024).toFixed(0)} KB`);
  console.log(
    `\nノード ${out.meta.counts.nodes}（${Object.entries(out.meta.counts.byType).map(([k, v]) => `${LABEL.node_type[k]} ${v}`).join(' / ')}）` +
    `\nアイテム ${out.meta.counts.items} / 逆引き ${Object.keys(itemToNodes).length}` +
    `\nアチーブメント ${out.meta.counts.achievements}（条件文入り ${runtimeAchs.filter((a) => a.condition).length} / ノード紐付け ${linked}）` +
    `\n用途ラベル ${Object.values(useLabels).join('・')}` +
    (staticFiles.length ? `\n静的複製 ${staticFiles.join(' / ')}` : '\nog:image なし（app/static/ogp.png を置くと付く）'),
  );
}

main().catch((e) => { console.error('ビルド失敗:', e.message); process.exit(1); });
