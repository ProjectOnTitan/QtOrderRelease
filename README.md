# QtOrderRelease

QtOrder 的發布中心，以 GitHub Pages 提供各版本的版本資訊、下載點與版本說明。
發布通道分為**穩定版**（`stable`）與**預覽版**（`preview`）。

> 目前 `data/releases.json` 是模擬資料（`"mock": true`），頁面頂端會顯示提示，下載連結尚未對應實際檔案。

## 結構

```text
index.html                 頁面骨架（純靜態，無建置步驟）
assets/css/site.css        樣式；色彩集中在 :root 的語意 token，支援深淺色
assets/js/app.js           讀取 releases.json 並渲染，不內嵌任何版本資料
assets/favicon.svg
data/releases.json         唯一的資料來源，CI 只需要更新這個檔案
data/releases.schema.json  releases.json 的 JSON Schema，CI 寫入後用它驗證
.nojekyll                  讓 GitHub Pages 直接提供檔案，不經 Jekyll 處理
```

## 本機預覽

頁面以 `fetch` 讀取 JSON，直接用瀏覽器開啟 `index.html`（`file://`）會載入失敗，請起一個靜態伺服器：

```powershell
python -m http.server 8080
# 開啟 http://localhost:8080/
```

## 啟用 GitHub Pages

Settings → Pages → Build and deployment：Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)`。
推送到 `main` 後約一分鐘生效，網址為 `https://projectontitan.github.io/QtOrderRelease/`。

## 資料契約（`data/releases.json`）

完整定義見 [`data/releases.schema.json`](data/releases.schema.json)，重點如下：

| 欄位 | 說明 |
|---|---|
| `mock` | `true` 時顯示模擬資料提示。改由 CI 產生正式資料後移除或設為 `false`。 |
| `generatedAt` | 本檔最後產生時間（ISO 8601），顯示為「資料更新」。 |
| `product.requirements` | 系統需求，每項一行純文字。 |
| `releases[].version` | SemVer，不含 `v`。穩定版不得帶 prerelease 標記；預覽版必須帶（例如 `1.3.0-preview.1`）。 |
| `releases[].channel` | `stable` 或 `preview`。 |
| `releases[].publishedAt` | 發布時間（ISO 8601）。頁面依此由新到舊排序，**陣列順序不拘**，CI 直接附加即可。 |
| `releases[].summary` | 一句話摘要。 |
| `releases[].releaseUrl` | 對應的 GitHub Release 頁面。 |
| `releases[].notes` | 版本說明，依 `breaking`／`features`／`improvements`／`fixes`／`knownIssues` 分組，每項一行純文字，可用反引號標示程式碼或檔名。 |
| `releases[].assets[]` | 下載檔案：`name`、`kind`（`installer`／`portable`）、`url`、`size`（位元組）、`sha256`（小寫 hex）。`installer` 會排在前面作為主要下載。 |

各通道的「最新版本」取該通道 `publishedAt` 最新的一筆。

頁面行為：

- `?channel=stable`／`?channel=preview` 開啟時直接套用篩選。
- `#v1.2.0` 會展開並捲動到該版本，可直接分享版本說明連結。
- 所有資料以純文字寫入畫面，連結只接受 `http(s)`。

## CI/CD 更新流程（規劃）

發版時由 QtOrder 的 CI：

1. 建置並計算各檔案的 SHA-256。
2. 在本 repo 建立 GitHub Release（tag `v<version>`），上傳檔案。
3. 在 `data/releases.json` 附加一筆 release、更新 `generatedAt`，並以 `releases.schema.json` 驗證。
4. 提交到 `main`，GitHub Pages 自動重新部署。

版本說明可由 Conventional Commits 對應：`feat` → `features`、`fix` → `fixes`、`perf`／`refactor` → `improvements`、`BREAKING CHANGE` → `breaking`。
