// Verre liquide.
// Le bureau arrive en continu via un flux vidéo (getDisplayMedia, rendu GPU).
// Le shader lit directement cette texture, déforme la zone derrière la carte
// (lentille, dispersion, flou, reflets) et dessine l'ombre.
// Les images ne sont redessinées que lorsqu'une nouvelle frame ou un changement de carte arrive.
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
    uniform sampler2D u_tex;   // flux de l'écran
    uniform vec2 u_res;        // taille du canvas (pixels physiques)
    uniform vec4 u_rect;       // carte : x, y, largeur, hauteur (pixels, origine haut-gauche)
    uniform float u_radius;    // rayon des coins de la carte
    uniform float u_s;         // échelle (dpr)
    uniform vec2 u_uvOff;      // position de la fenêtre dans l'écran (0..1)
    uniform vec2 u_uvScale;    // taille de la fenêtre par rapport à l'écran (0..1)
    uniform vec2 u_blurUV;     // rayon du flou en coordonnées de texture
    uniform float u_refract;   // force de la lentille (pixels)
    uniform float u_edge;      // épaisseur de la zone de réfraction (pixels)
    uniform float u_chroma;    // dispersion chromatique
    uniform float u_tint;      // voile clair

    float sdRoundBox(vec2 p, vec2 b, float r) {
      vec2 q = abs(p) - b + vec2(r);
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }

    // pixel de la fenêtre -> coordonnée de texture de l'écran
    vec2 toUV(vec2 pix) {
      return u_uvOff + (pix / u_res) * u_uvScale;
    }

    // Flou 3x3 du flux
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

      // Dispersion chromatique
      float cr = backdrop(p + disp * (1.0 + u_chroma)).r;
      vec3 mid = backdrop(p + disp);
      float cb = backdrop(p + disp * (1.0 - u_chroma)).b;
      vec3 col = vec3(cr, mid.g, cb);

      // Éclaircissement et saturation
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lum), col, 1.25);
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
    'u_refract', 'u_edge', 'u_chroma', 'u_tint']
    .forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));

  // Texture alimentée par la vidéo de l'écran
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.uniform1i(U.u_tex, 0);

  // ---------- Flux de l'écran ----------
  let stream = null;
  let starting = false;
  let geo = null;
  let newFrame = false;
  let hasFrame = false;

  function onVideoFrame() {
    newFrame = true;
    if (stream) video.requestVideoFrameCallback(onVideoFrame);
  }

  async function startCapture() {
    if (stream || starting) return;
    starting = true;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      stream = s;
      // Résolution réduite : le fond est flouté de toute façon, et c'est bien plus léger
      try {
        await s.getVideoTracks()[0].applyConstraints({
          width: { max: 1280 },
          height: { max: 720 },
          frameRate: { max: 30 },
        });
      } catch (_) {
        /* contraintes non acceptées : on garde la résolution native */
      }
      video.srcObject = s;
      await video.play();
      video.requestVideoFrameCallback(onVideoFrame);
    } catch (err) {
      console.error('capture écran :', err);
    } finally {
      starting = false;
    }
  }

  function stopCapture() {
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    hasFrame = false;
  }

  window.api.onVisibility((v) => (v ? startCapture() : stopCapture()));
  window.api.onGeometry((g) => (geo = g));

  // ---------- Rendu ----------
  let lastKey = '';
  let radius = 0;
  let radiusSrc = '';
  let vw = 1;
  let vh = 1;

  function frame() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    let uploaded = false;
    if (newFrame && video.readyState >= 2 && video.videoWidth) {
      newFrame = false;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      vw = video.videoWidth;
      vh = video.videoHeight;
      hasFrame = true;
      uploaded = true;
    }

    const r = card.getBoundingClientRect();
    const rs = getComputedStyle(card).borderTopLeftRadius;
    if (rs !== radiusSrc) {
      radiusSrc = rs;
      radius = parseFloat(rs) || 0;
    }

    const key = [W, H, r.left, r.top, r.width, r.height, radius,
      geo ? [geo.x, geo.y, geo.dw, geo.dh].join(',') : ''].join('|');

    if (hasFrame && geo && (uploaded || key !== lastKey)) {
      lastKey = key;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U.u_res, W, H);
      gl.uniform4f(U.u_rect, r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr);
      gl.uniform1f(U.u_radius, radius * dpr);
      gl.uniform1f(U.u_s, dpr);
      gl.uniform2f(U.u_uvOff, geo.x / geo.dw, geo.y / geo.dh);
      gl.uniform2f(U.u_uvScale, geo.w / geo.dw, geo.h / geo.dh);
      gl.uniform2f(U.u_blurUV, 1.5 / vw, 1.5 / vh);
      gl.uniform1f(U.u_refract, 16 * dpr);
      gl.uniform1f(U.u_edge, 34 * dpr);
      gl.uniform1f(U.u_chroma, 0.12);
      gl.uniform1f(U.u_tint, 0.12);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
