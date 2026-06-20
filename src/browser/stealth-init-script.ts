/**
 * Stealth fingerprint patches injected into every Playwright-controlled
 * context (never into real user browsers reached over CDP). Overrides the
 * automation tells that anti-bot vendors fingerprint: navigator.webdriver,
 * empty plugin/mimetype lists, headless WebGL vendor strings, the CDP
 * screenX/screenY bug, missing navigator.connection, canvas readback, etc.
 */
export const STEALTH_INIT_SCRIPT = `
        // navigator.webdriver — explicit override (backup for --disable-blink-features)
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // navigator.plugins — empty in headless, non-empty in real browsers
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ],
        });
        // navigator.languages — must match Accept-Language header
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        // hardware signals — realistic desktop values
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        // window.chrome — full stub matching real Chrome
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };
        if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
        if (!window.chrome.csi) window.chrome.csi = function() { return { onloadT: Date.now(), startE: Date.now(), pageT: Date.now() - performance.timing.navigationStart }; };
        if (!window.chrome.loadTimes) window.chrome.loadTimes = function() { return { commitLoadTime: Date.now() / 1000, connectionInfo: 'h2', finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now() / 1000 - 0.16, startLoadTime: Date.now() / 1000 - 0.16, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }; };
        // WebGL vendor/renderer — match real GPU values
        try {
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter.call(this, parameter);
          };
        } catch (_) {}
        try {
          const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter2.call(this, parameter);
          };
        } catch (_) {}
        // window.outerWidth/outerHeight — 0 in headless, match viewport in real browsers
        if (window.outerWidth === 0) Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
        if (window.outerHeight === 0) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
        // Patch permissions API — cover all permission types bots commonly mis-handle
        try {
          const origQuery = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (params) => {
            const deny = ['notifications', 'geolocation', 'camera', 'microphone', 'payment-handler'];
            if (deny.includes(params.name))
              return Promise.resolve({ state: 'denied', onchange: null });
            return origQuery(params);
          };
        } catch (_) {}
        // Canvas fingerprint noise — add imperceptible per-session noise to canvas readback
        // so each session produces a unique fingerprint (defeats static fingerprint matching)
        try {
          const seed = Math.random() * 0xffff | 0;
          const noisify = (canvas) => {
            try {
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              const { width: w, height: h } = canvas;
              if (w === 0 || h === 0) return;
              const img = ctx.getImageData(0, 0, w, h);
              const d = img.data;
              for (let i = 0; i < d.length; i += 4) {
                // deterministic per-pixel noise from seed + position
                d[i] = d[i] ^ ((seed + i) & 1);
              }
              ctx.putImageData(img, 0, 0);
            } catch (_) {}
          };
          const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function(...args) {
            noisify(this);
            return origToDataURL.apply(this, args);
          };
          const origToBlob = HTMLCanvasElement.prototype.toBlob;
          HTMLCanvasElement.prototype.toBlob = function(...args) {
            noisify(this);
            return origToBlob.apply(this, args);
          };
        } catch (_) {}
        // Fix CDP screenX/screenY bug — CDP Input.dispatchMouseEvent sets
        // screenX=clientX, screenY=clientY which never happens in real browsers.
        // Cloudflare Turnstile actively checks this. Add a per-session window
        // offset so screenX/screenY are realistic and internally consistent.
        try {
          const winX = Math.floor(Math.random() * 200) + 50;
          const winY = Math.floor(Math.random() * 100) + 50;
          const chrome = 85;
          Object.defineProperty(MouseEvent.prototype, 'screenX', {
            get() { return this.clientX + winX; },
            configurable: true,
          });
          Object.defineProperty(MouseEvent.prototype, 'screenY', {
            get() { return this.clientY + winY + chrome; },
            configurable: true,
          });
        } catch (_) {}
        // navigator.connection — missing in headless, present in real Chrome
        try {
          if (!navigator.connection) {
            Object.defineProperty(navigator, 'connection', {
              get: () => ({
                effectiveType: '4g',
                rtt: 50,
                downlink: 10,
                saveData: false,
                onchange: null,
              }),
            });
          }
        } catch (_) {}
        // Notification.permission — default differs in headless
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
          }
        } catch (_) {}
      `;
