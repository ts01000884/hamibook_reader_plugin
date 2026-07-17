# Chrome Web Store 審查說明

這份文件供 Developer Dashboard 的審查備註、權限理由與測試說明使用，不包含帳號或密碼。

## 單一用途

HamiBook 悅讀助手只在 HamiBook WebReader 閱讀頁提供閱讀輔助：中文語音朗讀、朗讀進度、自動翻頁、夜間顯示與平滑翻頁。本機／外部 TTS Server 是中文朗讀功能的選用語音來源，不是獨立的一般網路代理。

## 權限與必要性

| 權限／範圍 | 必要用途 | 限縮方式 |
|---|---|---|
| `storage` | 在 `chrome.storage.local` 保存朗讀引擎、TTS Server、選用 API Key、模型、聲音、語速與自動翻頁偏好，供選項頁和 MV3 service worker 共用 | 不使用 Chrome Sync；不保存書籍全文 |
| `optional_host_permissions` 的 HTTP／HTTPS 候選範圍 | 連線到使用者執行時自行輸入、無法預先列舉的 OpenAI 相容 TTS 主機 | 安裝時不授權；使用者在選項頁操作後才以 `chrome.permissions.request()` 請求該協定與單一 hostname；儲存新主機後移除舊主機權限 |
| `https://webreader.hamibook.com.tw/viewer/*` content scripts | 讀取使用者已開啟的閱讀頁文字、控制朗讀／翻頁、套用夜間與閱讀顯示 | 只比對 HamiBook WebReader 的 `/viewer/` 閱讀路徑，不在其他網站載入 |

Chrome host permission 的 match pattern 會忽略 Port 與路徑，因此執行時請求已採平台可表達的最窄範圍：所填 URL 的 protocol + hostname。

## TTS 資料流

| 使用方式 | 傳送內容 | 目的地 |
|---|---|---|
| 瀏覽器內建語音（預設） | 閱讀文字交給瀏覽器／作業系統 Web Speech API | 不呼叫 TTS Server |
| 本機 TTS | 目前朗讀段落、模型、聲音、語速 | 使用者電腦的 `localhost:{port}` |
| 外部 TTS | 目前朗讀段落、模型、聲音、語速；選填 API Key 放在 Authorization header | 使用者親自輸入並授權的主機 |

本擴充沒有開發者營運的 TTS、分析、追蹤或廣告後端。跨網域語音請求只由 `background.js` 的 MV3 service worker 執行；HamiBook 頁面不能指定 URL、取得 API Key 或把擴充當作任意代理。輸入文字限制為 500 字，音訊回應限制為 20 MiB，請求逾時為 60 秒。

## 明顯揭露與同意

`options.html` 在伺服器欄位與儲存按鈕旁固定顯示「朗讀文字傳送說明」，清楚區分 localhost 與外部主機、開發者不接收資料、第三方服務可能保存請求，以及 HTTP 不加密。使用者必須主動勾選同意，才能測試、試播或儲存；更換模式、Port 或外部 URL 時會取消同意並要求重新確認。`background.js` 在每次合成前也會再次檢查同意狀態。

## 遠端程式碼

未使用遠端程式碼。所有 JavaScript、HTML 與 CSS 均包含在擴充套件內；沒有遠端 `<script>`、`eval()`、動態程式碼或下載後執行的邏輯。TTS Server 只回傳聲音清單 JSON 與音訊資料，不回傳或執行程式碼。

## 審查測試步驟

1. 安裝擴充後開啟 HamiBook WebReader 閱讀頁。
2. 右下角「HamiBook 朗讀」面板預設使用瀏覽器內建語音，不需要 TTS Server 權限。
3. 點播放，確認中文朗讀、暫停／繼續、語速、進度與自動翻頁。
4. 點工具列圖示，可查看並手動開關相容書籍的「平滑翻頁」；此功能預設關閉。
5. 開啟擴充功能選項，可看到「本機 TTS／外部 TTS」及不可收合的資料傳送說明。未勾選同意時，測試與儲存會被阻擋。
6. TTS Server 是選用功能，需要審查者自行提供 OpenAI 相容端點；使用者按下測試／儲存時 Chrome 才會針對該 hostname 顯示權限提示。端點介面為 `GET /v1/audio/voices` 與 `POST /v1/audio/speech`。

## 送審前人工項目

- Developer Dashboard 若要求登入後功能的測試帳號，請在審查備註欄安全提供可進入 HamiBook 閱讀頁的測試方式；不要把帳密提交到 Git。
- 確認 Dashboard 的隱私權政策 URL 指向公開可讀的 `PRIVACY.md`。
- 資料類型依實際行為揭露網站內容、目前閱讀頁／進度，以及使用者選填的 TTS API Key；不要勾選未處理的資料類型。
- 權限理由可直接取用 `STORE_LISTING.md` 的 `storage`、選用 TTS 主機權限與網站存取說明。
