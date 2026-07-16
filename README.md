# HamiBook 悅讀助手（Chrome 擴充）— 審查說明

一個由 Tampermonkey 使用者腳本改寫的 Chrome 擴充功能（Manifest V3）。
本文件供**安裝前審查 / 稽核**使用，說明它做什麼、能存取什麼、以及如何自行驗證。

---

## TL;DR（給審查者）

- **只在一個網站生效**：`https://webreader.hamibook.com.tw/viewer/*`，其他網站完全不載入。
- **不要求額外 Chrome API 權限**：`manifest.json` 沒有 `permissions`，也沒有 `host_permissions`。
- **不連第三方服務、不上傳資料**：沒有 `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon`；只有使用者主動開啟平滑翻頁時，才以 iframe 向 HamiBook 本身預載前後頁（依資源上限最多延伸到第二層）。
- **不做動態程式碼**：沒有 `eval`、沒有 `new Function`、沒有動態 `import`、沒有遠端腳本。
- **不收集資料**：沒有分析、沒有追蹤，唯一的儲存是同源 `localStorage`（記閱讀進度與偏好，留在你自己瀏覽器）。
- **原始碼未壓縮、未混淆**：黑夜模式、EPUBFIX buffer、popup bridge、朗讀與 popup 均為可直接閱讀的本地檔案。

---

## 功能

- **中文語音朗讀**：朗讀可見範圍，語速上限 1.5，一段播完自動翻頁接續。
- **全文段落進度紀錄**：整章段落清單、記住上次讀到哪一段。
- **UI 黑夜模式**：右下角浮動「日 / 夜」按鈕切換（已修正切章節偶爾全黑）。
- **EPUBFIX 平滑翻頁**：固定版面 EPUB（`/viewer/07/`）可從擴充 ICON 手動開啟；預先修正前後頁、修正原生白色遮罩的重複邊距，並在原生 FIX 期間做視覺交接，首次預設關閉。
- **本機診斷 LOG**：popup 可複製最近 200 筆有上限的翻頁時序與版面尺寸；不含書名、查詢參數、會員資料、token 或內文，也不會自動上傳。

---

## 權限與資料存取（審查重點）

| 項目 | 內容 | 說明 |
|------|------|------|
| `permissions` | **無** | manifest 未宣告任何 Chrome API 權限 |
| `host_permissions` | **無** | 僅靠 content script 的 `matches` 限定網址 |
| 生效範圍 | `https://webreader.hamibook.com.tw/viewer/*` | 只有 HamiBook 閱讀頁會注入 |
| 網路連線 | **無第三方服務／不上傳** | 平滑翻頁啟用時會以 iframe 預載同源 HamiBook 前後頁（依資源上限最多第二層） |
| 資料收集 / 遙測 | **無** | 不外傳任何資訊 |
| 儲存 | 同源 `localStorage` | 閱讀進度、夜間模式、面板與平滑翻頁開關，僅存於本機 |
| 使用的瀏覽器 API | `speechSynthesis`、DOM、`MutationObserver`、`localStorage`、popup 訊息 | popup 只用 tab ID 傳訊，不讀網址／標題等敏感欄位 |
| 執行環境 | MAIN + ISOLATED + popup | 閱讀器整合在 MAIN；無權限 bridge 在 ISOLATED；工具列開關在 popup |

> 為什麼同時使用 MAIN 與 ISOLATED：朗讀及 EPUBFIX 需要存取頁面環境、Vue 2 store 與同源 iframe，
> 因此留在 MAIN；popup 訊息由 ISOLATED bridge 接收，再以固定命令傳遞開關、狀態與使用者主動要求的診斷 LOG，
> 不需要 `tabs`、`scripting`、`storage` 等權限。

---

## 檔案清單（審查者逐檔看什麼）

| 檔案 | 用途 | 審查看點 |
|------|------|----------|
| `manifest.json` | 擴充設定（MV3） | 確認無 `permissions`/`host_permissions`、`matches` 限定單一網址 |
| `darkmode.js` | UI 黑夜模式（content script，先載入） | 未混淆，可搜尋 `fetch`/`eval` 確認無網路與動態碼 |
| `epubfix-buffer.js` | EPUBFIX 前後頁 buffer 與視覺交接（MAIN） | 預設關閉、最多 4 個邏輯 buffer／6 個實體 iframe、失敗回退原生 |
| `epubfix-popup-bridge.js` | popup 與 MAIN 的訊息橋接（ISOLATED） | 僅接受固定 channel／command，沒有頁面特權 |
| `tts.js` | 朗讀 + 段落進度紀錄（content script，後載入） | 未混淆，可搜尋 `fetch`/`eval` 確認無網路與動態碼 |
| `popup.html/css/js` | 瀏覽器工具列開關、狀態與複製診斷 LOG | 無 inline script、無遠端資源、LOG 不會自動送出 |
| `icons/icon16·48·128.png` | 擴充圖示 | 純圖片，無邏輯 |
| `CHANGELOG.md` | 版本更新紀錄 | 擴充版 `1.x` 與改寫前使用者腳本時期 `0.x` 的完整軌跡 |

打包給使用者的 zip 只含執行必要檔案（`manifest.json`、四支 content script、`popup.html/css/js` 與 `icons/`）；`README.md` / `CHANGELOG.md` 為說明文件，不進打包。

> 版本：擴充版首發為 **1.0.0**；`0.x` 為改寫前的 Tampermonkey 更新軌跡，詳見 [`CHANGELOG.md`](CHANGELOG.md)。

---

## 與原 Tampermonkey 腳本的對照

| 項目 | 原本（Tampermonkey） | 現在（Chrome 擴充） |
|------|----------------------|---------------------|
| 生效網址 | `@match .../viewer/*` | `matches: .../viewer/*`（相同） |
| 執行時機 | `@run-at document-start` | `run_at: document_start`（相同） |
| 只在頂層執行 | `@noframes` | `all_frames: false`（相同） |
| 執行環境 | `@grant none`（頁面環境） | `world: "MAIN"`（頁面環境，相同） |
| 黑夜模式選單 | `GM_registerMenuCommand` | 改用右下角**浮動按鈕**（腳本本來就有此按鈕） |

`GM_registerMenuCommand` 是 Tampermonkey 專屬 API，Chrome 無對應；程式內原本就有 `typeof`
保護會自動略過，黑夜模式切換改由本來就存在的浮動按鈕完成，功能不變。

---

## 如何自行驗證（audit 步驟）

```bash
# 1) 確認沒有主動外連 API / 動態程式碼（應無輸出）
grep -nE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function|import\(" *.js

# 2) 確認 manifest 沒有要求任何權限（應無輸出）
grep -nE "\"permissions\"|\"host_permissions\"" manifest.json

# 3) 檢查 JS 語法無誤
node --check darkmode.js && node --check epubfix-buffer.js && node --check epubfix-popup-bridge.js && node --check popup.js && node --check tts.js
```

所有 JavaScript 均未經壓縮 / 混淆；各模組以獨立 IIFE 隔離。平滑翻頁關閉時只保留本機命令 controller、popup bridge 與有上限的診斷 ring，不建立 buffer iframe、overlay、Vue subscription、observer、遮罩樣式或額外 HamiBook 頁面請求。

---

## 安裝（私下分享 · 免開發者帳號）

Chrome 已封鎖直接安裝 `.crx`，私下分享請用「載入未封裝項目」：

1. 解壓 `hamibook-reader-extension.zip`。
2. 開 `chrome://extensions/`，打開右上角「開發人員模式 / Developer mode」。
3. 點「載入未封裝項目 / Load unpacked」，選解壓後的資料夾。
4. 打開 HamiBook 閱讀頁即可使用。更新版本時覆蓋檔案再按「重新載入」即可。

> 進階：若想要自動更新又不公開，可用 Chrome Web Store 的 **Unlisted（未列出）** 發布
> （需一次性 5 美元開發者帳號），只有拿到連結者能安裝。

---

## 隱私聲明

本擴充**不收集、不上傳、不傳輸**任何個人資料到外部服務。所有狀態（閱讀進度、偏好）僅以
`localStorage` 存在使用者自己的瀏覽器中，可隨時於瀏覽器清除。平滑翻頁啟用時只向目前已登入的 HamiBook 站台預載前後閱讀頁；診斷 LOG 只在本機 ring 中保留最近 200 筆，必須由使用者主動複製及自行貼出。
