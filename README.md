# QtOrderRelease

QtOrder 的發布中心：以 GitHub Pages 提供各版本的版本說明、下載檔案與 SHA-256，並產生 QtOrder 啟動器讀取的更新清單。
用語（預覽版、穩定版、晉升、撤回、最低支援版本…）以 [CONTEXT.md](CONTEXT.md) 為準；為什麼這樣設計見 [docs/adr/](docs/adr/)。

> 目前 `data/releases.json` 是模擬資料（`"mock": true`）：頁面頂端顯示提示，部署時自動加上 `noindex`。
> 第一個正式版本（首發）發布時，`scripts/release-record.js` 會清掉模擬資料。QtOrder 的打包流程已不再把 GCP 金鑰放進套件（QtOrder ADR-0034），並在發布前掃描機密。

## 結構

```text
index.html                    頁面骨架（純靜態）
assets/js/app.js              讀取發布紀錄並渲染頁面
assets/js/release-model.js    發布規則：各券商的最新版本、更新清單、跨欄位檢查；頁面與建置腳本共用
assets/css/site.css           樣式；版型參考 apple.com，只有淺色配色，色彩集中在 :root 的語意 token（已標註 WCAG AA 對比值）
data/releases.json            發布紀錄，唯一的資料來源
data/releases.schema.json     發布紀錄的 JSON Schema
scripts/build-site.js         驗證發布紀錄，輸出網站與更新清單（_site/update.json）
scripts/release-record.js     QtOrder 的 CI 與發布 workflow 呼叫：各券商的比較基準、發布與晉升前的檢查、寫入新版本、晉升
tests/                        發布規則與發布紀錄腳本的測試
.github/workflows/pages.yml   PR 時驗證；合併到 main 後建置並部署 Pages
```

## 本機開發

```powershell
npm ci
npm test          # 發布規則測試
npm run check     # 只驗證 data/releases.json
npm run build     # 驗證後輸出 _site/（含 update.json）
python -m http.server 8080 --directory _site   # 開啟 http://localhost:8080/
```

直接用瀏覽器開啟 `index.html`（`file://`）會讀不到 JSON，請透過靜態伺服器。

## 啟用 GitHub Pages

Settings → Pages → Build and deployment → Source 選 **GitHub Actions**。之後每次合併到 `main` 都會自動部署：

- 發布中心：`https://projectontitan.github.io/QtOrderRelease/`
- 更新清單：`https://projectontitan.github.io/QtOrderRelease/update.json`

GitHub Pages 約有 10 分鐘快取，發布後客戶最多晚 10 分鐘看到新版本。

## 發布流程

QtOrder 推到 `main` 時，CI 只打包自上次發布以來有異動的券商；發布與晉升在 QtOrder 的 `main` 手動觸發 `Release` workflow，勾選券商與通道，
以 GitHub App 直接 commit 到本 repo 的 `main`，Pages 隨之部署（QtOrder ADR-0043、ADR-0044，本 repo [ADR-0003](docs/adr/0003-publish-from-qtorder-workflow.md)、[ADR-0005](docs/adr/0005-per-broker-releases.md)）。
版本號三家共用，每個版本只含發布時勾選的券商。版本說明寫在 QtOrder 的 `release-notes/<版本>.md`，在 QtOrder 的 PR 審核；操作步驟見 QtOrder 的 `docs/04-release.md`。

| 動作 | 怎麼做 | 發布紀錄的變化 |
| --- | --- | --- |
| 發布預覽版 | 觸發時勾選券商、通道選預覽版 | workflow 建立 GitHub Release（tag `v<版本>`、標為 prerelease），只上傳勾選券商的安裝程式與更新套件，新增一筆 `channel: "preview"` 的版本。勾選的每一家都必須已有穩定版 |
| 晉升 | 觸發時動作選晉升、填版本號 | 該版本的 `channel` 改為 `"stable"`、填入 `promotedAt`；版本包含的券商一起晉升，下載檔案不變 |
| 首發 | 某家的第一個版本，通道選穩定版 | 新增一筆 `channel: "stable"` 的版本，`minimumVersions` 的那一家設為這個版本；整個發布中心的第一個正式版本另外清掉模擬資料 |
| 緊急修正 | 以新的版本號、通道選穩定版 | 新增一筆 `channel: "stable"`、沒有 `promotedAt` 的版本。QtOrder 只從 `main` 發布，`main` 上尚未發布的變更會一起發出 |
| 撤回 | 手動發 PR | 填入 `withdrawn: { at, reason }`，並刪除該 GitHub Release 上的檔案。撤回不會強制已安裝的客戶更新；要強制，另外提高那幾家的 `minimumVersions` |
| 調整最低支援版本 | 手動發 PR | 修改 `minimumVersions` 裡那一家的版本，必須是包含這家的未撤回穩定版 |

已發布的版本不補發其他券商，要發布另一家就升版號。每次修改都要更新 `generatedAt`。
CI 會擋下這些錯誤：版本號帶預覽標記、重複或沒有隨發布時間遞增；某家成為穩定版的版本號沒有遞增；包含的券商缺少安裝程式或更新套件；
某家的最低支援版本不是包含這家的未撤回穩定版。`scripts/release-record.js` 寫入前也跑同一套驗證；版本號或券商不對時，QtOrder 的 workflow 在建立 GitHub Release 之前就會失敗。

## 發布紀錄重點

完整定義見 [`data/releases.schema.json`](data/releases.schema.json)。目前是 schemaVersion 3（與更新清單的 schemaVersion 無關）。

| 欄位 | 說明 |
| --- | --- |
| `minimumVersions` | 各券商的最低支援版本，例如 `{ "capital": "1.6.0" }`；還沒有任何版本的券商不能設定 |
| `product.requirements`、`product.brokerRequirements` | 系統需求與各券商的前置條件 |
| `releases[].version` | 純數字三段（例如 `1.7.1`），不得帶 `-preview` 等標記，見 [ADR-0001](docs/adr/0001-promotion-based-versioning.md) |
| `releases[].channel` | `preview` 或 `stable`，晉升時改變 |
| `releases[].publishedAt`、`promotedAt` | 第一次發布、晉升為穩定版的時間 |
| `releases[].withdrawn` | 撤回時間與原因 |
| `releases[].sourceCommit` | 建置來源的 QtOrder commit；QtOrder 以各家最近一個版本的它判斷有沒有異動、是否需要重新安裝 |
| `releases[].requiresInstaller` | 需重新安裝：這個版本更新了券商元件或啟動器，啟動器不會套用更新套件 |
| `releases[].summary` | 一句話摘要，也是啟動器更新提示的內容 |
| `releases[].notes` | 版本說明：`upgradeNotes`（升級須知）、`features`、`improvements`、`fixes`、`knownIssues` |
| `releases[].assets` | 包含的每家各一個 `installer` 與 `update`，一家 2 個、最多 6 個；各含 `broker`、`size` 與 `sha256`。版本包含哪些券商由這裡推導 |

各通道的最新版本按券商各自取包含它、未撤回的最高版本號；某家的預覽版沒有比它的穩定版新時，頁面提示改用穩定版，更新清單的 `preview` 也指向穩定版。

## 更新清單（`update.json`）

更新清單使用 schemaVersion 2，先選券商，再讀發布通道。各家的版本可能不同；還沒有穩定版的券商不列入。
啟動器缺自身券商或券商識別不符時拒絕更新、照常啟動本機版本，不回退其他券商。

```json
{
  "schemaVersion": 2,
  "brokers": {
    "taishin": {
      "stable": {
        "broker": "taishin",
        "version": "1.7.1",
        "url": "…/QtOrder_taishin_v1.7.1.zip",
        "sha256": "…",
        "size": 57737216,
        "description": "…"
      },
      "preview": {
        "broker": "taishin",
        "version": "1.8.0",
        "url": "…/QtOrder_taishin_v1.8.0.zip",
        "sha256": "…",
        "size": 58195968,
        "description": "…",
        "min_installer_version": "1.8.0"
      },
      "min_version": "1.6.2"
    },
    "capital": {
      "stable": {
        "broker": "capital",
        "version": "1.7.2",
        "url": "…/QtOrder_capital_v1.7.2.zip",
        "sha256": "…",
        "size": 57737216,
        "description": "…"
      },
      "preview": {
        "broker": "capital",
        "version": "1.7.2",
        "url": "…/QtOrder_capital_v1.7.2.zip",
        "sha256": "…",
        "size": 57737216,
        "description": "…"
      },
      "min_version": "1.7.0"
    }
  }
}
```

`min_installer_version`：不超過該通道版本、包含這家、標示需重新安裝的最高版本（已撤回的也算）。客戶電腦上最後一次執行的安裝程式版本較低時，啟動器不套用更新套件，改引導客戶下載安裝程式。沒有這種版本時省略。
