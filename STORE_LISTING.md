# Chrome Web Store 商店資料（填寫用）

> 這份是上架時各欄位要貼的文字，非擴充執行必要檔。

## 名稱（Name）
```
HamiBook 悅讀助手
```

## 摘要（Summary，單行，上限 132 字）
```
為 HamiBook WebReader 提供中文朗讀、本機／外部 TTS、自動翻頁、閱讀進度、夜間模式與平滑翻頁。
```

## 類別（Category）
```
無障礙工具（CATEGORY_ACCESSIBILITY）
```
理由：核心價值為語音朗讀與護眼夜間模式，屬輔助閱讀性質。備選：功能與使用者介面。

## 語言（Language）
```
中文（繁體）
```

---

## 詳細說明（Detailed description，貼到「產品詳細資料」欄位）

```
HamiBook 悅讀助手，讓你在 HamiBook WebReader 上「用聽的」讀書，並提供更護眼的夜間閱讀體驗。

■ 主要功能
・中文語音朗讀：朗讀目前頁面內容，語速可調（上限 1.5 倍），適合通勤、做家事或讓眼睛休息時聆聽。
・可選 TTS Server：預設使用瀏覽器內建語音；也可由使用者主動設定這台電腦的本機 TTS，或自己信任的 OpenAI 相容外部 TTS 服務。伺服器模式支援選擇模型與中文聲音。
・播完自動翻頁接續：一段念完會自動翻到下一頁繼續朗讀，中途純圖片頁也能順利接續，不用一直手動翻頁。
・閱讀進度記憶：記住整章段落與上次念到的位置，下次打開接著聽。
・舒適夜間模式：一鍵切換介面深色主題，降低夜間閱讀的亮度負擔；切換章節時畫面穩定不再閃黑。
・平滑翻頁：可從瀏覽器工具列 ICON 手動開啟，預先修正前後頁並抑制原生遮罩外露，減少固定版面 EPUB 翻頁時的白畫面跳動；首次預設關閉。
・浮動控制面板：右下角小面板可播放/暫停、調整語速、開關夜間模式，可縮放、可收合，不擋閱讀。

■ 適合誰
・想用聽的方式讀電子書的人。
・長時間閱讀、需要護眼夜間模式的人。
・希望朗讀能自動翻頁、不用一直操作的人。

■ 使用方式
安裝後，開啟 HamiBook WebReader 的閱讀頁即可看到右下角控制面板（語音朗讀面板僅在 EPUB 文字格式顯示）。點播放開始朗讀，點「日／夜」按鈕切換夜間模式。固定版面 EPUB 可點擊瀏覽器工具列的擴充 ICON，再開啟「平滑翻頁」。如需 TTS Server，請先在擴充功能選項選擇本機或外部模式、閱讀文字傳送說明並主動同意，再測試及儲存伺服器。

■ 生效範圍
本擴充僅在 HamiBook WebReader 閱讀頁（webreader.hamibook.com.tw/viewer/）運作，其他網站完全不會載入。

■ 隱私
本擴充沒有分析、廣告或開發者營運的資料後端，也不會將資料傳送給開發者。一般朗讀使用瀏覽器／作業系統內建語音，內文不會傳送到 TTS Server。只有使用者主動設定、同意並選用「TTS 伺服器」朗讀引擎時，目前朗讀段落才會傳送到使用者指定的本機或外部伺服器以產生音訊；外部服務的紀錄政策由使用者選擇的服務決定。

`storage` 權限只用於在 Chrome 本機保存朗讀引擎、伺服器、選用 API Key、聲音、語速與翻頁偏好。TTS 主機權限為選用權限：不會在安裝或更新時取得所有網站權限，只有使用者在選項頁操作時，才針對所填寫的單一 HTTP／HTTPS 主機顯示 Chrome 授權提示。API Key 不同步到 Chrome Sync。平滑翻頁只向已登入的 HamiBook 同源站台預載相鄰頁；診斷 LOG 不會自動上傳。

■ 說明
本擴充為第三方輔助工具，與 HamiBook／中華電信無任何隸屬或合作關係，僅在你已具備閱讀權限的頁面上提供朗讀與顯示輔助。瀏覽器語音的實際音色依作業系統而定；本機／外部 TTS Server 皆由使用者自行安裝、選擇與管理，本擴充不提供或代營運任何 TTS 服務。
```

## 隱私權實務（Privacy practices，審查會問）
- 單一用途說明：在 HamiBook WebReader 閱讀頁提供語音朗讀、閱讀進度、夜間閱讀與平滑翻頁等閱讀輔助功能。
- 資料類型建議勾選：**網站內容**（閱讀文字／版面）、**瀏覽活動或網站記錄**（目前 HamiBook 閱讀頁與進度）、**驗證資訊**（僅使用者選填的 TTS API Key）。其餘未實際處理的類型不要勾選。
- 資料處理揭露：預設只在本機處理。選用 TTS Server 並同意揭露後，僅將目前朗讀段落、模型、聲音與語速傳送到使用者指定的本機／外部主機；不傳送給開發者。
- `storage` 權限：在 `chrome.storage.local` 保存 TTS 與播放偏好；API Key 不使用 Chrome Sync。
- `optional_host_permissions`：manifest 僅宣告可供選擇的 HTTP／HTTPS 範圍；實際透過 `chrome.permissions.request()` 只請求使用者所填主機，且必須由選項頁按鈕操作觸發。
- Content script 網站範圍：只在 `https://webreader.hamibook.com.tw/viewer/*` 載入，不在其他網站執行。
- 遠端程式碼：**未使用**（所有程式碼隨擴充封裝，無遠端載入）。
- Limited Use：資料只用於使用者可見的閱讀輔助功能，不用於廣告、分析、信用、出售或其他用途，也不允許人工讀取。

## 隱私權政策網址

```text
https://github.com/ts01000884/hamibook_reader_plugin/blob/main/PRIVACY.md
```

## 版本更新／權限變更說明

```text
本次更新新增選用的本機／外部 TTS Server 功能，並新增以下權限：

1. storage（必要）：只在 Chrome 本機保存朗讀引擎、TTS Server、選用 API Key、模型、聲音、語速與翻頁偏好；不使用 Chrome Sync。
2. optional_host_permissions（選用）：允許使用者自行指定 HTTP／HTTPS TTS Server。安裝或更新時不會自動取得所有網站權限；只有使用者在設定頁主動測試或儲存時，才針對所填寫的單一主機顯示 Chrome 權限提示。

閱讀頁的既有存取範圍仍限定在 https://webreader.hamibook.com.tw/viewer/*，沒有擴大到其他瀏覽頁面。擴充不載入或執行遠端程式碼，也沒有開發者營運的 TTS、分析或廣告伺服器。
```

## `storage` 權限說明

```text
storage 用於在 chrome.storage.local 保存朗讀引擎、本機／外部 TTS 設定、選用 API Key、模型、聲音、語速與自動翻頁偏好。這些設定需要由 extension service worker 讀取，無法只使用 HamiBook 網頁的 localStorage。資料不使用 Chrome Sync，也不會傳送給開發者。
```

## 選用 TTS 主機權限說明

```text
optional_host_permissions 宣告 http://*/* 與 https://*/*，是因為 TTS Server 的主機由使用者在執行時自行輸入，無法在送審時預先列出。擴充不會一次請求或取得所有主機權限；只有使用者在選項頁按下測試或儲存後，才使用 chrome.permissions.request() 請求該 URL 所屬的單一主機。Chrome host permission 不支援依 Port 或路徑進一步限縮，因此請求模式為該協定與 hostname。切換主機並儲存後會移除先前主機權限。

取得的主機權限只用於 GET /v1/audio/voices 與 POST /v1/audio/speech。跨網域請求由 MV3 service worker 執行；HamiBook 頁面不能指定請求 URL、讀取 API Key，或把擴充當作任意網路代理。
```

## 網站存取權限請求說明（Host permission justification）

```
本擴充為單一用途的閱讀輔助工具，僅透過 content_scripts 的比對模式在 HamiBook WebReader 的閱讀頁（https://webreader.hamibook.com.tw/viewer/*）注入，不會在其他瀏覽網站執行。

需要此網站存取範圍，是因為擴充的核心功能都必須直接在該閱讀頁上運作：
1. 語音朗讀：讀取頁面上的內文段落，交給瀏覽器內建語音合成功能朗讀。
2. 自動翻頁接續：偵測目前段落是否已顯示，並點擊頁面上的「下一頁」按鈕讓朗讀連續進行。
3. 夜間模式：注入 CSS 並調整頁面樣式，提供護眼的深色閱讀介面。
4. 閱讀進度記憶：以同源 localStorage 記住整章段落與上次朗讀位置。
5. 平滑翻頁：僅在相容的固定版面閱讀頁由使用者透過擴充工具列 ICON 手動開啟；依目前視窗尺寸預先修正相鄰閱讀頁，並在原生頁面完成修正前進行視覺交接，以減少白畫面與版面跳動。此功能首次預設關閉。
6. 本機診斷 LOG：在記憶體中保留最多 200 筆翻頁狀態、耗時與版面尺寸，只有使用者主動點擊複製時才會放入剪貼簿，不會自動上傳；LOG 不包含書名、URL 查詢參數、會員資料、token 或書籍內文。

以上功能僅在使用者已具備閱讀權限的 HamiBook 閱讀頁上進行顯示、朗讀與翻頁輔助。預設瀏覽器語音只在裝置本機處理；只有使用者另行設定、閱讀明顯揭露並主動同意 TTS Server 模式後，目前朗讀段落才會送到使用者指定的本機或外部 TTS 主機。資料不會傳送給開發者、分析或廣告服務。平滑翻頁只會向目前已登入的 HamiBook WebReader 同源站台預載相鄰閱讀頁。

閱讀頁存取範圍已限縮到 webreader.hamibook.com.tw 單一網域的 /viewer/ 路徑；唯一的路徑萬用字元只用於涵蓋該路徑下的閱讀頁。TTS 的廣泛 HTTP／HTTPS 模式只存在於 optional_host_permissions，實際權限由使用者逐一主機授予，不等同安裝時取得 <all_urls>。
```
