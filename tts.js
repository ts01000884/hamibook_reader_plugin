/*
 * HamiBook 朗讀 + 全文段落進度紀錄（Chrome 擴充 content script，MV3）
 * 與 darkmode.js 同屬本擴充，於 manifest.json 依序載入；兩模組各自為獨立 IIFE，不共用變數。
 * 完整更新軌跡與設計說明見 CHANGELOG.md 與 darkmode.js 檔首註解。
 */

/* ============================================================
 * 模組 B：TTS 朗讀 + 全文段落進度紀錄
 * 語速上限鎖定 1.5；且僅在 EPUB 文字格式 (viewer/08) 啟用面板
 * ============================================================ */
(function () {
  'use strict';
  const STORAGE_PREFIX = 'hamibook_tts_progress';
  const TTS_SETTINGS_KEY = 'tm_tts_global_settings';
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
  let selectedEngine = 'browser';
  let selectedExternalVoice = '';
  let externalVoices = [];
  let ttsDataDisclosureAccepted = false;
  const CHINESE_EXTERNAL_VOICE_NAMES = Object.freeze({
    zf_xiaobei: '曉北',
    zf_xiaoni: '曉妮',
    zf_xiaoxiao: '曉曉',
    zf_xiaoyi: '曉伊',
    zm_yunjian: '雲健',
    zm_yunxi: '雲希',
    zm_yunxia: '雲夏',
    zm_yunyang: '雲揚'
  });
  let extensionSettingsLoaded = false;
  let speakToken = 0;
  let lastVisibleSignature = '';
  let refreshTimer = null;
  let autoTurnPage = true; // 播完自動翻頁並接續朗讀（可見範圍結束 / 章節結束皆適用）
  let turnPageToken = 0; // 用來讓「等待翻頁完成」的流程在使用者按停止/重新播放時失效
  let ownTriggeredTurn = false; // 標記「這次翻頁是我們自己點的」，避免跟舊的手動翻頁監聽互相打架
  // 使用者暫停時可能自己翻了頁；繼續時若發現正在念的這段已不在畫面上，就設此旗標，
  // 讓接下來只照 index 往下念、不再自動翻頁「追」畫面（往下翻也找不到使用者翻去的位置）。
  // 換章或使用者重新按停止/播放時會重置。
  let suppressViewSync = false;
  const PANEL_COLLAPSED_KEY = 'tm_tts_panel_collapsed';
  let panelCollapsed = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1'; // 面板收合狀態，記住使用者上次的選擇
  // 正在朗讀的段落會被加上這個 class 顯示粗體，讓使用者一眼看出「現在念到哪裡」。
  // 樣式注入在內文 iframe 的 document 裡（段落 DOM 就在那個 document）。
  const HIGHLIGHT_CLASS = 'tm-tts-reading-para';
  const HIGHLIGHT_STYLE_ID = 'tm-tts-reading-para-style';
  let currentHighlightEl = null; // 目前被標記粗體的段落元素，換段/停止時用來還原
  let currentRemoteAudio = null;
  let currentRemoteAudioUrl = '';
  let preparedRemotePlayback = null;
  let remotePrefetch = null;
  const activeRemoteRequestIds = new Set();
  const bridgePending = new Map();
  let bridgeSequence = 0;

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || !message || message.source !== 'hamibook-tts-bridge') return;
    if (message.event === 'settingsChanged') {
      applyExtensionSettings(message.settings);
      return;
    }
    const pending = bridgePending.get(message.bridgeRequestId);
    if (!pending) return;
    bridgePending.delete(message.bridgeRequestId);
    clearTimeout(pending.timeout);
    if (message.response?.ok) pending.resolve(message.response.data);
    else pending.reject(new Error(message.response?.error || '擴充套件橋接失敗'));
  });

  function bridgeRequest(type, payload = {}, timeoutMs = 65000) {
    const bridgeRequestId = `bridge_${Date.now()}_${++bridgeSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bridgePending.delete(bridgeRequestId);
        reject(new Error('擴充套件橋接逾時'));
      }, timeoutMs);
      bridgePending.set(bridgeRequestId, { resolve, reject, timeout });
      window.postMessage({
        source: 'hamibook-tts-main',
        bridgeRequestId,
        type,
        ...payload
      }, '*');
    });
  }

  function openExtensionOptions() {
    window.postMessage({ source: 'hamibook-tts-main', type: 'HAMI_TTS_OPEN_OPTIONS' }, '*');
  }
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
    loadExtensionSettings();
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
      loadExtensionSettings();
      refreshFullChapterChunks(true);
      refreshBookmarkSelect();
      attachPageWatchers();
    }, 800);
    setTimeout(() => {
      applyStoredSettingsToUI();
      loadExtensionSettings();
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
          engine: selectedEngine,
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
    injectPanelStyle();
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
          <div class="tm-tts-main-controls">
            <button id="tm-tts-playpause" class="tm-tts-control-btn tm-btn-primary" data-state="stopped">▶ 播放</button>
            <button id="tm-tts-stop" class="tm-tts-control-btn tm-btn-secondary">停止</button>
          </div>
          <details class="tm-tts-more-options">
            <summary>更多播放選項</summary>
            <div class="tm-tts-option-grid">
              <button id="tm-tts-play-visible" class="tm-tts-control-btn">從目前畫面開始播放</button>
              <button id="tm-tts-play-saved" class="tm-tts-control-btn">從上次紀錄播放</button>
              <button id="tm-tts-refresh-visible" class="tm-tts-control-btn">更新段落清單</button>
            </div>
          </details>
          <div style="margin-top: 8px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px;">
              <span>朗讀引擎</span>
              <button id="tm-tts-open-settings" class="tm-tts-link-btn" type="button">TTS 伺服器設定</button>
            </div>
            <select id="tm-tts-engine" style="width: 100%;">
              <option value="browser">瀏覽器內建語音</option>
              <option value="openai">TTS 伺服器（本機／外部）</option>
            </select>
          </div>
          <div style="margin-top: 8px;">
            <div id="tm-tts-voice-label" style="margin-bottom: 4px;">中文語音</div>
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
          <details class="tm-tts-more-options">
            <summary>段落與位置管理</summary>
            <div class="tm-tts-manage-body">
              <div class="tm-tts-manage-label">段落</div>
              <select id="tm-tts-chunk-select"></select>
              <div class="tm-tts-manage-row">
                <button id="tm-tts-play-selected" class="tm-tts-control-btn">播放選取段落</button>
                <button id="tm-tts-save-bookmark" class="tm-tts-control-btn">加入位置</button>
              </div>
              <div class="tm-tts-manage-label">已存位置</div>
              <select id="tm-tts-bookmark-select"></select>
              <div class="tm-tts-manage-row">
                <button id="tm-tts-play-bookmark" class="tm-tts-control-btn">播放已存位置</button>
                <button id="tm-tts-delete-bookmark" class="tm-tts-control-btn">刪除位置</button>
                <button id="tm-tts-clear-progress" class="tm-tts-control-btn">清除紀錄</button>
              </div>
            </div>
          </details>
          <div id="tm-tts-status" style="margin-top: 8px; opacity: 0.88; line-height: 1.45;">待命</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    $('tm-tts-playpause').addEventListener('click', togglePlayPause);
    $('tm-tts-play-visible').addEventListener('click', () => {
      // 抓整章段落清單，但從「目前畫面上看得到的那一段」開始播，而不是整章從頭
      const chunks = refreshFullChapterChunks(true);
      readFromIndex(findFirstVisibleChunkIndex(chunks));
    });
    $('tm-tts-play-saved').addEventListener('click', playFromSavedProgress);
    $('tm-tts-refresh-visible').addEventListener('click', () => {
      refreshFullChapterChunks(true);
    });
    $('tm-tts-stop').addEventListener('click', stopReading);
    $('tm-tts-open-settings').addEventListener('click', openExtensionOptions);
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
      clearRemotePrefetch(true);
      saveSettings();
      if (isReading && !isPaused) {
        setStatus(`語速已改為 ${selectedRate.toFixed(1)}，下一段生效`);
      }
    });
    const engineSelect = $('tm-tts-engine');
    engineSelect.addEventListener('change', () => {
      const nextEngine = engineSelect.value === 'openai' ? 'openai' : 'browser';
      if (nextEngine === 'openai' && (!externalVoices.length || !ttsDataDisclosureAccepted)) {
        engineSelect.value = selectedEngine;
        setStatus('尚未完成 TTS 伺服器設定與文字傳送說明確認');
        openExtensionOptions();
        return;
      }
      if (isReading) stopReading();
      selectedEngine = nextEngine;
      populateVoiceSelect();
      saveSettings();
      setStatus(selectedEngine === 'openai' ? '已切換為 TTS 伺服器' : '已切換為瀏覽器內建語音');
    });
    const voiceSelect = $('tm-tts-voice');
    voiceSelect.addEventListener('change', () => {
      if (selectedEngine === 'openai') selectedExternalVoice = voiceSelect.value;
      else selectedVoiceURI = voiceSelect.value;
      clearRemotePrefetch(true);
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
    updatePlayPauseButton();
    applyPanelCollapsedState();
  }
  function injectPanelStyle() {
    if ($('tm-tts-panel-style')) return;
    const style = document.createElement('style');
    style.id = 'tm-tts-panel-style';
    style.textContent = `
      #tm-tts-panel .tm-tts-main-controls {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        margin-bottom: 8px;
      }
      #tm-tts-panel .tm-tts-control-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.24);
        border-radius: 999px;
        background: rgba(255,255,255,0.1);
        color: #fff;
        cursor: pointer;
        font: 600 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        min-height: 34px;
        padding: 8px 12px;
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
        white-space: nowrap;
      }
      #tm-tts-panel .tm-tts-control-btn:hover {
        background: rgba(255,255,255,0.18);
        border-color: rgba(255,255,255,0.42);
        transform: translateY(-1px);
      }
      #tm-tts-panel .tm-tts-control-btn:active {
        transform: translateY(0);
      }
      #tm-tts-panel .tm-btn-primary {
        min-height: 40px;
        background: #2f80ed;
        border-color: rgba(255,255,255,0.28);
        box-shadow: 0 6px 18px rgba(47,128,237,0.28);
        font-size: 15px;
      }
      #tm-tts-panel .tm-btn-primary:hover {
        background: #4b95f2;
        box-shadow: 0 8px 20px rgba(47,128,237,0.36);
      }
      #tm-tts-panel .tm-btn-secondary {
        min-width: 74px;
      }
      #tm-tts-panel .tm-tts-link-btn {
        appearance: none;
        border: 0;
        background: transparent;
        color: #8ec1ff;
        cursor: pointer;
        font: 600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 2px 0;
      }
      #tm-tts-panel .tm-tts-link-btn:hover {
        color: #c4e0ff;
        text-decoration: underline;
      }
      #tm-tts-panel .tm-tts-more-options {
        margin: 0 0 8px 0;
        border-top: 1px solid rgba(255,255,255,0.12);
        border-bottom: 1px solid rgba(255,255,255,0.12);
        padding: 7px 0;
      }
      #tm-tts-panel .tm-tts-more-options summary {
        cursor: pointer;
        user-select: none;
        color: rgba(255,255,255,0.88);
        font-weight: 600;
      }
      #tm-tts-panel .tm-tts-option-grid {
        display: grid;
        gap: 6px;
        margin-top: 8px;
      }
      #tm-tts-panel .tm-tts-option-grid .tm-tts-control-btn {
        width: 100%;
        text-align: left;
      }
      #tm-tts-panel .tm-tts-manage-body {
        display: grid;
        gap: 8px;
        margin-top: 8px;
      }
      #tm-tts-panel .tm-tts-manage-label {
        color: rgba(255,255,255,0.72);
        font-size: 12px;
        font-weight: 600;
      }
      #tm-tts-panel .tm-tts-manage-body select {
        width: 100%;
      }
      #tm-tts-panel .tm-tts-manage-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      @media (max-width: 420px) {
        #tm-tts-panel .tm-tts-main-controls {
          grid-template-columns: 1fr;
        }
        #tm-tts-panel .tm-btn-secondary {
          min-width: 0;
        }
      }
    `;
    document.head.appendChild(style);
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
    updatePlayPauseButton();
  }
  function updatePlayPauseButton() {
    const button = $('tm-tts-playpause');
    if (!button) return;
    if (isReading && !isPaused) {
      button.textContent = '⏸ 暫停';
      button.title = '暫停朗讀';
      button.dataset.state = 'playing';
      return;
    }
    if (isReading && isPaused) {
      button.textContent = '▶ 繼續';
      button.title = '繼續朗讀';
      button.dataset.state = 'paused';
      return;
    }
    button.textContent = '▶ 播放';
    button.title = '開始朗讀';
    button.dataset.state = 'stopped';
  }
  function togglePlayPause() {
    if (isReading) {
      if (isPaused) {
        resumeReading();
      } else {
        pauseReading();
      }
      return;
    }
    // 停止狀態下按播放：預設「從本頁開始」——抓整章段落，從目前畫面看得到的第一段念起。
    // 只有在「使用者沒有翻頁」（上次停下的那段目前還在畫面上）時，才精準地從記憶位置接續。
    // 否則同一章翻了幾頁再按播放又跳回舊位置，會導致「怎麼翻都到不了新頁」。
    const chunks = refreshFullChapterChunks(false);
    if (!chunks.length) {
      // 本章沒有可朗讀文字（新書封面/版權/目錄頁等）：自動往後翻找內文
      beginPlaybackFindingText();
      return;
    }
    const store = loadProgressStore();
    const rememberedIndex = findRememberedVisibleChunkIndex(chunks, store.last, getChapterTitle());
    if (rememberedIndex >= 0) {
      readFromIndex(rememberedIndex);          // 沒翻頁：從記憶位置精準接續
    } else {
      readFromIndex(findFirstVisibleChunkIndex(chunks)); // 有翻頁/無紀錄：從本頁開始
    }
  }
  // 判斷「使用者按停止後有沒有翻頁」：若上次停下那一段目前還在畫面可見範圍內，視為沒翻頁，
  // 回傳可精準接續的片段索引（優先 subIndex 完全相符）；否則回 -1，交給呼叫端改從本頁開始。
  function findRememberedVisibleChunkIndex(chunks, last, nowTitle) {
    if (!last || typeof last.paragraphIndex !== 'number') return -1;
    if (last.chapterTitle && nowTitle && last.chapterTitle !== nowTitle) return -1;
    const stillVisible = chunks.some(c =>
      c.paragraphIndex === last.paragraphIndex &&
      c.el && isElementVisibleInIframeViewport(c.el)
    );
    if (!stillVisible) return -1;
    let idx = chunks.findIndex(c =>
      c.paragraphIndex === last.paragraphIndex && c.subIndex === last.subIndex
    );
    if (idx < 0) idx = chunks.findIndex(c => c.paragraphIndex === last.paragraphIndex);
    return idx;
  }
  // 按下播放但目前章節沒有可朗讀文字時（新書開頭常是封面/版權/目錄頁），
  // 自動往後翻頁/翻章尋找內容，找到有文字的地方才開始念；翻到底或翻太多次仍沒有就停。
  const MAX_START_SKIP_PAGES = 15;    // 開頭最多往後翻幾頁尋找文字
  const START_SKIP_SETTLE_MS = 300;   // 每次翻頁後先等一下讓畫面渲染再判斷
  const START_SKIP_POLL_MS = 350;     // 等待翻頁生效的輪詢間隔
  const START_SKIP_TIMEOUT_MS = 6000; // 單次翻頁等待內容變化的逾時
  function beginPlaybackFindingText() {
    const chunks = refreshFullChapterChunks(false);
    if (chunks.length) {
      readFromIndex(findFirstVisibleChunkIndex(chunks));
      return;
    }
    // 用 turnPageToken 當這個尋找流程的識別；按停止或再次觸發播放都會遞增它而自動取消本流程
    const token = ++turnPageToken;
    setStatus('目前章節沒有可朗讀文字，自動往後尋找內容…');
    setTimeout(() => skipEmptyPagesThenPlay(0, token), START_SKIP_SETTLE_MS);
  }
  function skipEmptyPagesThenPlay(attempts, token) {
    if (token !== turnPageToken) return; // 已被停止或其他播放動作取消
    const chunks = extractAllParagraphChunks();
    if (chunks.length) {
      currentChunks = chunks;
      currentReadScope = 'chapter';
      lastVisibleSignature = getChunksSignature(chunks);
      populateChunkSelect();
      readFromIndex(findFirstVisibleChunkIndex(chunks));
      return;
    }
    if (attempts >= MAX_START_SKIP_PAGES) {
      setStatus('往後翻了多頁仍找不到可朗讀文字，已停止');
      return;
    }
    const btn = getNextPageButton();
    if (!btn || isNextPageButtonDisabled(btn)) {
      setStatus('目前沒有可朗讀文字，且已到最後一頁');
      return;
    }
    setStatus(`目前頁面沒有文字，自動翻頁尋找內容中…（第 ${attempts + 1} 次）`);
    const beforeSignature = getCurrentContentSignature();
    ownTriggeredTurn = true; // 這是我們自己點的翻頁，別讓 iframe load 監聽介入
    btn.click();
    waitForStartPageSettle(token, attempts, beforeSignature, 0);
  }
  function waitForStartPageSettle(token, attempts, beforeSignature, elapsedMs) {
    if (token !== turnPageToken) return;
    const changed = getCurrentContentSignature() !== beforeSignature;
    if (changed) {
      // 內容（頁碼/段落）已變，再多等一下讓文字渲染完再判斷有沒有可念的內容
      setTimeout(() => skipEmptyPagesThenPlay(attempts + 1, token), START_SKIP_SETTLE_MS);
      return;
    }
    if (elapsedMs >= START_SKIP_TIMEOUT_MS) {
      // 翻頁後內容遲遲沒變（可能翻不動），仍再判斷一次，交給下一輪決定要不要繼續
      skipEmptyPagesThenPlay(attempts + 1, token);
      return;
    }
    setTimeout(
      () => waitForStartPageSettle(token, attempts, beforeSignature, elapsedMs + START_SKIP_POLL_MS),
      START_SKIP_POLL_MS
    );
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
      bookmarks: []
    };
  }
  function loadProgressStore() {
    const key = getStorageKey();
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return createEmptyStore();
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        last: parsed.last || null,
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : []
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
      bookmarks: Array.isArray(store.bookmarks) ? store.bookmarks : []
    }));
  }
  function saveSettings() {
    saveGlobalSettings();
  }
  function applyStoredSettingsToUI() {
    if (!extensionSettingsLoaded) {
      const settings = loadGlobalSettings();
      selectedRate = settings.rate;
      selectedVoiceURI = settings.voiceURI;
      autoTurnPage = settings.autoTurnPage;
    }
    const rateInput = $('tm-tts-rate');
    const rateValue = $('tm-tts-rate-value');
    if (rateInput) rateInput.value = String(selectedRate);
    if (rateValue) rateValue.textContent = selectedRate.toFixed(1);
    const autoTurnCheckbox = $('tm-tts-auto-turn');
    if (autoTurnCheckbox) autoTurnCheckbox.checked = autoTurnPage;
    const engineSelect = $('tm-tts-engine');
    if (engineSelect) engineSelect.value = selectedEngine;
    populateVoiceSelect();
  }

  function normalizeExternalVoices(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map(item => {
        const id = typeof item === 'string' ? item : item?.id;
        const voiceKey = typeof id === 'string' ? id.trim().toLowerCase() : '';
        return {
          id: typeof id === 'string' ? id.trim() : '',
          name: CHINESE_EXTERNAL_VOICE_NAMES[voiceKey] ||
            (typeof item?.name === 'string' ? item.name : id)
        };
      })
      .filter(item => item.id && /^(?:zf|zm)_/i.test(item.id));
  }

  function applyExtensionSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    const nextEngine = settings.engine === 'openai' ? 'openai' : 'browser';
    const engineChanged = extensionSettingsLoaded && nextEngine !== selectedEngine;
    selectedEngine = nextEngine;
    selectedRate = clampRate(Number(settings.rate));
    selectedVoiceURI = typeof settings.browserVoiceURI === 'string' ? settings.browserVoiceURI : selectedVoiceURI;
    selectedExternalVoice = typeof settings.externalVoice === 'string' ? settings.externalVoice : '';
    externalVoices = normalizeExternalVoices(settings.externalVoices);
    ttsDataDisclosureAccepted = settings.dataDisclosureAccepted === true;
    autoTurnPage = settings.autoTurnPage !== undefined ? !!settings.autoTurnPage : autoTurnPage;
    extensionSettingsLoaded = true;
    if (engineChanged && isReading) stopReading();
    applyStoredSettingsToUI();
    if (selectedEngine === 'openai' && (!externalVoices.length || !ttsDataDisclosureAccepted)) {
      setStatus('TTS 伺服器尚未完成設定，請開啟伺服器設定');
    }
  }

  async function loadExtensionSettings() {
    const legacy = loadGlobalSettings();
    try {
      const settings = await bridgeRequest('HAMI_TTS_GET_SETTINGS', { legacy }, 8000);
      applyExtensionSettings(settings);
    } catch (error) {
      console.warn('[HamiBook TTS] 無法讀取擴充設定，沿用瀏覽器語音', error);
    }
  }
  function getDefaultGlobalSettings() {
    return {
      rate: 1,
      voiceURI: '',
      autoTurnPage: true
    };
  }
  function normalizeGlobalSettings(settings) {
    const defaults = getDefaultGlobalSettings();
    const rate = Number(settings?.rate);
    return {
      rate: clampRate(Number.isNaN(rate) ? defaults.rate : rate),
      voiceURI:
        typeof settings?.voiceURI === 'string'
          ? settings.voiceURI
          : defaults.voiceURI,
      autoTurnPage:
        settings?.autoTurnPage !== undefined
          ? !!settings.autoTurnPage
          : defaults.autoTurnPage
    };
  }
  function loadLegacyBookSettings() {
    try {
      const raw = window.localStorage.getItem(getStorageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.settings !== 'object') return null;
      return parsed.settings;
    } catch (e) {
      console.error(e);
      return null;
    }
  }
  function loadGlobalSettings() {
    try {
      const raw = window.localStorage.getItem(TTS_SETTINGS_KEY);
      if (raw) {
        return normalizeGlobalSettings(JSON.parse(raw));
      }
      // 書本 id 早期可能還是 unknown_book，此時讀不到舊設定；沒有可遷移的舊值就先回傳預設、
      // 不要把預設寫進全域 key，否則會擋掉稍後（書本載入好）真正的一次性遷移。
      const legacy = loadLegacyBookSettings();
      const migrated = normalizeGlobalSettings(legacy);
      if (legacy) {
        window.localStorage.setItem(TTS_SETTINGS_KEY, JSON.stringify(migrated));
      }
      return migrated;
    } catch (e) {
      console.error(e);
      return getDefaultGlobalSettings();
    }
  }
  function saveGlobalSettings() {
    const settings = normalizeGlobalSettings({
      rate: selectedRate,
      voiceURI: selectedVoiceURI,
      autoTurnPage
    });
    window.localStorage.setItem(TTS_SETTINGS_KEY, JSON.stringify(settings));
    bridgeRequest('HAMI_TTS_UPDATE_PLAYBACK_SETTINGS', {
      patch: {
        engine: selectedEngine,
        browserVoiceURI: selectedVoiceURI,
        externalVoice: selectedExternalVoice,
        rate: selectedRate,
        autoTurnPage
      }
    }, 8000).catch(error => console.warn('[HamiBook TTS] 儲存擴充設定失敗', error));
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
      clearReadingHighlight();
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
        clearReadingHighlight();
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
        clearReadingHighlight();
        setStatus('切換章節後找不到文字，已停止，請手動確認');
        return;
      }
      setTimeout(() => waitForChapterChangeAndContinue(token, afterSignature, 0, emptyRetries + 1), POLL_INTERVAL);
      return;
    }
    currentChunks = chunks;
    currentIndex = 0;
    currentReadScope = 'chapter';
    suppressViewSync = false; // 新章節恢復正常的翻頁追畫面
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
    const label = $('tm-tts-voice-label');
    const engineSelect = $('tm-tts-engine');
    if (engineSelect) engineSelect.value = selectedEngine;
    if (selectedEngine === 'openai') {
      if (label) label.textContent = '伺服器語音';
      voiceSelect.innerHTML = '';
      if (!externalVoices.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '請先設定並測試 TTS 伺服器';
        voiceSelect.appendChild(option);
        voiceSelect.disabled = true;
        selectedExternalVoice = '';
        return;
      }
      voiceSelect.disabled = false;
      for (const voice of externalVoices) {
        const option = document.createElement('option');
        option.value = voice.id;
        option.textContent = voice.name && voice.name !== voice.id ? `${voice.name} (${voice.id})` : voice.id;
        voiceSelect.appendChild(option);
      }
      if (!externalVoices.some(voice => voice.id === selectedExternalVoice)) {
        selectedExternalVoice = externalVoices[0].id;
      }
      voiceSelect.value = selectedExternalVoice;
      return;
    }
    if (label) label.textContent = '中文語音';
    voiceSelect.disabled = false;
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
    hardCancelSpeech();
    claimActiveReader(); // 通知其他分頁：本分頁要開始朗讀了，請自動停止避免聲音重疊
    currentIndex = Math.max(0, Math.min(index, currentChunks.length - 1));
    isReading = true;
    isPaused = false;
    suppressViewSync = false; // 全新播放：恢復正常的翻頁追畫面
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
        clearReadingHighlight();
        saveLastProgress(currentIndex);
        setStatus('章節朗讀完成');
      }
      return;
    }
    const chunk = currentChunks[currentIndex];
    if (autoTurnPage && !suppressViewSync && chunk.el && !isElementVisibleInIframeViewport(chunk.el)) {
      // 這段文字目前不在畫面上，先翻頁跟上（不重抓內容、不動 currentIndex）
      ensureChunkVisibleThenSpeak(token, chunk, 0);
      return;
    }
    speakChunk(token, chunk);
  }
  // 自己觸發的翻頁只是為了「讓畫面追上正在念的這一段」。因為進度是照 currentChunks 一段段往下走、
  // 不是使用者自己跳片段，所以要念的這段通常就在下一頁、頂多下下頁（中間偶爾夾一頁純圖片）。
  // 因此上限壓得很小，避免因為「點完馬上又判斷成看不到」而狂點下一頁。
  const MAX_VISIBILITY_SYNC_TURNS = 3;
  // 每次點下一頁後，等頁面渲染 / 捲動穩定下來再判斷是否要再翻，翻太快才會出現「瘋狂下一頁」。
  const PAGE_TURN_SETTLE_MS = 900;
  function ensureChunkVisibleThenSpeak(token, chunk, turnAttempts) {
    if (token !== speakToken || !isReading) return;
    if (isElementVisibleInIframeViewport(chunk.el)) {
      speakChunk(token, chunk);
      return;
    }
    const btn = getNextPageButton();
    if (turnAttempts >= MAX_VISIBILITY_SYNC_TURNS || !btn || isNextPageButtonDisabled(btn)) {
      // 翻了 2~3 次還是對不上（可能中間夾圖片，或翻頁後 DOM 重排讓舊的 chunk.el 失效），
      // 不再繼續翻頁，改成「重新抓整章段落 + 依內容重新定位這一段 + 重播這一段」。
      relocateAndReplayChunk(token, chunk);
      return;
    }
    setStatus('翻頁跟上朗讀進度中…');
    ownTriggeredTurn = true;
    btn.click();
    setTimeout(() => ensureChunkVisibleThenSpeak(token, chunk, turnAttempts + 1), PAGE_TURN_SETTLE_MS);
  }
  // 翻頁追不上時的保底：重新抓一次整章段落清單，用「原本這一段的內容」重新定位，
  // 更新 currentChunks / currentIndex 後直接重播這一段，不再繼續狂翻。
  function relocateAndReplayChunk(token, chunk) {
    if (token !== speakToken || !isReading) return;
    const chunks = extractAllParagraphChunks();
    if (chunks.length) {
      // 先用段落/片段索引比對；索引可能因重排改變時，退而用文字內容、再退而用開頭預覽比對
      let index = chunks.findIndex(c => sameChunk(c, chunk));
      if (index < 0) index = chunks.findIndex(c => c.text === chunk.text);
      if (index < 0 && chunk.preview) index = chunks.findIndex(c => c.preview === chunk.preview);
      if (index >= 0) {
        currentChunks = chunks;
        currentIndex = index;
        lastVisibleSignature = getChunksSignature(chunks);
        populateChunkSelect();
        setStatus('翻頁追不上，已重新定位段落並重播本段');
        speakChunk(token, chunks[index]);
        return;
      }
    }
    // 連重新定位都找不到（極少見）：別卡住，直接照原本內容念這一段
    setStatus('翻頁追不上，直接朗讀本段');
    speakChunk(token, chunk);
  }
  // 在段落所在的 iframe document 裡注入「粗體高亮」樣式（只注入一次）。
  // 每次換章節 iframe 會換成新的 document，這裡用 doc.getElementById 判斷，確保新 document 也會補上。
  function injectHighlightStyle(doc) {
    if (!doc || !doc.head && !doc.documentElement) return;
    if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS}, .${HIGHLIGHT_CLASS} * {
        font-weight: 700 !important;
      }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  }
  // 清掉目前段落的粗體標記，還原成原本樣子
  function clearReadingHighlight() {
    if (currentHighlightEl) {
      try {
        currentHighlightEl.classList.remove(HIGHLIGHT_CLASS);
      } catch (e) {
        // 元素可能已隨章節切換被移除，忽略即可
      }
      currentHighlightEl = null;
    }
  }
  // 把「正在朗讀」的這一段標成粗體，同時清掉上一段的標記。
  // 同一段被拆成多個片段（subChunk）時 el 相同，重複標記也沒關係。
  function highlightReadingChunk(chunk) {
    clearReadingHighlight();
    const el = chunk?.el;
    if (!el) return;
    const doc = el.ownerDocument;
    if (!doc) return;
    injectHighlightStyle(doc);
    try {
      el.classList.add(HIGHLIGHT_CLASS);
      currentHighlightEl = el;
    } catch (e) {
      currentHighlightEl = null;
    }
  }

  function getRemoteRequestKey(chunk, index) {
    return [index, selectedExternalVoice, selectedRate.toFixed(1), chunk?.text || ''].join('|');
  }

  function createRemoteSynthesisRequest(chunk, index) {
    const requestId = `audio_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    activeRemoteRequestIds.add(requestId);
    const promise = bridgeRequest('HAMI_TTS_SYNTHESIZE', {
      requestId,
      text: chunk.text,
      rate: selectedRate
    }).finally(() => activeRemoteRequestIds.delete(requestId));
    promise.catch(() => {});
    return { requestId, index, key: getRemoteRequestKey(chunk, index), promise };
  }

  function clearRemotePrefetch(cancelRequest) {
    if (!remotePrefetch) return;
    if (cancelRequest && activeRemoteRequestIds.has(remotePrefetch.requestId)) {
      bridgeRequest('HAMI_TTS_CANCEL', { requestId: remotePrefetch.requestId }, 8000).catch(() => {});
    }
    remotePrefetch = null;
  }

  function queueRemotePrefetch(index) {
    clearRemotePrefetch(true);
    if (selectedEngine !== 'openai' || index >= currentChunks.length) return;
    remotePrefetch = createRemoteSynthesisRequest(currentChunks[index], index);
  }

  function takeRemoteRequest(chunk, index) {
    const key = getRemoteRequestKey(chunk, index);
    if (remotePrefetch?.key === key) {
      const request = remotePrefetch;
      remotePrefetch = null;
      return request;
    }
    clearRemotePrefetch(true);
    return createRemoteSynthesisRequest(chunk, index);
  }

  function revokeCurrentRemoteAudio() {
    if (currentRemoteAudio) {
      currentRemoteAudio.onplay = null;
      currentRemoteAudio.onended = null;
      currentRemoteAudio.onerror = null;
      currentRemoteAudio.pause();
      currentRemoteAudio.removeAttribute('src');
      currentRemoteAudio.load();
      currentRemoteAudio = null;
    }
    if (currentRemoteAudioUrl) {
      URL.revokeObjectURL(currentRemoteAudioUrl);
      currentRemoteAudioUrl = '';
    }
    preparedRemotePlayback = null;
  }

  function cancelAllRemoteRequests() {
    for (const requestId of activeRemoteRequestIds) {
      bridgeRequest('HAMI_TTS_CANCEL', { requestId }, 8000).catch(() => {});
    }
    activeRemoteRequestIds.clear();
    clearRemotePrefetch(false);
  }

  function audioFromBase64(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    currentRemoteAudioUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'audio/mpeg' }));
    return new Audio(currentRemoteAudioUrl);
  }

  function handleRemoteFailure(token, error) {
    if (token !== speakToken) return;
    isReading = false;
    isPaused = false;
    clearReadingHighlight();
    saveLastProgress(currentIndex);
    revokeCurrentRemoteAudio();
    clearRemotePrefetch(true);
    const message = error?.message || String(error || '未知錯誤');
    setStatus(`TTS 伺服器失敗，停在目前段落：${message}`);
  }

  async function playPreparedRemoteAudio(token, chunk, audio) {
    if (token !== speakToken || !isReading || isPaused) return;
    preparedRemotePlayback = null;
    try {
      await audio.play();
    } catch (error) {
      handleRemoteFailure(token, new Error(`瀏覽器無法播放遠端音訊：${error.message || error}`));
    }
  }

  async function speakRemoteChunk(token, chunk) {
    if (!selectedExternalVoice) {
      handleRemoteFailure(token, new Error('尚未選擇伺服器聲音'));
      return;
    }
    updateChunkSelectValue();
    setStatus(`正在合成片段 ${currentIndex + 1}/${currentChunks.length}…`);
    const request = takeRemoteRequest(chunk, currentIndex);
    try {
      const result = await request.promise;
      if (token !== speakToken || !isReading) return;
      revokeCurrentRemoteAudio();
      const audio = audioFromBase64(result.audioBase64, result.mimeType);
      currentRemoteAudio = audio;
      preparedRemotePlayback = { token, chunk, audio };
      let hasStarted = false;
      audio.onplay = () => {
        if (token !== speakToken) return;
        highlightReadingChunk(chunk);
        const sub = chunk.subCount > 1 ? `-${chunk.subIndex + 1}/${chunk.subCount}` : '';
        setStatus(
          `TTS 伺服器朗讀中：全文第 ${chunk.paragraphIndex + 1} 段${sub}，片段 ${currentIndex + 1}/${currentChunks.length}，語速 ${selectedRate.toFixed(1)}`
        );
        if (!hasStarted) {
          hasStarted = true;
          queueRemotePrefetch(currentIndex + 1);
        }
      };
      audio.onended = () => {
        if (token !== speakToken) return;
        revokeCurrentRemoteAudio();
        currentIndex++;
        saveLastProgress(currentIndex);
        speakNextChunk();
      };
      audio.onerror = () => handleRemoteFailure(token, new Error('遠端音訊解碼或播放失敗'));
      await playPreparedRemoteAudio(token, chunk, audio);
    } catch (error) {
      handleRemoteFailure(token, error);
    }
  }

  function speakChunk(token, chunk) {
    if (selectedEngine === 'openai') {
      speakRemoteChunk(token, chunk);
      return;
    }
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
      highlightReadingChunk(chunk); // 這一段開始出聲時才標粗體，跟實際語音同步
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
  // Chrome 地雷：在「暫停中」直接呼叫 speechSynthesis.cancel()，佇列不會真的清乾淨——
  // 引擎仍停在 paused 狀態，被暫停、念到一半的舊 utterance 會殘留在裡面，
  // 之後引擎一離開暫停狀態就突然把它吐出來念（使用者看到「停止後卻莫名開始念舊段落」）。
  // 正確順序：先 resume() 讓引擎離開暫停狀態，再 cancel() 才會真的清空佇列。
  function hardCancelSpeech() {
    try {
      if (speechSynthesis.paused) {
        speechSynthesis.resume();
      }
    } catch (e) {
      console.error(e);
    }
    speechSynthesis.cancel();
    cancelAllRemoteRequests();
    revokeCurrentRemoteAudio();
  }
  function pauseReading() {
    if (!isReading) return;
    if (selectedEngine === 'openai') currentRemoteAudio?.pause();
    else speechSynthesis.pause();
    isPaused = true;
    saveLastProgress(currentIndex);
    setStatus(`已暫停：片段 ${currentIndex + 1}/${currentChunks.length}`);
  }
  function resumeReading() {
    if (!isReading || !isPaused) return;
    claimActiveReader(); // 恢復朗讀前也廣播一次，避免跟其他分頁同時發聲
    // 暫停期間使用者可能自己翻頁：若正在念的這段已不在畫面上，繼續時就別再自動翻頁追畫面
    const resumingChunk = currentChunks[currentIndex];
    if (resumingChunk && resumingChunk.el && !isElementVisibleInIframeViewport(resumingChunk.el)) {
      suppressViewSync = true;
    }
    isPaused = false;
    if (selectedEngine === 'openai') {
      if (currentRemoteAudio && preparedRemotePlayback) {
        playPreparedRemoteAudio(
          preparedRemotePlayback.token,
          preparedRemotePlayback.chunk,
          preparedRemotePlayback.audio
        );
      } else if (currentRemoteAudio) {
        currentRemoteAudio.play().catch(error => handleRemoteFailure(speakToken, error));
      }
    } else {
      speechSynthesis.resume();
    }
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
    hardCancelSpeech();
    clearReadingHighlight();
    suppressViewSync = false;
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
