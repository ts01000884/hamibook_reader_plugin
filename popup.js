(function () {
  "use strict";

  const CHANNEL = "HAMIBOOK_EPUBFIX_V1";
  const GET_STATE = "EPUBFIX_GET_STATE";
  const GET_LOGS = "EPUBFIX_GET_LOGS";
  const SET_ENABLED = "EPUBFIX_SET_ENABLED";
  const POLL_INTERVAL_MS = 700;

  const toggle = document.getElementById("epubfix-toggle");
  const status = document.getElementById("epubfix-status");
  const readiness = document.getElementById("epubfix-readiness");
  const prevState = document.getElementById("epubfix-prev");
  const nextState = document.getElementById("epubfix-next");
  const extensionVersion = document.getElementById("extension-version");
  const copyLogButton = document.getElementById("epubfix-copy-log");
  const copyLogStatus = document.getElementById("epubfix-copy-status");
  const logFallback = document.getElementById("epubfix-log-fallback");

  extensionVersion.textContent = "v" + chrome.runtime.getManifest().version;

  let activeTabId = null;
  let pollTimer = null;
  let requestInFlight = false;
  let logInFlight = false;

  function queryActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        const tab = tabs && tabs[0];
        if (!tab || typeof tab.id !== "number") {
          reject(new Error("找不到目前分頁"));
          return;
        }
        resolve(tab);
      });
    });
  }

  function sendToTab(message) {
    return new Promise((resolve, reject) => {
      if (typeof activeTabId !== "number") {
        reject(new Error("找不到目前分頁"));
        return;
      }
      chrome.tabs.sendMessage(activeTabId, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function setStatus(text, tone) {
    status.textContent = text;
    status.dataset.tone = tone || "neutral";
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        // Fall through to a selected textarea without requesting clipboard permission.
      }
    }

    logFallback.hidden = false;
    logFallback.value = text;
    logFallback.focus();
    logFallback.select();
    logFallback.setSelectionRange(0, text.length);
    try {
      if (document.execCommand("copy")) {
        logFallback.hidden = true;
        return true;
      }
    } catch (error) {
      // Keep the selected textarea visible for manual Ctrl+C.
    }
    return false;
  }

  function reasonText(reason) {
    const labels = {
      BUFFER_NOT_READY: "相鄰頁尚未完成準備",
      BUFFER_PREPARE_TIMEOUT: "頁面載入超過 20 秒",
      BUFFER_ASSETS_TIMEOUT: "圖片或字型載入逾時",
      BUFFER_FONTS_NOT_READY: "字型尚未完成載入",
      BUFFER_IMAGE_NOT_READY: "圖片尚未完成載入",
      BUFFER_LAYOUT_UNSTABLE: "頁面排版持續變動",
      BUFFER_VISUAL_FIX_FAILED: "頁面尺寸修正未完成",
      BUFFER_FRAME_LOAD_FAILED: "頁面載入失敗",
      CROSS_ORIGIN_BUFFER: "預載頁來源無法讀取",
      CROSS_ORIGIN_OR_INCOMPLETE: "預載頁來源或內容不相容",
      BUFFER_MISS: "翻頁時預載尚未完成",
      HANDOFF_TIMEOUT: "原生頁面交接逾時"
    };
    return labels[reason] || String(reason || "");
  }

  function directionText(value) {
    const labels = {
      READY: "已就緒",
      LOADING: "準備中",
      ERROR: "失敗",
      UNAVAILABLE: "無此頁",
      WAITING: "等待中"
    };
    return labels[value] || "等待中";
  }

  function phaseText(state) {
    const phase = state.phase || "";
    const labels = {
      DISABLED: "功能已關閉，不會建立額外預載頁。",
      WAITING_VISIBLE: "已啟用，等待閱讀分頁顯示後開始準備。",
      DISCOVERING: "已啟用，正在連接閱讀頁面…",
      SYNCING: "已啟用，等待目前頁面完成修正…",
      BUFFERING: "已啟用，正在準備前後頁…",
      READY: "平滑翻頁已啟用。",
      HANDOFF: "正在以預先修正頁面交接…",
      FALLBACK: "本次使用原生翻頁，正在重新準備。",
      DEGRADED: "頁面結構不相容，已安全回退原生翻頁。",
      UNSUPPORTED: "目前頁面不支援平滑翻頁。"
    };
    if (phase === "FALLBACK" && state.reason) {
      return "預載未就緒：" + reasonText(state.reason) + "；本次維持原生翻頁。";
    }
    if (phase === "DEGRADED" && state.reason) {
      return "頁面結構不相容（" + reasonText(state.reason) + "），已回退原生翻頁。";
    }
    return labels[phase] || "已連接閱讀頁面。";
  }

  function renderState(state) {
    if (!state || state.ok === false) {
      toggle.disabled = true;
      copyLogButton.disabled = true;
      readiness.hidden = true;
      setStatus("無法取得功能狀態，請重新整理閱讀頁。", "error");
      return;
    }

    if (!state.supported) {
      toggle.checked = false;
      toggle.disabled = true;
      copyLogButton.disabled = true;
      readiness.hidden = true;
      setStatus("目前頁面不支援平滑翻頁。", "neutral");
      return;
    }

    toggle.disabled = false;
    toggle.checked = Boolean(state.enabled);
    copyLogButton.disabled = !state.enabled || logInFlight;
    readiness.hidden = !state.enabled;
    const previousStatus = state.prevStatus || (state.prevReady ? "READY" : "WAITING");
    const followingStatus = state.nextStatus || (state.nextReady ? "READY" : "WAITING");
    prevState.textContent = directionText(previousStatus);
    nextState.textContent = directionText(followingStatus);
    prevState.dataset.state = previousStatus;
    nextState.dataset.state = followingStatus;
    prevState.title = reasonText(state.prevReason);
    nextState.title = reasonText(state.nextReason);

    let tone = "working";
    if (!state.enabled) tone = "neutral";
    if (state.phase === "READY") tone = "ok";
    if (state.phase === "FALLBACK" || state.phase === "DEGRADED") tone = "error";
    setStatus(phaseText(state), tone);
  }

  function renderDisconnected() {
    toggle.checked = false;
    toggle.disabled = true;
    copyLogButton.disabled = true;
    readiness.hidden = true;
    setStatus("請開啟 HamiBook 閱讀頁；若剛更新擴充，請先重新整理該頁。", "error");
  }

  async function refreshState() {
    if (requestInFlight || typeof activeTabId !== "number") return;
    requestInFlight = true;
    try {
      const response = await sendToTab({ channel: CHANNEL, type: GET_STATE });
      renderState(response);
    } catch (error) {
      renderDisconnected();
    } finally {
      requestInFlight = false;
    }
  }

  toggle.addEventListener("change", async () => {
    if (requestInFlight) return;
    const wanted = toggle.checked;
    requestInFlight = true;
    toggle.disabled = true;
    setStatus(wanted ? "正在啟用…" : "正在關閉…", "working");
    try {
      const response = await sendToTab({
        channel: CHANNEL,
        type: SET_ENABLED,
        enabled: wanted
      });
      renderState(response);
    } catch (error) {
      toggle.checked = !wanted;
      renderDisconnected();
    } finally {
      requestInFlight = false;
    }
  });

  copyLogButton.addEventListener("click", async () => {
    if (logInFlight || typeof activeTabId !== "number") return;
    logInFlight = true;
    copyLogButton.disabled = true;
    copyLogStatus.hidden = false;
    copyLogStatus.textContent = "正在整理診斷 LOG…";
    logFallback.hidden = true;
    try {
      const response = await sendToTab({ channel: CHANNEL, type: GET_LOGS });
      if (!response || response.ok !== true || typeof response.text !== "string") {
        throw new Error("LOG_UNAVAILABLE");
      }
      const payload = JSON.stringify(
        {
          extensionVersion: chrome.runtime.getManifest().version,
          capturedAt: new Date().toISOString(),
          diagnostics: JSON.parse(response.text)
        },
        null,
        2
      );
      const copied = await copyText(payload);
      copyLogStatus.textContent = copied
        ? "已複製，請直接貼給開發者。"
        : "無法自動複製；LOG 已全選，請按 Ctrl+C。";
    } catch (error) {
      copyLogStatus.textContent = "無法取得 LOG，請先重新整理閱讀頁再重現。";
    } finally {
      logInFlight = false;
      copyLogButton.disabled = !toggle.checked;
    }
  });

  async function init() {
    try {
      const tab = await queryActiveTab();
      activeTabId = tab.id;
      await refreshState();
      pollTimer = window.setInterval(refreshState, POLL_INTERVAL_MS);
    } catch (error) {
      renderDisconnected();
    }
  }

  window.addEventListener("unload", () => {
    if (pollTimer) window.clearInterval(pollTimer);
  });

  init();
})();
