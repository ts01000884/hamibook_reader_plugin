(function () {
  'use strict';
  const {
    SETTINGS_KEY,
    normalizeApiBaseUrl,
    normalizeLocalPort,
    localApiBaseUrl,
    getPermissionPattern,
    normalizeSettings,
    normalizeVoices
  } = HamiTtsSettings;
  const $ = id => document.getElementById(id);
  let savedPermissionPattern = '';
  let lastAudio = null;

  function serverMode() {
    return $('server-mode-external').checked ? 'external' : 'local';
  }

  function updateLocalUrlPreview() {
    try {
      $('local-url-preview').textContent = localApiBaseUrl($('local-port').value);
    } catch (error) {
      $('local-url-preview').textContent = 'Port 尚未填寫完成';
    }
  }

  function updateModeUi({ resetVoice = false } = {}) {
    const external = serverMode() === 'external';
    $('local-fields').hidden = external;
    $('custom-fields').hidden = !external;
    $('local-port').required = !external;
    $('api-base-url').required = external;
    $('model').required = external;
    $('data-disclosure-mode').textContent = external
      ? '使用外部 TTS 時，目前朗讀的文字會傳送到你填寫的伺服器，以產生語音；請只使用你信任的服務。'
      : '使用伺服器 TTS 時，目前朗讀的文字會傳送到這台電腦的本機 TTS Server，以產生語音。';
    if (resetVoice) {
      $('data-disclosure-accepted').checked = false;
      renderVoices([], '', '請先測試連線');
      setStatus(`已切換到${external ? '外部' : '本機'} TTS，請測試連線`);
    }
    updateLocalUrlPreview();
  }

  function setStatus(text, isError = false) {
    $('status').textContent = text;
    $('status').classList.toggle('error', isError);
  }

  function formValues() {
    const mode = serverMode();
    const localPort = normalizeLocalPort($('local-port').value);
    const customUrlInput = $('api-base-url').value.trim();
    const customApiBaseUrl = customUrlInput ? normalizeApiBaseUrl(customUrlInput) : '';
    if (mode === 'external' && !customApiBaseUrl) throw new Error('請填寫外部 TTS 網址');
    const customApiKey = $('api-key').value.trim();
    const customModel = $('model').value.trim() || 'kokoro';
    return {
      serverMode: mode,
      localPort,
      apiBaseUrl: mode === 'external' ? customApiBaseUrl : localApiBaseUrl(localPort),
      apiKey: mode === 'external' ? customApiKey : '',
      model: mode === 'external' ? customModel : 'kokoro',
      customApiBaseUrl,
      customApiKey,
      customModel,
      dataDisclosureAccepted: $('data-disclosure-accepted').checked,
      externalVoice: $('external-voice').value
    };
  }

  function requireDataDisclosure(values) {
    if (!values.dataDisclosureAccepted) {
      throw new Error('請先閱讀並勾選朗讀文字傳送說明');
    }
  }

  async function ensurePermission(apiBaseUrl) {
    const pattern = getPermissionPattern(apiBaseUrl);
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error(`未授權連線到 ${pattern}`);
    return pattern;
  }

  function headers(apiKey, accept = 'application/json') {
    const value = { Accept: accept };
    if (apiKey) value.Authorization = `Bearer ${apiKey}`;
    return value;
  }

  function renderVoices(voices, selected, emptyText = '請先測試連線') {
    const select = $('external-voice');
    select.innerHTML = '';
    if (!voices.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = emptyText;
      select.appendChild(option);
      $('test-speech').disabled = true;
      return;
    }
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.name === voice.id ? voice.id : `${voice.name} (${voice.id})`;
      select.appendChild(option);
    }
    select.value = voices.some(item => item.id === selected) ? selected : voices[0].id;
    $('test-speech').disabled = false;
  }

  async function fetchVoices(values) {
    const response = await fetch(`${values.apiBaseUrl}/audio/voices`, {
      headers: headers(values.apiKey)
    });
    if (!response.ok) throw new Error(`聲音清單回應 ${response.status}`);
    const payload = await response.json();
    return normalizeVoices(Array.isArray(payload) ? payload : payload.voices);
  }

  async function testConnection() {
    try {
      const values = formValues();
      requireDataDisclosure(values);
      await ensurePermission(values.apiBaseUrl);
      setStatus(`正在連接${values.serverMode === 'external' ? '外部' : '本機'} TTS…`);
      const voices = await fetchVoices(values);
      renderVoices(voices, values.externalVoice, '伺服器沒有回傳中文聲音');
      setStatus(`連線成功，共取得 ${voices.length} 個聲音`);
      return voices;
    } catch (error) {
      setStatus(error.message || String(error), true);
      throw error;
    }
  }

  async function playTestSpeech() {
    try {
      const values = formValues();
      requireDataDisclosure(values);
      if (!values.externalVoice) throw new Error('請先選擇聲音');
      await ensurePermission(values.apiBaseUrl);
      setStatus('正在產生中文測試音訊…');
      const requestHeaders = headers(values.apiKey, 'audio/mpeg');
      requestHeaders['Content-Type'] = 'application/json';
      const response = await fetch(`${values.apiBaseUrl}/audio/speech`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          model: values.model,
          input: '您好，這是 HamiBook 語音伺服器的中文測試。',
          voice: values.externalVoice,
          response_format: 'mp3',
          speed: 1
        })
      });
      if (!response.ok) throw new Error(`語音合成回應 ${response.status}：${(await response.text()).slice(0, 200)}`);
      if (lastAudio) {
        lastAudio.pause();
        URL.revokeObjectURL(lastAudio.src);
      }
      lastAudio = new Audio(URL.createObjectURL(await response.blob()));
      lastAudio.onended = () => setStatus('測試播放完成');
      await lastAudio.play();
      setStatus('正在播放測試音訊');
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }

  async function save(event) {
    event.preventDefault();
    try {
      const values = formValues();
      requireDataDisclosure(values);
      const newPattern = await ensurePermission(values.apiBaseUrl);
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const current = normalizeSettings(stored[SETTINGS_KEY]);
      const voices = await fetchVoices(values);
      const next = normalizeSettings({ ...current, ...values, externalVoices: voices });
      next.externalVoice = voices.some(voice => voice.id === values.externalVoice)
        ? values.externalVoice
        : voices[0]?.id || '';
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      if (savedPermissionPattern && savedPermissionPattern !== newPattern) {
        await chrome.permissions.remove({ origins: [savedPermissionPattern] });
      }
      savedPermissionPattern = newPattern;
      renderVoices(next.externalVoices, next.externalVoice);
      setStatus(`${next.serverMode === 'external' ? '外部' : '本機'} TTS 設定已儲存；回到 HamiBook 閱讀頁重新整理後即可使用`);
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }

  async function init() {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = normalizeSettings(stored[SETTINGS_KEY]);
    $('server-mode-external').checked = settings.serverMode === 'external';
    $('server-mode-local').checked = settings.serverMode !== 'external';
    $('local-port').value = String(settings.localPort);
    $('api-base-url').value = settings.customApiBaseUrl;
    $('api-key').value = settings.customApiKey;
    $('model').value = settings.customModel;
    $('data-disclosure-accepted').checked = settings.dataDisclosureAccepted;
    updateModeUi();
    renderVoices(settings.externalVoices, settings.externalVoice);
    if (settings.apiBaseUrl) {
      savedPermissionPattern = getPermissionPattern(settings.apiBaseUrl);
      setStatus('已載入現有設定');
    }
  }

  $('test-connection').addEventListener('click', () => testConnection().catch(() => {}));
  $('test-speech').addEventListener('click', playTestSpeech);
  $('settings-form').addEventListener('submit', save);
  $('server-mode-local').addEventListener('change', () => updateModeUi({ resetVoice: true }));
  $('server-mode-external').addEventListener('change', () => updateModeUi({ resetVoice: true }));
  $('local-port').addEventListener('input', () => {
    updateLocalUrlPreview();
    $('data-disclosure-accepted').checked = false;
  });
  $('api-base-url').addEventListener('input', () => {
    $('data-disclosure-accepted').checked = false;
  });
  init().catch(error => setStatus(error.message || String(error), true));
})();
