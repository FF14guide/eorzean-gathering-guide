# エオルゼア採集図鑑 — Eorzean Gathering Guide

どの採取場で、いつ、何が取れるのか。採掘師・園芸師の時間限定ノード（未知・伝説・幻想）を、
エオルゼア時間でカウントダウンしながら一覧する非公式データベース。
姉妹サイト「エオルゼア釣り図鑑」と同じ作法で作ってある。

**収録：採取ポイント 225（未知 112 / 伝説 83 / 幻想 30）／アイテム 341 種**
**用途（精選・スクリップ）と実装パッチは外部データから自動判定**
**アチーブメント 155 件の名称・条件文を datamining から自動取り込み**

---

## 動かす

```bash
node tools/build.mjs            # dist/ を生成（キャッシュがあれば使う）
node tools/build.mjs --refresh  # 上流データを取り直す（パッチ後はこれ）
```

生成物は `dist/` に入る。静的ファイルだけなので、そのまま置けばどこでも動く。

```
dist/
  index.html            骨格だけ。データは別ファイルから読む
  data/core.xxxx.json   採取ポイント・アイテム・アチーブメント。約 136 KB
  standalone.html       全部入りの単体版。file:// で直接開ける
  robots.txt / sitemap.xml / _headers / .nojekyll
```

**手元で確認するとき**は `dist/standalone.html` をブラウザで直接開く。
`index.html` はデータを別ファイルから読むので `file://` では動かない
（ローカル配信なら `npx serve dist`）。

環境変数：

| 変数 | 用途 |
|---|---|
| `SITE_URL` | 公開先のURL。OGP・canonical・sitemap の絶対URLに使う |

```bash
SITE_URL=https://saisyu.eorzeanfishing.com node tools/build.mjs
```

## 中身

```
app/index.html               サイト本体（データ差し込み前のテンプレート）
app/static/                  そのまま dist/ 直下へ複製される静的ファイル（SNS共有用の ogp.png を含む）
tools/build.mjs              ETL。外部データを取得して正規化し dist/ を書き出す
tools/.cache/                ダウンロードした元データ（.gitignore 済み）
data/achievement-links.json  唯一の手動データ：アチーブメントのノード紐付けと攻略メモ
```

## データはすべて外部由来（手入力ゼロ）

採取データ本体は `tools/build.mjs` が上流から毎回組み立てる。手入力する採取データは無い。

| 項目 | 出典 | 導出 |
|---|---|---|
| クラス・種別・Lv・座標・出現ET・取得物 | Teamcraft `nodes.json` | `spawns`+`duration` → 出現枠、`type` → 採掘/園芸、`ephemeral`/`folklore` → 種別 |
| アイテム名・地名・エーテライト | Teamcraft `items`/`places`/`aetherytes` | 日本語名。AREAは地図画像自体が持つ`placename_id`（MAP名単位）を使用。最寄りエーテライトは同マップ最短で解決。ノード側のzoneid/mapが欠損(0)の場合は最寄りエーテライト自身のzoneid/mapで補完 |
| 用途（精選・スクリップ色） | Teamcraft `reverse-reduction`/`collectables` | 精選対象＝「精選」、収集品は報酬通貨名から色（例 橙貨・紫貨） |
| 実装パッチ | Teamcraft `item-patch`/`patch-names` | 見出し取得物の最大パッチ |
| 地図画像・座標変換 | Teamcraft `maps.json`（XIVAPI v2アセット配信） | ノードの`map`IDから画像URLと`size_factor`を解決。座標をマップ画像上の%位置に変換 |
| アチーブメント名称・条件文 | xivapi/ffxiv-datamining `ja/Achievement.csv` | 採集系を名称で絞り、`Name`/`Description` を取得 |
| アイテムアイコン | xivapi/ffxiv-datamining `ja/Item.csv`（`Icon`列）→ XIVAPI v2アセット配信 | アイコンIDから `ui/icon/xxx000/xxxNNN.tex` のパスを組み立てて画像URL化 |
| 採取枠の位置（空き枠含む8枠） | xivapi/ffxiv-datamining `en/GatheringPointBase.csv`＋`en/GatheringItem.csv` | ノードの`base`IDで`Item[0]`〜`Item[7]`を解決。Teamcraft側の`items`との突合で全225ノード完全一致を確認済み |

**唯一の手動データ**は `data/achievement-links.json`。アチーブメントの名称・条件文は自動で入るので、
ここには「どのノード/エリア/アイテムに紐づくか（link）」と「攻略メモ（tip）」だけを書く。
空でもサイトは成立し、書いた分だけノード詳細に「どうすれば取れるか」ガイドが増える。

```json
{ "links": [
  { "ach_id": "ac_190", "link_type": "node", "link_ids": ["nd_289"], "tip": "…" }
] }
```

`ach_id` は `ac_<XIVID>`、`link_type` は `node` / `item` / `zone`（zone はエリア名）。
参照先が実在しないと build 時に警告が出る。

## できること

- **一覧＝近い時間順** — いま取れるノードが緑に点灯し、次に開く順で並ぶ。バーが窓の接近を表す
- **絞り込み** — 採掘/園芸・種別（未知/伝説/幻想）・エリア・用途
- **逆引き検索** — アイテム名で検索すると、それが取れるノードに絞れる。詳細には「この取得物は他◯か所でも取れる」も出る
- **ノード詳細** — エリア・最寄りエーテライト・座標・全取得物（収集品は◆）・用途・伝承録・出現枠・アチーブメント攻略
- **アラーム** — 詳細で登録すると、取得可能になった瞬間にトースト通知。ブラウザ通知を許可した場合はデスクトップ通知も使用できる
- **端末内保存** — 取得済み・お気に入り・アラームは、このブラウザの端末内に保存され、再読み込み後も維持される。別ブラウザ／別端末への同期はしない
- **ET時計** — エオルゼア時間と現地時間を並べて表示。カウントダウンは実時間で常に正確

## パッチが来たら

```bash
node tools/build.mjs --refresh
```

上流（Teamcraft / datamining）が更新されていれば、新エリアのノードとアイテムが自動で入る。公開中のGitHub Actionsは毎日正午（JST）に24ソースを再取得し、各ソースのSHA-256と最新・準最新パッチを `tools/upstream-state.json` に記録する。差分を検知した場合だけ状態ファイルを自動コミットし、Cloudflare Pagesを再ビルドするため、パッチ後のデータ更新が自動で本番へ反映される。差分がない日は公開処理を行わない。パッチ直後に確認したい場合は、Actionsの `ビルドと公開` を手動実行できる。初回公開前はGitHub Actions Secret `CLOUDFLARE_PAGES_DEPLOY_HOOK` と、ワークフローがコミットできる `contents: write` 権限を確認すること。詳しくは [PUBLISHING.md](PUBLISHING.md) を参照。

## 公開する

`dist/` を置くだけ。SNS共有では `app/static/ogp.png` がOGP画像として自動で含まれる。**サブドメインでの公開手順とDeploy Hookの設定は [PUBLISHING.md](PUBLISHING.md)** にまとめてある。

## 著作物利用条件について

スクウェア・エニックスの「FFXIV 著作物利用条件」に従う。**ゲーム内テキスト**（アイテム名・
地名・アチーブメントの条件文など）は利用できる著作物に含まれる。運営は日本国内向けの非営利で、
**広告・投げ銭・アフィリエイトは入れない**。権利表記はフッターに出してある。当社から依頼が
あれば遅滞なく利用を中止する旨も明記済み。上流データの出典（Teamcraft: MIT、ffxiv-datamining）
もフッターに出している。

---

FINAL FANTASY XIV © SQUARE ENIX CO., LTD. All Rights Reserved.
非公式ファンサイト。スクウェア・エニックスとは関係ありません。
