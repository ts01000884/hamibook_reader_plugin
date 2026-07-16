(function () {
  "use strict";

  const CHANNEL = "HAMIBOOK_EPUBFIX_V1";
  const PROTOCOL = 1;
  const COMMAND_EVENT = "hamibook-epubfix-command-v1";
  const RESPONSE_EVENT = "hamibook-epubfix-response-v1";
  const RESPONSE_TIMEOUT_MS = 1500;
  const ALLOWED_TYPES = new Set([
    "EPUBFIX_GET_STATE",
    "EPUBFIX_GET_LOGS",
    "EPUBFIX_SET_ENABLED"
  ]);

  function makeRequestId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function forwardToMain(message) {
    return new Promise((resolve) => {
      const requestId = makeRequestId();
      let finished = false;

      function finish(response) {
        if (finished) return;
        finished = true;
        document.removeEventListener(RESPONSE_EVENT, onResponse);
        window.clearTimeout(timeoutId);
        resolve(response);
      }

      function onResponse(event) {
        if (typeof event.detail !== "string") return;
        let payload;
        try {
          payload = JSON.parse(event.detail);
        } catch (error) {
          return;
        }
        if (
          payload &&
          payload.protocol === PROTOCOL &&
          payload.requestId === requestId
        ) {
          finish(payload.response);
        }
      }

      const timeoutId = window.setTimeout(() => {
        finish({
          ok: false,
          supported: false,
          enabled: false,
          phase: "UNSUPPORTED",
          reason: "MAIN_BRIDGE_NOT_READY"
        });
      }, RESPONSE_TIMEOUT_MS);

      document.addEventListener(RESPONSE_EVENT, onResponse);
      document.dispatchEvent(
        new CustomEvent(COMMAND_EVENT, {
          detail: JSON.stringify({
            protocol: PROTOCOL,
            requestId,
            command: message.type,
            enabled: message.enabled === true
          })
        })
      );
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      !message ||
      message.channel !== CHANNEL ||
      !ALLOWED_TYPES.has(message.type)
    ) {
      return false;
    }

    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, reason: "INVALID_SENDER" });
      return false;
    }

    forwardToMain(message)
      .then(sendResponse)
      .catch(() => {
        sendResponse({
          ok: false,
          supported: false,
          enabled: false,
          phase: "UNSUPPORTED",
          reason: "BRIDGE_FAILURE"
        });
      });
    return true;
  });
})();
