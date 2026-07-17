# 隱私權政策 — HamiBook 悅讀助手

最後更新：2026-07-17

本擴充不包含分析、追蹤、廣告或開發者營運的資料收集後端，也不販售個人資料。

本擴充對使用者資料的使用遵守 Chrome Web Store 使用者資料政策（包括 Limited Use 規範）：資料只用於提供使用者主動操作的閱讀輔助功能，不用於個人化廣告、再行銷、信用判斷、出售或其他未揭露用途，也不允許開發者或其他人員人工閱讀。

## 閱讀與朗讀資料

- 使用瀏覽器內建 TTS 時，內文只交由瀏覽器／作業系統的 Web Speech API 處理。
- 使用者在設定頁閱讀明顯揭露、勾選同意並明確選擇「TTS 伺服器」後，本擴充才會把目前朗讀段落、所選模型、聲音與語速傳送至所選的本機或外部伺服器，並下載產生的音訊。
- 本機模式只連線到這台電腦的 `localhost`。外部 TTS 的資料處理與保存方式取決於使用者選擇的服務；本專案無法控制第三方或自架伺服器的紀錄政策。
- 平滑翻頁啟用時，只會向目前已登入的 HamiBook WebReader 預載前後閱讀頁。

## 本機儲存

- HamiBook 同源 `localStorage`：每本書的閱讀進度、書籤、夜間模式、面板狀態與平滑翻頁開關。
- `chrome.storage.local`：朗讀引擎、TTS Base URL、選用 API Key、模型、聲音、語速與自動翻頁偏好。
- API Key 不使用 Chrome Sync，但會以明文存在目前 Chrome 使用者資料中。
- 翻頁診斷 LOG 只在記憶體保留最近 200 筆翻頁狀態、耗時與版面尺寸，不含書名、URL query、會員資料、token 或書籍內文；只有使用者主動複製時才會放入剪貼簿，不會自動上傳。

## 權限與安全

- `storage`：保存上述擴充設定。
- `optional_host_permissions`：manifest 宣告可由使用者選擇 HTTP／HTTPS TTS 主機；安裝時不會取得全部主機權限。只有使用者在選項頁主動測試或儲存時，才透過 Chrome 權限提示申請所填寫的單一主機，供 service worker 呼叫該服務。
- Content script 只在 `https://webreader.hamibook.com.tw/viewer/*` 載入。
- 本擴充不載入遠端程式碼。

使用 HTTP TTS 伺服器時，內文、API Key 與音訊傳輸不加密，應只在可信任的 LAN 或 VPN 使用；不應把無驗證的 TTS 服務公開至網際網路。

## 保存與刪除

- 閱讀進度與偏好保存在 HamiBook 同源 `localStorage`；TTS 設定保存在 `chrome.storage.local`，保存到使用者清除網站／擴充資料或移除擴充為止。
- 翻頁診斷 LOG 只存在目前分頁記憶體，關閉或重新整理分頁後即消失。
- 本專案沒有開發者後端，因此開發者沒有可供查閱或刪除的伺服器端使用者資料。外部 TTS 服務保存的資料需依該服務的政策處理。

## 第三方與聯絡方式

本擴充與 HamiBook／中華電信沒有隸屬或合作關係。如有疑問，請使用專案 GitHub Issues：

`https://github.com/ts01000884/hamibook_reader_plugin`
