/**
 * BINANCE SQUARE — NETWORK INTERCEPTOR
 * =====================================
 * Вставь этот код в Chrome DevTools → Console
 * на странице: https://www.binanceuz.co/en/square/profile/binance_news
 *
 * Скрипт перехватывает ВСЕ сетевые запросы (fetch, XHR, WebSocket)
 * и показывает только те, что связаны с постами/фидом Square.
 *
 * ИНСТРУКЦИЯ:
 * 1. Открой https://www.binanceuz.co/en/square/profile/binance_news
 * 2. Открой DevTools (F12) → Console
 * 3. Вставь ВЕСЬ код ниже и нажми Enter
 * 4. Прокрути страницу вниз или подожди загрузки постов
 * 5. Скопируй вывод из консоли и отправь мне
 */

(function () {
  'use strict';

  const CAPTURE = window.__BNB_CAPTURE__ = {
    requests: [],
    ws_messages: [],
    log(type, data) {
      this.requests.push({ type, ...data });
      const isRelevant = /square|feed|post|profile|article|news|content|creator/i.test(
        JSON.stringify(data).substring(0, 500)
      );
      if (isRelevant) {
        console.group(`%c🎯 [${type}] RELEVANT`, 'color:#00ff88;font-weight:bold');
        console.log('URL:', data.url);
        if (data.method) console.log('Method:', data.method);
        if (data.requestBody) console.log('Request body:', data.requestBody);
        if (data.response) console.log('Response (first 2000 chars):', JSON.stringify(data.response).substring(0, 2000));
        console.log('Full data:', data);
        console.groupEnd();
      }
    }
  };

  // ── 1. Intercept fetch ────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const method = init?.method || 'GET';
    const requestBody = init?.body ? (() => {
      try { return JSON.parse(init.body); } catch { return init.body; }
    })() : undefined;

    const response = await _fetch.apply(this, args);
    const clone = response.clone();

    clone.text().then(text => {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text.substring(0, 500); }
      CAPTURE.log('FETCH', { url, method, requestBody, response: parsed, headers: init?.headers });
    }).catch(() => {});

    return response;
  };

  // ── 2. Intercept XHR ─────────────────────────────────────────────────────
  const _XHR_open = XMLHttpRequest.prototype.open;
  const _XHR_send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._bnb_method = method;
    this._bnb_url = url;
    return _XHR_open.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const origOnload = xhr.onload;

    xhr.addEventListener('load', function () {
      let parsed;
      try { parsed = JSON.parse(xhr.responseText); } catch { parsed = xhr.responseText?.substring(0, 200); }
      let requestBody;
      try { requestBody = body ? JSON.parse(body) : undefined; } catch { requestBody = body; }
      CAPTURE.log('XHR', {
        url: xhr._bnb_url,
        method: xhr._bnb_method,
        status: xhr.status,
        requestBody,
        response: parsed
      });
    });

    return _XHR_send.apply(this, [body]);
  };

  // ── 3. Intercept WebSocket ────────────────────────────────────────────────
  const _WS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new _WS(url, protocols) : new _WS(url);
    console.log('%c🔌 WebSocket opened:', 'color:#ff9800;font-weight:bold', url);
    CAPTURE.ws_messages.push({ type: 'WS_OPEN', url, time: new Date().toISOString() });

    ws.addEventListener('message', function (event) {
      let data;
      try { data = JSON.parse(event.data); } catch { data = event.data?.substring?.(0, 300); }
      const isRelevant = /square|feed|post|profile|article|news/i.test(JSON.stringify(data).substring(0, 300));
      CAPTURE.ws_messages.push({ url, data, time: new Date().toISOString() });
      if (isRelevant) {
        console.log('%c📨 WS Message (RELEVANT):', 'color:#ff9800;font-weight:bold', url, data);
      }
    });

    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;
  Object.defineProperty(window.WebSocket, 'CONNECTING', { value: _WS.CONNECTING });
  Object.defineProperty(window.WebSocket, 'OPEN',       { value: _WS.OPEN });
  Object.defineProperty(window.WebSocket, 'CLOSING',    { value: _WS.CLOSING });
  Object.defineProperty(window.WebSocket, 'CLOSED',     { value: _WS.CLOSED });

  // ── 4. REPORT function ───────────────────────────────────────────────────
  window.BNB_REPORT = function () {
    const relevant = CAPTURE.requests.filter(r =>
      /square|feed|post|profile|article|news|content|creator/i.test(JSON.stringify(r).substring(0, 1000))
    );
    console.log('\n%c══════════════════════════════════', 'color:#00ff88');
    console.log('%c   BINANCE SQUARE — CAPTURE REPORT', 'color:#00ff88;font-size:14px;font-weight:bold');
    console.log('%c══════════════════════════════════\n', 'color:#00ff88');
    console.log(`Total requests intercepted: ${CAPTURE.requests.length}`);
    console.log(`Relevant requests: ${relevant.length}`);
    console.log(`WebSocket frames: ${CAPTURE.ws_messages.length}`);

    if (relevant.length === 0) {
      console.log('%c⚠️  No relevant requests found yet. Try scrolling the page.', 'color:orange');
    }

    relevant.forEach((r, i) => {
      console.group(`%c[${i + 1}] ${r.type}: ${r.url}`, 'color:#00bfff;font-weight:bold');
      if (r.method) console.log('Method:', r.method);
      if (r.requestBody) {
        console.log('📤 Request body:');
        console.log(JSON.stringify(r.requestBody, null, 2));
      }
      if (r.response) {
        const resp = r.response;
        console.log('📥 Response structure:');
        if (typeof resp === 'object') {
          // Show keys and first item of any array
          const summary = {};
          for (const [k, v] of Object.entries(resp)) {
            if (Array.isArray(v)) summary[k] = `Array(${v.length}), first: ${JSON.stringify(v[0]).substring(0, 200)}`;
            else if (typeof v === 'object' && v !== null) summary[k] = `{${Object.keys(v).join(', ')}}`;
            else summary[k] = v;
          }
          console.log(summary);
        } else {
          console.log(String(resp).substring(0, 500));
        }
      }
      console.groupEnd();
    });

    if (CAPTURE.ws_messages.length > 0) {
      console.group('%c🔌 WebSocket messages:', 'color:#ff9800;font-weight:bold');
      CAPTURE.ws_messages.slice(0, 10).forEach(m => console.log(m));
      console.groupEnd();
    }

    console.log('\n%c📋 Copy-paste for me (run this):', 'color:#ffff00;font-weight:bold');
    console.log('copy(JSON.stringify(window.__BNB_CAPTURE__.requests.filter(r => /square|feed|post|profile|article|news/i.test(JSON.stringify(r).substring(0,1000))), null, 2))');
    console.log('%c(Then paste the clipboard content to me)\n', 'color:#aaa');
  };

  console.log('%c✅ Binance Square interceptor ACTIVE', 'color:#00ff88;font-size:13px;font-weight:bold');
  console.log('%cОжидаю запросы... Прокрути страницу или подожди загрузки постов.', 'color:#aaa');
  console.log('%cДля отчёта введи: BNB_REPORT()', 'color:#ffff00');
})();
