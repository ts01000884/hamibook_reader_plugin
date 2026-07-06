# HamiBook 悅讀助手（Chrome 擴充）— 審查說明

一個由 Tampermonkey 使用者腳本改寫的 Chrome 擴充功能（Manifest V3）。
本文件供**安裝前審查 / 稽核**使用，說明它做什麼、能存取什麼、以及如何自行驗證。

---

## TL;DR（給審查者）

- **只在一個網站生效**：`https://webreader.hamibook.com.tw/viewer/*`，其他網站完全不載入。
- **不要求任何權限**：`manifest.json` 沒有 `permissions`，也沒有 `host_permissions`。
- **不連任何網路**：全程沒有 `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon`，不上傳任何資料。
- **不做動態程式碼**：沒有 `eval`、沒有 `new Function`、沒有動態 `import`、沒有遠端腳本。
- **不收集資料**：沒有分析、沒有追蹤，唯一的儲存是同源 `localStorage`（記閱讀進度與偏好，留在你自己瀏覽器）。
- **單一原始碼檔**：核心邏輯全在 `main.js`，未壓縮、未混淆，可直接閱讀。

---

## 功能

- **中文語音朗讀**：朗讀可見範圍，語速上限 1.5，一段播完自動翻頁接續。
- **全文段落進度紀錄**：整章段落清單、記住上次讀到哪一段。
- **UI 黑夜模式**：右下角浮動「日 / 夜」按鈕切換（已修正切章節偶爾全黑）。

---

## 權限與資料存取（審查重點）

| 項目 | 內容 | 說明 |
|------|------|------|
| `permissions` | **無** | manifest 未宣告任何擴充權限 |
| `host_permissions` | **無** | 僅靠 content script 的 `matches` 限定網址 |
| 生效範圍 | `https://webreader.hamibook.com.tw/viewer/*` | 只有 HamiBook 閱讀頁會注入 |
| 網路連線 | **無** | 不含 fetch / XHR / WebSocket / beacon |
| 資料收集 / 遙測 | **無** | 不外傳任何資訊 |
| 儲存 | 同源 `localStorage` | 閱讀進度、夜間模式開關、面板收合狀態，僅存於本機 |
| 使用的瀏覽器 API | `speechSynthesis`、DOM、`MutationObserver`、`localStorage` | 皆為朗讀與樣式所需 |
| 執行環境 | `world: "MAIN"` | 跑在頁面環境（等同原腳本 `@grant none`），無需 `chrome.*` API |

> 為什麼用 `world: "MAIN"`：原腳本以頁面環境執行並使用 `speechSynthesis`、頁面 `localStorage`
> 與同源 iframe 內容。MAIN world 讓行為與原本一致，且**不需要**任何 `chrome.*` 權限。

---

## 檔案清單（審查者逐檔看什麼）

| 檔案 | 用途 | 審查看點 |
|------|------|----------|
| `manifest.json` | 擴充設定（MV3） | 確認無 `permissions`/`host_permissions`、`matches` 限定單一網址 |
| `main.js` | 全部功能邏輯（content script） | 未混淆，可搜尋 `fetch`/`eval` 確認無網路與動態碼 |
| `icons/icon16·48·128.png` | 擴充圖示 | 純圖片，無邏輯 |
| `CHANGELOG.md` | 版本更新紀錄 | 擴充版 `1.x` 與改寫前使用者腳本時期 `0.x` 的完整軌跡 |

打包給使用者的 `hamibook-reader-extension.zip` 只含執行必要檔案（`manifest.json` + `main.js` + `icons/`）；`README.md` / `CHANGELOG.md` 為說明文件，不進打包。

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
# 1) 確認完全沒有網路連線 / 動態程式碼（應無輸出）
grep -nE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function|import\(" main.js

# 2) 確認 manifest 沒有要求任何權限（應無輸出）
grep -nE "\"permissions\"|\"host_permissions\"" manifest.json

# 3) 檢查 JS 語法無誤
node --check main.js
```

`main.js` 未經壓縮 / 混淆，可整份閱讀；核心分兩個 IIFE：黑夜模式與 TTS 朗讀。

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

本擴充**不收集、不儲存、不傳輸**任何個人資料到外部。所有狀態（閱讀進度、偏好）僅以
`localStorage` 存在使用者自己的瀏覽器中，可隨時於瀏覽器清除。
