# 公開までの手順（サブドメイン）

釣り図鑑（`eorzeanfishing.com`）が Cloudflare にあるなら、その**サブドメイン**で
採集手帳を出すのが一番きれい。例：`https://saisyu.eorzeanfishing.com`。

親ドメインが Cloudflare の DNS に載っているので、サブドメインは Pages 側で入力するだけで
DNS レコードも証明書も自動で付く。費用ゼロ・追加のドメイン購入は不要。所要 20〜30 分。

---

## 全体像

```
GitHub リポジトリ ──push──▶ Cloudflare Pages が自動ビルド・公開
                            └─ saisyu.eorzeanfishing.com（サブドメイン）
GitHub Actions ──毎日──▶ 上流データを取り直して push（＝再ビルドのきっかけ）
```

釣り図鑑と別リポジトリ・別 Pages プロジェクトにする。親ドメインは共有し、
サブドメインだけ分ける形。

---

## 手順1：GitHub にリポジトリを作る（10分）

1. GitHub で **New repository** → 名前 `eorzean-gathering-guide` → **Public** → 作成
2. このフォルダを push する（Git 未導入なら <https://git-scm.com/downloads>）

```bash
cd eorzean-gathering-guide      # このフォルダ
git init
git add .
git commit -m "エオルゼア採集図鑑"
git branch -M main
git remote add origin https://github.com/ユーザー名/eorzean-gathering-guide.git
git push -u origin main
```

> `dist/` と `tools/.cache/` は `.gitignore` 済み。ビルド結果とキャッシュは毎回作り直すので
> リポジトリに入れない。`data/achievement-links.json` は入れる（手動データ）。

---

## 手順2：Cloudflare Pages に繋ぐ（10分）

1. <https://dash.cloudflare.com> → **Compute (Workers) → Pages** → **Git に接続**
2. `eorzean-gathering-guide` を選ぶ
3. ビルド設定：

   | 項目 | 値 |
   |---|---|
   | フレームワーク プリセット | なし（None） |
   | ビルドコマンド | `node tools/build.mjs --refresh` |
   | ビルド出力ディレクトリ | `dist` |

4. **保存してデプロイ** → 数分で `https://eorzean-gathering-guide.pages.dev` が出る

（Node で落ちる場合は環境変数に `NODE_VERSION` = `20` を追加）

---

## 手順3：サブドメインを割り当てる（5分）

1. その Pages プロジェクト → **カスタムドメイン** → **カスタムドメインを設定**
2. `saisyu.eorzeanfishing.com`（好きなサブドメイン名）を入力
3. 親ドメインが同じ Cloudflare アカウントにあるので、**DNS レコード（CNAME）は自動で追加**される。
   案内に従って承認するだけ。証明書も自動発行

> 親ドメインが別アカウント／別レジストラにある場合は、表示された CNAME を
> 親側の DNS に手で足す。

---

## 手順4：SITE_URL を入れて再デプロイ（3分）

1. Pages プロジェクト → **設定 → 環境変数** に追加

   | 名前 | 値 |
   |---|---|
   | `SITE_URL` | `https://saisyu.eorzeanfishing.com` |

2. **デプロイを再実行**（OGP・canonical・sitemap の絶対URLがサブドメインになる）

これで公開完了。以後 GitHub に push があるたびに自動で作り直される。

---

## 手順5：自動更新の確認

`.github/workflows/build.yml` が毎日正午（JST）に走り、上流データを取り直して push する。
Cloudflare Pages がその push を拾って再ビルドするので、放っておけば最新に追従する。
パッチ直後など待てないときは **Actions タブ → Run workflow** で手動実行。

---

## とりあえず今すぐ見たいなら

Git を用意する前でも、**`dist/` フォルダ**（`node tools/build.mjs` で生成）を
Cloudflare Pages の「アップロード」に投げれば即公開できる。あとから Git 連携に切り替えればいい。
サブドメイン割り当て（手順3）とやり方は同じ。

---

## 独自のトップドメインで出したいなら

サブドメインではなく `saisyu-zukan.com` のような別ドメインにするなら、手順3で
そのドメインを入力し、レジストラで取得（Cloudflare Registrar が原価に近い）。
`SITE_URL` をそのドメインに変えて再デプロイする。

> ドメイン代は運営費であって収益ではないので、著作物利用条件の「商用・営利目的」には
> 当たらない。ただし**広告・投げ銭・アフィリエイトで回収しようとすると抵触する**。

---

## つまずいたら

**push で認証を求められ続ける** → GitHub のパスワードではなくトークン。ブラウザ認証が出たら従う。
出なければ Settings → Developer settings → Personal access tokens で `repo` 権限のトークンを作り、パスワード欄に貼る。

**Cloudflare のビルドが Node のバージョンで落ちる** → 環境変数に `NODE_VERSION` = `20`。

**ビルドは通るのにページが真っ白** → 出力ディレクトリが `dist` か確認。ブラウザの開発者ツールの
コンソールに読み込みエラーが出ていないかも見る。

**GitHub Pages だけで済ませたい**（サブドメインは使わない）
→ リポジトリ変数に `DEPLOY_GITHUB_PAGES` = `true` と `SITE_URL` を足し、
Settings → Pages の Source を「GitHub Actions」にする。URL は `ユーザー名.github.io/eorzean-gathering-guide`。
