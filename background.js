/* MV3 service worker: owns TTS server settings and performs isolated fetches. */
'use strict';

importScripts('tts-settings.js');

const {
  SETTINGS_KEY,
  normalizeSettings,
  publicSettings
} = HamiTtsSettings;
const activeRequests = new Map();
const MAX_INPUT_LENGTH = 500;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60000;

function isTrustedHamiSender(sender) {
  try {
    const url = new URL(sender?.url || '');
    return url.origin === 'https://webreader.hamibook.com.tw' && /^\/viewer\/08(?:\/|$)/.test(url.pathname);
  } catch (error) {
    return false;
  }
}

async function loadSettings(legacy) {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (stored[SETTINGS_KEY]) return normalizeSettings(stored[SETTINGS_KEY]);
  const initial = normalizeSettings({
    browserVoiceURI: legacy?.voiceURI,
    rate: legacy?.rate,
    autoTurnPage: legacy?.autoTurnPage
  });
  await chrome.storage.local.set({ [SETTINGS_KEY]: initial });
  return initial;
}

async function updatePlaybackSettings(patch) {
  const current = await loadSettings();
  const allowed = {
    engine: patch?.engine,
    browserVoiceURI: patch?.browserVoiceURI,
    externalVoice: patch?.externalVoice,
    rate: patch?.rate,
    autoTurnPage: patch?.autoTurnPage
  };
  for (const key of Object.keys(allowed)) {
    if (allowed[key] === undefined) delete allowed[key];
  }
  const next = normalizeSettings({ ...current, ...allowed });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return publicSettings(next);
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function synthesize(message, sender) {
  if (!isTrustedHamiSender(sender)) throw new Error('不允許的訊息來源');
  const requestId = String(message.requestId || '');
  const input = String(message.text || '').trim();
  if (!requestId) throw new Error('缺少 requestId');
  if (!input || input.length > MAX_INPUT_LENGTH) throw new Error('朗讀文字長度不符合限制');

  const settings = await loadSettings();
  if (settings.engine !== 'openai') throw new Error('目前未選擇 TTS 伺服器');
  if (!settings.dataDisclosureAccepted) throw new Error('尚未同意朗讀文字傳送說明');
  if (!settings.apiBaseUrl) throw new Error('尚未設定 TTS 伺服器');
  if (!settings.externalVoice) throw new Error('尚未選擇伺服器聲音');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
  activeRequests.set(`${sender.tab?.id ?? 'unknown'}:${requestId}`, controller);
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'audio/mpeg' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const response = await fetch(`${settings.apiBaseUrl}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: settings.model,
        input,
        voice: settings.externalVoice,
        response_format: 'mp3',
        speed: HamiTtsSettings.clampRate(message.rate)
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`TTS 伺服器回應 ${response.status}${detail ? `：${detail}` : ''}`);
    }
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) throw new Error('TTS 伺服器回傳空白音訊');
    if (buffer.byteLength > MAX_AUDIO_BYTES) throw new Error('TTS 音訊超過 20 MiB 限制');
    return {
      audioBase64: bytesToBase64(buffer),
      mimeType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg'
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('TTS 請求已取消或逾時');
    throw error;
  } finally {
    clearTimeout(timeout);
    activeRequests.delete(`${sender.tab?.id ?? 'unknown'}:${requestId}`);
  }
}

function cancelRequest(message, sender) {
  const requestId = String(message.requestId || '');
  const key = `${sender.tab?.id ?? 'unknown'}:${requestId}`;
  activeRequests.get(key)?.abort('cancelled');
  activeRequests.delete(key);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    switch (message?.type) {
      case 'HAMI_TTS_GET_SETTINGS':
        if (!isTrustedHamiSender(sender)) throw new Error('不允許的訊息來源');
        return publicSettings(await loadSettings(message.legacy));
      case 'HAMI_TTS_UPDATE_PLAYBACK_SETTINGS':
        if (!isTrustedHamiSender(sender)) throw new Error('不允許的訊息來源');
        return updatePlaybackSettings(message.patch);
      case 'HAMI_TTS_SYNTHESIZE':
        return synthesize(message, sender);
      case 'HAMI_TTS_CANCEL':
        if (!isTrustedHamiSender(sender)) throw new Error('不允許的訊息來源');
        cancelRequest(message, sender);
        return { cancelled: true };
      default:
        throw new Error('未知的 TTS 指令');
    }
  };
  handle()
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
