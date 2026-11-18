# AGENTS.md

本檔是本專案 AI 代理規範的唯一來源。專案用途與發布流程見 [README.md](README.md)，領域語彙見 [CONTEXT.md](CONTEXT.md)。

## Git／版本控制

- **原子化任務提交（Atomic Commits）**：在執行 Git 提交（commit）時，必須將每次的檔案異動依照「單一職責的原子化任務」進行邏輯拆分，分別建立獨立且具備清晰語意（Conventional Commits）的 commit，禁止將多個不相關的功能修改、重構或設定變更混雜在同一個 commit 中。
