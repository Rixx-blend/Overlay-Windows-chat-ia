// Verre liquide : le shader déforme le bureau derrière la carte, avec aberration chromatique sur les bords.
//
// Deux modes :
// - fond figé (défaut) : l'overlay est visible dans les captures et le partage d'écran.
//   Le fond est une photo du bureau prise sans l'overlay (au démarrage, au retour, ou Ctrl+Alt+B).
// - verre live (Ctrl+Alt+L) : le fond est en continu (20-30 fps) mais l'overlay est masqué des captures,
//   sinon le verre se reflèterait lui-même.
(function () {
  const canvas = document.getElementById('glass');
  const video = document.getElementById('bg');
  const card = document.getElementById('card');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) {
    console.error('WebGL indisponible : verre désactivé');
    return;
  }

  const VS = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const FS = `
    precision highp float;
    uniform sampler2D u_tex;   // bureau (flux live ou photo figée)
    uniform vec2 u_res;        // taille du canvas (pixels physiques)
    uniform vec4 u_rect;       // carte : x, y, largeur, hauteur (pixels, origine haut-gauche)
    uniform float u_radius;    // rayon des coins
    uniform float u_s;         // échelle (dpr)
    uniform vec2 u_uvOff;      // position de la fenêtre dans l'écran (0..1)
    uniform vec2 u_uvScale;    // taille de la fenêtre par rapport à l'écran (0..1)
    uniform vec2 u_blurUV;     // rayon du flou en coordonnées de texture
    uniform float u_refract;   // force de la lentille (pixels)
    uniform float u_edge;      // épaisseur de la zone de réfraction (pixels)
    uniform float u_ca;        // aberration chromatique sur les bords (pixels)
    uniform float u_tint;      // voile clair

    float sdRoundBox(vec2 p, vec2 b, float r) {
      vec2 q = abs(p) - b + vec2(r);
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }

    vec2 toUV(vec2 pix) {
      return u_uvOff + (pix / u_res) * u_uvScale;
    }

    // Flou 3x3 du bureau
    vec3 backdrop(vec2 pix) {
      vec2 uv = toUV(pix);
      vec3 s = vec3(0.0);
      for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
          s += texture2D(u_tex, uv + vec2(float(i), float(j)) * u_blurUV).rgb;
        }
      }
      return s / 9.0;
    }

    void main() {
      vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
      vec2 c = u_rect.xy + u_rect.zw * 0.5;
      vec2 b = u_rect.zw * 0.5;
      float r = min(u_radius, min(b.x, b.y));
      vec2 q = p - c;
      float d = sdRoundBox(q, b, r);

      float cover = 1.0 - smoothstep(-0.75, 0.75, d);

      // Hors de la carte : seulement l'ombre
      if (cover <= 0.0) {
        float ds = sdRoundBox(q - vec2(0.0, 8.0 * u_s), b, r);
        float sa = (1.0 - smoothstep(0.0, 26.0 * u_s, ds)) * 0.22;
        gl_FragColor = vec4(0.0, 0.0, 0.0, sa);
        return;
      }

      // Normale au bord
      vec2 e = vec2(1.0, 0.0);
      float gx = sdRoundBox(q + e.xy, b, r) - sdRoundBox(q - e.xy, b, r);
      float gy = sdRoundBox(q + e.yx, b, r) - sdRoundBox(q - e.yx, b, r);
      vec2 n = normalize(vec2(gx, gy) + vec2(1e-5));

      // Lentille : déplacement fort sur les bords
      float depth = clamp(-d / u_edge, 0.0, 1.0);
      float lens = pow(1.0 - depth, 3.0);
      vec2 disp = -n * lens * u_refract;

      // Aberration chromatique : rouge et bleu se décalent de part et d'autre, proportionnellement à la courbure
      vec2 fr = n * lens * u_ca;
      float cr = backdrop(p + disp + fr).r;
      vec3 mid = backdrop(p + disp);
      float cb = backdrop(p + disp - fr).b;
      vec3 col = vec3(cr, mid.g, cb);

      // Éclaircissement et saturation
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lum), col, 0.85);
      col = mix(col, vec3(1.0), u_tint);

      // Bord lumineux + reflet spéculaire (lumière en haut à gauche)
      vec2 light = normalize(vec2(-0.5, -0.9));
      float rim = 1.0 - smoothstep(0.0, 2.5, -d);
      float spec = pow(max(dot(n, light), 0.0), 3.0) * rim;
      col += vec3(spec * 0.7 + rim * 0.22);

      // Reflet de la partie haute
      float top = 1.0 - smoothstep(0.0, b.y * 0.9, p.y - u_rect.y);
      col += vec3(top * 0.10);

      gl_FragColor = vec4(col * cover, cover);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  ['u_tex', 'u_res', 'u_rect', 'u_radius', 'u_s', 'u_uvOff', 'u_uvScale', 'u_blurUV',
    'u_refract', 'u_edge', 'u_ca', 'u_tint']
    .forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));
  gl.uniform1i(U.u_tex, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const liveTex = makeTex();   // flux continu (mode live)
  const snapTex = makeTex();   // photo figée du bureau (mode défaut)

  // ---------- État ----------
  let live = false;
  let shown = true;
  let geo = null;
  let stream = null;
  let newFrame = false;
  let snapping = false;
  let liveW = 0, liveH = 0, hasLive = false;
  let snapW = 0, snapH = 0, hasSnap = false, snapVersion = 0;

  // Compteurs d'images (affichés avec Ctrl+Alt+F)
  let vFrames = 0, rFrames = 0, lastStat = performance.now();
  let fpsEl = null;

  function onVideoFrame() {
    newFrame = true;
    vFrames++;
    if (stream) video.requestVideoFrameCallback(onVideoFrame);
  }

  async function startStream() {
    if (stream) return true;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
      stream = s;
      try {
        await s.getVideoTracks()[0].applyConstraints({
          width: { max: 960 },
          height: { max: 540 },
          frameRate: { min: 20, ideal: 30, max: 30 },
        });
      } catch (_) {
        /* on garde la résolution native */
      }
      video.srcObject = s;
      await video.play();
      video.requestVideoFrameCallback(onVideoFrame);
      return true;
    } catch (err) {
      console.error('capture écran :', err);
      stream = null;
      return false;
    }
  }

  function stopStream() {
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    newFrame = false;
  }

  // Attend quelques images après avoir masqué l'overlay, pour être sûr qu'elles sont propres
  function waitFrames(n) {
    return new Promise((resolve) => {
      let count = 0;
      const cb = () => {
        if (++count >= n) resolve();
        else video.requestVideoFrameCallback(cb);
      };
      video.requestVideoFrameCallback(cb);
      setTimeout(resolve, 2000);
    });
  }

  // Photo du bureau sans l'overlay (overlay masqué des captures le temps de la prise)
  async function takeSnapshot() {
    if (live || snapping || !shown) return;
    snapping = true;
    try {
      await window.api.protect(true);
      if (await startStream()) {
        await waitFrames(8);
        if (video.videoWidth) {
          gl.bindTexture(gl.TEXTURE_2D, snapTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          snapW = video.videoWidth;
          snapH = video.videoHeight;
          hasSnap = true;
          snapVersion++;
        }
        stopStream();
      }
    } finally {
      await window.api.protect(live);
      snapping = false;
    }
  }

  window.api.onMode((isLive) => {
    live = isLive;
    if (live) {
      if (shown) startStream();
    } else {
      stopStream();
      takeSnapshot();
    }
  });

  window.api.onVisibility((v) => {
    shown = v;
    if (!v) {
      stopStream();
    } else if (live) {
      startStream();
    } else {
      takeSnapshot();
    }
  });

  window.api.onSnapshot(() => takeSnapshot());

  window.api.onFpsToggle(() => {
    if (fpsEl) {
      fpsEl.remove();
      fpsEl = null;
    } else {
      fpsEl = document.createElement('div');
      fpsEl.id = 'fps';
      fpsEl.textContent = 'mesure…';
      document.body.appendChild(fpsEl);
    }
  });
  window.api.onGeometry((g) => (geo = g));

  // ---------- Rendu ----------
  let lastKey = '';
  let radius = 0;
  let radiusSrc = '';

  function frame() {
    const now = performance.now();
    if (now - lastStat >= 1000) {
      if (fpsEl) fpsEl.textContent = `écran ${vFrames} fps · rendu ${rFrames} fps`;
      vFrames = 0;
      rFrames = 0;
      lastStat = now;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    let uploaded = false;
    if (live && newFrame && video.readyState >= 2 && video.videoWidth) {
      newFrame = false;
      gl.bindTexture(gl.TEXTURE_2D, liveTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      liveW = video.videoWidth;
      liveH = video.videoHeight;
      hasLive = true;
      uploaded = true;
    }

    const r = card.getBoundingClientRect();
    const rs = getComputedStyle(card).borderTopLeftRadius;
    if (rs !== radiusSrc) {
      radiusSrc = rs;
      radius = parseFloat(rs) || 0;
    }

    const hasSrc = live ? hasLive : hasSnap;
    const srcW = live ? liveW : snapW;
    const srcH = live ? liveH : snapH;
    const key = [W, H, r.left, r.top, r.width, r.height, radius, live,
      geo ? [geo.x, geo.y, geo.dw, geo.dh].join(',') : '', snapVersion].join('|');

    if (hasSrc && geo && srcW && (uploaded || key !== lastKey)) {
      lastKey = key;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindTexture(gl.TEXTURE_2D, live ? liveTex : snapTex);
      gl.uniform2f(U.u_res, W, H);
      gl.uniform4f(U.u_rect, r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr);
      gl.uniform1f(U.u_radius, radius * dpr);
      gl.uniform1f(U.u_s, dpr);
      gl.uniform2f(U.u_uvOff, geo.x / geo.dw, geo.y / geo.dh);
      gl.uniform2f(U.u_uvScale, geo.w / geo.dw, geo.h / geo.dh);
      gl.uniform2f(U.u_blurUV, 3.0 / srcW, 3.0 / srcH);
      gl.uniform1f(U.u_refract, 16 * dpr);
      gl.uniform1f(U.u_edge, 34 * dpr);
      gl.uniform1f(U.u_ca, 6 * dpr);
      gl.uniform1f(U.u_tint, 0.3);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rFrames++;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
