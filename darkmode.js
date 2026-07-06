/*
 * HamiBook 朗讀 + 夜間模式（Chrome 擴充 content script，MV3）
 * 生效網址 / 執行時機 / 只在頂層執行 等設定，改由 manifest.json 宣告。
 *
 * 原始功能：HamiBook 可見範圍中文朗讀（語速上限 1.5，播完自動翻頁接續）
 *          + 全文章節段落進度紀錄 + UI 黑夜模式（已修正切章節偶爾全黑的問題）
 */

/*
 * 合併說明（2026-07-06）：
 * 註：以下 0.x 版本號為 Tampermonkey 使用者腳本時期的更新軌跡（原標為 v1.x，
 *     改寫為 Chrome 擴充後重新編為 0.x）；擴充版首發為 1.0.0。完整紀錄見 CHANGELOG.md。
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
 * 4.（0.1.0）新增「播完自動翻頁並接續朗讀」：可見範圍或整章讀完時，會自動點擊下一頁
 *    按鈕（猜測 class 為 .btn-block-next，來源是黑夜模式腳本裡出現過的同名 class），
 *    等頁面內容確認變更後，重新抓取段落並接續播放。找不到按鈕或翻頁逾時（6 秒）就會
 *    停止朗讀並顯示狀態訊息。可用面板上的核取方塊關閉，或在主控台呼叫
 *    hamiTts.status() 確認按鈕有沒有被正確抓到。
 * 5.（0.2.0）修正黑夜模式切換章節後偶爾全黑看不到字：原因是內文所在的 iframe
 *    在切章節時會整個換成新 document，舊 document 裡注入的樣式與 class 一起消失，
 *    但外層背景已經是黑的，導致「黑底 + 新 iframe 尚未上色的原生黑字」重疊在一起。
 *    改用 MutationObserver 持續監看新出現的 iframe，並在其 load 事件重新套用
 *    樣式，不再只靠頁面剛載入時的 8 秒 interval。
 * 6.（0.2.1）修正下一頁按鈕選擇器：使用者確認實際結構是
 *    <div class="next-block"><a title="下一頁" class="btn next"></a></div>，
 *    改用 .next-block .btn.next 優先比對，原本猜測的 .btn-block-next 保留作為備援。
 * 7.（0.3.0）修正自動翻頁的兩個問題：
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
 * 8.（0.4.0）架構重寫：「念什麼」跟「要不要翻頁」完全分開。
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
 * 9.（0.5.0）UI 調整：
 *    (a) 面板加上 resize: both + overflow: auto，右下角可以拖曳縮放視窗大小。
 *    (b) 「段落」「已存位置」改用原生 <details>/<summary>，預設收合，點一下才展開，
 *        平常畫面比較乾淨，需要時再點開選擇。
 * 10.（0.6.0）面板右下角的縮放把手跟黑夜模式切換鈕（固定在 right:16px/bottom:16px）
 *     位置太近，會互相干擾。這次調整：
 *     (a) 展開時面板整體上移到 bottom: 76px，讓縮放把手離按鈕遠一點，不會搶滑鼠事件。
 *     (b) 新增整個面板的收合/展開按鈕（標題列右邊的「－」）。收合後面板會變成跟黑夜
 *         模式按鈕一樣大小的圓形小按鈕，固定放在它左邊（right: 72px/bottom: 16px），
 *         不會重疊。收合狀態會記住，下次開啟頁面維持上次的選擇。
 * 11.（0.6.1）收合後的「讀」圓形按鈕，樣式直接比照黑夜模式切換鈕（同樣的邊框顏色、
 *     陰影、字體大小/粗細），視覺上跟「日/夜」按鈕一樣大，不會看起來比較小。
 * 12.（0.7.0）修正多分頁同時朗讀會混在一起的問題：
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
