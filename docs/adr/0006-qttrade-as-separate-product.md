# ADR-0006：QtTrade 以獨立產品在同一個發布中心發布

Date: 2026-10-14
Status: Accepted

## Context

QtTrade 是凱基客戶專用的自動下單程式，要對客戶發布安裝程式、版本說明與更新。它與 QtOrder 是不同的 codebase 與應用程式（.NET 8 + Electron、自己的啟動器、不使用客戶授權碼），只是要在同一個發布頁面釋出版本。

發布中心原本只為 QtOrder 設計：券商識別寫死三家、版本號與 `v<版本>` tag 全域共用、檔名固定為 `Setup_QtOrder_*`、頁面文案全是 QtOrder 的安裝方式。

## Decision

- QtTrade 是發布中心的第二個產品。兩個產品只共用發布頁面與存放下載檔案的 GitHub Releases（本 repo），其餘各自獨立。
- QtTrade 的發布紀錄另存 `data/qttrade/releases.json`，更新清單另發布於 `qttrade/update.json`。QtOrder 的 `data/releases.json`、`update.json` 與 QtOrder workflow 的呼叫方式都不變。
- QtTrade 的版本號自成一條線，從 `1.0.0` 起；tag 為 `qttrade-v<版本>`，GitHub Release 以 `--latest=false` 建立。
- QtTrade 保留券商維度，但只有 `kgi`。檔名為 `Setup_QtTrade_kgi_v<版本>.exe` 與 `QtTrade_kgi_v<版本>.zip`，更新清單沿用 schemaVersion 2 的格式。
- 發布規則（通道、晉升、首發、緊急修正、撤回、最低支援版本、需重新安裝）兩個產品相同。`release-model.js` 與 `release-record.js` 改為依產品定義運作：券商清單、檔名規則、tag 前綴、發布紀錄與更新清單的路徑。
- 頁面品牌改為「發布中心」，以頁內導覽分成 QtOrder 與 QtTrade（凱基專用）兩個獨立區塊。

## Considered Options

- **把 `kgi` 當成 QtOrder 的第四家券商、共用版本號**：兩個 codebase 會搶同一條版本號與 tag。ADR-0005 共用版本號的前提是三家出自同一個 codebase、只從 QtOrder 的 `main` 發布，對 QtTrade 不成立；檔名、必要元件、頁面上的客戶授權碼與 .NET Framework 說明也都不適用。
- **QtTrade 冠上 QtOrder 品牌、版本號獨立**：客戶會同時看到 QtOrder 1.0.0 與 1.6.1，也違反 ADR-0005 版本號全域不重複的規則。
- **合併成一份 schemaVersion 4 的發布紀錄**：QtOrder 的發布紀錄 2026-10-13 才正式首發，合併要遷移正式資料並改動 QtOrder workflow。
- **另開 QtTradeRelease repo**：客戶要到兩個網站下載。
- **拿掉 QtTrade 的券商維度**：模型較簡潔，但發布規則與啟動器解析更新清單的程式都要另寫一套。

## Consequences

- ADR-0005「版本號不分券商都隨發布時間遞增」改為在各產品內檢查；兩個產品的版本號互不相干。
- 兩份發布紀錄各自保存 `product.components`，QtOrder 發布時整批覆寫必要元件不會影響 QtTrade。
- QtTrade 的發布與晉升由 QtTrade repo 的本機發布腳本執行，直接 commit 到本 repo 的 `main`；撤回與調整最低支援版本仍走 PR（同 ADR-0003），規則仍只放在本 repo 的腳本。
