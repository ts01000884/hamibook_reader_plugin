/*
 * HamiBook 朗讀 + 夜間模式（Chrome 擴充 content script，MV3）
 * 生效網址 / 執行時機 / 只在頂層執行 等設定，改由 manifest.json 宣告。
 *
 * 原始功能：HamiBook 可見範圍中文朗讀（語速上限 1.5，播完自動翻頁接續）
 *          + 全文章節段落進度紀錄 + UI 黑夜模式（已修正切章節偶爾全黑的問題）
 */

/*
 * 合併說明（2026-07-06）：
 * 1. 原本兩支腳本的 @match 不同：TTS 只在 /viewer/08/* 生效，黑夜模式在 /viewer/* 全格式生效。
 *    合併後統一用黑夜模式較廣的 @match，並在 TTS 模組內加上 isTtsSupportedPage() 判斷，
 *    確保 TTS 面板依然「只在 EPUB 文字格式 (viewer/08) 顯示」，行為與原本一致。
 * 2. 原 TTS 腳本是 @grant none（無沙盒）、@run-at document-idle；
 *    黑夜模式是 @grant GM_registerMenuCommand、@run-at document-start。
 *    Tampermonkey 不允許 "none" 與其他 @grant 並存，所以統一改成 document-start +
 *    GM_registerMenuCommand。TTS 只用到 DOM / localStorage / speechSynthesis，
 *    這些在沙盒模式下仍可正常存取，不受影響；但因為 document-start 執行時 <body>
 *    可能還不存在，因此把 TTS 的 init() 包了一層「等 body 準備好才執行」的保護。
 * 3. 語速上限依需求鎖定在 1.5（原本可到 1.8，太快聽不清楚），滑桿 max 與程式端都會夾住上限。
 * 4.（v1.1.0）新增「播完自動翻頁並接續朗讀」：可見範圍或整章讀完時，會自動點擊下一頁
 *    按鈕（猜測 class 為 .btn-block-next，來源是黑夜模式腳本裡出現過的同名 class），
 *    等頁面內容確認變更後，重新抓取段落並接續播放。找不到按鈕或翻頁逾時（6 秒）就會
 *    停止朗讀並顯示狀態訊息。可用面板上的核取方塊關閉，或在主控台呼叫
 *    hamiTts.status() 確認按鈕有沒有被正確抓到。
 * 5.（v1.2.0）修正黑夜模式切換章節後偶爾全黑看不到字：原因是內文所在的 iframe
 *    在切章節時會整個換成新 document，舊 document 裡注入的樣式與 class 一起消失，
 *    但外層背景已經是黑的，導致「黑底 + 新 iframe 尚未上色的原生黑字」重疊在一起。
 *    改用 MutationObserver 持續監看新出現的 iframe，並在其 load 事件重新套用
 *    樣式，不再只靠頁面剛載入時的 8 秒 interval。
 * 6.（v1.2.1）修正下一頁按鈕選擇器：使用者確認實際結構是
 *    <div class="next-block"><a title="下一頁" class="btn next"></a></div>，
 *    改用 .next-block .btn.next 優先比對，原本猜測的 .btn-block-next 保留作為備援。
 * 7.（v1.3.0）修正自動翻頁的兩個問題：
 *    (a) 舊版 TTS 模組原本就有「iframe 觸發 load 事件就 stopReading()」的監聽（是設計給
 *        使用者「自己手動翻頁」時用的），但自動翻頁點同一顆按鈕也會觸發同一個 load 事件，
 *        兩邊互相打架，導致朗讀被中途打斷、位置錯亂、甚至看起來像從章節開頭重念。
 *        新增 ownTriggeredTurn 旗標：只要是我們自己點的翻頁，就讓自動翻頁流程自己接手
 *        接續朗讀，不要被舊的手動翻頁監聽介入；使用者自己手動翻頁時仍維持原本行為。
 *    (b) 翻到純圖片、沒有文字的頁面時，原本只會傻等 6 秒後放棄。現在改成偵測到「翻頁後
 *        沒有文字」就立刻再點一次下一頁繼續跳過去找文字（最多連續跳 8 頁），而不是空等
 *        或誤判成要從頭念。
 *    另外自動翻頁後一律用「這一頁目前有的段落」接續朗讀（不筛選可見範圍），盡量符合
 *    「段落清單應該完整顯示，而不是只顯示當下這一小段」的需求。
 * 8.（v1.4.0）架構重寫：「念什麼」跟「要不要翻頁」完全分開。
 *    使用者發現：每次點下一頁，extractAllParagraphChunks() 抓到的只是「這一頁」的
 *    幾段，不是整章；但用「播放已存位置」那條路徑（一開始就整章抓一次，不再翻頁重抓）
 *    卻能正確抓到全部 50 幾段。可見翻頁這個動作本身會讓當下抓取變得不準，不應該在
 *    翻頁後重新呼叫 extractAllParagraphChunks() 當作「新內容」。
 *    新設計：
 *    - currentChunks 一律是「整章」段落清單，只在真正換章節時才重新抓取一次；
 *      章節中途念的時候完全不會重抓、不會把 currentIndex 歸零。
 *    - 每個 chunk 保留原始 DOM 元素（chunk.el），念下一段前先檢查這個元素目前在畫面上
 *      看不看得到；看不到才點下一頁讓畫面跟上（純粹同步畫面，不影響念到第幾段），
 *      看得到就直接念，不理會翻頁。
 *    - 只有整章 currentChunks 真的全部念完，才會觸發換章節（點下一頁 + 等內容確定變了
 *      + 重新抓「新章節」的整章段落清單 + 從頭開始）。
 *    - 拿掉了「翻頁後沒有文字就自動跳過」的邏輯：因為現在翻頁只用來同步畫面、不用來
 *      決定還有沒有文字，純圖片頁不會再讓朗讀誤判成「沒內容」或「從頭重念」。
 * 9.（v1.5.0）UI 調整：
 *    (a) 面板加上 resize: both + overflow: auto，右下角可以拖曳縮放視窗大小。
 *    (b) 「段落」「已存位置」改用原生 <details>/<summary>，預設收合，點一下才展開，
 *        平常畫面比較乾淨，需要時再點開選擇。
 * 10.（v1.6.0）面板右下角的縮放把手跟黑夜模式切換鈕（固定在 right:16px/bottom:16px）
 *     位置太近，會互相干擾。這次調整：
 *     (a) 展開時面板整體上移到 bottom: 76px，讓縮放把手離按鈕遠一點，不會搶滑鼠事件。
 *     (b) 新增整個面板的收合/展開按鈕（標題列右邊的「－」）。收合後面板會變成跟黑夜
 *         模式按鈕一樣大小的圓形小按鈕，固定放在它左邊（right: 72px/bottom: 16px），
 *         不會重疊。收合狀態會記住，下次開啟頁面維持上次的選擇。
 * 11.（v1.6.1）收合後的「讀」圓形按鈕，樣式直接比照黑夜模式切換鈕（同樣的邊框顏色、
 *     陰影、字體大小/粗細），視覺上跟「日/夜」按鈕一樣大，不會看起來比較小。
 * 12.（v1.7.0）修正多分頁同時朗讀會混在一起的問題：
 *     Chrome 的 speechSynthesis 語音佇列其實是整個瀏覽器共用的，不是每個分頁各自獨立，
 *     所以兩個分頁同時 speak()/cancel() 就會互相干擾、聲音疊在一起或被打斷。
 *     這是瀏覽器 API 本身的限制，使用者腳本沒辦法讓語音引擎完全隔離，只能用「協調」
 *     的方式處理：新增 BroadcastChannel，任何分頁開始/恢復朗讀時會廣播一次，其他
 *     正在朗讀的分頁收到後會自動停止，確保同一時間只有一個分頁在出聲音。
 */

/* ============================================================
 * 模組 A：UI 黑夜模式
 * 維持 document-start 執行，避免翻頁/進站時出現白畫面閃爍
 * ============================================================ */
(function () {
  'use strict';
  const STORAGE_KEY = 'tm_reader_ui_dark_mode_enabled';
  const CLASS_NAME = 'tm-reader-ui-dark-mode';
  const EPUB_CLASS_NAME = 'tm-reader-format-08';
  const STYLE_ID = 'tm-reader-ui-dark-mode-style';
  const BUTTON_ID = 'tm-dark-mode-toggle';
  function log(...args) {
    console.log('[HamiBook UI DarkMode]', ...args);
  }
  function isFormat08(win = window) {
    const path = win.location.pathname.replace(/\/+$/, '');
    const params = new URLSearchParams(win.location.search);
    return (
      path === '/viewer/08' ||
      path.startsWith('/viewer/08/') ||
      path.startsWith('/getEpub/') ||
      params.get('format') === '08'
    );
  }
  function getEnabled() {
    return localStorage.getItem(STORAGE_KEY) === '1';
  }
  function getCss() {
    return `
      html.${CLASS_NAME},
      html.${CLASS_NAME} body,
      body.${CLASS_NAME} {
        background: #050505 !important;
        color: #d8d8d8 !important;
      }
      html.${CLASS_NAME} #app,
      html.${CLASS_NAME} .viewer,
      html.${CLASS_NAME} .viewer.morning,
      html.${CLASS_NAME} .main,
      html.${CLASS_NAME} .book,
      html.${CLASS_NAME} .fix,
      body.${CLASS_NAME} .main {
        background: #050505 !important;
      }
      html.${CLASS_NAME} canvas,
      html.${CLASS_NAME} img,
      body.${CLASS_NAME} img {
        filter: none !important;
      }
      html.${CLASS_NAME} .top,
      html.${CLASS_NAME} .bottom,
      html.${CLASS_NAME} .right_menu,
      html.${CLASS_NAME} .right_menu2,
      html.${CLASS_NAME} .box,
      html.${CLASS_NAME} .setting,
      html.${CLASS_NAME} .menu,
      html.${CLASS_NAME} .content,
      html.${CLASS_NAME} .tab,
      html.${CLASS_NAME} .tip .box {
        background: rgba(12, 12, 12, 0.96) !important;
        color: #d8d8d8 !important;
        border-color: #333 !important;
        box-shadow: none !important;
      }
      html.${CLASS_NAME} .menu .content,
      html.${CLASS_NAME} .content.catalog,
      html.${CLASS_NAME} .content.info,
      html.${CLASS_NAME} .menu ul,
      html.${CLASS_NAME} .bottom ul,
      html.${CLASS_NAME} .page_line ul {
        background: #101010 !important;
        color: #d8d8d8 !important;
      }
      html.${CLASS_NAME} .menu li,
      html.${CLASS_NAME} .bottom li,
      html.${CLASS_NAME} .page_line li {
        background: #111 !important;
        color: #d8d8d8 !important;
        border-color: #333 !important;
      }
      html.${CLASS_NAME} .menu li.active,
      html.${CLASS_NAME} .bottom li.active,
      html.${CLASS_NAME} .page_line li.active,
      html.${CLASS_NAME} .tab .active {
        background: #242424 !important;
        color: #fff !important;
        outline: 1px solid #666 !important;
      }
      html.${CLASS_NAME} .title,
      html.${CLASS_NAME} .date,
      html.${CLASS_NAME} .desc,
      html.${CLASS_NAME} .text,
      html.${CLASS_NAME} .num,
      html.${CLASS_NAME} span,
      html.${CLASS_NAME} a,
      html.${CLASS_NAME} .btn {
        color: #d8d8d8 !important;
      }
      html.${CLASS_NAME} .loading,
      html.${CLASS_NAME} .loading1,
      html.${CLASS_NAME} .loading2,
      html.${CLASS_NAME} .loading3,
      html.${CLASS_NAME} .loadingBack {
        background: #050505 !important;
        color: #d8d8d8 !important;
      }
      html.${CLASS_NAME} .btn-block-prev,
      html.${CLASS_NAME} .btn-block-next {
        background: transparent !important;
      }
      /*
       * EPUB 文字型閱讀器。
       * 同時支援：
       * 1. 外層 viewer/08
       * 2. 內層 getEpub document
       */
      html.${CLASS_NAME}.${EPUB_CLASS_NAME},
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} body,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} {
        background: #050505 !important;
        color: #e8e8e8 !important;
      }
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main,
      html.${EPUB_CLASS_NAME} body.${CLASS_NAME} .main {
        background: #050505 !important;
        color: #e8e8e8 !important;
      }
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main *,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main *,
      html.${EPUB_CLASS_NAME} body.${CLASS_NAME} .main * {
        background-color: transparent !important;
        color: #e8e8e8 !important;
        text-shadow: none !important;
        box-shadow: none !important;
      }
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h1,
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h2,
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h3,
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h4,
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h5,
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h6,
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main .bold,
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main .small-h3,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h1,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h2,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h3,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h4,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h5,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main h6,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main .bold,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main .small-h3 {
        color: #ffffff !important;
      }
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main a,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main a {
        color: #9fc7ff !important;
      }
      html.${CLASS_NAME}.${EPUB_CLASS_NAME} .main img,
      body.${CLASS_NAME}.${EPUB_CLASS_NAME} .main img {
        filter: none !important;
        background: transparent !important;
      }
      #${BUTTON_ID} {
        position: fixed !important;
        right: 16px !important;
        bottom: 16px !important;
        z-index: 2147483647 !important;
        width: 48px !important;
        height: 48px !important;
        border-radius: 999px !important;
        border: 1px solid rgba(255,255,255,0.3) !important;
        background: rgba(20,20,20,0.92) !important;
        color: #fff !important;
        font-size: 14px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        user-select: none !important;
        box-shadow: 0 2px 14px rgba(0,0,0,0.55) !important;
      }
      html:not(.${CLASS_NAME}) #${BUTTON_ID} {
        background: rgba(255,255,255,0.92) !important;
        color: #111 !important;
        border-color: rgba(0,0,0,0.25) !important;
      }
    `;
  }
  function applyClasses(doc, enabled) {
    const win = doc.defaultView || window;
    const epub = isFormat08(win);
    doc.documentElement.classList.toggle(CLASS_NAME, enabled);
    doc.documentElement.classList.toggle(EPUB_CLASS_NAME, epub);
    if (doc.body) {
      doc.body.classList.toggle(CLASS_NAME, enabled);
      doc.body.classList.toggle(EPUB_CLASS_NAME, epub);
    }
  }
  function injectStyleToDocument(doc) {
    if (!doc || !doc.documentElement) return;
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = getCss();
    (doc.head || doc.documentElement).appendChild(style);
  }
  function applyToDocument(doc, enabled) {
    injectStyleToDocument(doc);
    applyClasses(doc, enabled);
  }
  function applyToSameOriginFrames(enabled) {
    const frames = document.querySelectorAll('iframe');
    frames.forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        applyToDocument(doc, enabled);
        log('applied to iframe', {
          src: frame.src,
          path: frame.contentWindow.location.pathname,
          format08: isFormat08(frame.contentWindow)
        });
      } catch (err) {
        log('skip iframe, not same-origin or not ready', frame.src);
      }
    });
  }
  function setEnabled(enabled, source = 'unknown') {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    applyToDocument(document, enabled);
    applyToSameOriginFrames(enabled);
    const btn = document.getElementById(BUTTON_ID);
    if (btn) {
      btn.textContent = enabled ? '夜' : '日';
      btn.title = enabled ? 'UI 黑夜模式已開啟' : 'UI 黑夜模式已關閉';
    }
    log('setEnabled', {
      enabled,
      source,
      url: location.href,
      path: location.pathname,
      format08: isFormat08()
    });
  }
  function toggle(source = 'toggle') {
    setEnabled(!document.documentElement.classList.contains(CLASS_NAME), source);
  }
  /*
   * Bug 修正：切換章節時偶爾會「全黑看不到字」。
   * 原因：章節/分頁切換時，內文所在的 iframe 會整個換成新的 document，
   * 舊 document 裡注入的 <style> 和 CLASS_NAME/EPUB_CLASS_NAME class 都會一併消失。
   * 外層文件的 .main 背景只要有 CLASS_NAME 就會強制變黑（不管 EPUB_CLASS_NAME），
   * 如果這個黑色透出到新 iframe（iframe 本身背景透明），但新 iframe 內文字
   * 還沒被重新上色成亮色，就會變成「黑底黑字」。
   * 舊版只在頁面剛載入的 8 秒內用 interval 重新套用一次，之後章節再切換就不會
   * 再自動處理。這裡改用 MutationObserver 持續監看新出現的 iframe，
   * 並在 iframe 的 load 事件重新套用樣式，讓每次切章節都會自動修好。
   */
  function bindIframeReapply(frame) {
    if (!frame || frame.__tmDarkModeBound) return;
    frame.__tmDarkModeBound = true;
    frame.addEventListener('load', () => {
      setEnabled(getEnabled(), 'iframe-load');
      // 有些內容是 load 事件後才由頁面自己的 JS 慢慢渲染進去，補兩次重試
      setTimeout(() => setEnabled(getEnabled(), 'iframe-load-retry-300'), 300);
      setTimeout(() => setEnabled(getEnabled(), 'iframe-load-retry-900'), 900);
    });
  }
  function watchForIframes() {
    document.querySelectorAll('iframe').forEach(bindIframeReapply);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.tagName === 'IFRAME') {
            bindIframeReapply(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('iframe').forEach(bindIframeReapply);
          }
        });
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  function createButton() {
    if (!document.body) return;
    if (document.getElementById(BUTTON_ID)) return;
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = getEnabled() ? '夜' : '日';
    btn.title = '切換 UI 黑夜模式';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle('floating-button');
    }, true);
    document.body.appendChild(btn);
  }
  function init() {
    setEnabled(getEnabled(), 'init');
    if (document.body) {
      createButton();
    } else {
      document.addEventListener('DOMContentLoaded', createButton, { once: true });
    }
    // 持續監看 iframe 的新增與 load 事件，修正切換章節後偶爾全黑看不到字的問題
    watchForIframes();
    /*
     * 保留原本頁面剛載入時的短暫 interval 補套（雙保險，成本很低）。
     * 真正解決「之後切章節」問題的是上面的 watchForIframes()。
     */
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      setEnabled(getEnabled(), 'iframe-refresh');
      if (count >= 10) {
        clearInterval(timer);
      }
    }, 800);
    window.hamiDarkMode = {
      on() {
        setEnabled(true, 'console');
      },
      off() {
        setEnabled(false, 'console');
      },
      toggle() {
        toggle('console');
      },
      refresh() {
        setEnabled(getEnabled(), 'console-refresh');
      },
      status() {
        return {
          enabled: document.documentElement.classList.contains(CLASS_NAME),
          format08: isFormat08(),
          path: location.pathname,
          search: location.search,
          url: location.href,
          htmlClass: document.documentElement.className,
          iframeCount: document.querySelectorAll('iframe').length,
          iframes: Array.from(document.querySelectorAll('iframe')).map((f) => {
            try {
              return {
                src: f.src,
                path: f.contentWindow.location.pathname,
                sameOrigin: true,
                format08: isFormat08(f.contentWindow)
              };
            } catch (e) {
              return {
                src: f.src,
                sameOrigin: false
              };
            }
          })
        };
      }
    };
    log('ready');
    log('Console: hamiDarkMode.status(), hamiDarkMode.refresh(), hamiDarkMode.on()');
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('切換 UI 黑夜模式', function () {
      toggle('tampermonkey-menu');
    });
    GM_registerMenuCommand('開啟 UI 黑夜模式', function () {
      setEnabled(true, 'tampermonkey-menu');
    });
    GM_registerMenuCommand('關閉 UI 黑夜模式', function () {
      setEnabled(false, 'tampermonkey-menu');
    });
    GM_registerMenuCommand('重新套用 UI 黑夜模式', function () {
      setEnabled(getEnabled(), 'tampermonkey-menu-refresh');
    });
  }
  init();
})();

/* ============================================================
 * 模組 B：TTS 朗讀 + 全文段落進度紀錄
 * 語速上限鎖定 1.5；且僅在 EPUB 文字格式 (viewer/08) 啟用面板
 * ============================================================ */
(function () {
  'use strict';
  const STORAGE_PREFIX = 'hamibook_tts_progress';
  const MAX_CHUNK_LENGTH = 180;
  const MAX_RATE = 1.5; // 語速上限：原本 1.8 太快聽不清楚，鎖在 1.5
  const MIN_RATE = 0.6;
  let isReading = false;
  let isPaused = false;
  let currentChunks = [];
  let currentIndex = 0;
  let currentReadScope = 'chapter'; // 現在一律以整章段落清單為準，這個欄位主要留給進度紀錄用
  let selectedRate = 1;
  let selectedVoiceURI = '';
  let speakToken = 0;
  let lastVisibleSignature = '';
  let refreshTimer = null;
  let autoTurnPage = true; // 播完自動翻頁並接續朗讀（可見範圍結束 / 章節結束皆適用）
  let turnPageToken = 0; // 用來讓「等待翻頁完成」的流程在使用者按停止/重新播放時失效
  let ownTriggeredTurn = false; // 標記「這次翻頁是我們自己點的」，避免跟舊的手動翻頁監聽互相打架
  const PANEL_COLLAPSED_KEY = 'tm_tts_panel_collapsed';
  let panelCollapsed = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1'; // 面板收合狀態，記住使用者上次的選擇
  /*
   * 多分頁同時朗讀會互相干擾的原因：
   * Chrome 的 speechSynthesis 語音佇列其實是整個瀏覽器共用的（不是每個分頁各自獨立），
   * 所以只要有兩個分頁同時呼叫 speak()/cancel()，聲音就會被排在同一個佇列裡混在一起，
   * 或是某一分頁的 cancel() 把另一分頁正在念的內容打斷。這是瀏覽器 API 本身的限制，
   * 使用者腳本沒辦法讓每個分頁的語音引擎完全隔離。
   * 這裡用 BroadcastChannel 做「同時間只有一個分頁在朗讀」的簡單協調機制：
   * 任何分頁一開始/恢復朗讀，就廣播「我要開始念了」，其他分頁收到後如果自己也在念，
   * 就自動停止，避免兩邊同時輸出語音疊在一起。
   */
  const TAB_ID = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const ttsBroadcastChannel =
    typeof BroadcastChannel === 'function' ? new BroadcastChannel('hamibook_tts_active_reader') : null;
  if (ttsBroadcastChannel) {
    ttsBroadcastChannel.onmessage = (event) => {
      const data = event.data;
      if (!data || data.tabId === TAB_ID) return;
      if (data.type === 'claim' && isReading) {
        stopReading();
        setStatus('偵測到其他分頁開始朗讀，本分頁已自動停止，避免聲音重疊');
      }
    };
  }
  // 這個分頁要開始/恢復念之前，先廣播一下，讓其他分頁自己讓開
  function claimActiveReader() {
    if (ttsBroadcastChannel) {
      ttsBroadcastChannel.postMessage({ type: 'claim', tabId: TAB_ID, ts: Date.now() });
    }
  }
  function $(id) {
    return document.getElementById(id);
  }
  // 語速夾在 0.6 ~ 1.5 之間，避免舊資料或滑桿以外的來源超出可辨識範圍
  function clampRate(value) {
    if (Number.isNaN(value)) return 1;
    return Math.min(MAX_RATE, Math.max(MIN_RATE, value));
  }
  function init() {
    createPanel();
    applyStoredSettingsToUI();
    speechSynthesis.getVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = () => {
        populateVoiceSelect();
      };
    }
    setTimeout(populateVoiceSelect, 300);
    setTimeout(populateVoiceSelect, 1000);
    setTimeout(() => {
      applyStoredSettingsToUI();
      refreshFullChapterChunks(true);
      refreshBookmarkSelect();
      attachPageWatchers();
    }, 800);
    setTimeout(() => {
      applyStoredSettingsToUI();
      refreshFullChapterChunks(false);
      refreshBookmarkSelect();
      attachPageWatchers();
    }, 1800);
    // 主控台除錯用：hamiTts.status() 可確認翻頁按鈕有沒有被抓到
    window.hamiTts = {
      status() {
        return {
          isReading,
          isPaused,
          currentReadScope,
          currentIndex,
          chunksLength: currentChunks.length,
          autoTurnPage,
          rate: selectedRate,
          nextButtonFound: !!getNextPageButton(),
          nextButtonSelectorMatched: getNextPageButton()?.className || null
        };
      },
      forceChapterAdvance() {
        attemptChapterAdvance();
      }
    };
  }
  function createPanel() {
    if ($('tm-tts-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'tm-tts-panel';
    panel.innerHTML = `
      <div id="tm-tts-panel-box" style="
        position: fixed;
        right: 20px;
        bottom: 76px;
        z-index: 999999;
        background: rgba(0,0,0,0.84);
        color: white;
        padding: 12px;
        border-radius: 8px;
        font-size: 14px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        width: 390px;
        min-width: 260px;
        min-height: 120px;
        max-width: 92vw;
        max-height: 85vh;
        line-height: 1.35;
        resize: both;
        overflow: auto;
        box-sizing: border-box;
      ">
        <div id="tm-tts-header" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px;">
          <span id="tm-tts-title" style="font-weight: 600;">HamiBook 朗讀</span>
          <button id="tm-tts-collapse-toggle" title="收合/展開面板" style="flex-shrink: 0; width: 26px; height: 26px; line-height: 1; border-radius: 999px; border: 1px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.08); color: white; cursor: pointer;">－</button>
        </div>
        <div id="tm-tts-body">
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;">
            <button id="tm-tts-play-visible">從目前畫面開始播放</button>
            <button id="tm-tts-play-saved">從上次紀錄播放</button>
            <button id="tm-tts-refresh-visible">更新整章段落清單</button>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;">
            <button id="tm-tts-pause">暫停</button>
            <button id="tm-tts-resume">繼續</button>
            <button id="tm-tts-stop">停止</button>
          </div>
          <div style="margin-top: 8px;">
            <div style="margin-bottom: 4px;">中文語音</div>
            <select id="tm-tts-voice" style="width: 100%;"></select>
          </div>
          <div style="margin-top: 8px;">
            語速（上限 1.5）
            <input id="tm-tts-rate" type="range" min="0.6" max="1.5" step="0.1" value="1" style="width: 230px;">
            <span id="tm-tts-rate-value">1.0</span>
          </div>
          <div style="margin-top: 8px;">
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
              <input id="tm-tts-auto-turn" type="checkbox" checked style="width: 16px; height: 16px;">
              播完自動翻頁並接續朗讀
            </label>
          </div>
          <details style="margin-top: 8px;">
            <summary style="cursor: pointer; user-select: none;">段落（點開查看/選擇）</summary>
            <select id="tm-tts-chunk-select" style="width: 100%; margin-top: 4px;"></select>
          </details>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">
            <button id="tm-tts-play-selected">播放選取段落</button>
            <button id="tm-tts-save-bookmark">加入位置</button>
          </div>
          <details style="margin-top: 8px;">
            <summary style="cursor: pointer; user-select: none;">已存位置（點開查看/選擇）</summary>
            <select id="tm-tts-bookmark-select" style="width: 100%; margin-top: 4px;"></select>
          </details>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">
            <button id="tm-tts-play-bookmark">播放已存位置</button>
            <button id="tm-tts-delete-bookmark">刪除位置</button>
            <button id="tm-tts-clear-progress">清除紀錄</button>
          </div>
          <div id="tm-tts-status" style="margin-top: 8px; opacity: 0.88; line-height: 1.45;">待命</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    $('tm-tts-play-visible').addEventListener('click', () => {
      // 抓整章段落清單，但從「目前畫面上看得到的那一段」開始播，而不是整章從頭
      const chunks = refreshFullChapterChunks(true);
      readFromIndex(findFirstVisibleChunkIndex(chunks));
    });
    $('tm-tts-play-saved').addEventListener('click', playFromSavedProgress);
    $('tm-tts-refresh-visible').addEventListener('click', () => {
      refreshFullChapterChunks(true);
    });
    $('tm-tts-pause').addEventListener('click', pauseReading);
    $('tm-tts-resume').addEventListener('click', resumeReading);
    $('tm-tts-stop').addEventListener('click', stopReading);
    $('tm-tts-play-selected').addEventListener('click', () => {
      if (!currentChunks.length) {
        refreshFullChapterChunks(true);
      }
      const select = $('tm-tts-chunk-select');
      const index = Number(select.value || 0);
      readFromIndex(index);
    });
    $('tm-tts-save-bookmark').addEventListener('click', saveCurrentBookmark);
    $('tm-tts-play-bookmark').addEventListener('click', playSelectedBookmark);
    $('tm-tts-delete-bookmark').addEventListener('click', deleteSelectedBookmark);
    $('tm-tts-clear-progress').addEventListener('click', clearProgress);
    const rateInput = $('tm-tts-rate');
    const rateValue = $('tm-tts-rate-value');
    rateInput.addEventListener('input', () => {
      selectedRate = clampRate(Number(rateInput.value));
      rateValue.textContent = selectedRate.toFixed(1);
      saveSettings();
      if (isReading && !isPaused) {
        setStatus(`語速已改為 ${selectedRate.toFixed(1)}，下一段生效`);
      }
    });
    const voiceSelect = $('tm-tts-voice');
    voiceSelect.addEventListener('change', () => {
      selectedVoiceURI = voiceSelect.value;
      saveSettings();
      if (isReading && !isPaused) {
        setStatus('語音已變更，下一段生效');
      }
    });
    const autoTurnCheckbox = $('tm-tts-auto-turn');
    autoTurnCheckbox.addEventListener('change', () => {
      autoTurnPage = autoTurnCheckbox.checked;
      saveSettings();
      setStatus(autoTurnPage ? '已開啟自動翻頁接續朗讀' : '已關閉自動翻頁，段落播完會停止');
    });
    $('tm-tts-collapse-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      panelCollapsed = !panelCollapsed;
      localStorage.setItem(PANEL_COLLAPSED_KEY, panelCollapsed ? '1' : '0');
      applyPanelCollapsedState();
    });
    populateVoiceSelect();
    populateChunkSelect();
    refreshBookmarkSelect();
    applyPanelCollapsedState();
  }
  // 收合狀態：整個面板縮成跟黑夜模式按鈕一樣大小的圓形小按鈕，放在它左邊（right: 72px），
  // 避免跟固定在右下角（right:16px/bottom:16px）的日夜切換鈕重疊或搶滑鼠事件。
  // 展開狀態：面板整體往上移到 bottom: 76px，讓可拖曳縮放的右下角把手離按鈕遠一點。
  function applyPanelCollapsedState() {
    const box = $('tm-tts-panel-box');
    const body = $('tm-tts-body');
    const title = $('tm-tts-title');
    const toggleBtn = $('tm-tts-collapse-toggle');
    const header = $('tm-tts-header');
    if (!box || !body || !toggleBtn || !header) return;
    if (panelCollapsed) {
      body.style.display = 'none';
      title.style.display = 'none';
      header.style.margin = '0';
      header.style.width = '100%';
      header.style.height = '100%';
      // 圓形小按鈕的尺寸/邊框/陰影/字體，直接比照黑夜模式切換鈕的樣式，確保視覺上一樣大
      box.style.right = '72px';
      box.style.bottom = '16px';
      box.style.width = '48px';
      box.style.minWidth = '0';
      box.style.maxWidth = 'none';
      box.style.height = '48px';
      box.style.minHeight = '0';
      box.style.maxHeight = 'none';
      box.style.padding = '0';
      box.style.borderRadius = '999px';
      box.style.resize = 'none';
      box.style.overflow = 'hidden';
      box.style.border = '1px solid rgba(255,255,255,0.3)';
      box.style.boxSizing = 'border-box';
      box.style.boxShadow = '0 2px 14px rgba(0,0,0,0.55)';
      box.style.display = 'flex';
      box.style.alignItems = 'center';
      box.style.justifyContent = 'center';
      toggleBtn.textContent = '讀';
      toggleBtn.style.width = '100%';
      toggleBtn.style.height = '100%';
      toggleBtn.style.fontSize = '14px';
      toggleBtn.style.fontWeight = '700';
      toggleBtn.style.border = 'none';
      toggleBtn.style.background = 'transparent';
      toggleBtn.style.borderRadius = '999px';
      toggleBtn.style.boxSizing = 'border-box';
    } else {
      body.style.display = '';
      title.style.display = '';
      header.style.margin = '0 0 8px 0';
      header.style.width = '';
      header.style.height = '';
      box.style.right = '20px';
      box.style.bottom = '76px';
      box.style.width = '390px';
      box.style.minWidth = '260px';
      box.style.maxWidth = '92vw';
      box.style.height = '';
      box.style.minHeight = '120px';
      box.style.maxHeight = '85vh';
      box.style.padding = '12px';
      box.style.borderRadius = '8px';
      box.style.resize = 'both';
      box.style.overflow = 'auto';
      box.style.border = 'none';
      box.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
      box.style.display = 'block';
      box.style.alignItems = '';
      box.style.justifyContent = '';
      toggleBtn.textContent = '－';
      toggleBtn.style.width = '26px';
      toggleBtn.style.height = '26px';
      toggleBtn.style.fontSize = '';
      toggleBtn.style.fontWeight = '';
      toggleBtn.style.border = '1px solid rgba(255,255,255,0.3)';
      toggleBtn.style.background = 'rgba(255,255,255,0.08)';
      toggleBtn.style.borderRadius = '999px';
    }
  }
  function setStatus(text) {
    const el = $('tm-tts-status');
    if (el) el.textContent = text;
  }
  function getBookIframe() {
    return (
      document.querySelector('.book iframe') ||
      document.querySelector('iframe[src*="/getEpub/"]') ||
      document.querySelector('iframe')
    );
  }
  function getIframeDocument(iframe) {
    try {
      return iframe?.contentDocument || iframe?.contentWindow?.document || null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }
  function getBookId() {
    const iframe = getBookIframe();
    const rawSrc = iframe?.getAttribute('src') || iframe?.src || '';
    const fromIframe = rawSrc.match(/\/getEpub\/([^/?#]+)/);
    if (fromIframe) return fromIframe[1];
    const fromPath = location.pathname.match(/\/viewer\/[^/]+\/([^/?#]+)/);
    if (fromPath) return fromPath[1];
    const fromUrl = location.href.match(/book[_-]?id=([^&#]+)/i);
    if (fromUrl) return decodeURIComponent(fromUrl[1]);
    return 'unknown_book';
  }
  function getFormat() {
    const match = location.pathname.match(/\/viewer\/([^/]+)/);
    return match ? match[1] : 'unknown_format';
  }
  function getStorageKey() {
    return `${STORAGE_PREFIX}:book_id=${getBookId()}:format=${getFormat()}`;
  }
  function createEmptyStore() {
    return {
      version: 1,
      last: null,
      bookmarks: [],
      settings: {
        rate: 1,
        voiceURI: '',
        autoTurnPage: true
      }
    };
  }
  function loadProgressStore() {
    const key = getStorageKey();
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return createEmptyStore();
      const parsed = JSON.parse(raw);
      const empty = createEmptyStore();
      return {
        version: 1,
        last: parsed.last || null,
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
        settings: {
          ...empty.settings,
          ...(parsed.settings || {})
        }
      };
    } catch (e) {
      console.error(e);
      return createEmptyStore();
    }
  }
  function saveProgressStore(store) {
    const key = getStorageKey();
    window.localStorage.setItem(key, JSON.stringify({
      version: 1,
      last: store.last || null,
      bookmarks: Array.isArray(store.bookmarks) ? store.bookmarks : [],
      settings: {
        rate: Number(store.settings?.rate || selectedRate || 1),
        voiceURI: String(store.settings?.voiceURI || selectedVoiceURI || ''),
        autoTurnPage:
          store.settings?.autoTurnPage !== undefined
            ? !!store.settings.autoTurnPage
            : autoTurnPage
      }
    }));
  }
  function saveSettings() {
    const store = loadProgressStore();
    store.settings = {
      rate: selectedRate,
      voiceURI: selectedVoiceURI,
      autoTurnPage
    };
    saveProgressStore(store);
  }
  function applyStoredSettingsToUI() {
    const store = loadProgressStore();
    const rate = Number(store.settings?.rate || 1);
    if (!Number.isNaN(rate)) {
      // 讀取舊資料時一併夾住上限，避免曾經存過 >1.5 的語速殘留
      selectedRate = clampRate(rate);
    }
    if (store.settings?.voiceURI) {
      selectedVoiceURI = store.settings.voiceURI;
    }
    if (store.settings?.autoTurnPage !== undefined) {
      autoTurnPage = !!store.settings.autoTurnPage;
    }
    const rateInput = $('tm-tts-rate');
    const rateValue = $('tm-tts-rate-value');
    if (rateInput) rateInput.value = String(selectedRate);
    if (rateValue) rateValue.textContent = selectedRate.toFixed(1);
    const autoTurnCheckbox = $('tm-tts-auto-turn');
    if (autoTurnCheckbox) autoTurnCheckbox.checked = autoTurnPage;
    populateVoiceSelect();
  }
  function getChapterTitle() {
    return (
      document.querySelector('.title')?.innerText ||
      document.querySelector('[class*="title"]')?.innerText ||
      document.title ||
      ''
    ).replace(/\s+/g, ' ').trim();
  }
  function getPageInfo() {
    const current = Number(document.querySelector('.pages .current')?.innerText || 0);
    const total = Number(document.querySelector('.pages .total')?.innerText || 0);
    return {
      pageCurrent: current || null,
      pageTotal: total || null
    };
  }
  function normalizeText(text) {
    return String(text || '')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n+/g, ' ')
      .trim();
  }
  function getTextLeafElements(doc) {
    const all = [...doc.body.querySelectorAll('body *')];
    return all.filter(el => {
      const text = normalizeText(el.innerText || el.textContent || '');
      if (!text) return false;
      const hasTextChild = [...el.children].some(child =>
        normalizeText(child.innerText || child.textContent || '')
      );
      return !hasTextChild;
    });
  }
  function getParagraphElements() {
    const iframe = getBookIframe();
    const doc = getIframeDocument(iframe);
    if (!doc || !doc.body) return [];
    let elements = [...doc.body.querySelectorAll('p')];
    if (!elements.length) {
      elements = getTextLeafElements(doc);
    }
    const items = [];
    let textIndex = 0;
    for (const el of elements) {
      const text = normalizeText(el.innerText || el.textContent || '');
      if (!text) continue;
      items.push({
        el,
        index: textIndex,
        text
      });
      textIndex++;
    }
    return items;
  }
  function isElementVisibleInIframeViewport(el) {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    if (!win) return false;
    const style = win.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    const viewportWidth =
      doc.documentElement.clientWidth ||
      win.innerWidth ||
      0;
    const viewportHeight =
      doc.documentElement.clientHeight ||
      win.innerHeight ||
      0;
    if (!viewportWidth || !viewportHeight) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    const visibleWidth =
      Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
    const visibleHeight =
      Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
    return visibleWidth > 8 && visibleHeight > 6;
  }
  function splitLongParagraph(text, maxLength = MAX_CHUNK_LENGTH) {
    const sentences = normalizeText(text)
      .split(/(?<=[。！？!?；;])/);
    const chunks = [];
    let buffer = '';
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!s) continue;
      if ((buffer + s).length > maxLength) {
        if (buffer.trim()) chunks.push(buffer.trim());
        buffer = s;
      } else {
        buffer += s;
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
    return chunks.length ? chunks : [text];
  }
  function buildChunksFromParagraphItems(paragraphItems) {
    const chunks = [];
    for (const item of paragraphItems) {
      const parts = splitLongParagraph(item.text);
      parts.forEach((part, subIndex) => {
        chunks.push({
          text: part,
          el: item.el, // 保留原始 DOM 元素參考，之後要判斷「這段現在看不看得到」會用到
          paragraphIndex: item.index,
          subIndex,
          subCount: parts.length,
          preview: part.slice(0, 42)
        });
      });
    }
    return chunks;
  }
  function extractVisibleParagraphChunks() {
    const paragraphs = getParagraphElements();
    const visibleParagraphs = paragraphs.filter(item =>
      isElementVisibleInIframeViewport(item.el)
    );
    return buildChunksFromParagraphItems(visibleParagraphs);
  }
  function extractAllParagraphChunks() {
    const paragraphs = getParagraphElements();
    return buildChunksFromParagraphItems(paragraphs);
  }
  function getChunksSignature(chunks) {
    if (!chunks.length) return 'empty';
    const first = chunks[0];
    const last = chunks[chunks.length - 1];
    return [
      chunks.length,
      first.paragraphIndex,
      first.subIndex,
      last.paragraphIndex,
      last.subIndex
    ].join(':');
  }
  // 抓「整章」目前已經渲染出來的所有段落（不筛選是否在畫面可見範圍內）。
  // 這是使用者要求的行為：播放內容跟「要不要翻頁」分開處理，播放永遠針對整章段落，
  // 翻頁只是為了讓畫面跟著朗讀進度捲動，不該用來決定「還有沒有文字可以念」。
  function refreshFullChapterChunks(showStatus) {
    const chunks = extractAllParagraphChunks();
    currentChunks = chunks;
    currentReadScope = 'chapter';
    lastVisibleSignature = getChunksSignature(chunks);
    populateChunkSelect();
    if (showStatus) {
      if (!chunks.length) {
        setStatus('目前章節沒有可朗讀文字');
      } else {
        setStatus(`已取得整章段落清單，共 ${chunks.length} 段`);
      }
    }
    return chunks;
  }
  // 在整章段落清單裡，找出「目前畫面上看得到的第一段」的 index，找不到就從頭開始
  function findFirstVisibleChunkIndex(chunks) {
    const idx = chunks.findIndex(c => c.el && isElementVisibleInIframeViewport(c.el));
    return idx >= 0 ? idx : 0;
  }
  // 使用者沒在朗讀、手動瀏覽/捲動時，定期確認整章段落清單是否需要更新
  // （例如章節剛載入完成、內容變多了），並不用來驅動朗讀本身。
  function refreshChunksIfChanged() {
    if (isReading) return;
    const chunks = extractAllParagraphChunks();
    const sig = getChunksSignature(chunks);
    if (sig === lastVisibleSignature) return;
    currentChunks = chunks;
    currentReadScope = 'chapter';
    lastVisibleSignature = sig;
    populateChunkSelect();
  }
  function scheduleVisibleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshChunksIfChanged();
    }, 220);
  }
  function attachPageWatchers() {
    if (window.__tmHamiTtsWatchersAttached) return;
    window.__tmHamiTtsWatchersAttached = true;
    document.addEventListener('click', scheduleVisibleRefresh, true);
    document.addEventListener('keydown', scheduleVisibleRefresh, true);
    window.addEventListener('resize', scheduleVisibleRefresh);
    const iframe = getBookIframe();
    const doc = getIframeDocument(iframe);
    if (iframe) {
      iframe.addEventListener('load', () => {
        if (ownTriggeredTurn) {
          // 這次翻頁是自動朗讀流程自己點的按鈕（跟上朗讀進度或換章節），
          // 交給 speakNextChunk/ensureChunkVisibleThenSpeak/waitForChapterChangeAndContinue
          // 自己處理，這裡不要介入，避免互相打架導致朗讀被打斷或位置錯亂。
          ownTriggeredTurn = false;
          return;
        }
        // 使用者自己手動翻頁：維持原本行為，停止朗讀讓使用者自己決定
        if (isReading) {
          stopReading();
        }
        setTimeout(() => {
          refreshFullChapterChunks(true);
          refreshBookmarkSelect();
        }, 300);
      });
    }
    if (doc) {
      doc.addEventListener('scroll', scheduleVisibleRefresh, true);
      doc.addEventListener('click', scheduleVisibleRefresh, true);
      doc.addEventListener('keydown', scheduleVisibleRefresh, true);
    }
    setInterval(() => {
      if (!isReading) {
        refreshChunksIfChanged();
      }
    }, 1200);
  }
  // 取得「下一頁」按鈕。實際結構是使用者確認過的：
  // <div class="next-block"><a title="下一頁" class="btn next"></a></div>
  // 在章節最後一頁點它會直接跳到下一章節，正合我們要的效果。
  // 後面幾個是保底選擇器，避免頁面版型微調後直接抓不到。
  function getNextPageButton() {
    return (
      document.querySelector('.next-block .btn.next') ||
      document.querySelector('a.btn.next') ||
      document.querySelector('[title="下一頁"]') ||
      document.querySelector('.btn-block-next') ||
      document.querySelector('[class*="btn-block-next"]') ||
      document.querySelector('.btn-next-page') ||
      document.querySelector('[class*="btn-next"]') ||
      null
    );
  }
  function isNextPageButtonDisabled(btn) {
    if (!btn) return true;
    return (
      btn.disabled === true ||
      btn.classList.contains('disabled') ||
      btn.getAttribute('aria-disabled') === 'true'
    );
  }
  // 用「章節標題 + 頁碼 + 段落內容特徵」組成簽章，用來判斷翻頁後內容是否真的變了
  function getCurrentContentSignature() {
    const { pageCurrent, pageTotal } = getPageInfo();
    const chunks = extractAllParagraphChunks();
    return `${getChapterTitle()}::${pageCurrent}/${pageTotal}::${getChunksSignature(chunks)}`;
  }
  // 整章 currentChunks 真的全部念完了，才會呼叫這裡：點下一頁換到下一章節。
  // 章節中途的翻頁（跟上朗讀進度）由 speakNextChunk/ensureChunkVisibleThenSpeak 處理，
  // 跟這裡完全分開，這裡只負責「換章節」這件事。
  function attemptChapterAdvance() {
    const token = ++turnPageToken;
    const btn = getNextPageButton();
    if (!btn || isNextPageButtonDisabled(btn)) {
      isReading = false;
      saveLastProgress(currentIndex);
      setStatus('已到全書最後（找不到下一頁按鈕），朗讀結束');
      return;
    }
    const beforeSignature = getCurrentContentSignature();
    setStatus('本章朗讀完成，正在切換下一章…');
    saveLastProgress(currentIndex);
    ownTriggeredTurn = true;
    btn.click();
    waitForChapterChangeAndContinue(token, beforeSignature, 0, 0);
  }
  const MAX_EMPTY_CHAPTER_RETRIES = 10; // 新章節內容還沒渲染出文字時，最多重試幾次
  // 輪詢確認章節內容已經真的換了（章節/頁碼/段落簽章都跟原本不一樣），
  // 換章節可能比單純翻頁久一點，逾時抓寬鬆一點。
  function waitForChapterChangeAndContinue(token, beforeSignature, elapsedMs, emptyRetries) {
    const POLL_INTERVAL = 300;
    const TIMEOUT_MS = 8000;
    if (token !== turnPageToken || !isReading) return;
    const afterSignature = getCurrentContentSignature();
    if (afterSignature === beforeSignature) {
      if (elapsedMs >= TIMEOUT_MS) {
        isReading = false;
        setStatus('切換章節逾時，已停止朗讀，請手動確認頁面狀態');
        return;
      }
      setTimeout(() => waitForChapterChangeAndContinue(token, beforeSignature, elapsedMs + POLL_INTERVAL, emptyRetries), POLL_INTERVAL);
      return;
    }
    // 內容確定變了，重新抓「新章節」的整章段落清單
    const chunks = extractAllParagraphChunks();
    if (!chunks.length) {
      // 新章節可能還在渲染，或開頭剛好是純圖片頁，用新的簽章當基準繼續等一下（有次數上限，避免卡死）
      if (emptyRetries + 1 >= MAX_EMPTY_CHAPTER_RETRIES) {
        isReading = false;
        setStatus('切換章節後找不到文字，已停止，請手動確認');
        return;
      }
      setTimeout(() => waitForChapterChangeAndContinue(token, afterSignature, 0, emptyRetries + 1), POLL_INTERVAL);
      return;
    }
    currentChunks = chunks;
    currentIndex = 0;
    currentReadScope = 'chapter';
    populateChunkSelect();
    setStatus('已切換章節，繼續朗讀');
    saveLastProgress(currentIndex);
    speakNextChunk();
  }
  function populateChunkSelect() {
    const select = $('tm-tts-chunk-select');
    if (!select) return;
    select.innerHTML = '';
    if (!currentChunks.length) {
      const option = document.createElement('option');
      option.value = '0';
      option.textContent = '目前沒有段落';
      select.appendChild(option);
      return;
    }
    const scopeLabel = currentReadScope === 'chapter' ? '章節' : '可見';
    currentChunks.forEach((chunk, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      const sub =
        chunk.subCount > 1
          ? `-${chunk.subIndex + 1}/${chunk.subCount}`
          : '';
      option.textContent =
        `${scopeLabel} ${index + 1}/${currentChunks.length}｜全文第 ${chunk.paragraphIndex + 1} 段${sub}｜${chunk.preview}`;
      select.appendChild(option);
    });
    select.value = String(Math.min(currentIndex, currentChunks.length - 1));
    select.onchange = () => {
      currentIndex = Number(select.value || 0);
      if (!isReading) {
        saveLastProgress(currentIndex);
      }
      const chunk = currentChunks[currentIndex];
      setStatus(
        `已選全文第 ${chunk.paragraphIndex + 1} 段，朗讀片段 ${currentIndex + 1}/${currentChunks.length}`
      );
    };
  }
  function updateChunkSelectValue() {
    const select = $('tm-tts-chunk-select');
    if (!select || !currentChunks.length) return;
    select.value = String(Math.min(currentIndex, currentChunks.length - 1));
  }
  function getChineseVoicesSorted() {
    const voices = speechSynthesis.getVoices();
    return voices
      .filter(v => v.lang && v.lang.toLowerCase().startsWith('zh'))
      .slice()
      .sort((a, b) => {
        const priority = lang => {
          lang = String(lang || '').toLowerCase();
          if (lang === 'zh-tw') return 0;
          if (lang === 'zh-hant') return 1;
          if (lang === 'zh-hk') return 2;
          if (lang === 'zh-cn') return 3;
          if (lang === 'zh-hans') return 4;
          if (lang.startsWith('zh')) return 5;
          return 9;
        };
        const p = priority(a.lang) - priority(b.lang);
        if (p !== 0) return p;
        return `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`);
      });
  }
  function populateVoiceSelect() {
    const voiceSelect = $('tm-tts-voice');
    if (!voiceSelect) return;
    const oldValue = selectedVoiceURI || voiceSelect.value;
    const voices = getChineseVoicesSorted();
    voiceSelect.innerHTML = '';
    if (!voices.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '找不到中文語音';
      voiceSelect.appendChild(option);
      selectedVoiceURI = '';
      return;
    }
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} / ${voice.lang}${voice.localService ? ' / local' : ''}`;
      voiceSelect.appendChild(option);
    }
    const preferredVoice =
      voices.find(v => v.lang.toLowerCase() === 'zh-tw') ||
      voices.find(v => v.lang.toLowerCase() === 'zh-hant') ||
      voices.find(v => v.lang.toLowerCase() === 'zh-hk') ||
      voices.find(v => v.lang.toLowerCase() === 'zh-cn') ||
      voices[0];
    const stillExists = voices.some(v => v.voiceURI === oldValue);
    selectedVoiceURI = stillExists
      ? oldValue
      : preferredVoice.voiceURI;
    voiceSelect.value = selectedVoiceURI;
  }
  function getSelectedVoice() {
    const voices = getChineseVoicesSorted();
    return (
      voices.find(v => v.voiceURI === selectedVoiceURI) ||
      voices.find(v => v.lang.toLowerCase() === 'zh-tw') ||
      voices.find(v => v.lang.toLowerCase() === 'zh-hant') ||
      voices.find(v => v.lang.toLowerCase() === 'zh-hk') ||
      voices.find(v => v.lang.toLowerCase() === 'zh-cn') ||
      voices[0] ||
      null
    );
  }
  function sameChunk(a, b) {
    return (
      a &&
      b &&
      a.paragraphIndex === b.paragraphIndex &&
      a.subIndex === b.subIndex
    );
  }
  function findNextChunkInChapter(chunk) {
    if (!chunk) return null;
    const allChunks =
      currentReadScope === 'chapter'
        ? currentChunks
        : extractAllParagraphChunks();
    const index = allChunks.findIndex(item => sameChunk(item, chunk));
    if (index >= 0 && index + 1 < allChunks.length) {
      return allChunks[index + 1];
    }
    return null;
  }
  function makeProgress(chunkIndex) {
    if (!currentChunks.length) return null;
    const { pageCurrent, pageTotal } = getPageInfo();
    const completedCurrentRange = chunkIndex >= currentChunks.length;
    let safeIndex = Math.max(
      0,
      Math.min(chunkIndex, currentChunks.length - 1)
    );
    let chunk = currentChunks[safeIndex];
    let chapterDone = false;
    if (completedCurrentRange) {
      const nextChunk = findNextChunkInChapter(chunk);
      if (nextChunk) {
        chunk = nextChunk;
      } else {
        chapterDone = true;
      }
    }
    return {
      version: 1,
      bookId: getBookId(),
      format: getFormat(),
      storageKey: getStorageKey(),
      chapterTitle: getChapterTitle(),
      pageCurrent,
      pageTotal,
      readScope: currentReadScope,
      chunkIndex: safeIndex,
      chunksLength: currentChunks.length,
      paragraphIndex: chunk?.paragraphIndex ?? null,
      subIndex: chunk?.subIndex ?? 0,
      completedCurrentRange,
      chapterDone,
      preview: chunk?.preview || '',
      updatedAt: new Date().toISOString()
    };
  }
  function saveLastProgress(chunkIndex) {
    const progress = makeProgress(chunkIndex);
    if (!progress) return;
    const store = loadProgressStore();
    store.last = progress;
    saveProgressStore(store);
    refreshBookmarkSelect();
  }
  function saveCurrentBookmark() {
    if (!currentChunks.length) {
      refreshFullChapterChunks(false);
    }
    if (!currentChunks.length) {
      setStatus('沒有可儲存的位置');
      return;
    }
    const select = $('tm-tts-chunk-select');
    const selectedIndex = Number(select.value || currentIndex || 0);
    const progress = makeProgress(selectedIndex);
    if (!progress) return;
    progress.id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    progress.updatedAt = new Date().toISOString();
    const store = loadProgressStore();
    store.bookmarks.unshift(progress);
    store.bookmarks = store.bookmarks.slice(0, 80);
    saveProgressStore(store);
    refreshBookmarkSelect();
    setStatus(`已加入位置：全文第 ${progress.paragraphIndex + 1} 段`);
  }
  function clearProgress() {
    const store = loadProgressStore();
    store.last = null;
    store.bookmarks = [];
    saveProgressStore(store);
    refreshBookmarkSelect();
    setStatus('已清除本書朗讀紀錄，語音與語速設定保留');
  }
  function refreshBookmarkSelect() {
    const select = $('tm-tts-bookmark-select');
    if (!select) return;
    const store = loadProgressStore();
    select.innerHTML = '';
    if (store.last) {
      const option = document.createElement('option');
      option.value = 'last';
      option.textContent = formatProgressLabel('上次紀錄', store.last);
      select.appendChild(option);
    }
    for (const bookmark of store.bookmarks) {
      const option = document.createElement('option');
      option.value = bookmark.id;
      option.textContent = formatProgressLabel('位置', bookmark);
      select.appendChild(option);
    }
    if (!store.last && !store.bookmarks.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '沒有已存位置';
      select.appendChild(option);
    }
  }
  function formatProgressLabel(prefix, progress) {
    const page = progress.pageCurrent && progress.pageTotal
      ? `視覺頁 ${progress.pageCurrent}/${progress.pageTotal}`
      : '視覺頁 ?';
    const para = typeof progress.paragraphIndex === 'number'
      ? `全文第 ${progress.paragraphIndex + 1} 段`
      : '全文段落 ?';
    const title = progress.chapterTitle || '未命名章節';
    const preview = progress.preview ? `｜${progress.preview}` : '';
    return `${prefix}｜${page}｜${para}｜${title}${preview}`;
  }
  function getSelectedProgress() {
    const select = $('tm-tts-bookmark-select');
    if (!select || !select.value) return null;
    const store = loadProgressStore();
    if (select.value === 'last') return store.last;
    return store.bookmarks.find(item => item.id === select.value) || null;
  }
  function deleteSelectedBookmark() {
    const select = $('tm-tts-bookmark-select');
    if (!select || !select.value || select.value === 'last') {
      setStatus('上次紀錄不能用刪除位置移除；要移除請按清除紀錄');
      return;
    }
    const store = loadProgressStore();
    store.bookmarks = store.bookmarks.filter(item => item.id !== select.value);
    saveProgressStore(store);
    refreshBookmarkSelect();
    setStatus('已刪除位置');
  }
  function playSelectedBookmark() {
    const progress = getSelectedProgress();
    if (!progress) {
      setStatus('沒有可播放的位置');
      return;
    }
    playFromProgress(progress);
  }
  function playFromSavedProgress() {
    const store = loadProgressStore();
    if (!store.last) {
      setStatus('沒有上次紀錄');
      return;
    }
    playFromProgress(store.last);
  }
  function jumpToParagraphIndex(paragraphIndex) {
    if (typeof paragraphIndex !== 'number') return false;
    const paragraphs = getParagraphElements();
    const target = paragraphs.find(item => item.index === paragraphIndex);
    if (!target) return false;
    try {
      target.el.scrollIntoView({
        block: 'start',
        inline: 'nearest'
      });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  function playFromProgress(progress) {
    const nowTitle = getChapterTitle();
    if (
      progress.chapterTitle &&
      nowTitle &&
      progress.chapterTitle !== nowTitle
    ) {
      setStatus(
        `紀錄屬於「${progress.chapterTitle}」，目前是「${nowTitle}」。先切回該章節再播放。`
      );
      return;
    }
    const allChunks = extractAllParagraphChunks();
    if (!allChunks.length) {
      setStatus('目前章節沒有可朗讀文字');
      return;
    }
    if (typeof progress.paragraphIndex === 'number') {
      jumpToParagraphIndex(progress.paragraphIndex);
    }
    let index = allChunks.findIndex(chunk =>
      chunk.paragraphIndex === progress.paragraphIndex &&
      chunk.subIndex === progress.subIndex
    );
    if (index < 0 && typeof progress.paragraphIndex === 'number') {
      index = allChunks.findIndex(chunk =>
        chunk.paragraphIndex >= progress.paragraphIndex
      );
    }
    if (index < 0) index = 0;
    currentChunks = allChunks;
    currentIndex = index;
    currentReadScope = 'chapter';
    populateChunkSelect();
    readFromIndex(index);
  }
  function readFromIndex(index) {
    if (!currentChunks.length) {
      refreshFullChapterChunks(false);
    }
    if (!currentChunks.length) {
      setStatus('沒有可朗讀文字');
      return;
    }
    turnPageToken++; // 讓先前殘留的「等待翻頁」流程失效
    speakToken++;
    speechSynthesis.cancel();
    claimActiveReader(); // 通知其他分頁：本分頁要開始朗讀了，請自動停止避免聲音重疊
    currentIndex = Math.max(0, Math.min(index, currentChunks.length - 1));
    isReading = true;
    isPaused = false;
    saveLastProgress(currentIndex);
    updateChunkSelectValue();
    const chunk = currentChunks[currentIndex];
    setStatus(`從全文第 ${chunk.paragraphIndex + 1} 段開始朗讀`);
    speakNextChunk();
  }
  // 「念哪一段」跟「要不要翻頁」分開處理：
  // - 念的內容永遠依照 currentChunks（整章段落清單）依序往下走，不會因為翻頁而重抓/歸零。
  // - 翻頁只是為了讓畫面跟上朗讀進度：發現目前要念的這段不在畫面上，才點下一頁同步畫面，
  //   文字本身已經在 currentChunks 裡了，翻頁完就直接照樣念，不會重新抓取或改變進度。
  function speakNextChunk() {
    if (!isReading) return;
    const token = ++speakToken;
    if (currentIndex >= currentChunks.length) {
      // 整章 currentChunks 真的念完了，這才是要換下一章節的時機
      if (autoTurnPage) {
        attemptChapterAdvance();
      } else {
        isReading = false;
        saveLastProgress(currentIndex);
        setStatus('章節朗讀完成');
      }
      return;
    }
    const chunk = currentChunks[currentIndex];
    if (autoTurnPage && chunk.el && !isElementVisibleInIframeViewport(chunk.el)) {
      // 這段文字目前不在畫面上，先翻頁跟上（不重抓內容、不動 currentIndex）
      ensureChunkVisibleThenSpeak(token, chunk, 0);
      return;
    }
    speakChunk(token, chunk);
  }
  const MAX_VISIBILITY_SYNC_TURNS = 15; // 為了讓畫面跟上朗讀進度，最多連續翻幾次頁
  function ensureChunkVisibleThenSpeak(token, chunk, turnAttempts) {
    if (token !== speakToken || !isReading) return;
    if (isElementVisibleInIframeViewport(chunk.el)) {
      speakChunk(token, chunk);
      return;
    }
    if (turnAttempts >= MAX_VISIBILITY_SYNC_TURNS) {
      // 翻了很多次畫面還是對不上（少見的例外狀況），放棄同步畫面，文字內容一樣照念
      speakChunk(token, chunk);
      return;
    }
    const btn = getNextPageButton();
    if (!btn || isNextPageButtonDisabled(btn)) {
      // 沒有下一頁按鈕可以同步畫面了，直接照樣念文字
      speakChunk(token, chunk);
      return;
    }
    setStatus('翻頁跟上朗讀進度中…');
    ownTriggeredTurn = true;
    btn.click();
    setTimeout(() => ensureChunkVisibleThenSpeak(token, chunk, turnAttempts + 1), 350);
  }
  function speakChunk(token, chunk) {
    updateChunkSelectValue();
    const utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.rate = selectedRate;
    utterance.pitch = 1;
    utterance.volume = 1;
    const voice = getSelectedVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang || 'zh-TW';
    } else {
      utterance.lang = 'zh-TW';
    }
    utterance.onstart = () => {
      if (token !== speakToken) return;
      const sub =
        chunk.subCount > 1
          ? `-${chunk.subIndex + 1}/${chunk.subCount}`
          : '';
      setStatus(
        `朗讀中：全文第 ${chunk.paragraphIndex + 1} 段${sub}，片段 ${currentIndex + 1}/${currentChunks.length}，語速 ${selectedRate.toFixed(1)}`
      );
    };
    utterance.onend = () => {
      if (token !== speakToken) return;
      currentIndex++;
      saveLastProgress(currentIndex);
      speakNextChunk();
    };
    utterance.onerror = () => {
      if (token !== speakToken) return;
      currentIndex++;
      saveLastProgress(currentIndex);
      speakNextChunk();
    };
    speechSynthesis.speak(utterance);
  }
  function pauseReading() {
    if (!isReading) return;
    speechSynthesis.pause();
    isPaused = true;
    saveLastProgress(currentIndex);
    setStatus(`已暫停：片段 ${currentIndex + 1}/${currentChunks.length}`);
  }
  function resumeReading() {
    if (!isReading || !isPaused) return;
    claimActiveReader(); // 恢復朗讀前也廣播一次，避免跟其他分頁同時發聲
    speechSynthesis.resume();
    isPaused = false;
    setStatus(`繼續朗讀：片段 ${currentIndex + 1}/${currentChunks.length}`);
  }
  function stopReading() {
    if (currentChunks.length) {
      saveLastProgress(currentIndex);
    }
    isReading = false;
    isPaused = false;
    speakToken++;
    turnPageToken++; // 中止任何正在等待翻頁完成的流程
    speechSynthesis.cancel();
    setStatus('已停止，已保存目前位置');
  }
  // TTS 面板僅在 EPUB 文字格式（viewer/08）顯示與啟動，其他格式不受影響
  function isTtsSupportedPage() {
    return /^\/viewer\/08(\/|$)/.test(location.pathname);
  }
  // @run-at 改成 document-start 後，body 可能還不存在，等 body 準備好再啟動面板
  function startTts() {
    if (!isTtsSupportedPage()) return;
    if (document.body) {
      init();
    } else {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    }
  }
  startTts();
})();