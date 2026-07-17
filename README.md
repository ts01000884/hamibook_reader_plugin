# HamiBook 悅讀助手（Chrome 擴充）

Manifest V3 Chrome 擴充功能，只在 `https://webreader.hamibook.com.tw/viewer/*` 載入。提供夜間模式、中文朗讀、自動翻頁、閱讀進度、平滑翻頁，以及本機／外部 OpenAI 相容 TTS。

## 功能

- 瀏覽器內建中文語音，或使用者自行設定的本機／外部 OpenAI 相容 TTS。
- 整章段落清單、目前段落高亮、暫停／繼續、書籤與進度記憶。
- 播完自動翻頁並接續下一章。
- HamiBook UI 夜間模式。
- 支援的固定版面書籍可由工具列 popup 開啟平滑翻頁；預設關閉，失敗時回退原生翻頁。
- popup 可查看 buffer 狀態並手動複製最近 200 筆本機診斷 LOG；不含書名、URL query、會員資料、token 或書籍內文，也不會自動上傳。

## TTS 伺服器設定

1. 在 `chrome://extensions/` 找到本擴充，開啟「擴充功能選項」。
2. 使用這台電腦上的 Windows／macOS Server 時，選「本機 TTS」，只需填入 Port（預設 `8890`）。
3. 使用其他電腦、ZeroTier 或雲端服務時，選「外部 TTS」，再填 API Base URL、選用 API Key 與模型。
4. 點「測試連線並載入聲音」，選擇聲音後儲存。
5. 回到 HamiBook 朗讀面板，將「朗讀引擎」切成「TTS 伺服器（本機／外部）」。

本機模式會自動組成 `http://localhost:{port}/v1`，API Key 留空並使用 `kokoro` 模型。

設定頁會在伺服器欄位旁明顯說明資料流向；使用者必須勾選理解朗讀文字會傳送到所選伺服器後才能測試或儲存。更換本機 Port、外部模式或外部 URL 時會要求重新確認。

Base URL 可填伺服器根網址或 `/v1`，擴充會呼叫：

- `GET {base}/audio/voices`
- `POST {base}/audio/speech`

若服務要求 API Key，會以 `Authorization: Bearer <key>` 傳送。外部服務失敗時會停在目前段落，不會默默改用另一個引擎或跳過文字。

目前伺服器 TTS 會等一個段落的 MP3 完整產生後才開始播放，播放當前段落時預抓下一段；這不是收到音訊即播放的真正串流。

## 權限與安全邊界

| 項目 | 用途 |
|------|------|
| `storage` | 在擴充本機儲存 TTS 伺服器與播放偏好 |
| `optional_host_permissions` | 使用者測試或儲存伺服器時，只授權該 HTTP/HTTPS 主機 |
| HamiBook content scripts | 讀取閱讀頁 DOM、翻頁、夜間模式、閱讀顯示與播放控制 |
| 網路連線 | HamiBook 既有內容／翻頁預載，以及使用者明確設定的 TTS 主機 |

跨網域 TTS 請求只由 MV3 service worker 執行。HamiBook 頁面只能提交短文字、語速與 request id；服務網址、模型、聲音與 API Key 由 service worker 從 `chrome.storage.local` 讀取，頁面不能把擴充當作任意 URL 代理。

API Key 以明文存在 Chrome 本機 extension storage，不使用 Chrome Sync。若使用 HTTP，文字、Key 與音訊不具傳輸加密；建議只用於可信任的 LAN／VPN，勿將無驗證服務直接公開至網際網路。

Manifest 中的 `http://*/*` 與 `https://*/*` 只用來宣告「可選主機」的候選範圍；擴充不會在安裝時取得全部主機存取權。使用者操作測試或儲存時，才以 `chrome.permissions.request()` 申請所填 URL 的單一 hostname；更換並儲存主機後會移除舊主機權限。

所有程式碼隨擴充封裝，不載入遠端 JavaScript，不使用 `eval` 或動態程式碼。

## 原始碼結構

- `darkmode.js`：HamiBook 夜間模式（MAIN world）。
- `epubfix-buffer.js`：固定版面 EPUB buffer 與視覺交接（MAIN world）。
- `tts.js`：TTS UI、段落、進度與播放狀態機（MAIN world）。
- `epubfix-popup-bridge.js`：popup 與頁面翻頁 controller 的隔離世界橋接。
- `tts-bridge.js`：頁面 TTS 與 extension runtime 的隔離世界橋接。
- `background.js`：TTS 設定持有者、來源驗證與隔離 fetch。
- `popup.html/css/js`：平滑翻頁開關、狀態與診斷 LOG。
- `options.html/css/js`：本機／外部 TTS 設定、權限申請與試播。
- `tts-settings.js`：選項頁與 service worker 共用的設定正規化。

平滑翻頁啟用時，單頁模式最多 4 個邏輯 buffer，雙頁模式最多 6 個實體 iframe；關閉或環境不相容時會清理資源並使用原生翻頁。

## 安裝與開發

1. 開啟 `chrome://extensions/`。
2. 開啟「開發人員模式」。
3. 點「載入未封裝項目」，選擇本專案目錄。
4. 修改程式後，在擴充卡片按「重新載入」，再重新整理 HamiBook。

基本靜態檢查：

```bash
python3 -m json.tool manifest.json >/dev/null
node --check darkmode.js
node --check epubfix-buffer.js
node --check epubfix-popup-bridge.js
node --check popup.js
node --check tts.js
node --check background.js
node --check tts-bridge.js
node --check tts-settings.js
node --check options.js
```

Chrome 私下分享請使用「載入未封裝項目」；更新版本時覆蓋檔案、重新載入擴充，再重新整理閱讀頁。

## Kokoro-FastAPI

本機 Docker 部署與 benchmark 放在：

```text
/home/uka/work/docker/kokoro-fastapi
```

預設服務網址為 `http://localhost:8880`；ZeroTier 其他節點使用 `http://192.168.191.10:8880`。完整逐輪 benchmark 與串流行為說明在該目錄的 `benchmark-report.txt`。

## 隱私

使用瀏覽器內建 TTS 時，擴充本身不向 TTS 伺服器傳送內文。選擇伺服器 TTS 時，目前朗讀的段落會傳送到本機或使用者指定的外部伺服器以產生音訊；詳見 [PRIVACY.md](PRIVACY.md)。
