/* Shared extension-side settings helpers. Loaded by the service worker and options page. */
(function (root) {
  'use strict';

  const SETTINGS_KEY = 'ttsSettingsV2';
  const DEFAULTS = Object.freeze({
    version: 3,
    engine: 'browser',
    serverMode: 'local',
    localPort: 8890,
    apiBaseUrl: 'http://localhost:8890/v1',
    apiKey: '',
    model: 'kokoro',
    customApiBaseUrl: '',
    customApiKey: '',
    customModel: 'kokoro',
    dataDisclosureAccepted: false,
    browserVoiceURI: '',
    externalVoice: '',
    externalVoices: [],
    rate: 1,
    autoTurnPage: true
  });

  const CHINESE_VOICE_NAMES = Object.freeze({
    zf_xiaobei: '曉北',
    zf_xiaoni: '曉妮',
    zf_xiaoxiao: '曉曉',
    zf_xiaoyi: '曉伊',
    zm_yunjian: '雲健',
    zm_yunxi: '雲希',
    zm_yunxia: '雲夏',
    zm_yunyang: '雲揚'
  });

  function clampRate(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate)) return DEFAULTS.rate;
    return Math.min(1.5, Math.max(0.6, rate));
  }

  function normalizeApiBaseUrl(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    let url;
    try {
      url = new URL(input);
    } catch (error) {
      throw new Error('伺服器網址格式不正確');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('伺服器網址只支援 http:// 或 https://');
    }
    if (url.username || url.password) {
      throw new Error('請勿把帳號或密碼寫在網址中');
    }
    if (url.search || url.hash) {
      throw new Error('伺服器網址不可包含查詢參數或錨點');
    }
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
    return url.toString().replace(/\/$/, '');
  }

  function normalizeLocalPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('Port 必須是 1024 到 65535 的整數');
    }
    return port;
  }

  function localApiBaseUrl(port) {
    return normalizeApiBaseUrl(`http://localhost:${normalizeLocalPort(port)}`);
  }

  function isLocalApiBaseUrl(value) {
    try {
      const url = new URL(normalizeApiBaseUrl(value));
      return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    } catch (error) {
      return false;
    }
  }

  function portFromApiBaseUrl(value) {
    try {
      const url = new URL(normalizeApiBaseUrl(value));
      return normalizeLocalPort(url.port || 80);
    } catch (error) {
      return DEFAULTS.localPort;
    }
  }

  function getPermissionPattern(apiBaseUrl) {
    const url = new URL(normalizeApiBaseUrl(apiBaseUrl));
    return `${url.protocol}//${url.hostname}/*`;
  }

  function normalizeVoices(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const voices = [];
    for (const item of value) {
      const id = typeof item === 'string' ? item : item?.id;
      if (typeof id !== 'string' || !id.trim() || seen.has(id.trim())) continue;
      const normalizedId = id.trim();
      const voiceKey = normalizedId.toLowerCase();
      if (!voiceKey.startsWith('zf_') && !voiceKey.startsWith('zm_')) continue;
      seen.add(normalizedId);
      voices.push({
        id: normalizedId,
        name: CHINESE_VOICE_NAMES[voiceKey] ||
          (typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : normalizedId)
      });
    }
    return voices;
  }

  function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const legacyApiBaseUrl = typeof source.apiBaseUrl === 'string' ? source.apiBaseUrl : '';
    const inferredMode = legacyApiBaseUrl && !isLocalApiBaseUrl(legacyApiBaseUrl) ? 'external' : 'local';
    const serverMode = source.serverMode === 'external' || source.serverMode === 'custom'
      ? 'external'
      : source.serverMode === 'local' ? 'local' : inferredMode;
    let localPort = DEFAULTS.localPort;
    try {
      localPort = normalizeLocalPort(source.localPort ??
        (isLocalApiBaseUrl(legacyApiBaseUrl) ? portFromApiBaseUrl(legacyApiBaseUrl) : DEFAULTS.localPort));
    } catch (error) {
      localPort = DEFAULTS.localPort;
    }
    let customApiBaseUrl = '';
    const customUrlSource = source.customApiBaseUrl || (inferredMode === 'external' ? legacyApiBaseUrl : '');
    try {
      customApiBaseUrl = normalizeApiBaseUrl(customUrlSource);
    } catch (error) {
      customApiBaseUrl = '';
    }
    const customApiKeySource = source.customApiKey ?? (inferredMode === 'external' ? source.apiKey : '');
    const customModelSource = source.customModel ?? (inferredMode === 'external' ? source.model : DEFAULTS.model);
    const customApiKey = typeof customApiKeySource === 'string' ? customApiKeySource.trim() : '';
    const customModel = typeof customModelSource === 'string' && customModelSource.trim()
      ? customModelSource.trim()
      : DEFAULTS.model;
    const apiBaseUrl = serverMode === 'external' ? customApiBaseUrl : localApiBaseUrl(localPort);
    const apiKey = serverMode === 'external' ? customApiKey : '';
    const model = serverMode === 'external' ? customModel : DEFAULTS.model;
    return {
      version: 3,
      engine: source.engine === 'openai' ? 'openai' : 'browser',
      serverMode,
      localPort,
      apiBaseUrl,
      apiKey,
      model,
      customApiBaseUrl,
      customApiKey,
      customModel,
      dataDisclosureAccepted: source.dataDisclosureAccepted === true,
      browserVoiceURI: typeof source.browserVoiceURI === 'string' ? source.browserVoiceURI : '',
      externalVoice: typeof source.externalVoice === 'string' ? source.externalVoice : '',
      externalVoices: normalizeVoices(source.externalVoices),
      rate: clampRate(source.rate),
      autoTurnPage: source.autoTurnPage !== undefined ? !!source.autoTurnPage : true
    };
  }

  function publicSettings(value) {
    const settings = normalizeSettings(value);
    return {
      version: settings.version,
      engine: settings.engine,
      browserVoiceURI: settings.browserVoiceURI,
      externalVoice: settings.externalVoice,
      externalVoices: settings.externalVoices,
      rate: settings.rate,
      autoTurnPage: settings.autoTurnPage,
      dataDisclosureAccepted: settings.dataDisclosureAccepted
    };
  }

  root.HamiTtsSettings = {
    SETTINGS_KEY,
    DEFAULTS,
    clampRate,
    normalizeApiBaseUrl,
    normalizeLocalPort,
    localApiBaseUrl,
    getPermissionPattern,
    normalizeVoices,
    normalizeSettings,
    publicSettings
  };
})(globalThis);
