# ADR-0004：三家單券商交付共用版本與發布通道

Date: 2026-10-04
Status: Accepted

## Context

QtOrder 改為單券商建置並支援三家同機並存，舊發布模型每版只有一組 installer/update，無法保證啟動器取得自身券商的套件。使用者已授權在本機修改發布中心；正式發布另行處理。

## Decision

沿用每版唯一版本號、發布通道與晉升規則，每版必須包含 `taishin`、`zf-mega`、`capital` 各一個 installer 與 update，共六個資產。每個資產加入 `broker`，檔名包含正式識別與版本；不接受 `mega` 作發布識別。晉升沿用六個原始資產。

發布紀錄與更新清單使用 schemaVersion 2。更新清單為 `brokers[broker]` 下的 stable、preview、min_version，通道項目再次包含 broker；大小、SHA-256 與最低安裝程式版本規則維持。缺檔、重複種類、未知券商或不符的檔名在記錄發布前拒絕。頁面明列三家安裝程式及各自雜湊。

目前資料仍為 `mock: true`，僅將模擬資產改為六個，不產生真實可下載連結。QtOrder 的新發布 workflow 上線前，必須先讓發布中心支援此格式。

## Consequences

舊啟動器不支援新清單，首版必須重新安裝。三家不能獨立升版或撤回，這符合共用版本與發布節奏的決定。正式交付仍需完成 QtOrder SDD-006 的 COM 並存與兆豐憑證依賴人工驗收。

驗證：24 項 Node 測試、發布紀錄 schema 檢查與靜態網站建置通過；未推送、未觸發 Pages 或正式發布。
