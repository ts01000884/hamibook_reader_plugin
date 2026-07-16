(function () {
  "use strict";

  const PROTOCOL = 1;
  const COMMAND_EVENT = "hamibook-epubfix-command-v1";
  const RESPONSE_EVENT = "hamibook-epubfix-response-v1";
  const GET_STATE = "EPUBFIX_GET_STATE";
  const GET_LOGS = "EPUBFIX_GET_LOGS";
  const SET_ENABLED = "EPUBFIX_SET_ENABLED";
  const STORAGE_KEY = "hamibook_epubfix_buffer_enabled_v1";
  const SUPPORTED_PATH = /^\/viewer\/07(?:\/|$)/;

  const DISCOVERY_TIMEOUT_MS = 15000;
  const BUFFER_TIMEOUT_MS = 20000;
  const ASSET_SETTLE_TIMEOUT_MS = 12000;
  const HANDOFF_TIMEOUT_MS = 5000;
  const HANDOFF_POLL_MS = 50;
  const LAYOUT_DEBOUNCE_MS = 250;
  const SYNC_RETRY_MS = 100;

  const OVERLAY_ID = "hamibook-epubfix-buffer-root";
  const BUFFER_ATTR = "data-hamibook-epubfix-buffer";
  const NATIVE_CONTAINER_ATTR = "data-hamibook-epubfix-native";
  const MASK_FIX_STYLE_ID = "hamibook-epubfix-mask-fix";
  const DEBUG_LOG_LIMIT = 200;
  const MAX_LOGICAL_BUFFERS = 4;
  const MAX_PHYSICAL_BUFFER_FRAMES = 6;
  const RESTRICTED_SINGLE_IMAGE_CP_IDS = new Set([59, 101469]);

  const debugStartedAt = Date.now();
  const debugEntries = [];
  let debugSequence = 0;

  const runtime = {
    supported: SUPPORTED_PATH.test(window.location.pathname),
    enabled: false,
    active: false,
    phase: "DISABLED",
    reason: "",
    epoch: 0,
    transitionSerial: 0,
    contentRevision: 0,
    contentRef: null,
    currentPage: null,
    lastPageDirection: 1,
    layoutSignature: "",
    store: null,
    nativeContainer: null,
    overlayRoot: null,
    buffers: new Map(),
    transition: null,
    unsubscribeStore: null,
    nativeObserver: null,
    resizeObserver: null,
    discoveryTimer: null,
    discoveryStartedAt: 0,
    syncTimer: null,
    layoutTimer: null,
    positionRaf: null,
    syncConfirmToken: 0,
    syncConfirmKey: "",
    lastNativeBlocker: "",
    managedFrames: new Map()
  };

  function rounded(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
  }

  function rectSnapshot(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rounded(rect.left),
      top: rounded(rect.top),
      width: rounded(rect.width),
      height: rounded(rect.height),
      right: rounded(rect.right),
      bottom: rounded(rect.bottom)
    };
  }

  function bufferListSnapshot() {
    const now = Date.now();
    return Array.from(runtime.buffers.values()).map((buffer) => ({
      index: buffer.index,
      status: buffer.status,
      reason: buffer.reason || "",
      ageMs: buffer.startedAt ? now - buffer.startedAt : null,
      frames: Array.isArray(buffer.frames) ? buffer.frames.length : 0
    }));
  }

  function frameVisualSnapshot(frame) {
    const result = {
      frameRect: rectSnapshot(frame),
      accessible: false
    };
    try {
      const doc = frame && frame.contentDocument;
      const body = doc && doc.body;
      if (!doc || !body) return result;
      const images = Array.from(doc.images || []);
      const imageRects = images.map(rectSnapshot).filter(Boolean);
      const maxImageBottom = imageRects.length
        ? Math.max(...imageRects.map((rect) => Number(rect.bottom || 0)))
        : null;
      const frameHeight = result.frameRect && Number(result.frameRect.height);
      let bodyBackground = "";
      try {
        bodyBackground = frame.contentWindow.getComputedStyle(body).backgroundColor || "";
      } catch (error) {
        bodyBackground = body.style.backgroundColor || "";
      }
      result.accessible = true;
      result.readyState = doc.readyState;
      result.fontStatus = doc.fonts && doc.fonts.status ? doc.fonts.status : "unknown";
      result.bodyRect = rectSnapshot(body);
      result.bodyScrollWidth = Number(body.scrollWidth || 0);
      result.bodyScrollHeight = Number(body.scrollHeight || 0);
      result.bodyTransform = String(body.style.transform || "");
      result.bodyBackground = bodyBackground;
      result.imageCount = images.length;
      result.incompleteImages = images.filter((image) => !image.complete).length;
      result.brokenImages = images.filter(
        (image) => Boolean(image.currentSrc || image.getAttribute("src")) && Number(image.naturalWidth || 0) <= 0
      ).length;
      result.images = images.slice(0, 4).map((image, index) => ({
        index: index,
        complete: Boolean(image.complete),
        naturalWidth: Number(image.naturalWidth || 0),
        naturalHeight: Number(image.naturalHeight || 0),
        rect: rectSnapshot(image)
      }));
      result.visualGapBelowPx =
        maxImageBottom === null || !Number.isFinite(frameHeight)
          ? null
          : rounded(Math.max(0, frameHeight - maxImageBottom));
    } catch (error) {
      result.error = "FRAME_ACCESS_ERROR";
    }
    return result;
  }

  function nativeGeometrySnapshot() {
    const container = runtime.nativeContainer;
    const containerRect = rectSnapshot(container);
    const mask = container && container.querySelector(".iframe-mask");
    const maskRect = rectSnapshot(mask);
    let containerOverflow = "";
    let containerBackground = "";
    let maskDisplay = "";
    let maskMarginTop = "";
    let maskBackground = "";
    if (container) {
      try {
        const containerStyle = window.getComputedStyle(container);
        containerOverflow = containerStyle.overflow;
        containerBackground = containerStyle.backgroundColor;
      } catch (error) {
        containerOverflow = "unknown";
      }
    }
    if (mask) {
      try {
        const style = window.getComputedStyle(mask);
        maskDisplay = style.display;
        maskMarginTop = style.marginTop;
        maskBackground = style.backgroundColor;
      } catch (error) {
        maskDisplay = "unknown";
      }
    }
    return {
      containerRect: containerRect,
      containerOverflow: containerOverflow,
      containerBackground: containerBackground,
      mask: mask
        ? {
            display: maskDisplay,
            marginTop: maskMarginTop,
            background: maskBackground,
            rect: maskRect,
            overhangBottom:
              containerRect && maskRect
                ? rounded(Math.max(0, Number(maskRect.bottom) - Number(containerRect.bottom)))
                : null
          }
        : null,
      frames: getNativeVisibleFrames().map(frameVisualSnapshot)
    };
  }

  function debugLog(eventName, details, level) {
    const entry = {
      seq: ++debugSequence,
      elapsedMs: Date.now() - debugStartedAt,
      event: String(eventName || "unknown"),
      phase: runtime.phase,
      currentPage: getCurrentIndex(),
      details: details || {}
    };
    debugEntries.push(entry);
    if (debugEntries.length > DEBUG_LOG_LIMIT) debugEntries.splice(0, debugEntries.length - DEBUG_LOG_LIMIT);
    return entry;
  }

  function debugExportObject() {
    const windowState = runtime.store && runtime.store.state && runtime.store.state.window_state;
    return {
      schema: 1,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - debugStartedAt,
      location: runtime.supported ? "/viewer/07/*" : "unsupported",
      state: stateSnapshot(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      fixedLayout: windowState
        ? {
            iframeWidth: Number(windowState.iframe_w || 0),
            iframeHeight: Number(windowState.iframe_h || 0),
            sourceWidth: Number(windowState.tmp_w || 0),
            sourceHeight: Number(windowState.tmp_h || 0),
            singlePage: Boolean(windowState.page_type1),
            zoom: Number(windowState.zoom || 0)
          }
        : null,
      buffers: bufferListSnapshot(),
      transition: runtime.transition
        ? {
            target: runtime.transition.index,
            ageMs: Date.now() - runtime.transition.startedAt,
            nativeBlocker: runtime.transition.nativeBlocker || ""
          }
        : null,
      native: nativeGeometrySnapshot(),
      entries: debugEntries.slice()
    };
  }

  function debugExportText() {
    return JSON.stringify(debugExportObject(), null, 2);
  }

  function readEnabledSetting() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function writeEnabledSetting(enabled) {
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
      return true;
    } catch (error) {
      return false;
    }
  }

  function setPhase(phase, reason) {
    const previousPhase = runtime.phase;
    const previousReason = runtime.reason;
    runtime.phase = phase;
    runtime.reason = reason || "";
    if (runtime.overlayRoot) {
      runtime.overlayRoot.dataset.phase = phase;
    }
    if (previousPhase !== runtime.phase || previousReason !== runtime.reason) {
      debugLog("phase.changed", {
        from: previousPhase,
        to: runtime.phase,
        reason: runtime.reason,
        buffers: bufferListSnapshot()
      });
    }
  }

  function getCurrentIndex() {
    const book = runtime.store && runtime.store.state && runtime.store.state.book;
    const index = book && Number(book.current_page);
    return Number.isInteger(index) ? index : null;
  }

  function stateSnapshot() {
    const current = getCurrentIndex();
    const previous = directionSnapshot(current === null ? null : current - 1);
    const next = directionSnapshot(current === null ? null : current + 1);
    return {
      ok: true,
      supported: runtime.supported,
      enabled: runtime.enabled,
      phase: runtime.supported ? runtime.phase : "UNSUPPORTED",
      prevReady: previous.status === "READY",
      nextReady: next.status === "READY",
      prevStatus: previous.status,
      nextStatus: next.status,
      prevReason: previous.reason,
      nextReason: next.reason,
      reason: runtime.reason || ""
    };
  }

  function directionSnapshot(index) {
    if (!Number.isInteger(index)) return { status: "WAITING", reason: "" };
    if (!isValidPageIndex(index)) return { status: "UNAVAILABLE", reason: "" };
    const buffer = runtime.buffers.get(index);
    if (!buffer) return { status: "WAITING", reason: "" };
    return {
      status: String(buffer.status || "WAITING"),
      reason: String(buffer.reason || "")
    };
  }

  function dispatchCommandResponse(requestId, response) {
    document.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: JSON.stringify({
          protocol: PROTOCOL,
          requestId: requestId,
          response: response
        })
      })
    );
  }

  function onCommand(event) {
    if (typeof event.detail !== "string") return;
    let request;
    try {
      request = JSON.parse(event.detail);
    } catch (error) {
      return;
    }

    if (
      !request ||
      request.protocol !== PROTOCOL ||
      typeof request.requestId !== "string"
    ) {
      return;
    }

    if (request.command === GET_STATE) {
      dispatchCommandResponse(request.requestId, stateSnapshot());
      return;
    }

    if (request.command === GET_LOGS) {
      debugLog("debug.exported", { entries: debugEntries.length });
      dispatchCommandResponse(request.requestId, {
        ok: true,
        text: debugExportText()
      });
      return;
    }

    if (request.command !== SET_ENABLED || typeof request.enabled !== "boolean") {
      dispatchCommandResponse(request.requestId, {
        ok: false,
        supported: runtime.supported,
        enabled: runtime.enabled,
        phase: runtime.phase,
        prevReady: false,
        nextReady: false,
        reason: "INVALID_COMMAND"
      });
      return;
    }

    if (!runtime.supported) {
      dispatchCommandResponse(request.requestId, {
        ok: false,
        supported: false,
        enabled: runtime.enabled,
        phase: "UNSUPPORTED",
        prevReady: false,
        nextReady: false,
        reason: "UNSUPPORTED_PAGE"
      });
      return;
    }

    if (!writeEnabledSetting(request.enabled)) {
      const failed = stateSnapshot();
      failed.ok = false;
      failed.reason = "STORAGE_UNAVAILABLE";
      dispatchCommandResponse(request.requestId, failed);
      return;
    }

    runtime.enabled = request.enabled;
    if (runtime.enabled) {
      startRuntime();
    } else {
      stopRuntime();
    }
    dispatchCommandResponse(request.requestId, stateSnapshot());
  }

  function normalizeUrl(value) {
    try {
      return new URL(String(value || ""), document.baseURI).href;
    } catch (error) {
      return "";
    }
  }

  function arraysEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  function getPageGroup(index) {
    const book = runtime.store && runtime.store.state && runtime.store.state.book;
    const content = book && book.content_obj;
    if (!Array.isArray(content) || !Number.isInteger(index) || !Array.isArray(content[index])) {
      return [];
    }
    return content[index].filter((entry) => entry && entry.src);
  }

  function getPageUrls(index) {
    return getPageGroup(index).map((entry) => normalizeUrl(entry.src)).filter(Boolean);
  }

  function isValidPageIndex(index) {
    const book = runtime.store && runtime.store.state && runtime.store.state.book;
    return Boolean(
      Number.isInteger(index) &&
      book &&
      Array.isArray(book.content_obj) &&
      index >= 0 &&
      index < book.content_obj.length
    );
  }

  function desiredBufferIndexes(currentIndex, reservedFrames, logicalLimit) {
    if (!Number.isInteger(currentIndex)) return [];
    const limit = Number.isInteger(logicalLimit)
      ? Math.max(0, Math.min(MAX_LOGICAL_BUFFERS, logicalLimit))
      : MAX_LOGICAL_BUFFERS;
    if (limit === 0) return [];
    const direction = runtime.lastPageDirection < 0 ? -1 : 1;
    const candidates = [
      currentIndex + direction,
      currentIndex - direction,
      currentIndex + direction * 2,
      currentIndex - direction * 2
    ];
    const desired = [];
    let physicalFrames = Math.max(0, Number(reservedFrames) || 0);
    for (const index of candidates) {
      if (!isValidPageIndex(index) || desired.includes(index)) continue;
      const frameCount = getPageUrls(index).length;
      if (frameCount === 0) continue;
      if (physicalFrames + frameCount > MAX_PHYSICAL_BUFFER_FRAMES) continue;
      desired.push(index);
      physicalFrames += frameCount;
      if (desired.length >= limit) break;
    }
    return desired;
  }

  function getVueStoreFromElement(element) {
    let vm = element && element.__vue__;
    let depth = 0;
    while (vm && depth < 20) {
      if (vm.$store) return vm.$store;
      if (vm.$root && vm.$root.$store) return vm.$root.$store;
      vm = vm.$parent;
      depth += 1;
    }
    return null;
  }

  function isCompatibleStore(store) {
    if (
      !store ||
      typeof store.subscribe !== "function" ||
      !store.state ||
      !store.state.book ||
      !store.state.window_state ||
      !Array.isArray(store.state.book.content_obj)
    ) {
      return false;
    }

    const book = store.state.book;
    const windowState = store.state.window_state;
    if (
      book.content_obj.length === 0 ||
      !Number.isInteger(Number(book.current_page)) ||
      Number(windowState.iframe_w) <= 0 ||
      Number(windowState.iframe_h) <= 0
    ) {
      return false;
    }

    if (
      store.getters &&
      Object.prototype.hasOwnProperty.call(store.getters, "window_state/isEpubFixType") &&
      store.getters["window_state/isEpubFixType"] !== true
    ) {
      return false;
    }
    return true;
  }

  function findStoreAndContainer() {
    const elements = [
      document.getElementById("app"),
      document.querySelector(".viewer"),
      document.querySelector(".viewer .main .book")
    ].filter(Boolean);

    let store = null;
    for (const element of elements) {
      store = getVueStoreFromElement(element);
      if (isCompatibleStore(store)) break;
      store = null;
    }

    if (!store) return null;
    const container =
      document.querySelector(".viewer .main .book > .iframe") ||
      document.querySelector(".book > .iframe");
    if (!container) return null;
    return { store: store, container: container };
  }

  function clearTimer(name) {
    if (runtime[name]) {
      window.clearTimeout(runtime[name]);
      runtime[name] = null;
    }
  }

  function requestManagedFrame() {
    return new Promise((resolve) => {
      const frameId = window.requestAnimationFrame(() => {
        runtime.managedFrames.delete(frameId);
        resolve(true);
      });
      runtime.managedFrames.set(frameId, resolve);
    });
  }

  function cancelManagedFrames() {
    for (const [frameId, resolve] of runtime.managedFrames.entries()) {
      window.cancelAnimationFrame(frameId);
      resolve(false);
    }
    runtime.managedFrames.clear();
    if (runtime.positionRaf) {
      window.cancelAnimationFrame(runtime.positionRaf);
      runtime.positionRaf = null;
    }
  }

  async function waitTwoFrames() {
    if (!(await requestManagedFrame())) return false;
    return requestManagedFrame();
  }

  function getReaderBackgroundColor() {
    try {
      const frame = getNativeVisibleFrames()[0];
      const frameBody = frame && frame.contentDocument && frame.contentDocument.body;
      if (frameBody) {
        const frameColor = frame.contentWindow.getComputedStyle(frameBody).backgroundColor;
        if (frameColor && frameColor !== "transparent" && frameColor !== "rgba(0, 0, 0, 0)") {
          return frameColor;
        }
      }
    } catch (error) {
      // Continue with outer reader elements.
    }

    const candidates = [
      runtime.nativeContainer,
      runtime.nativeContainer && runtime.nativeContainer.closest(".viewer"),
      document.body
    ].filter(Boolean);
    for (const element of candidates) {
      const color = window.getComputedStyle(element).backgroundColor;
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
        return color;
      }
    }
    return "#f4f4f4";
  }

  function createOverlayRoot() {
    if (runtime.overlayRoot || !document.body) return;
    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.setAttribute(BUFFER_ATTR, "root");
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:0",
      "height:0",
      "z-index:11",
      "overflow:hidden",
      "pointer-events:none",
      "opacity:0",
      "background:" + getReaderBackgroundColor(),
      "contain:layout paint style",
      "will-change:opacity,transform",
      "transition:none"
    ].join(";");
    document.body.appendChild(root);
    runtime.overlayRoot = root;
    updateOverlayRect();
  }

  function installNativeMaskFix() {
    if (!runtime.nativeContainer || !document.head) return;
    runtime.nativeContainer.setAttribute(NATIVE_CONTAINER_ATTR, "true");
    let style = document.getElementById(MASK_FIX_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = MASK_FIX_STYLE_ID;
      style.textContent =
        "[" + NATIVE_CONTAINER_ATTR + "] > .iframe-mask{" +
        "margin:0!important;margin-top:0!important;margin-bottom:0!important;" +
        "margin-left:0!important;margin-right:0!important}";
      document.head.appendChild(style);
    }
    debugLog("mask-fix.installed", {
      native: nativeGeometrySnapshot()
    });
  }

  function removeNativeMaskFix() {
    if (runtime.nativeContainer) runtime.nativeContainer.removeAttribute(NATIVE_CONTAINER_ATTR);
    const style = document.getElementById(MASK_FIX_STYLE_ID);
    if (style) style.remove();
  }

  function updateOverlayRect() {
    if (!runtime.overlayRoot || !runtime.nativeContainer) return;
    const rect = runtime.nativeContainer.getBoundingClientRect();
    runtime.overlayRoot.style.left = rect.left + "px";
    runtime.overlayRoot.style.top = rect.top + "px";
    runtime.overlayRoot.style.width = rect.width + "px";
    runtime.overlayRoot.style.height = rect.height + "px";
    runtime.overlayRoot.style.backgroundColor = getReaderBackgroundColor();
  }

  function scheduleOverlayPosition() {
    if (!runtime.active || runtime.positionRaf) return;
    runtime.positionRaf = window.requestAnimationFrame(() => {
      runtime.positionRaf = null;
      updateOverlayRect();
    });
  }

  function getNativeVisibleFrames() {
    if (!runtime.nativeContainer) return [];
    return Array.from(runtime.nativeContainer.children).filter((element) => {
      if (element.tagName !== "IFRAME" || element.hasAttribute(BUFFER_ATTR)) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && !element.hidden;
    });
  }

  function inspectNativePageReady(index, expectedUrls) {
    const urls = expectedUrls || getPageUrls(index);
    const report = {
      ready: false,
      reason: "",
      expectedFrames: urls.length,
      visibleFrames: 0
    };
    if (urls.length === 0) {
      report.reason = "NO_PAGE_URLS";
      return report;
    }
    if (!runtime.nativeContainer) {
      report.reason = "NO_NATIVE_CONTAINER";
      return report;
    }

    const frames = getNativeVisibleFrames();
    report.visibleFrames = frames.length;
    if (frames.length !== urls.length) {
      report.reason = "FRAME_COUNT_MISMATCH";
      return report;
    }
    const frameUrls = frames.map((frame) => normalizeUrl(frame.src));
    if (!arraysEqual(frameUrls, urls)) {
      report.reason = "URL_MISMATCH";
      return report;
    }

    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      try {
        const doc = frame.contentDocument;
        const body = doc && doc.body;
        if (!doc || doc.readyState !== "complete" || !body) {
          report.reason = "DOCUMENT_INCOMPLETE";
          report.frameIndex = frameIndex;
          report.readyState = doc ? doc.readyState : "missing";
          return report;
        }
        if (!String(body.style.transform || "").includes("scale(")) {
          report.reason = "FIX_TRANSFORM_MISSING";
          report.frameIndex = frameIndex;
          return report;
        }
        if (frame.getBoundingClientRect().width <= 0 || frame.getBoundingClientRect().height <= 0) {
          report.reason = "FRAME_ZERO_SIZE";
          report.frameIndex = frameIndex;
          return report;
        }
      } catch (error) {
        report.reason = "FRAME_ACCESS_ERROR";
        report.frameIndex = frameIndex;
        return report;
      }
    }

    if (runtime.nativeContainer.querySelector(".iframe-mask")) {
      report.reason = "MASK_PRESENT";
      return report;
    }
    report.ready = true;
    report.reason = "READY";
    return report;
  }

  function nativePageReady(index, expectedUrls) {
    return inspectNativePageReady(index, expectedUrls).ready;
  }

  function computeLayoutSignature() {
    if (!runtime.store || !runtime.nativeContainer) return "";
    const book = runtime.store.state.book;
    const windowState = runtime.store.state.window_state;
    const rect = runtime.nativeContainer.getBoundingClientRect();
    const roundedWidth = Math.round(rect.width * 100) / 100;
    const roundedHeight = Math.round(rect.height * 100) / 100;
    return JSON.stringify([
      String(book.book_id || ""),
      Number(book.cp_id || 0),
      runtime.contentRevision,
      Number(windowState.iframe_w || 0),
      Number(windowState.iframe_h || 0),
      Boolean(windowState.page_type1),
      Number(windowState.zoom || 0),
      Number(window.devicePixelRatio || 1),
      roundedWidth,
      roundedHeight
    ]);
  }

  function createBufferSlot(index) {
    const windowState = runtime.store.state.window_state;
    const width = Number(windowState.iframe_w);
    const height = Number(windowState.iframe_h);
    const logicalWidth = windowState.page_type1 ? width : width * 2;
    const backgroundColor = getReaderBackgroundColor();
    const slot = document.createElement("div");
    slot.setAttribute(BUFFER_ATTR, String(index));
    slot.dataset.status = "LOADING";
    slot.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      "display:flex",
      "flex-direction:row",
      "width:" + logicalWidth + "px",
      "height:" + height + "px",
      "overflow:hidden",
      "opacity:0",
      "pointer-events:none",
      "background:" + backgroundColor,
      "will-change:opacity",
      "transition:none"
    ].join(";");
    return slot;
  }

  function pauseMediaInDocument(doc) {
    if (!doc) return;
    doc.querySelectorAll("audio, video").forEach((media) => {
      try {
        media.autoplay = false;
        media.muted = true;
        media.pause();
      } catch (error) {
        // The visual buffer must never block native reading on media errors.
      }
    });
  }

  function pauseBufferMedia(buffer) {
    if (!buffer || !Array.isArray(buffer.frames)) return;
    for (const frame of buffer.frames) {
      try {
        pauseMediaInDocument(frame.contentDocument);
      } catch (error) {
        // Ignore frames that navigated or became inaccessible.
      }
    }
  }

  function pauseAllBuffers() {
    for (const buffer of runtime.buffers.values()) {
      pauseBufferMedia(buffer);
    }
  }

  function invokeBufferCancelCallbacks(buffer) {
    if (!buffer || !buffer.cancelCallbacks) return;
    for (const cancel of Array.from(buffer.cancelCallbacks)) {
      try {
        cancel();
      } catch (error) {
        // Cleanup is best-effort.
      }
    }
    buffer.cancelCallbacks.clear();
  }

  function removeBufferDom(buffer) {
    if (!buffer) return;
    pauseBufferMedia(buffer);
    for (const frame of buffer.frames || []) {
      try {
        frame.src = "about:blank";
      } catch (error) {
        // Removing the node below is the final cleanup fallback.
      }
    }
    if (buffer.slot && buffer.slot.isConnected) buffer.slot.remove();
    buffer.frames = [];
  }

  function disposeBuffer(buffer, removeFromMap) {
    if (!buffer) return;
    debugLog("buffer.disposed", {
      index: buffer.index,
      status: buffer.status,
      reason: buffer.reason || "",
      ageMs: buffer.startedAt ? Date.now() - buffer.startedAt : null,
      removeFromMap: Boolean(removeFromMap)
    });
    buffer.cancelled = true;
    if (buffer.timeoutId) {
      window.clearTimeout(buffer.timeoutId);
      buffer.timeoutId = null;
    }
    if (buffer.retryTimer) {
      window.clearTimeout(buffer.retryTimer);
      buffer.retryTimer = null;
    }
    invokeBufferCancelCallbacks(buffer);
    removeBufferDom(buffer);
    if (removeFromMap && runtime.buffers.get(buffer.index) === buffer) {
      runtime.buffers.delete(buffer.index);
    }
  }

  function clearAllBuffers() {
    for (const buffer of Array.from(runtime.buffers.values())) {
      disposeBuffer(buffer, false);
    }
    runtime.buffers.clear();
  }

  function settleWithin(promise, timeoutMs, buffer) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timerId);
        buffer.cancelCallbacks.delete(cancel);
        resolve(Boolean(timedOut));
      };
      const cancel = () => finish(true);
      const timerId = window.setTimeout(() => finish(true), timeoutMs);
      buffer.cancelCallbacks.add(cancel);
      Promise.resolve(promise).then(
        () => finish(false),
        () => finish(false)
      );
    });
  }

  function waitForImage(image) {
    if (image.complete) {
      if (typeof image.decode === "function") return image.decode().catch(() => {});
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    });
  }

  async function waitForAssets(doc, buffer, frameIndex) {
    const startedAt = Date.now();
    const images = Array.from(doc.images || []);
    debugLog("assets.wait", {
      index: buffer.index,
      frameIndex: frameIndex,
      images: images.length,
      incompleteImages: images.filter((image) => !image.complete).length,
      fontStatus: doc.fonts && doc.fonts.status ? doc.fonts.status : "unknown"
    });
    images.forEach((image) => {
      if (String(image.loading || "").toLowerCase() === "lazy") image.loading = "eager";
    });
    const tasks = images.map(waitForImage);
    if (doc.fonts && doc.fonts.ready) tasks.push(doc.fonts.ready);
    const timedOut = await settleWithin(
      Promise.allSettled(tasks),
      ASSET_SETTLE_TIMEOUT_MS,
      buffer
    );
    if (timedOut) throw new Error("BUFFER_ASSETS_TIMEOUT");
    if (doc.fonts && doc.fonts.status && doc.fonts.status !== "loaded") {
      throw new Error("BUFFER_FONTS_NOT_READY");
    }
    for (const image of images) {
      const hasSource = Boolean(image.currentSrc || image.getAttribute("src"));
      if (!image.complete || (hasSource && Number(image.naturalWidth || 0) <= 0)) {
        throw new Error("BUFFER_IMAGE_NOT_READY");
      }
    }
    debugLog("assets.ready", {
      index: buffer.index,
      frameIndex: frameIndex,
      elapsedMs: Date.now() - startedAt,
      images: images.length,
      dimensions: images.slice(0, 4).map((image) => [
        Number(image.naturalWidth || 0),
        Number(image.naturalHeight || 0)
      ]),
      fontStatus: doc.fonts && doc.fonts.status ? doc.fonts.status : "unknown"
    });
  }

  function visualLayoutSample(doc) {
    const body = doc.body;
    const html = doc.documentElement;
    const rect = body.getBoundingClientRect();
    return [
      Math.round(rect.width * 100) / 100,
      Math.round(rect.height * 100) / 100,
      body.scrollWidth,
      body.scrollHeight,
      html.scrollWidth,
      html.scrollHeight
    ];
  }

  async function waitForStableVisualLayout(doc, buffer) {
    let previous = null;
    let stableCount = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (!(await requestManagedFrame())) throw new Error("BUFFER_CANCELLED");
      if (buffer.cancelled || buffer.epoch !== runtime.epoch) {
        throw new Error("BUFFER_CANCELLED");
      }
      const current = visualLayoutSample(doc);
      if (previous && arraysEqual(previous, current)) {
        stableCount += 1;
        if (stableCount >= 2) return;
      } else {
        stableCount = 0;
      }
      previous = current;
    }
    throw new Error("BUFFER_LAYOUT_UNSTABLE");
  }

  function applyStyleObject(element, styles) {
    if (!element || !styles) return;
    for (const [property, value] of Object.entries(styles)) {
      if (value === null || typeof value === "undefined") continue;
      element.style.setProperty(property, String(value));
    }
  }

  function addBufferWatermark(doc) {
    if (!doc || !doc.body) return;
    doc.querySelectorAll(".hami-epubfix-buffer-watermark").forEach((node) => node.remove());
    let memberId = "";
    try {
      memberId = String(runtime.store.getters["user/getMemberid"] || "");
    } catch (error) {
      memberId = "";
    }
    if (!memberId) return;

    const watermark = doc.createElement("span");
    watermark.className = "bookWatermark hami-epubfix-buffer-watermark";
    watermark.textContent = memberId;
    watermark.style.cssText = [
      "position:fixed",
      "top:calc(50% - 20px)",
      "left:45%",
      "color:#f5f5f5",
      "opacity:0.1",
      "z-index:9999",
      "font-size:20px",
      "pointer-events:none"
    ].join(";");
    doc.body.appendChild(watermark);
  }

  function getVisualBodyStyle(singleLargeImage) {
    const book = runtime.store.state.book;
    const windowState = runtime.store.state.window_state;
    let bodyStyle = null;
    try {
      const getter = runtime.store.getters["window_state/getEPub_FixSubIframeStyle"];
      const result = typeof getter === "function" ? getter(book.cp_id) : null;
      bodyStyle = result && result.body ? Object.assign({}, result.body) : null;
    } catch (error) {
      bodyStyle = null;
    }

    if (!bodyStyle) {
      bodyStyle = {
        width: "auto",
        height: "auto",
        "-webkit-touch-callout": "none",
        "-webkit-user-select": "none",
        "transform-origin": "0 0",
        "-webkit-transform-origin": "0 0",
        "background-position": "left top",
        "background-color": "#f4f4f4",
        overflow: "hidden"
      };
    }

    const iframeWidth = Number(windowState.iframe_w || 0);
    const iframeHeight = Number(windowState.iframe_h || 0);
    const tmpWidth = Number(windowState.tmp_w || 768);
    const tmpHeight = Number(windowState.tmp_h || 1024);
    const predictedSingleImage = Boolean(windowState.epubfix_single_img || singleLargeImage);
    let scale = Math.min(iframeWidth / tmpWidth, iframeHeight / tmpHeight);
    if (
      predictedSingleImage &&
      RESTRICTED_SINGLE_IMAGE_CP_IDS.has(Number(book.cp_id))
    ) {
      scale = 1;
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;

    bodyStyle.transform = "scale(" + scale + ")";
    bodyStyle["-webkit-transform"] = "scale(" + scale + ")";
    bodyStyle["transform-origin"] = "0 0";
    bodyStyle["-webkit-transform-origin"] = "0 0";
    bodyStyle["background-size"] = iframeWidth + "px " + iframeHeight + "px";
    return bodyStyle;
  }

  async function prepareFrame(frame, expectedUrl, buffer, frameIndex) {
    if (buffer.cancelled || buffer.epoch !== runtime.epoch) {
      throw new Error("BUFFER_CANCELLED");
    }

    let doc;
    try {
      doc = frame.contentDocument;
      if (
        !doc ||
        !doc.body ||
        doc.readyState !== "complete" ||
        new URL(doc.URL).origin !== window.location.origin
      ) {
        throw new Error("CROSS_ORIGIN_OR_INCOMPLETE");
      }
    } catch (error) {
      throw new Error("CROSS_ORIGIN_OR_INCOMPLETE");
    }

    pauseMediaInDocument(doc);
    await waitForAssets(doc, buffer, frameIndex);
    if (buffer.cancelled || buffer.epoch !== runtime.epoch) {
      throw new Error("BUFFER_CANCELLED");
    }

    const images = Array.from(doc.images || []);
    const tmpHeight = Number(runtime.store.state.window_state.tmp_h || 1024);
    const singleLargeImage =
      images.length === 1 && Number(images[0].naturalHeight || 0) > tmpHeight;

    const visualStyle = getVisualBodyStyle(singleLargeImage);
    applyStyleObject(doc.body, visualStyle);
    addBufferWatermark(doc);
    pauseMediaInDocument(doc);

    await waitForStableVisualLayout(doc, buffer);
    if (buffer.cancelled || buffer.epoch !== runtime.epoch) {
      throw new Error("BUFFER_CANCELLED");
    }
    if (
      normalizeUrl(frame.src) !== expectedUrl ||
      !String(doc.body.style.transform || "").includes("scale(")
    ) {
      throw new Error("BUFFER_VISUAL_FIX_FAILED");
    }
    debugLog("frame.fixed", {
      index: buffer.index,
      frameIndex: frameIndex,
      singleLargeImage: singleLargeImage,
      transform: String(visualStyle.transform || ""),
      visual: frameVisualSnapshot(frame)
    });
  }

  function loadAndPrepareFrame(frame, expectedUrl, buffer, frameIndex) {
    return new Promise((resolve, reject) => {
      let finished = false;

      function cleanup() {
        frame.removeEventListener("load", onLoad);
        frame.removeEventListener("error", onError);
        buffer.cancelCallbacks.delete(onCancel);
      }

      function finishWithError(error) {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      }

      function onCancel() {
        finishWithError(new Error("BUFFER_CANCELLED"));
      }

      function onError() {
        finishWithError(new Error("BUFFER_FRAME_LOAD_FAILED"));
      }

      async function onLoad() {
        if (finished) return;
        try {
          const locationHref = frame.contentWindow && frame.contentWindow.location.href;
          if (locationHref === "about:blank") return;
        } catch (error) {
          finishWithError(new Error("CROSS_ORIGIN_BUFFER"));
          return;
        }

        try {
          debugLog("frame.loaded", {
            index: buffer.index,
            frameIndex: frameIndex,
            elapsedMs: buffer.startedAt ? Date.now() - buffer.startedAt : null,
            visual: frameVisualSnapshot(frame)
          });
          await prepareFrame(frame, expectedUrl, buffer, frameIndex);
          if (finished) return;
          finished = true;
          cleanup();
          resolve();
        } catch (error) {
          finishWithError(error);
        }
      }

      buffer.cancelCallbacks.add(onCancel);
      frame.addEventListener("load", onLoad);
      frame.addEventListener("error", onError);
      frame.src = expectedUrl;
    });
  }

  function refreshBufferPhase() {
    if (!runtime.active || runtime.transition) return;
    const current = getCurrentIndex();
    if (current === null) return;
    if (
      (runtime.phase === "FALLBACK" || runtime.phase === "SYNCING") &&
      !nativePageReady(current)
    ) {
      return;
    }
    const desired = desiredBufferIndexes(current).filter(
      (index) => Math.abs(index - current) === 1
    );
    if (desired.length === 0) {
      setPhase("READY");
      return;
    }

    const records = desired.map((index) => runtime.buffers.get(index)).filter(Boolean);
    if (records.some((buffer) => buffer.status === "READY")) {
      setPhase("READY");
    } else if (records.some((buffer) => buffer.status === "LOADING")) {
      setPhase("BUFFERING");
    } else {
      const failed = records.find((buffer) => buffer.status === "ERROR" && buffer.reason);
      setPhase("FALLBACK", failed ? failed.reason : "BUFFER_NOT_READY");
    }
  }

  function failBuffer(buffer, reason) {
    if (
      !buffer ||
      buffer.cancelled ||
      runtime.buffers.get(buffer.index) !== buffer
    ) {
      return;
    }
    buffer.status = "ERROR";
    buffer.reason = reason;
    buffer.cancelled = true;
    debugLog("buffer.failed", {
      index: buffer.index,
      reason: reason,
      retry: buffer.retryCount,
      elapsedMs: buffer.startedAt ? Date.now() - buffer.startedAt : null
    }, "warn");
    if (buffer.timeoutId) {
      window.clearTimeout(buffer.timeoutId);
      buffer.timeoutId = null;
    }
    invokeBufferCancelCallbacks(buffer);
    removeBufferDom(buffer);
    refreshBufferPhase();

    const permanentReasons = new Set([
      "CROSS_ORIGIN_BUFFER",
      "CROSS_ORIGIN_OR_INCOMPLETE"
    ]);
    if (buffer.retryCount < 1 && !permanentReasons.has(reason)) {
      buffer.retryTimer = window.setTimeout(() => {
        buffer.retryTimer = null;
        const current = getCurrentIndex();
        if (
          runtime.active &&
          runtime.buffers.get(buffer.index) === buffer &&
          current !== null &&
          Math.abs(buffer.index - current) === 1 &&
          computeLayoutSignature() === buffer.signature
        ) {
          runtime.buffers.delete(buffer.index);
          buildBuffer(buffer.index, buffer.signature, buffer.retryCount + 1);
          refreshBufferPhase();
        }
      }, 1000);
    }
  }

  function buildBuffer(index, signature, retryCount) {
    if (
      !runtime.active ||
      !runtime.overlayRoot ||
      !isValidPageIndex(index) ||
      runtime.buffers.has(index)
    ) {
      return;
    }

    const urls = getPageUrls(index);
    if (urls.length === 0) return;
    const slot = createBufferSlot(index);
    const buffer = {
      index: index,
      urls: urls,
      signature: signature,
      epoch: runtime.epoch,
      startedAt: Date.now(),
      status: "LOADING",
      reason: "",
      cancelled: false,
      slot: slot,
      frames: [],
      timeoutId: null,
      retryTimer: null,
      retryCount: Number(retryCount) || 0,
      cancelCallbacks: new Set()
    };
    runtime.buffers.set(index, buffer);
    runtime.overlayRoot.appendChild(slot);

    const windowState = runtime.store.state.window_state;
    const backgroundColor = getReaderBackgroundColor();
    const width = Number(windowState.iframe_w);
    const height = Number(windowState.iframe_h);
    debugLog("buffer.started", {
      index: index,
      relativeToCurrent: index - Number(getCurrentIndex()),
      retry: buffer.retryCount,
      frameCount: urls.length,
      iframeWidth: width,
      iframeHeight: height,
      sourceWidth: Number(windowState.tmp_w || 0),
      sourceHeight: Number(windowState.tmp_h || 0),
      singlePage: Boolean(windowState.page_type1),
      zoom: Number(windowState.zoom || 0)
    });
    for (let pageIndex = 0; pageIndex < urls.length; pageIndex += 1) {
      const frame = document.createElement("iframe");
      frame.setAttribute(BUFFER_ATTR, String(index));
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("scrolling", "no");
      frame.setAttribute("loading", "eager");
      frame.setAttribute("allow", "autoplay 'none'");
      frame.style.cssText = [
        "display:block",
        "flex:0 0 " + width + "px",
        "width:" + width + "px",
        "height:" + height + "px",
        "margin:0",
        "padding:0",
        "border:0",
        "pointer-events:none",
        "background:" + backgroundColor
      ].join(";");
      buffer.frames.push(frame);
      slot.appendChild(frame);
    }

    buffer.timeoutId = window.setTimeout(() => {
      failBuffer(buffer, "BUFFER_PREPARE_TIMEOUT");
    }, BUFFER_TIMEOUT_MS);

    Promise.all(
      buffer.frames.map((frame, frameIndex) =>
        loadAndPrepareFrame(frame, urls[frameIndex], buffer, frameIndex)
      )
    )
      .then(() => {
        if (
          buffer.cancelled ||
          buffer.epoch !== runtime.epoch ||
          runtime.buffers.get(index) !== buffer
        ) {
          return;
        }
        if (buffer.timeoutId) {
          window.clearTimeout(buffer.timeoutId);
          buffer.timeoutId = null;
        }
        buffer.status = "READY";
        buffer.slot.dataset.status = "READY";
        debugLog("buffer.ready", {
          index: buffer.index,
          elapsedMs: Date.now() - buffer.startedAt,
          frames: buffer.frames.map(frameVisualSnapshot)
        });
        const currentIndex = getCurrentIndex();
        const currentSignature = computeLayoutSignature();
        if (
          currentIndex === buffer.index &&
          !runtime.transition &&
          buffer.signature === currentSignature &&
          arraysEqual(buffer.urls, getPageUrls(currentIndex)) &&
          !nativePageReady(currentIndex, buffer.urls)
        ) {
          debugLog("page.late-buffer-hit", {
            target: currentIndex,
            elapsedMs: Date.now() - buffer.startedAt
          });
          beginHandoff(buffer, currentIndex, currentSignature);
          return;
        }
        refreshBufferPhase();
      })
      .catch((error) => {
        if (String(error && error.message) !== "BUFFER_CANCELLED") {
          failBuffer(buffer, String(error && error.message) || "BUFFER_PREPARE_FAILED");
        }
      });
  }

  function reconcileBuffers(currentIndex, signature, protectedBuffer, updatePhase) {
    const protectedRecord =
      protectedBuffer &&
      runtime.buffers.get(protectedBuffer.index) === protectedBuffer &&
      protectedBuffer.signature === signature &&
      protectedBuffer.status !== "ERROR" &&
      arraysEqual(protectedBuffer.urls, getPageUrls(currentIndex))
        ? protectedBuffer
        : null;
    const reservedFrames = protectedRecord ? protectedRecord.frames.length : 0;
    const desired = desiredBufferIndexes(
      currentIndex,
      reservedFrames,
      MAX_LOGICAL_BUFFERS - (protectedRecord ? 1 : 0)
    );
    const desiredSet = new Set(desired);

    for (const buffer of Array.from(runtime.buffers.values())) {
      if (
        buffer !== protectedRecord &&
        (!desiredSet.has(buffer.index) || buffer.signature !== signature)
      ) {
        disposeBuffer(buffer, true);
      }
    }

    // Start the most likely direction first, then its opposite and the second layer.
    for (const index of desired) {
      if (!runtime.buffers.has(index)) buildBuffer(index, signature);
    }

    while (runtime.buffers.size > MAX_LOGICAL_BUFFERS) {
      const oldest = Array.from(runtime.buffers.values()).find(
        (buffer) => buffer !== protectedRecord
      );
      if (!oldest) break;
      disposeBuffer(oldest, true);
    }
    if (updatePhase !== false) refreshBufferPhase();
  }

  function hideOverlay() {
    if (!runtime.overlayRoot) return;
    runtime.overlayRoot.style.opacity = "0";
    for (const buffer of runtime.buffers.values()) {
      if (buffer.slot) buffer.slot.style.opacity = "0";
    }
  }

  function cancelHandoff(reason, clearBuffers) {
    const transition = runtime.transition;
    runtime.transitionSerial += 1;
    if (transition) {
      debugLog("handoff.cancelled", {
        target: transition.index,
        reason: reason || "CANCELLED",
        elapsedMs: transition.startedAt ? Date.now() - transition.startedAt : null,
        nativeBlocker: transition.nativeBlocker || "",
        clearBuffers: Boolean(clearBuffers),
        bufferVisual: transition.buffer
          ? transition.buffer.frames.map(frameVisualSnapshot)
          : [],
        native: nativeGeometrySnapshot()
      }, "warn");
      if (transition.timeoutId) window.clearTimeout(transition.timeoutId);
      if (transition.pollId) window.clearInterval(transition.pollId);
    }
    runtime.transition = null;
    hideOverlay();
    if (clearBuffers) {
      clearAllBuffers();
    } else if (transition && transition.buffer) {
      disposeBuffer(transition.buffer, true);
    }
    if (reason && runtime.active) setPhase("FALLBACK", reason);
  }

  function completeHandoff(success, reason) {
    const transition = runtime.transition;
    if (!transition) return;
    debugLog("handoff.completed", {
      target: transition.index,
      success: Boolean(success),
      reason: reason || "",
      elapsedMs: transition.startedAt ? Date.now() - transition.startedAt : null,
      nativeReadyAfterMs: transition.nativeReadyAt
        ? transition.nativeReadyAt - transition.startedAt
        : null,
      lastNativeBlocker: transition.nativeBlocker || "",
      native: nativeGeometrySnapshot()
    }, success ? "info" : "warn");
    if (transition.timeoutId) window.clearTimeout(transition.timeoutId);
    if (transition.pollId) window.clearInterval(transition.pollId);
    runtime.transition = null;
    hideOverlay();

    if (transition.buffer) disposeBuffer(transition.buffer, true);
    if (!success) clearAllBuffers();
    setPhase(success ? "SYNCING" : "FALLBACK", success ? "" : reason);
    scheduleSync(success ? 0 : SYNC_RETRY_MS);
  }

  function checkHandoff() {
    const transition = runtime.transition;
    if (
      !transition ||
      transition.token !== runtime.transitionSerial ||
      transition.epoch !== runtime.epoch
    ) {
      return;
    }

    if (computeLayoutSignature() !== transition.signature) {
      completeHandoff(false, "LAYOUT_CHANGED_DURING_HANDOFF");
      return;
    }
    const readiness = inspectNativePageReady(transition.index, transition.urls);
    if (readiness.reason !== transition.nativeBlocker) {
      transition.nativeBlocker = readiness.reason;
      debugLog("handoff.native-status", {
        target: transition.index,
        elapsedMs: Date.now() - transition.startedAt,
        readiness: readiness,
        native: nativeGeometrySnapshot()
      });
    }
    if (!readiness.ready) return;
    if (!transition.nativeReadyAt) transition.nativeReadyAt = Date.now();
    if (transition.confirming) return;

    transition.confirming = true;
    waitTwoFrames().then((completed) => {
      const current = runtime.transition;
      if (
        !completed ||
        !current ||
        current.token !== transition.token ||
        computeLayoutSignature() !== transition.signature ||
        !nativePageReady(transition.index, transition.urls)
      ) {
        if (current && current.token === transition.token) current.confirming = false;
        return;
      }
      completeHandoff(true);
    });
  }

  function beginHandoff(buffer, targetIndex, signature) {
    if (!runtime.overlayRoot || !buffer.slot) return false;
    cancelHandoff("", false);
    const token = runtime.transitionSerial;
    updateOverlayRect();
    const handoffBackground = getReaderBackgroundColor();
    runtime.overlayRoot.style.backgroundColor = handoffBackground;
    buffer.slot.style.backgroundColor = handoffBackground;
    for (const frame of buffer.frames) frame.style.backgroundColor = handoffBackground;
    for (const record of runtime.buffers.values()) {
      if (record.slot) record.slot.style.opacity = record === buffer ? "1" : "0";
    }
    runtime.overlayRoot.style.opacity = "1";
    buffer.status = "CONSUMED";
    buffer.slot.dataset.status = "CONSUMED";

    const transition = {
      token: token,
      epoch: runtime.epoch,
      index: targetIndex,
      urls: buffer.urls.slice(),
      signature: signature,
      buffer: buffer,
      confirming: false,
      startedAt: Date.now(),
      nativeReadyAt: null,
      nativeBlocker: "",
      timeoutId: null,
      pollId: null
    };
    runtime.transition = transition;
    setPhase("HANDOFF");
    debugLog("handoff.started", {
      target: targetIndex,
      bufferAgeMs: buffer.startedAt ? Date.now() - buffer.startedAt : null,
      bufferVisual: buffer.frames.map(frameVisualSnapshot),
      overlayRect: rectSnapshot(runtime.overlayRoot),
      slotRect: rectSnapshot(buffer.slot),
      native: nativeGeometrySnapshot()
    });
    // Do not wait for native FIX to finish before rolling the preload window.
    // Keeping the consumed page protected lets a rapid second/third turn reuse
    // READY or still-LOADING neighbours instead of clearing them.
    reconcileBuffers(targetIndex, signature, buffer);
    transition.timeoutId = window.setTimeout(() => {
      if (runtime.transition === transition) {
        completeHandoff(false, "HANDOFF_TIMEOUT");
      }
    }, HANDOFF_TIMEOUT_MS);
    transition.pollId = window.setInterval(checkHandoff, HANDOFF_POLL_MS);
    checkHandoff();
    return true;
  }

  function handlePageChange() {
    if (!runtime.active || !runtime.store) return;
    const targetIndex = getCurrentIndex();
    const previousIndex = runtime.currentPage;
    if (targetIndex === null || targetIndex === previousIndex) return;

    const targetBefore = runtime.buffers.get(targetIndex);
    const interruptedHandoff = Boolean(runtime.transition);
    const direction = targetIndex > previousIndex ? 1 : -1;
    debugLog("page.changed", {
      from: previousIndex,
      to: targetIndex,
      direction: direction > 0 ? "next" : "previous",
      hadHandoff: Boolean(runtime.transition),
      targetBufferStatus: targetBefore ? targetBefore.status : "MISSING",
      buffersBefore: bufferListSnapshot(),
      native: nativeGeometrySnapshot()
    });

    runtime.currentPage = targetIndex;
    runtime.lastPageDirection = direction;
    runtime.syncConfirmToken += 1;
    runtime.syncConfirmKey = "";
    if (runtime.transition) cancelHandoff("INTERRUPTED_BY_NEW_PAGE", false);

    const signature = computeLayoutSignature();
    const targetUrls = getPageUrls(targetIndex);
    const buffer = runtime.buffers.get(targetIndex);
    if (
      buffer &&
      buffer.status === "READY" &&
      buffer.signature === signature &&
      arraysEqual(buffer.urls, targetUrls)
    ) {
      debugLog("page.buffer-hit", {
        target: targetIndex,
        bufferAgeMs: buffer.startedAt ? Date.now() - buffer.startedAt : null
      });
      beginHandoff(buffer, targetIndex, signature);
      return;
    }

    debugLog("page.fallback", {
      target: targetIndex,
      reason: "BUFFER_MISS",
      targetBufferStatus: buffer ? buffer.status : "MISSING",
      interruptedHandoff: interruptedHandoff,
      buffersAfterInterrupt: bufferListSnapshot(),
      native: nativeGeometrySnapshot()
    }, "warn");
    hideOverlay();
    setPhase("FALLBACK", "BUFFER_MISS");
    // Prime the next window immediately. If the current target was already
    // LOADING, protect it so its completion can still become a late handoff.
    reconcileBuffers(targetIndex, signature, buffer, false);
    scheduleSync(SYNC_RETRY_MS);
  }

  function scheduleSync(delayMs) {
    if (!runtime.active || !runtime.store) return;
    clearTimer("syncTimer");
    runtime.syncTimer = window.setTimeout(() => {
      runtime.syncTimer = null;
      syncNow();
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function confirmNativeAndBuild(index, signature, confirmToken) {
    let succeeded = false;
    try {
      if (!(await waitTwoFrames())) return;
      if (
        !runtime.active ||
        runtime.transition ||
        confirmToken !== runtime.syncConfirmToken ||
        computeLayoutSignature() !== signature ||
        getCurrentIndex() !== index ||
        !nativePageReady(index)
      ) {
        return;
      }
      runtime.layoutSignature = signature;
      runtime.currentPage = index;
      reconcileBuffers(index, signature);
      succeeded = true;
    } finally {
      if (confirmToken === runtime.syncConfirmToken) {
        runtime.syncConfirmKey = "";
        if (!succeeded && runtime.active && !runtime.transition) {
          scheduleSync(SYNC_RETRY_MS);
        }
      }
    }
  }

  function syncNow() {
    if (!runtime.active || !runtime.store || runtime.transition) return;
    if (document.visibilityState === "hidden") {
      setPhase("WAITING_VISIBLE");
      return;
    }

    const book = runtime.store.state.book;
    if (book.content_obj !== runtime.contentRef) {
      runtime.contentRef = book.content_obj;
      runtime.contentRevision += 1;
      clearAllBuffers();
    }

    const currentIndex = getCurrentIndex();
    if (!isValidPageIndex(currentIndex)) {
      runtime.syncConfirmToken += 1;
      runtime.syncConfirmKey = "";
      setPhase("SYNCING", "WAITING_FOR_PAGE_DATA");
      scheduleSync(SYNC_RETRY_MS);
      return;
    }

    runtime.currentPage = currentIndex;
    updateOverlayRect();
    const nativeReadiness = inspectNativePageReady(currentIndex);
    if (!nativeReadiness.ready) {
      if (nativeReadiness.reason !== runtime.lastNativeBlocker) {
        runtime.lastNativeBlocker = nativeReadiness.reason;
        debugLog("native.wait", {
          index: currentIndex,
          readiness: nativeReadiness,
          native: nativeGeometrySnapshot()
        });
      }
      runtime.syncConfirmToken += 1;
      runtime.syncConfirmKey = "";
      setPhase("SYNCING", "WAITING_FOR_NATIVE_FIX");
      scheduleSync(SYNC_RETRY_MS);
      return;
    }
    if (runtime.lastNativeBlocker !== "READY") {
      debugLog("native.ready", {
        index: currentIndex,
        previousBlocker: runtime.lastNativeBlocker,
        native: nativeGeometrySnapshot()
      });
      runtime.lastNativeBlocker = "READY";
    }

    const signature = computeLayoutSignature();
    const confirmKey = currentIndex + "|" + signature;
    if (runtime.syncConfirmKey === confirmKey) return;
    runtime.syncConfirmKey = confirmKey;
    const confirmToken = ++runtime.syncConfirmToken;
    confirmNativeAndBuild(currentIndex, signature, confirmToken);
  }

  function invalidateLayout(reason, delayMs) {
    if (!runtime.active) return;
    debugLog("layout.invalidated", {
      reason: reason,
      delayMs: Number(delayMs) || 0,
      buffers: bufferListSnapshot(),
      native: nativeGeometrySnapshot()
    });
    clearTimer("layoutTimer");
    runtime.syncConfirmToken += 1;
    runtime.syncConfirmKey = "";
    cancelHandoff(reason, true);
    setPhase("SYNCING", reason);
    runtime.layoutTimer = window.setTimeout(() => {
      runtime.layoutTimer = null;
      scheduleSync(0);
    }, Math.max(0, Number(delayMs) || 0));
  }

  function onStoreMutation(mutation) {
    if (!runtime.active || !mutation) return;
    try {
      if (mutation.type === "book/changePage") {
        handlePageChange();
        return;
      }
      if (mutation.type === "book/setContentObj") {
        runtime.contentRef = runtime.store.state.book.content_obj;
        runtime.contentRevision += 1;
        invalidateLayout("CONTENT_CHANGED", 0);
        return;
      }
      const layoutMutations = new Set([
        "window_state/setIframeW",
        "window_state/setIframeH",
        "window_state/setPageType1",
        "window_state/setZoom",
        "window_state/setDefaultWH",
        "window_state/setWindowWH"
      ]);
      if (layoutMutations.has(mutation.type)) {
        invalidateLayout("LAYOUT_CHANGED", LAYOUT_DEBOUNCE_MS);
      }
    } catch (error) {
      enterDegraded("STORE_SUBSCRIBER_FAILED");
    }
  }

  function onNativeMutation() {
    if (!runtime.active) return;
    if (runtime.transition) {
      checkHandoff();
    } else {
      scheduleSync(0);
    }
  }

  function onWindowResize() {
    invalidateLayout("WINDOW_RESIZED", LAYOUT_DEBOUNCE_MS);
  }

  function onAnyScroll() {
    scheduleOverlayPosition();
  }

  function onVisibilityChange() {
    if (!runtime.active) return;
    if (document.visibilityState === "hidden") {
      clearTimer("discoveryTimer");
      clearTimer("syncTimer");
      cancelHandoff("TAB_HIDDEN", true);
      pauseAllBuffers();
      setPhase("WAITING_VISIBLE");
      return;
    }
    if (!runtime.store) {
      beginDiscovery();
    } else {
      scheduleSync(0);
    }
  }

  function attachRuntime(found) {
    runtime.store = found.store;
    runtime.nativeContainer = found.container;
    runtime.contentRef = found.store.state.book.content_obj;
    runtime.contentRevision += 1;
    runtime.currentPage = Number(found.store.state.book.current_page);
    runtime.lastNativeBlocker = "";
    installNativeMaskFix();
    createOverlayRoot();
    if (!runtime.overlayRoot) {
      enterDegraded("OVERLAY_ROOT_UNAVAILABLE");
      return;
    }

    runtime.unsubscribeStore = runtime.store.subscribe(onStoreMutation);
    runtime.nativeObserver = new MutationObserver(onNativeMutation);
    runtime.nativeObserver.observe(runtime.nativeContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "style", "class"]
    });
    if (typeof ResizeObserver === "function") {
      runtime.resizeObserver = new ResizeObserver(() => {
        invalidateLayout("CONTAINER_RESIZED", LAYOUT_DEBOUNCE_MS);
      });
      runtime.resizeObserver.observe(runtime.nativeContainer);
    }
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("scroll", onAnyScroll, true);
    debugLog("runtime.attached", {
      currentPage: runtime.currentPage,
      native: nativeGeometrySnapshot()
    });
    setPhase("SYNCING");
    scheduleSync(0);
  }

  function attemptDiscovery(epoch) {
    if (!runtime.active || runtime.epoch !== epoch) return;
    if (document.visibilityState === "hidden") {
      setPhase("WAITING_VISIBLE");
      return;
    }

    const found = findStoreAndContainer();
    if (found) {
      runtime.discoveryTimer = null;
      attachRuntime(found);
      return;
    }

    if (Date.now() - runtime.discoveryStartedAt >= DISCOVERY_TIMEOUT_MS) {
      runtime.discoveryTimer = null;
      enterDegraded("VUE_STORE_NOT_FOUND");
      return;
    }
    runtime.discoveryTimer = window.setTimeout(() => {
      runtime.discoveryTimer = null;
      attemptDiscovery(epoch);
    }, SYNC_RETRY_MS);
  }

  function beginDiscovery() {
    clearTimer("discoveryTimer");
    runtime.discoveryStartedAt = Date.now();
    setPhase("DISCOVERING");
    attemptDiscovery(runtime.epoch);
  }

  function teardownRuntime() {
    runtime.epoch += 1;
    runtime.transitionSerial += 1;
    runtime.syncConfirmToken += 1;
    runtime.syncConfirmKey = "";
    runtime.active = false;

    clearTimer("discoveryTimer");
    clearTimer("syncTimer");
    clearTimer("layoutTimer");
    cancelManagedFrames();
    cancelHandoff("", false);
    clearAllBuffers();

    if (runtime.unsubscribeStore) {
      try {
        runtime.unsubscribeStore();
      } catch (error) {
        // Vuex cleanup is best-effort during page teardown.
      }
      runtime.unsubscribeStore = null;
    }
    if (runtime.nativeObserver) {
      runtime.nativeObserver.disconnect();
      runtime.nativeObserver = null;
    }
    if (runtime.resizeObserver) {
      runtime.resizeObserver.disconnect();
      runtime.resizeObserver = null;
    }

    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener("scroll", onAnyScroll, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);

    if (runtime.overlayRoot && runtime.overlayRoot.isConnected) {
      runtime.overlayRoot.remove();
    }
    removeNativeMaskFix();
    runtime.overlayRoot = null;
    runtime.store = null;
    runtime.nativeContainer = null;
    runtime.contentRef = null;
    runtime.currentPage = null;
    runtime.lastPageDirection = 1;
    runtime.layoutSignature = "";
    runtime.lastNativeBlocker = "";
    runtime.transition = null;
  }

  function enterDegraded(reason) {
    teardownRuntime();
    setPhase("DEGRADED", reason);
    console.warn("[HamiBook EPUBFIX] 已回退原生翻頁：", reason);
  }

  function stopRuntime() {
    teardownRuntime();
    setPhase("DISABLED");
  }

  function startRuntime() {
    if (!runtime.supported || !runtime.enabled || runtime.active) return;
    runtime.active = true;
    runtime.epoch += 1;
    runtime.reason = "";
    debugLog("runtime.started", {
      epoch: runtime.epoch,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      }
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState === "hidden") {
      setPhase("WAITING_VISIBLE");
      return;
    }
    beginDiscovery();
  }

  function onStorage(event) {
    if (event.key !== STORAGE_KEY || !runtime.supported) return;
    const enabled = event.newValue === "1";
    if (runtime.enabled === enabled) return;
    runtime.enabled = enabled;
    if (enabled) startRuntime();
    else stopRuntime();
  }

  function onPageHide() {
    teardownRuntime();
    setPhase(runtime.enabled ? "WAITING_VISIBLE" : "DISABLED");
  }

  function onPageShow() {
    if (runtime.supported && runtime.enabled && !runtime.active) startRuntime();
  }

  runtime.enabled = readEnabledSetting();
  debugLog("controller.loaded", {
    supported: runtime.supported,
    enabled: runtime.enabled
  });
  if (!runtime.supported) setPhase("UNSUPPORTED");

  document.addEventListener(COMMAND_EVENT, onCommand);
  window.addEventListener("storage", onStorage);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  if (runtime.supported && runtime.enabled) startRuntime();
})();
