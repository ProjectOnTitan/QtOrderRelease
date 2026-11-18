# AGENTS.md

本檔是本專案 AI 代理規範的唯一來源。專案用途與發布流程見 [README.md](README.md)，領域語彙見 [CONTEXT.md](CONTEXT.md)。

## Git／版本控制

- 依單一職責拆分提交：每個 commit 只含一項功能修改、重構或設定變更，各自使用 Conventional Commits，方便逐項審查與回退。

## 發布

- push 到 `main` 會由 `.github/workflows/pages.yml` 把發布頁與更新清單直接部署給客戶。push、手動觸發 workflow，或修改 `data/releases.json`、`data/qttrade/releases.json` 之前，先說明影響範圍並取得使用者同意。
