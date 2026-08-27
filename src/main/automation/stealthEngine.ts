// ---------------------------------------------------------------------------
// stealthEngine.ts  — anti-detect init script injected into every Playwright
// BrowserContext via context.addInitScript(). Runs before any page script on
// every document (including iframes), patching the handful of JS-visible
// signals Facebook's bot-detection commonly checks:
//   navigator.webdriver, window.chrome, navigator.plugins/languages,
//   WebGL vendor/renderer, and the Notification permission-query mismatch.
// Pure content-script patching — no changes to Chromium's actual CDP-level
// automation flags (those are handled separately via launch args).
// ---------------------------------------------------------------------------

export interface StealthOptions {
  /** Locale list for navigator.languages — primary language first. */
  languages?: string[]
  /** WebGL UNMASKED_VENDOR_WEBGL string (e.g. "Google Inc. (NVIDIA)"). */
  gpuVendor?: string
  /** WebGL UNMASKED_RENDERER_WEBGL string (e.g. an ANGLE D3D11 renderer line). */
  gpuRenderer?: string
  /**
   * Seed for deterministic-per-profile canvas/audio noise — pass the
   * account's UID (or any stable per-profile string). The SAME seed always
   * produces the SAME noise pattern, so a given account's canvas/audio
   * fingerprint is stable across sessions (looking like one consistent real
   * device) while still differing from every other account's profile.
   * Omitted/empty falls back to a fixed default seed.
   */
  profileSeed?: string
}

const NVIDIA_RENDERERS = [
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)'
]
const AMD_RENDERERS = [
  'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'
]
const INTEL_RENDERERS = [
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'
]

/** Pick a plausible GPU vendor/renderer pair — desktop Chrome's actual mix skews heavily Nvidia/Intel/AMD. */
export function randomGpu(): { vendor: string; renderer: string } {
  const pools: [string, string[]][] = [
    ['Google Inc. (NVIDIA)', NVIDIA_RENDERERS],
    ['Google Inc. (Intel)', INTEL_RENDERERS],
    ['Google Inc. (AMD)', AMD_RENDERERS]
  ]
  const [vendor, renderers] = pools[Math.floor(Math.random() * pools.length)]
  return { vendor, renderer: renderers[Math.floor(Math.random() * renderers.length)] }
}

/**
 * Builds the init-script source as a string (Playwright's addInitScript runs
 * it via a new Function in the page context, so it must be self-contained —
 * no closures over Node-side values beyond what's serialized into it here).
 */
/**
 * Deterministic 32-bit hash of a string (FNV-1a) — used to turn an account's
 * UID into a stable numeric seed for the canvas/audio noise generators
 * below, so the SAME account always gets the SAME noise pattern (a
 * consistent fingerprint across sessions, the way a real returning device
 * would look) while different accounts get different, uncorrelated ones.
 */
function seedFromString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function buildStealthScript(options: StealthOptions = {}): string {
  const languages = options.languages ?? ['en-US', 'en']
  const gpu = options.gpuVendor && options.gpuRenderer
    ? { vendor: options.gpuVendor, renderer: options.gpuRenderer }
    : randomGpu()
  const seed = seedFromString(options.profileSeed?.trim() || 'default-profile-seed')

  const config = JSON.stringify({
    languages,
    gpuVendor: gpu.vendor,
    gpuRenderer: gpu.renderer,
    seed
  })

  return `(() => {
    const CFG = ${config};

    // ---- 1. Mask navigator.webdriver ----
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => undefined,
        configurable: true
      });
    } catch (e) {}

    // ---- 2. Mock window.chrome runtime (absent by default under CDP) ----
    try {
      if (!window.chrome || !window.chrome.runtime) {
        window.chrome = {
          runtime: {
            connect: () => {},
            sendMessage: () => {},
            onMessage: { addListener: () => {}, removeListener: () => {} }
          },
          app: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
          },
          csi: function () { return {}; },
          loadTimes: function () { return {}; }
        };
      }
    } catch (e) {}

    // ---- 3. Spoof navigator.plugins & navigator.languages ----
    try {
      Object.defineProperty(Navigator.prototype, 'languages', {
        get: () => CFG.languages,
        configurable: true
      });

      const makePlugin = (name, filename, description) => {
        const plugin = Object.create(Plugin.prototype);
        Object.defineProperties(plugin, {
          name: { value: name, enumerable: true },
          filename: { value: filename, enumerable: true },
          description: { value: description, enumerable: true },
          length: { value: 1, enumerable: true }
        });
        return plugin;
      };
      const fakePlugins = [
        makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        makePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        makePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        makePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format')
      ];
      const pluginArray = Object.create(PluginArray.prototype);
      fakePlugins.forEach((p, i) => { pluginArray[i] = p; pluginArray[p.name] = p; });
      Object.defineProperty(pluginArray, 'length', { value: fakePlugins.length });
      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: () => pluginArray,
        configurable: true
      });
    } catch (e) {}

    // ---- 4. WebGL vendor/renderer masking ----
    try {
      const patchContext = (proto) => {
        const original = proto.getParameter;
        proto.getParameter = function (parameter) {
          // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
          if (parameter === 37445) return CFG.gpuVendor;
          if (parameter === 37446) return CFG.gpuRenderer;
          return original.call(this, parameter);
        };
      };
      if (window.WebGLRenderingContext) patchContext(WebGLRenderingContext.prototype);
      if (window.WebGL2RenderingContext) patchContext(WebGL2RenderingContext.prototype);
    } catch (e) {}

    // ---- 5. Permissions API — notifications query should mirror the real
    // Notification.permission value, not the CDP-automation-flagged default
    // Chrome otherwise reports (a common headless/automation tell). ----
    try {
      const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (originalQuery) {
        window.navigator.permissions.query = function (parameters) {
          if (parameters && parameters.name === 'notifications') {
            return Promise.resolve({
              state: Notification.permission,
              onchange: null
            });
          }
          return originalQuery.call(window.navigator.permissions, parameters);
        };
      }
    } catch (e) {}

    // ---- 6. Canvas fingerprint noise — deterministic per-profile (CFG.seed)
    // pseudo-random RGB delta (+/-1..2) applied to the pixel buffer before
    // toDataURL()/getImageData() return it. Same seed -> same noise every
    // call (a consistent "device" across sessions); different seed per
    // account -> different, uncorrelated canvas hashes. The delta is small
    // enough that rendered content still looks correct to a human/screenshot
    // — this only perturbs the underlying pixel bytes a canvas-fingerprint
    // script reads, not what's visibly drawn. ----
    try {
      // Mulberry32 PRNG seeded from CFG.seed — small, fast, deterministic.
      const makeRng = (seed) => {
        let s = seed >>> 0;
        return function () {
          s = (s + 0x6D2B79F5) >>> 0;
          let t = s;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };

      const noisifyImageData = (imageData) => {
        const rng = makeRng(CFG.seed ^ (imageData.width * 2654435761 + imageData.height));
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const delta = Math.floor(rng() * 5) - 2; // -2..+2
          data[i] = Math.min(255, Math.max(0, data[i] + delta));
          data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + delta));
          data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + delta));
          // alpha channel left untouched — noise on alpha would visibly
          // affect transparency, unlike a +/-2 RGB nudge.
        }
        return imageData;
      };

      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        const result = origGetImageData.apply(this, args);
        try {
          return noisifyImageData(result);
        } catch (e) {
          return result;
        }
      };

      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        try {
          const ctx = this.getContext('2d');
          if (ctx && this.width > 0 && this.height > 0) {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            // getImageData is already patched above, so imageData here is
            // already noised — write it back so toDataURL encodes the noised
            // pixels rather than the original clean ones.
            ctx.putImageData(imageData, 0, 0);
          }
        } catch (e) {}
        return origToDataURL.apply(this, args);
      };

      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      if (origToBlob) {
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
          try {
            const ctx = this.getContext('2d');
            if (ctx && this.width > 0 && this.height > 0) {
              const imageData = ctx.getImageData(0, 0, this.width, this.height);
              ctx.putImageData(imageData, 0, 0);
            }
          } catch (e) {}
          return origToBlob.call(this, callback, ...args);
        };
      }
    } catch (e) {}

    // ---- 7. AudioContext fingerprint jitter — deterministic per-profile
    // micro-jitter (+/-0.00005 amplitude) added to sample data read back from
    // getChannelData(), the primary vector AudioContext fingerprinting scripts
    // use (render a fixed tone/oscillator offline, then hash the resulting
    // buffer). Same seed -> same jitter pattern per account; jitter magnitude
    // is far below audible/functional significance. ----
    try {
      const makeRng2 = (seed) => {
        let s = seed >>> 0;
        return function () {
          s = (s + 0x6D2B79F5) >>> 0;
          let t = s;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };

      const patchGetChannelData = (proto) => {
        if (!proto || !proto.getChannelData) return;
        const original = proto.getChannelData;
        proto.getChannelData = function (channel) {
          const data = original.call(this, channel);
          try {
            const rng = makeRng2(CFG.seed ^ (channel + 1) ^ data.length);
            // Sampling every Nth value keeps this cheap even for large
            // buffers while still perturbing the hash a fingerprinting
            // script would compute over the whole buffer.
            const stride = Math.max(1, Math.floor(data.length / 4096));
            for (let i = 0; i < data.length; i += stride) {
              data[i] = data[i] + (rng() - 0.5) * 0.0001;
            }
          } catch (e) {}
          return data;
        };
      };
      if (window.AudioBuffer) patchGetChannelData(AudioBuffer.prototype);
    } catch (e) {}

    // ---- 8. WebRTC local-IP leak protection — a naive
    // RTCPeerConnection.createOffer()/setLocalDescription() reveals host
    // (and sometimes srflx) ICE candidates containing the machine's real
    // local/private IP even when all page traffic is routed through a
    // proxy, since WebRTC negotiates its own UDP path outside the proxy
    // entirely. Stripping "a=candidate" lines whose type isn't "relay" from
    // the SDP before it's set neutralizes that leak — the relay/TURN
    // candidate (if any) is left intact, since that path already goes
    // through a server rather than exposing a local address. ----
    try {
      const stripNonRelayCandidates = (sdp) => {
        if (!sdp) return sdp;
        return sdp
          .split('\\r\\n')
          .filter((line) => {
            if (!line.startsWith('a=candidate')) return true;
            return / typ relay /.test(line);
          })
          .join('\\r\\n');
      };

      if (window.RTCPeerConnection) {
        const OrigPC = window.RTCPeerConnection;
        const origCreateOffer = OrigPC.prototype.createOffer;
        OrigPC.prototype.createOffer = function (...args) {
          return origCreateOffer.apply(this, args).then((offer) => {
            try {
              if (offer && offer.sdp) offer.sdp = stripNonRelayCandidates(offer.sdp);
            } catch (e) {}
            return offer;
          });
        };

        const origSetLocalDescription = OrigPC.prototype.setLocalDescription;
        OrigPC.prototype.setLocalDescription = function (description, ...rest) {
          try {
            if (description && description.sdp) {
              description = Object.assign({}, description, {
                sdp: stripNonRelayCandidates(description.sdp)
              });
            }
          } catch (e) {}
          return origSetLocalDescription.call(this, description, ...rest);
        };
      }
    } catch (e) {}
  })();`
}
