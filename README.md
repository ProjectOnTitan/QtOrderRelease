# QtOrderRelease

QtOrder 的發布中心：以 GitHub Pages 提供各版本的版本說明、下載檔案與 SHA-256，並產生 QtOrder 啟動器讀取的更新清單。
用語（預覽版、穩定版、晉升、撤回、最低支援版本…）以 [CONTEXT.md](CONTEXT.md) 為準；為什麼這樣設計見 [docs/adr/](docs/adr/)。

> 目前 `data/releases.json` 是模擬資料（`"mock": true`）：頁面頂端顯示提示，部署時自動加上 `noindex`。
> 第一個正式版本（首發）發布時，`scripts/release-record.js` 會清掉模擬資料。QtOrder 的打包流程已不再把 GCP 金鑰放進套件（QtOrder ADR-0034），並在發布前掃描機密。

## 結構

```text
index.html                    頁面骨架（純靜態）
assets/js/app.js              讀取發布紀錄並渲染頁面
assets/js/release-model.js    發布規則：最新版本、更新清單、跨欄位檢查；頁面與建置腳本共用
assets/css/site.css           樣式；版型參考 apple.com，只有淺色配色，色彩集中在 :root 的語意 token（已標註 WCAG AA 對比值）
data/releases.json            發布紀錄，唯一的資料來源
data/releases.schema.json     發布紀錄的 JSON Schema
scripts/build-site.js         驗證發布紀錄，輸出網站與更新清單（_site/update.json）
scripts/release-record.js     QtOrder 的發布 workflow 呼叫：判斷建置或晉升、寫入新版本、晉升
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

發布、晉升與緊急修正由 QtOrder 的發布 workflow 在 `release/preview`、`release/stable` 手動觸發，以 GitHub App 直接 commit 到本 repo 的 `main`，Pages 隨之部署（[ADR-0003](docs/adr/0003-publish-from-qtorder-workflow.md)）。
版本說明寫在 QtOrder 的 `release-notes/<版本>.md`，在 QtOrder 的 PR 審核；操作步驟見 QtOrder 的 `docs/04-release.md`。

| 動作 | 怎麼做 | 發布紀錄的變化 |
| --- | --- | --- |
| 發布預覽版 | 在 QtOrder 的 `release/preview` 觸發 | workflow 建立 GitHub Release（tag `v<版本>`、標為 prerelease）並上傳兩個下載檔案，新增一筆 `channel: "preview"` 的版本 |
| 晉升 | 把同一個 commit fast-forward 到 `release/stable` 後觸發 | 該版本的 `channel` 改為 `"stable"`、填入 `promotedAt`；下載檔案不變，GitHub Release 改為 latest |
| 首發 | 第一個正式版本在 `release/stable` 觸發 | 清掉模擬資料，新增一筆 `channel: "stable"` 的版本，`minimumVersion` 設為這個版本 |
| 緊急修正 | 在 `release/stable` 以新的版本號觸發 | 新增一筆 `channel: "stable"`、沒有 `promotedAt` 的版本；下一個預覽版必須包含同樣的修正 |
| 撤回 | 手動發 PR | 填入 `withdrawn: { at, reason }`，並刪除該 GitHub Release 上的檔案。撤回不會強制已安裝的客戶更新；要強制，另外提高 `minimumVersion` |
| 調整最低支援版本 | 手動發 PR | 修改 `minimumVersion`，必須是一個未撤回的穩定版 |

每次修改都要更新 `generatedAt`。CI 會擋下這些錯誤：版本號帶預覽標記或重複、穩定版或預覽版的版本號沒有隨時間遞增、缺少安裝程式或更新套件、最低支援版本不是未撤回的穩定版。
`scripts/release-record.js` 寫入前也跑同一套驗證；版本號不對時，QtOrder 的 workflow 在建置前就會失敗。

## 發布紀錄重點

完整定義見 [`data/releases.schema.json`](data/releases.schema.json)。

| 欄位 | 說明 |
| --- | --- |
| `minimumVersion` | 最低支援版本 |
| `product.requirements`、`product.brokerRequirements` | 系統需求與各券商的前置條件 |
| `releases[].version` | 純數字三段（例如 `1.7.1`），不得帶 `-preview` 等標記，見 [ADR-0001](docs/adr/0001-promotion-based-versioning.md) |
| `releases[].channel` | `preview` 或 `stable`，晉升時改變 |
| `releases[].publishedAt`、`promotedAt` | 第一次發布、晉升為穩定版的時間 |
| `releases[].withdrawn` | 撤回時間與原因 |
| `releases[].sourceCommit` | 建置來源的 QtOrder commit；晉升時比對 `release/stable` 的 HEAD |
| `releases[].requiresInstaller` | 需重新安裝：這個版本更新了券商元件或啟動器，啟動器不會套用更新套件 |
| `releases[].summary` | 一句話摘要，也是啟動器更新提示的內容 |
| `releases[].notes` | 版本說明：`upgradeNotes`（升級須知）、`features`、`improvements`、`fixes`、`knownIssues` |
| `releases[].assets` | `installer`（安裝程式）與 `update`（更新套件）各一個，含 `size` 與 `sha256` |

各通道的最新版本取未撤回的最高版本號；預覽版沒有比穩定版新的版本時，頁面提示改用穩定版，更新清單的 `preview` 也指向穩定版。

## 更新清單（`update.json`）

沿用啟動器既有的格式，另加更新套件的 `sha256` 與 `size`，供啟動器下載後比對：

```json
{
  "stable":  { "version": "1.7.1", "url": "…/QtOrder_v1.7.1.zip", "sha256": "…", "size": 57737216, "description": "…" },
  "preview": { "version": "1.8.0", "url": "…/QtOrder_v1.8.0.zip", "sha256": "…", "size": 58195968, "description": "…", "min_installer_version": "1.8.0" },
  "min_version": "1.6.2"
}
```

`min_installer_version`：不超過該通道版本、標示需重新安裝的最高版本（已撤回的也算）。客戶電腦上最後一次執行的安裝程式版本較低時，啟動器不套用更新套件，改引導客戶下載安裝程式。沒有這種版本時省略。
