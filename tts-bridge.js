/* Isolated-world bridge between HamiBook page logic and privileged extension APIs. */
(function () {
  'use strict';
  const PAGE_SOURCE = 'hamibook-tts-main';
  const BRIDGE_SOURCE = 'hamibook-tts-bridge';

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || !message || message.source !== PAGE_SOURCE) return;
    if (message.type === 'HAMI_TTS_OPEN_OPTIONS') {
      chrome.runtime.openOptionsPage();
      return;
    }
    const requestId = String(message.bridgeRequestId || '');
    if (!requestId) return;
    const forwarded = { ...message };
    delete forwarded.source;
    delete forwarded.bridgeRequestId;
    chrome.runtime.sendMessage(forwarded, response => {
      const runtimeError = chrome.runtime.lastError;
      window.postMessage({
        source: BRIDGE_SOURCE,
        bridgeRequestId: requestId,
        response: runtimeError
          ? { ok: false, error: runtimeError.message }
          : response || { ok: false, error: '擴充套件沒有回應' }
      }, '*');
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.ttsSettingsV2?.newValue) return;
    const value = changes.ttsSettingsV2.newValue;
    const settings = {
      version: value.version,
      engine: value.engine,
      browserVoiceURI: value.browserVoiceURI,
      externalVoice: value.externalVoice,
      externalVoices: value.externalVoices,
      rate: value.rate,
      autoTurnPage: value.autoTurnPage,
      dataDisclosureAccepted: value.dataDisclosureAccepted === true
    };
    window.postMessage({ source: BRIDGE_SOURCE, event: 'settingsChanged', settings }, '*');
  });
})();
