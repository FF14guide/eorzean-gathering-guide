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
};

// 採集系アチーブメントを名称で絞る語彙（DoL のみ拾う）
const ACH_KEYWORD = /採集|採掘|園芸|収集|幻想|伝説|エオルゼア|名匠|ギャザ|マイスター|大地|自然|カーマ|土地神|恵み/;

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
  const pnames = JSON.parse(raw['patch-names.json']);

  const placeJa = (id) => (places[id]?.ja || places[id]?.en || '').trim();
  const itemJa  = (id) => (items[id]?.ja || items[id]?.en || `#${id}`).trim();

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
    return [...tags];
  };

  // ─── アイテムの実装パッチ "X.Y" ───────────────────────────────
  const itemVersion = (itemId) => {
    const nm = (pnames[ipatch[itemId]] && (pnames[ipatch[itemId]].en || pnames[ipatch[itemId]].ja)) || '';
    const m = nm.match(/(\d+\.\d+)/); return m ? parseFloat(m[1]) : null;
  };
  const nodePatch = (ids) => { const vs = ids.map(itemVersion).filter((v) => v != null); return vs.length ? Math.max(...vs).toFixed(1) : ''; };

  // ─── ノード正規化 ─────────────────────────────────────────────
  const LABEL = {
    node_type: { unspoiled: '未知', legendary: '伝説', ephemeral: '幻想', folklore: '伝承' },
    use: useLabels,
    class: { MIN: '採掘師', BTN: '園芸師' },
  };
  const itemInfo = new Map();
  const runtimeNodes = [];
  for (const id in nodes) {
    const n = nodes[id];
    if (!n.limited || n.type > 3) continue;        // 時間限定の陸ノードのみ（漁除外）
    const cls = classOf(n.type);
    const a = nearestAeth(n);
    const gm = n.map != null ? gameMaps[n.map] : null;
    // ゲーム内座標(1-41付近)→画像上の%位置。釣り図鑑と同じ変換式。
    const mapPct = (coord) => (((coord - 1) * ((gm?.size_factor ?? 100) / 100)) / 41) * 100;
    const visible = (n.items || []).concat(n.hiddenItems || []);
    for (const it of visible) {
      if (!itemInfo.has(it)) itemInfo.set(it, { jobs: new Set() });
      itemInfo.get(it).jobs.add(cls);
    }
    runtimeNodes.push({
      id: `nd_${id}`, class: cls, node_type: nodeType(n), level: n.level,
      area: placeJa(n.zoneid), aetheryte: a ? placeJa(a.nameid) : '',
      x: n.x, y: n.y,
      map: gm ? { image: gm.image, px: mapPct(n.x), py: mapPct(n.y) } : null,
      windows: windows(n).map((w) => { const [s, e] = w.split('-').map(Number); return [s, e]; }),
      patch: nodePatch(n.items || []),
      folklore: n.folklore ? itemJa(n.folklore) : '',
      items: visible.map((it) => ({ id: `it_${it}`, name: itemJa(it), collectable: !!coll[it], use: usesFor(it) })),
      use: [...new Set(visible.flatMap((it) => usesFor(it)))],
      achievements: [],
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
