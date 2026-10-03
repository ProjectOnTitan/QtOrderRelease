# 發布與晉升由 QtOrder 的發布 workflow 直接寫入，撤回與最低支援版本仍經 PR

ADR-0002 原本規定任何發布、晉升、撤回都經本 repo 的 PR 審核才生效。QtOrder 改為在 `release/preview`、`release/stable` 手動觸發發布（QtOrder ADR-0033）之後，手動觸發本身就是人工把關，版本說明也已在 QtOrder 的 PR 審過；再多一道合併只會拖慢緊急修正。因此發布預覽版、晉升、首發與緊急修正由 QtOrder 的 workflow 以組織擁有的 GitHub App 直接 commit 到 `main`，寫入前以 `scripts/release-record.js` 跑與 PR 相同的驗證；撤回與調整最低支援版本很少發生、又需要判斷，維持手動發 PR。本則取代 ADR-0002 中「發布、晉升都經 PR」的部分，其餘不變。

## Considered Options

- **workflow 開 PR，人工合併才上線**：等於同一份版本說明審兩次，緊急修正也要多等一個人合併。
- **發布規則在 QtOrder 另寫一份**：兩邊規則會漂移，啟動器拿到的更新清單與頁面顯示的最新版本可能不一致；所以 QtOrder 只呼叫本 repo 的腳本。
- **撤回也由 workflow 處理**：撤回要寫給客戶看的原因、判斷要不要提高最低支援版本，不適合一鍵完成。

## Consequences

- 發布紀錄新增 `sourceCommit`（晉升時比對 `release/stable` 的 HEAD，判斷需重新安裝時當作 git diff 的基準）與 `requiresInstaller`；更新清單各通道新增 `min_installer_version`。
- 第一個正式版本只能在 `release/stable` 發布（首發），同時清掉模擬資料並設為最低支援版本；沒有穩定版時在 `release/preview` 觸發會直接失敗。
- 以 GitHub App 推送的 commit 會觸發 `pages.yml`，發布完成後約 10 分鐘內頁面與更新清單更新。
- `main` 會出現沒有經過 PR 的 commit；回頭查發布歷史時以 commit 訊息與 GitHub Release 為準。
