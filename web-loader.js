/* The engine stays unmodified. Reassemble large assets below the host's per-file limit. */
(function () {
  'use strict';
  const originalFetch = window.fetch.bind(window);
  // The page tags its scripts with a build id. Game files carry it too, so a cached older file never mixes with a new build.
  const build = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch (_) { return ''; } })();
  function versioned(url) {
    if (!build) return url;
    const tagged = new URL(url, location.href); tagged.searchParams.set('v', build); return tagged;
  }
  let manifestPromise;
  function manifest() {
    return manifestPromise ||= originalFetch(build ? 'asset-parts.json?v='+build : 'asset-parts.json', {cache:'no-cache'}).then(r => {
      if (!r.ok) throw new Error('The game download is unavailable. Please reload.');
      return r.json();
    });
  }
  window.fetch = async function (input, options) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !/\/index\.(wasm|pck)$/.test(url.pathname)) return originalFetch(input, options);
    const entry = (await manifest())[url.pathname.split('/').pop()];
    if (!entry) return originalFetch(build ? versioned(url) : input, options);
    const compressed = typeof DecompressionStream !== 'undefined' && entry.gzip_parts?.length;
    const buffers = await Promise.all((compressed ? entry.gzip_parts : entry.parts).map(async part => {
      const response = await originalFetch(versioned(new URL(part, url)), options);
      if (!response.ok) throw new Error('A game file could not be downloaded. Please reload.');
      return response.arrayBuffer();
    }));
    const blob = new Blob(buffers);
    const data = compressed ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : await blob.arrayBuffer();
    if (data.byteLength !== entry.size) throw new Error('The game download was interrupted. Please reload.');
    return new Response(data, {headers:{'Content-Type':url.pathname.endsWith('.wasm')?'application/wasm':'application/octet-stream','Content-Length':String(entry.size)}});
  };
  window.stationBrowser = {
    visibilityCallback:null,
    importCallback:null,
    importPicker:null,
    pinchCallback:null,
    viewerActive:false,
    wheelBound:false,
    setVisibilityCallback(callback) { this.visibilityCallback = callback; },
    setPinchCallback(callback) {
      this.pinchCallback = callback;
      if (this.wheelBound) return;
      const canvas = document.getElementById('canvas');
      if (!canvas) return;
      this.wheelBound = true;
      let gesture = false, scale = 1, touches = 0;
      const emit = (event, factor) => {
        if (!this.viewerActive || !this.pinchCallback) return;
        const rect = canvas.getBoundingClientRect();
        const u = Number.isFinite(event.clientX) ? (event.clientX-rect.left)/rect.width : 0.5;
        const v = Number.isFinite(event.clientY) ? (event.clientY-rect.top)/rect.height : 0.5;
        if (u < 0 || u > 1 || v < 0 || v > 1 || !Number.isFinite(factor) || factor <= 0) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (touches < 2) this.pinchCallback(Math.min(2,Math.max(0.5,factor)),u,v);
      };
      canvas.addEventListener('wheel',event=>{
        // Desktop trackpad pinches arrive as Ctrl-wheel. Ordinary scrolling never zooms.
        if (event.ctrlKey && !gesture) emit(event,Math.exp(-event.deltaY*0.01));
      },{capture:true,passive:false});
      canvas.addEventListener('touchstart',event=>{touches=event.touches.length;},{passive:true});
      canvas.addEventListener('touchend',event=>{touches=event.touches.length;},{passive:true});
      canvas.addEventListener('touchcancel',()=>{touches=0;},{passive:true});
      canvas.addEventListener('gesturestart',event=>{gesture=true;scale=1;emit(event,1);},{capture:true,passive:false});
      canvas.addEventListener('gesturechange',event=>{
        const next = event.scale; emit(event,next/scale); if (Number.isFinite(next) && next > 0) scale=next;
      },{capture:true,passive:false});
      canvas.addEventListener('gestureend',()=>{gesture=false;scale=1;},{capture:true});
    },
    setImportCallback(callback) {
      this.importCallback = callback;
      if (!callback) this.cancelImport();
    },
    cancelImport() {
      this.importPicker?.remove(); this.importPicker = null;
    },
    chooseBackup() {
      if (!this.importCallback) return;
      this.importPicker?.remove();
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = '.json,application/json'; picker.hidden = true;
      this.importPicker = picker;
      picker.addEventListener('change', async () => {
        const callback = this.importCallback;
        const file = picker.files?.[0];
        try {
          if (!file || !callback) return;
          if (file.size > 524288) { callback('', 'That backup is too large.'); return; }
          const text = await file.text();
          // A chooser can finish after the player has left or the engine has shut down.
          if (this.importCallback === callback && this.importPicker === picker) callback(text, '');
        } catch (_) {
          if (this.importCallback === callback && this.importPicker === picker) callback('', 'Could not read that backup.');
        } finally {
          picker.remove();
          if (this.importPicker === picker) this.importPicker = null;
        }
      }, {once:true});
      picker.addEventListener('cancel', () => { picker.remove(); if (this.importPicker === picker) this.importPicker = null; }, {once:true});
      document.body.appendChild(picker);
      picker.click();
    },
    saved() {
      document.getElementById('message').textContent = 'Station saved. See you next night.';
      document.getElementById('cover').hidden = false;
      const start = document.getElementById('start');
      start.disabled = false; start.textContent = 'Return to the studio'; start.onclick = () => location.reload();
    }
  };
  function visibility() { window.stationBrowser.visibilityCallback?.(document.hidden); }
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', () => window.stationBrowser.visibilityCallback?.(true));
  window.addEventListener('pageshow', visibility);
  window.stationLauncher = {
    start(config, threads) {
      const canvas = document.getElementById('canvas');
      const frame = document.getElementById('frame');
      const cover = document.getElementById('cover');
      const button = document.getElementById('start');
      const message = document.getElementById('message');
      const progress = document.getElementById('progress');
      function resize() {
        const bounds = frame.getBoundingClientRect();
        const height = Math.max(1, Math.floor(bounds.height));
        const width = Math.max(1, Math.floor(Math.min(bounds.width, height * 0.68, 540)));
        canvas.style.width = width+'px'; canvas.style.height = height+'px';
        // Bound render resolution on high-DPI phones; touch coordinates still use CSS pixels.
        const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.round(width*ratio); canvas.height = Math.round(height*ratio);
      }
      new ResizeObserver(resize).observe(frame);
      window.visualViewport?.addEventListener('resize', () => {
        frame.style.bottom = `calc(env(safe-area-inset-bottom) + ${Math.max(0,window.innerHeight-window.visualViewport.height-window.visualViewport.offsetTop)}px)`;
        resize();
      });
      resize();
      const missing = Engine.getMissingFeatures({threads});
      if (missing.length) { message.textContent = 'This browser needs '+missing.join(', ')+'. Try an updated Safari.'; button.hidden = true; return; }
      const engine = new Engine({...config, canvas, canvasResizePolicy:0});
      let launched = false;
      button.onclick = async () => {
        if (launched) return;
        launched = true; button.disabled = true; button.textContent = 'Tuning in…';
        message.textContent = 'Opening your station. The first download takes a moment.';
        progress.hidden = false;
        try {
          await engine.startGame({onProgress(current,total) {
            if (total > 0) { progress.max = total; progress.value = current; }
            else progress.removeAttribute('value');
          }, onExit() { window.stationBrowser.saved(); }});
          cover.hidden = true; canvas.focus(); resize();
        } catch (error) {
          console.error(error); message.textContent = 'Could not tune in. Check your connection and reload.';
          button.disabled = false; button.textContent = 'Reload'; button.onclick = () => location.reload(); progress.hidden = true;
        }
      };
    }
  };
}());
