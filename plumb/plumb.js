/* Plumb — a daily test of physical intuition.
 *
 * Five tests, two rounds each, ten rounds a day. Each round scores 0–100.
 * Every round is generated from a seed, so everyone gets the same set on the
 * same day. Each test draws onto a fixed 800 × 600 board that is scaled to fit.
 *
 * A test is an object with:
 *   make(rng, k)    -> params for round k (0 or 1), from the seeded random source
 *   mount(p, api)   -> a round controller with frame(), and optionally
 *                      down/move/up(point), submit(), keyDown()/keyUp()
 * A controller calls api.input() once the player may act, api.ready(bool) to
 * enable "Lock in", and api.done(result) itself if it finishes without one.
 * A result is { score, head, detail, delay }.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ utils */
  const $ = (s) => document.querySelector(s);
  const W = 800, H = 600;
  const D2R = Math.PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedFor(base, i) {
    let h = (2166136261 ^ base) >>> 0;
    h = Math.imul(h ^ ((i + 1) * 374761393), 16777619);
    h ^= h >>> 13; h = Math.imul(h, 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  /* 100 at zero error, 50 at `half`, falling away smoothly after that. */
  const curve = (err, half) => Math.round(100 * Math.pow(2, -Math.pow(Math.abs(err) / half, 1.5)));

  /* Puzzle No. 1 is 9 November 2026, by the player's own calendar. */
  const EPOCH = new Date(2026, 10, 9);
  function dayNo(d = new Date()) {
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((a - EPOCH) / 864e5) + 1;
  }
  function dateOf(n) { return new Date(EPOCH.getFullYear(), EPOCH.getMonth(), EPOCH.getDate() + n - 1); }

  const store = {
    get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const KEY = 'plumb:v1';

  /* --------------------------------------------------------------- polygons */
  function rotPts(pts, cx, cy, th) {
    const c = Math.cos(th), s = Math.sin(th);
    return pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
  }
  function polyArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }
  /* Keep the part of `poly` where f(point) >= 0 (Sutherland–Hodgman, one plane). */
  function clipPoly(poly, f) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }
  /* Height y of a level surface that leaves `target` area below it. */
  function levelFor(poly, target) {
    let lo = Infinity, hi = -Infinity;
    for (const p of poly) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    for (let i = 0; i < 48; i++) {
      const m = (lo + hi) / 2;
      if (polyArea(clipPoly(poly, (q) => q[1] - m)) > target) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  }

  /* ----------------------------------------------------------------- canvas */
  const cv = $('#cv');
  const ctx = cv.getContext('2d');
  let scale = 1, dpr = 1;
  let C = {};

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    C = {
      bg: v('--bg'), bg2: v('--bg-2'), surface: v('--surface'),
      ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'),
      line: v('--line'), lineStrong: v('--line-strong'),
      level: v('--level'), spin: v('--spin'), lamp: v('--lamp'), hold: v('--hold'), bank: v('--bank'),
      sans: v('--font-sans'), mono: v('--font-mono'), display: v('--font-display'),
    };
  }
  function resize() {
    const r = cv.getBoundingClientRect();
    if (!r.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.width * .75 * dpr);
    scale = r.width / W;
  }
  function pointOf(e) {
    const r = cv.getBoundingClientRect();
    return [(e.clientX - r.left) / (r.width / W), (e.clientY - r.top) / (r.height / H)];
  }

  const g = {
    line(x1, y1, x2, y2, color, w = 2, dash) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
    },
    circle(x, y, r, fill, stroke, w = 2) {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = w; ctx.stroke(); }
    },
    path(pts, close) {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (close) ctx.closePath();
    },
    /* Board text is drawn in board units, so on a small screen it would shrink
       with the board. Keep it readable: at least `keep` of its nominal size in
       real pixels (headlines may shrink more than labels). */
    size(n, font) { const keep = font === 'display' ? .5 : .8; return Math.max(n, n * keep / scale); },
    text(s, x, y, { font = 'sans', size = 14, weight = 500, color = C.ink, align = 'left', base = 'alphabetic', track = 0 } = {}) {
      const fam = font === 'mono' ? C.mono : font === 'display' ? C.display : C.sans;
      ctx.font = `${weight} ${g.size(size, font)}px ${fam}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = track ? `${track}px` : '0px';
      ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
      ctx.fillText(s, x, y);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    },
    wrap(s, x, y, maxW, lh, opts) {
      const fam = opts.font === 'display' ? C.display : opts.font === 'mono' ? C.mono : C.sans;
      const px = g.size(opts.size, opts.font);
      lh = lh * px / opts.size;
      ctx.font = `${opts.weight || 400} ${px}px ${fam}`;
      const words = s.split(' ');
      let line = '', yy = y;
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > maxW && line) { g.text(line, x, yy, opts); line = w; yy += lh; }
        else line = test;
      }
      if (line) g.text(line, x, yy, opts);
      return yy;
    },
    /* small triangle whose tip sits on (x, y), pointing along angle `a` */
    pointer(x, y, a, size, fill) {
      const c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - c * size - s * size * .62, y - s * size + c * size * .62);
      ctx.lineTo(x - c * size + s * size * .62, y - s * size - c * size * .62);
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    },
    label(s, x, y, color, align = 'center') {
      g.text(s, x, y, { font: 'mono', size: 13, weight: 500, color, align, base: 'middle' });
    },
  };

  /* ==================================================================== LEVEL
   * A glass is shown upright with water in it. It tilts, the water vanishes,
   * and the player draws the surface. Water stays level and keeps its volume.
   */
  const GLASSES = {
    tumbler: { pts: [[-86, -150], [-63, 150], [63, 150], [86, -150]] },
    beaker:  { pts: [[-80, -150], [-80, 150], [80, 150], [80, -150]] },
    flask:   { pts: [[-26, -165], [-26, -58], [-114, 150], [114, 150], [26, -58], [26, -165]] },
    bottle:  { pts: [[-24, -178], [-24, -118], [-72, -74], [-72, 160], [72, 160], [72, -74], [24, -118], [24, -178]] },
    bowl:    { pts: [[-98, -125], [-92, -40], [-64, 28], [-24, 56], [24, 56], [64, 28], [92, -40], [98, -125]], stem: true },
  };
  const LV = { cx: 400, cy: 300 };

  function belowFn(L) {
    let dx = L.b[0] - L.a[0], dy = L.b[1] - L.a[1];
    if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
    const ax = L.a[0], ay = L.a[1];
    return (q) => dx * (q[1] - ay) - dy * (q[0] - ax);
  }
  function crossings(P, h) {
    const xs = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      if ((a[1] - h) * (b[1] - h) < 0) xs.push(a[0] + (b[0] - a[0]) * (h - a[1]) / (b[1] - a[1]));
    }
    return xs.sort((p, q) => p - q);
  }

  const Level = {
    id: 'level', name: 'Level', unit: 'degrees',
    brief: 'Where does the water sit now?',
    howto: 'Drag across the glass to draw the surface. Redraw as often as you like.',
    make(rng, k) {
      const pool = k === 0 ? ['tumbler', 'beaker', 'bowl'] : ['flask', 'bottle', 'bowl', 'tumbler'];
      const shape = pool[Math.floor(rng() * pool.length)];
      let fill = lerp(.3, .58, rng());
      let deg = lerp(24, 58, rng()) * (rng() < .5 ? -1 : 1);
      const pts = GLASSES[shape].pts;
      for (let i = 0; i < 30; i++) {
        const P = rotPts(pts, LV.cx, LV.cy, deg * D2R);
        const h = levelFor(P, polyArea(P) * fill);
        if (Math.max(P[0][1], P[P.length - 1][1]) < h - 18) break; // both rim corners stay dry
        deg *= .9; fill *= .96;
      }
      return { shape, fill, deg };
    },
    mount(p, api) {
      const G = GLASSES[p.shape];
      const up = rotPts(G.pts, LV.cx, LV.cy, 0);
      const A = polyArea(up);
      const hUp = levelFor(up, A * p.fill);
      const th = p.deg * D2R;
      const tilted = rotPts(G.pts, LV.cx, LV.cy, th);
      const hT = levelFor(tilted, A * p.fill);
      let phase = 'watch', line = null, drag = null, revealAt = 0;
      api.tag('Remember the water');

      function drawGlass(P, angle) {
        g.path(P, true); ctx.globalAlpha = .55; ctx.fillStyle = C.bg2; ctx.fill(); ctx.globalAlpha = 1;
        if (G.stem) {
          const s = rotPts([[0, 56], [0, 150], [-62, 150], [62, 150]], LV.cx, LV.cy, angle);
          g.line(s[0][0], s[0][1], s[1][0], s[1][1], C.ink2, 6);
          g.line(s[2][0], s[2][1], s[3][0], s[3][1], C.ink2, 6);
        }
        g.path(P, false);
        ctx.strokeStyle = C.ink2; ctx.lineWidth = 6; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
      }
      function drawWater(P, h, alpha) {
        if (alpha <= 0) return;
        const Wp = clipPoly(P, (q) => q[1] - h);
        if (Wp.length < 3) return;
        g.path(Wp, true);
        ctx.globalAlpha = alpha * .26; ctx.fillStyle = C.level; ctx.fill();
        ctx.globalAlpha = alpha;
        const xs = crossings(P, h);
        for (let i = 0; i + 1 < xs.length; i += 2) g.line(xs[i], h, xs[i + 1], h, C.level, 3);
        ctx.globalAlpha = 1;
      }
      function drawUser(L, final) {
        if (!L || dist(L.a, L.b) < 4) return;
        const d = [L.b[0] - L.a[0], L.b[1] - L.a[1]];
        const n = Math.hypot(d[0], d[1]); d[0] /= n; d[1] /= n;
        if (!final) {
          const Up = clipPoly(tilted, belowFn(L));
          if (Up.length > 2) { g.path(Up, true); ctx.globalAlpha = .07; ctx.fillStyle = C.ink; ctx.fill(); ctx.globalAlpha = 1; }
        }
        ctx.save(); g.path(tilted, true); ctx.clip();
        g.line(L.a[0] - d[0] * 900, L.a[1] - d[1] * 900, L.a[0] + d[0] * 900, L.a[1] + d[1] * 900, C.ink, 2.5, final ? [7, 6] : null);
        ctx.restore();
      }

      return {
        frame() {
          const t = api.now();
          if (phase === 'watch') {
            if (t < 2.1) { drawGlass(up, 0); drawWater(up, hUp, 1); }
            else if (t < 2.45) { drawGlass(up, 0); drawWater(up, hUp, 1 - (t - 2.1) / .35); }
            else if (t < 3.4) { api.tag(''); const a = th * easeInOut((t - 2.45) / .95); drawGlass(rotPts(G.pts, LV.cx, LV.cy, a), a); }
            else { phase = 'input'; api.tag('Drag to draw the water line'); api.input(); }
          }
          if (phase === 'input' || phase === 'reveal') {
            drawGlass(tilted, th);
            if (phase === 'reveal') drawWater(tilted, hT, easeOut(clamp((t - revealAt) / .6, 0, 1)));
            drawUser(drag || line, phase === 'reveal');
          }
        },
        down(q) { if (phase === 'input') drag = { a: q, b: q }; },
        move(q) { if (drag) drag.b = q; },
        up() {
          if (!drag) return;
          if (dist(drag.a, drag.b) > 20) { line = drag; api.ready(true); api.tag(''); }
          drag = null;
        },
        submit() {
          const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1];
          let ang = Math.atan2(dy, dx) / D2R;
          if (ang > 90) ang -= 180;
          if (ang <= -90) ang += 180;
          const ae = Math.abs(ang);
          const userA = polyArea(clipPoly(tilted, belowFn(line)));
          const ve = (userA - A * p.fill) / A;
          phase = 'reveal'; revealAt = api.now();
          const score = Math.round(.5 * curve(ae, 7) + .5 * curve(ve, .07));
          return {
            score,
            head: ae < .5 ? 'Dead level' : `${ae.toFixed(1)}° off level`,
            detail: Math.abs(ve) < .015 ? 'Amount of water spot on' : `${Math.round(Math.abs(ve) * 100)}% ${ve > 0 ? 'too much' : 'too little'} water`,
            delay: 700,
          };
        },
      };
    },
  };

  /* ===================================================================== SPIN
   * A wheel with one red slice spins and slows at a steady rate. A cover closes
   * over it while it is still turning. The player marks where the slice stops.
   * Angles: degrees, 0 at twelve o'clock, clockwise positive.
   */
  const SP = { cx: 400, cy: 304, r: 206, n: 16 };
  const toCanvas = (deg) => (deg - 90) * D2R;
  const angDiff = (a, b) => ((a - b) % 360 + 540) % 360 - 180;

  const Spin = {
    id: 'spin', name: 'Spin', unit: 'degrees',
    brief: 'Where will the red slice stop?',
    howto: 'Watch it slow down. When the cover closes, tap the rim where the slice will come to rest.',
    make(rng, k) {
      const dir = rng() < .5 ? -1 : 1;
      const alpha = lerp(50, 105, rng());                         // deceleration, °/s²
      const R = k === 0 ? lerp(110, 230, rng()) : lerp(200, 330, rng()); // turn left after the cover closes
      const T = 1.8;                                               // seconds visible
      const wh = Math.sqrt(2 * alpha * R);
      return { dir, alpha, R, T, w0: wh + alpha * T, phi0: rng() * 360 };
    },
    mount(p, api) {
      const SL = 360 / SP.n;
      const tStop = p.w0 / p.alpha;
      const phiAt = (t) => { const tt = Math.min(t, tStop); return p.phi0 + p.dir * (p.w0 * tt - .5 * p.alpha * tt * tt); };
      const finalC = phiAt(tStop) + SL / 2;
      let phase = 'watch', mark = null, revealAt = 0;

      function wheel(phi) {
        for (let i = 0; i < SP.n; i++) {
          const a0 = toCanvas(phi + i * SL), a1 = toCanvas(phi + (i + 1) * SL);
          ctx.beginPath(); ctx.moveTo(SP.cx, SP.cy); ctx.arc(SP.cx, SP.cy, SP.r, a0, a1); ctx.closePath();
          ctx.fillStyle = i === 0 ? C.spin : C.surface; ctx.fill();
          if (i && i % 2) { ctx.globalAlpha = .09; ctx.fillStyle = C.ink; ctx.fill(); ctx.globalAlpha = 1; }
          ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
        }
        g.circle(SP.cx, SP.cy, SP.r, null, C.ink2, 2);
        g.circle(SP.cx, SP.cy, 16, C.surface, C.ink2, 2);
        g.circle(SP.cx, SP.cy, 4, C.ink2);
      }
      function dial() {
        const R1 = SP.r + 14;
        for (let d = 0; d < 360; d += 5) {
          const big = d % 45 === 0, mid = d % 15 === 0;
          const len = big ? 13 : mid ? 8 : 4;
          const a = toCanvas(d), c = Math.cos(a), s = Math.sin(a);
          g.line(SP.cx + c * R1, SP.cy + s * R1, SP.cx + c * (R1 + len), SP.cy + s * (R1 + len), big ? C.ink3 : C.lineStrong, big ? 1.6 : 1);
        }
      }
      function cover(alpha) {
        ctx.globalAlpha = alpha;
        g.circle(SP.cx, SP.cy, SP.r + 3, C.bg2, C.lineStrong, 1.5);
        g.circle(SP.cx, SP.cy, SP.r * .62, null, C.line, 1);
        g.circle(SP.cx, SP.cy, SP.r * .28, null, C.line, 1);
        g.text('still turning', SP.cx, SP.cy + 4, { font: 'mono', size: 13, color: C.ink3, align: 'center', base: 'middle', track: 1 });
        ctx.globalAlpha = 1;
      }
      function marker(deg, color, r = SP.r + 12) {
        const a = toCanvas(deg);
        g.pointer(SP.cx + Math.cos(a) * r, SP.cy + Math.sin(a) * r, a + Math.PI, 18, color);
      }

      return {
        frame() {
          const t = api.now();
          dial();
          if (phase === 'watch') {
            wheel(phiAt(t));
            if (t > p.T) cover(clamp((t - p.T) / .28, 0, 1));
            if (t > p.T + .28) { phase = 'input'; api.input(); api.tag('Tap the rim'); }
          } else if (phase === 'input') {
            cover(1);
            if (mark != null) marker(mark, C.ink);
          } else {
            const tw = p.T + (t - revealAt);
            wheel(phiAt(tw));
            const k = clamp((t - revealAt) / .25, 0, 1);
            if (k < 1) cover(1 - k);
            marker(mark, C.ink);
            if (tw >= tStop + .15) {
              marker(finalC, C.spin, SP.r + 34);
              const e = angDiff(mark, finalC);
              const R2 = SP.r + 40;
              ctx.beginPath();
              ctx.arc(SP.cx, SP.cy, R2, toCanvas(Math.min(finalC, finalC + e)), toCanvas(Math.max(finalC, finalC + e)));
              ctx.strokeStyle = C.ink3; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
            }
          }
        },
        down(q) {
          if (phase !== 'input') return;
          const dx = q[0] - SP.cx, dy = q[1] - SP.cy, r = Math.hypot(dx, dy);
          if (r < 30) return;
          mark = (Math.atan2(dx, -dy) / D2R + 360) % 360;
          api.ready(true); api.tag('');
        },
        move(q) { if (mark != null && phase === 'input' && this.dragging) this.down(q); },
        submit() {
          phase = 'reveal'; revealAt = api.now();
          const e = Math.abs(angDiff(mark, finalC));
          return {
            score: curve(e, 20),
            head: e < 1 ? 'Right on the slice' : `Off by ${Math.round(e)}°`,
            detail: `It turned another ${Math.round(p.R)}° behind the cover`,
            delay: (tStop - p.T) * 1000 + 450,
          };
        },
      };
    },
  };

  /* ===================================================================== LAMP
   * Side view. A lamp lights some posts and each casts a shadow on the ground.
   * The lamp is hidden; the player marks where it is. 100 px = 1 metre.
   */
  const GROUND = 500;
  const Lamp = {
    id: 'lamp', name: 'Lamp', unit: 'metres',
    brief: 'Where is the lamp?',
    howto: 'Each shadow points straight away from the light. Tap where the lamp hangs, then drag to adjust.',
    make(rng, k) {
      const n = k === 0 ? 2 : 3;
      for (let tries = 0; tries < 900; tries++) {
        const lx = lerp(150, 650, rng()), ly = lerp(90, 235, rng());
        const Lh = GROUND - ly;
        const posts = [];
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
          let placed = false;
          for (let j = 0; j < 50 && !placed; j++) {
            const x = lerp(60, 740, rng());
            const h = lerp(60, Math.min(190, Lh - 85), rng());
            const xs = lx + (x - lx) * Lh / (Lh - h);
            if (xs < 28 || xs > 772 || Math.abs(xs - x) < 34) continue;
            const lo = Math.min(x, xs) - 16, hi = Math.max(x, xs) + 16;
            if (posts.some((q) => !(hi < q.lo || lo > q.hi))) continue;
            posts.push({ x, h, xs, lo, hi }); placed = true;
          }
          ok = placed;
        }
        if (ok) return { lx, ly, posts };
      }
      return { lx: 400, ly: 160, posts: [{ x: 250, h: 120, xs: 250 - 150 * 340 / 220 }, { x: 560, h: 90, xs: 400 + 160 * 340 / 250 }] };
    },
    mount(p, api) {
      let phase = 'input', mark = null, revealAt = 0;
      api.input(); api.tag('Tap where the lamp is');
      const Lh = GROUND - p.ly;

      function scene() {
        ctx.fillStyle = C.bg2; ctx.fillRect(0, GROUND, W, H - GROUND);
        g.line(0, GROUND, W, GROUND, C.lineStrong, 1.5);
        for (const q of p.posts) {
          ctx.globalAlpha = .5;
          g.line(q.x, GROUND + 4, q.xs, GROUND + 4, C.ink, 8);
          ctx.globalAlpha = 1;
        }
        for (const q of p.posts) {
          g.line(q.x, GROUND, q.x, GROUND - q.h, C.ink, 5);
          g.circle(q.x, GROUND - q.h, 6.5, C.ink);
        }
        // scale bar: 1 metre
        g.line(W - 136, H - 34, W - 36, H - 34, C.ink3, 1.5);
        g.line(W - 136, H - 40, W - 136, H - 28, C.ink3, 1.5);
        g.line(W - 36, H - 40, W - 36, H - 28, C.ink3, 1.5);
        g.text('1 m', W - 86, H - 46, { font: 'mono', size: 12, color: C.ink3, align: 'center' });
      }
      function userMark(q) {
        g.circle(q[0], q[1], 12, null, C.ink, 2);
        g.line(q[0] - 19, q[1], q[0] - 6, q[1], C.ink, 1.5);
        g.line(q[0] + 6, q[1], q[0] + 19, q[1], C.ink, 1.5);
        g.line(q[0], q[1] - 19, q[0], q[1] - 6, C.ink, 1.5);
        g.line(q[0], q[1] + 6, q[0], q[1] + 19, C.ink, 1.5);
      }

      return {
        frame() {
          const t = api.now();
          if (phase === 'reveal') {
            const k = easeOut(clamp((t - revealAt) / .7, 0, 1));
            const glow = ctx.createRadialGradient(p.lx, p.ly, 0, p.lx, p.ly, 170);
            glow.addColorStop(0, C.lamp); glow.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.globalAlpha = .22 * k; ctx.fillStyle = glow; ctx.fillRect(0, 0, W, GROUND); ctx.globalAlpha = 1;
            scene();
            for (const q of p.posts) {
              g.line(p.lx, p.ly, lerp(p.lx, q.xs, k), lerp(p.ly, GROUND + 4, k), C.lamp, 1.6, [6, 6]);
            }
            g.line(mark[0], mark[1], p.lx, p.ly, C.ink3, 1.2, [2, 4]);
            userMark(mark);
            g.circle(p.lx, p.ly, 11, C.lamp);
            g.circle(p.lx, p.ly, 17, null, C.lamp, 1.5);
          } else {
            scene();
            if (mark) userMark(mark);
          }
        },
        down(q) {
          if (phase !== 'input') return;
          mark = [clamp(q[0], 12, W - 12), clamp(q[1], 12, GROUND - 14)];
          api.ready(true); api.tag('');
        },
        move(q) { if (this.dragging) this.down(q); },
        submit() {
          phase = 'reveal'; revealAt = api.now();
          const d = dist(mark, [p.lx, p.ly]);
          return {
            score: curve(d, 50),
            head: `Off by ${(d / 100).toFixed(2)} m`,
            detail: `The lamp hung ${(Lh / 100).toFixed(1)} m above the ground`,
            delay: 800,
          };
        },
      };
    },
  };

  /* ===================================================================== HOLD
   * Hold for as long as a real event lasts. Each target is a fixed, checkable
   * duration: a dated record, a rule, or plain physics.
   */
  const EVENTS = [
    // under 5 s
    { s: 1.28, k: 'Physics', t: 'Moonlight travelling from the Moon to your eyes', n: 'About 384,400 km at the speed of light.' },
    { s: 2.92, k: 'Everyday physics', t: 'Thunder reaching you from a lightning strike 1 km away', n: 'Sound covers about 343 metres each second.' },
    { s: 1.43, k: 'Physics', t: 'A ball dropped from 10 metres falling to the ground', n: 'Ignoring air: t = √(2h / g).' },
    { s: 1.00, k: 'Physics', t: 'A 1-metre pendulum swinging from one side to the other', n: 'A pendulum that ticks once a second is 99.4 cm long.' },
    { s: 4.21, k: 'American football', t: 'Xavier Worthy’s 40-yard dash at the 2024 NFL Combine', n: 'The fastest ever recorded at the Combine.' },
    { s: 1.80, k: 'Formula 1', t: 'McLaren’s record pit stop at the 2023 Qatar Grand Prix', n: 'Four new tyres on Lando Norris’s car.' },
    { s: 2.56, k: 'Space', t: 'A laser pulse travelling to the Moon and back', n: 'Apollo crews left mirrors on the Moon for exactly this.' },
    { s: 0.79, k: 'Physics', t: 'A ball falling from basketball-hoop height (3.05 m)', n: 'Ignoring air: t = √(2h / g).' },
    { s: 3.00, k: 'Basketball', t: 'How long an attacker may stand in the NBA paint', n: 'The three-second rule.' },
    { s: 1.00, k: 'Physics', t: 'Light travelling seven and a half times around the Equator', n: 'Earth’s equator is 40,075 km round.' },
    // 5 s and over
    { s: 9.58, k: 'Athletics', t: 'Usain Bolt’s 100 m in Berlin, 2009', n: 'Still the world record.' },
    { s: 12.0, k: 'History', t: 'The Wright brothers’ first powered flight', n: 'Kitty Hawk, 17 December 1903. About 37 metres.' },
    { s: 8.00, k: 'Rodeo', t: 'The ride a bull rider must last to get a score', n: 'Eight seconds, in professional bull riding.' },
    { s: 10.49, k: 'Athletics', t: 'Florence Griffith-Joyner’s 100 m in Indianapolis, 1988', n: 'Still the women’s world record.' },
    { s: 13.0, k: 'Records', t: 'The longest recorded flight of a chicken', n: 'A Guinness record, set in 1985.' },
    { s: 6.00, k: 'Internet', t: 'One Vine video', n: 'The looping-video app capped every clip at six seconds.' },
    { s: 8.20, k: 'Physics', t: 'Falling from the top of the Eiffel Tower, if there were no air', n: '330 metres. With air, a person takes far longer.' },
    { s: 5.00, k: 'Basketball', t: 'The time an NBA player has to throw the ball in', n: 'The five-second inbound rule.' },
  ];
  const SHORT = EVENTS.filter((e) => e.s < 5), LONG = EVENTS.filter((e) => e.s >= 5);
  const fmtS = (s) => (s >= 10 ? s.toFixed(2) : s.toFixed(2));
  const PAD = { x: 400, y: 428, r: 76 };

  const Hold = {
    id: 'hold', name: 'Hold', unit: 'seconds',
    brief: 'How long does it last?',
    howto: 'Press and hold the circle, or Space. Let go when it would be over. One try.',
    lockLabel: 'Hold the circle',
    make(rng, k) {
      const list = k === 0 ? SHORT : LONG;
      return { e: list[Math.floor(rng() * list.length)] };
    },
    mount(p, api) {
      const ev = p.e;
      let phase = 'input', start = 0, held = 0, revealAt = 0, pressing = false;
      api.input();

      function begin() { if (phase !== 'input' || pressing) return; pressing = true; start = performance.now(); }
      function end() {
        if (!pressing) return;
        pressing = false;
        held = (performance.now() - start) / 1000;
        if (held < .12) return; // a tap, not a hold
        phase = 'reveal'; revealAt = api.now();
        const e = Math.log(held / ev.s);
        const pct = Math.round(Math.abs(held / ev.s - 1) * 100);
        api.done({
          score: curve(e, Math.log(1.15)),
          head: pct === 0 ? 'Spot on' : `${pct}% ${held < ev.s ? 'short' : 'long'}`,
          detail: `You held ${fmtS(held)} s. It lasts ${fmtS(ev.s)} s.`,
          delay: 900,
        });
      }

      return {
        frame() {
          const t = api.now();
          g.text(ev.k.toUpperCase(), 56, 84, { font: 'mono', size: 13, color: C.ink3, track: 1.5 });
          const yEnd = g.wrap(ev.t, 56, 136, 688, 48, { font: 'display', size: 42, weight: 400, color: C.ink });
          if (phase === 'input') {
            const sq = pressing ? .95 : 1;
            g.circle(PAD.x, PAD.y, PAD.r * sq, pressing ? C.hold : C.surface, pressing ? C.hold : C.lineStrong, 1.5);
            if (!pressing) g.circle(PAD.x, PAD.y, PAD.r * .3, C.hold);
            g.text(pressing ? 'Let go when it ends' : 'Press and hold', PAD.x, PAD.y + PAD.r + 34, { size: 15, weight: 550, color: C.ink2, align: 'center' });
          } else {
            const k = easeOut(clamp((t - revealAt) / .8, 0, 1));
            const noteEnd = g.wrap(ev.n, 56, yEnd + g.size(42, 'display') * .95, 688, 24, { size: 17, color: C.ink2 });
            const max = Math.max(held, ev.s) * 1.16;
            const x0 = 56, x1 = 744, sx = (v) => x0 + (x1 - x0) * v / max;
            const step = max <= 2.5 ? .5 : max <= 9 ? 1 : 2;
            const by = clamp(noteEnd + 44, 380, 470), bh = Math.max(22, g.size(13, 'mono') * 1.5);
            const ax = by + bh * 2 + 30;
            g.line(x0, ax, x1, ax, C.lineStrong, 1);
            for (let v = 0; v <= max + 1e-6; v += step) {
              g.line(sx(v), ax, sx(v), ax + 6, C.lineStrong, 1);
              g.text(String(+v.toFixed(1)), sx(v), ax + 22, { font: 'mono', size: 12, color: C.ink3, align: 'center' });
            }
            g.text('s', x1, ax + 22, { font: 'mono', size: 12, color: C.ink3, align: 'right' });
            const bar = (y, v, color, label) => {
              const w = (sx(v) - x0) * k;
              ctx.fillStyle = color; ctx.fillRect(x0, y, w, bh);
              ctx.font = `500 ${g.size(13, 'mono')}px ${C.mono}`;
              const inside = x0 + w + 10 + ctx.measureText(label).width > W - 8;
              g.text(label, inside ? x0 + w - 8 : x0 + w + 10, y + bh / 2 + 1, { font: 'mono', size: 13, color: inside ? C.surface : C.ink, base: 'middle', align: inside ? 'right' : 'left' });
            };
            bar(by, held, C.ink2, `you ${fmtS(held)}`);
            bar(by + bh + 12, ev.s, C.hold, `real ${fmtS(ev.s)}`);
          }
        },
        down(q) { if (dist(q, [PAD.x, PAD.y]) < PAD.r + 26) begin(); },
        up() { end(); },
        cancel() { end(); },
        keyDown() { begin(); return true; },
        keyUp() { end(); },
      };
    },
  };

  /* ===================================================================== BANK
   * A ball rolls across a pool table with no spin and bounces off the long
   * cushions. It vanishes early; the player marks where it meets the far rail.
   * The playing area is 360 px tall; a 9-ft table's is 127 cm.
   */
  const TB = { l: 70, r: 730, t: 120, b: 480, ball: 9, x0: 112, speed: 610 };
  const CM_PER_PX = 127 / (TB.b - TB.t);
  function bankPath(y0, deg) {
    const lo = TB.t + TB.ball, hi = TB.b - TB.ball, h = hi - lo, tan = Math.tan(deg * D2R);
    const xEnd = TB.r - TB.ball;
    const yAt = (x) => {
      const u = y0 + tan * (x - TB.x0);
      const m = (((u - lo) % (2 * h)) + 2 * h) % (2 * h);
      return m <= h ? lo + m : lo + 2 * h - m;
    };
    const uEnd = y0 + tan * (xEnd - TB.x0);
    return { yAt, xEnd, yEnd: yAt(xEnd), bounces: Math.abs(Math.floor((uEnd - lo) / h)), lo, hi };
  }

  const Bank = {
    id: 'bank', name: 'Bank', unit: 'centimetres',
    brief: 'Where does the ball meet the far rail?',
    howto: 'No spin, so it leaves each cushion at the angle it arrived. Tap the right-hand rail where it lands.',
    make(rng, k) {
      for (let i = 0; i < 600; i++) {
        const y0 = lerp(TB.t + 50, TB.b - 50, rng());
        const deg = (k === 0 ? lerp(16, 30, rng()) : lerp(28, 44, rng())) * (rng() < .5 ? -1 : 1);
        const b = bankPath(y0, deg).bounces;
        if (k === 0 ? b >= 1 && b <= 2 : b >= 2 && b <= 4) return { y0, deg };
      }
      return { y0: 300, deg: 30 };
    },
    mount(p, api) {
      const path = bankPath(p.y0, p.deg);
      const vx = TB.speed * Math.cos(p.deg * D2R);
      const SHOW = .5;
      let phase = 'watch', mark = null, revealAt = 0;
      api.tag('Watch the shot');

      function table() {
        const pad = 24;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(TB.l - pad, TB.t - pad, TB.r - TB.l + pad * 2, TB.b - TB.t + pad * 2, 16);
        else ctx.rect(TB.l - pad, TB.t - pad, TB.r - TB.l + pad * 2, TB.b - TB.t + pad * 2);
        ctx.fillStyle = C.bg2; ctx.fill();
        ctx.beginPath(); ctx.rect(TB.l, TB.t, TB.r - TB.l, TB.b - TB.t);
        ctx.fillStyle = C.surface; ctx.fill();
        ctx.globalAlpha = .1; ctx.fillStyle = C.bank; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = C.lineStrong; ctx.lineWidth = 1.5; ctx.stroke();
        // diamonds (sights) on the rails, as on a real table
        for (let i = 1; i < 8; i++) {
          const x = TB.l + (TB.r - TB.l) * i / 8;
          g.circle(x, TB.t - 12, 2.6, C.ink3); g.circle(x, TB.b + 12, 2.6, C.ink3);
        }
        for (let j = 1; j < 4; j++) {
          const y = TB.t + (TB.b - TB.t) * j / 4;
          g.circle(TB.l - 12, y, 2.6, C.ink3); g.circle(TB.r + 12, y, 2.6, C.ink3);
        }
        // target rail
        g.line(TB.r, TB.t, TB.r, TB.b, phase === 'input' ? C.ink : C.ink3, phase === 'input' ? 3 : 2);
      }
      function trail(xFrom, xTo, color, alpha, w) {
        ctx.beginPath();
        for (let x = xFrom; x <= xTo; x += 3) { const y = path.yAt(x); x === xFrom ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.lineTo(xTo, path.yAt(xTo));
        ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.stroke(); ctx.globalAlpha = 1;
      }
      function railMark(y, color, off = 0) {
        g.pointer(TB.r + 3 + off, y, Math.PI, 16, color);
      }

      return {
        frame() {
          const t = api.now();
          table();
          if (phase === 'watch') {
            const x = Math.min(TB.x0 + vx * t, path.xEnd);
            const fade = t < SHOW ? 1 : clamp(1 - (t - SHOW) / .2, 0, 1);
            if (x > TB.x0 + 2) trail(Math.max(TB.x0, x - 130), x, C.bank, .5 * fade, 3);
            ctx.globalAlpha = fade; g.circle(x, path.yAt(x), TB.ball, C.ink); ctx.globalAlpha = 1;
            if (t > SHOW + .25) { phase = 'input'; api.input(); api.tag('Tap the right-hand rail'); }
          } else if (phase === 'input') {
            g.circle(TB.x0, p.y0, TB.ball, null, C.lineStrong, 1.5);
            if (mark != null) railMark(mark, C.ink);
          } else {
            const x = Math.min(TB.x0 + vx * 1.5 * (t - revealAt), path.xEnd);
            trail(TB.x0, x, C.bank, .9, 2.5);
            g.circle(x, path.yAt(x), TB.ball, C.ink);
            railMark(mark, C.ink);
            if (x >= path.xEnd) {
              railMark(path.yEnd, C.bank, 22);
              g.line(TB.r + 30, Math.min(mark, path.yEnd), TB.r + 30, Math.max(mark, path.yEnd), C.ink3, 1.2, [2, 4]);
            }
          }
        },
        down(q) {
          if (phase !== 'input') return;
          mark = clamp(q[1], path.lo, path.hi);
          api.ready(true); api.tag('');
        },
        move(q) { if (this.dragging) this.down(q); },
        submit() {
          phase = 'reveal'; revealAt = api.now();
          const d = Math.abs(mark - path.yEnd);
          const travel = (path.xEnd - TB.x0) / (vx * 1.5);
          const b = path.bounces;
          return {
            score: curve(d, 42),
            head: d * CM_PER_PX < 1 ? 'Into the same spot' : `Off by ${Math.round(d * CM_PER_PX)} cm`,
            detail: `${b} cushion${b === 1 ? '' : 's'} before the far rail`,
            delay: travel * 1000 + 350,
          };
        },
      };
    },
  };

  const TESTS = [Level, Spin, Lamp, Hold, Bank];
  const ROUNDS = TESTS.length * 2;

  function buildSet(seed) {
    const rounds = [];
    TESTS.forEach((T, ti) => {
      for (let k = 0; k < 2; k++) rounds.push({ ti, k, p: T.make(mulberry32(seedFor(seed, ti * 2 + k)), k) });
    });
    return rounds;
  }

  /* ------------------------------------------------------------- game state */
  const today = dayNo();
  let mode = 'daily';          // 'daily' | 'practice'
  let set = null, idx = 0, scores = [], heads = [];
  let ctrl = null, T = null, mountT = 0, state = 'idle', pointerDown = false;
  let timer = null;

  const data = store.get(KEY, { days: {} });
  const saveDay = () => { if (mode === 'daily') { data.days[today] = { scores: scores.slice(), heads: heads.slice() }; store.set(KEY, data); } };
  const dayRec = () => data.days[today] || null;

  const el = {
    intro: $('#intro'), run: $('#run'), end: $('#end'), lbview: $('#lbview'),
    topMeta: $('#topMeta'), introKicker: $('#introKicker'), startBtn: $('#startBtn'), startMeta: $('#startMeta'),
    playedNote: $('#playedNote'), practiceBtn: $('#practiceBtn'),
    rIdx: $('#rIdx'), rTask: $('#rTask'), rName: $('#rName'), rMeta: $('#rMeta'), progress: $('#progress'),
    tag: $('#stageTag'), copy: $('#copy'), brief: $('#brief'), howto: $('#howto'),
    verdict: $('#verdict'), vScore: $('#vScore'), vHead: $('#vHead'), vDetail: $('#vDetail'), act: $('#act'),
  };

  let view = 'intro';
  function show(which) {
    view = which;
    for (const k of ['intro', 'run', 'end', 'lbview']) el[k].hidden = k !== which;
    document.documentElement.dataset.playing = String(which === 'run');
    window.scrollTo(0, 0);
  }

  const fmtDate = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  function renderIntro() {
    el.topMeta.textContent = `No. ${today} · ${fmtDate(new Date())}`;
    el.introKicker.textContent = `Daily · No. ${today}`;
    const rec = dayRec();
    const n = rec ? rec.scores.length : 0;
    el.playedNote.hidden = true;
    if (n >= ROUNDS) {
      el.startBtn.textContent = 'See today’s result';
      el.startMeta.textContent = `${rec.scores.reduce((a, b) => a + b, 0)}/1000 today`;
    } else if (n > 0) {
      el.startBtn.textContent = `Continue No. ${today}`;
      el.startMeta.textContent = `Round ${n + 1} of ${ROUNDS}`;
    } else {
      el.startBtn.textContent = 'Start today’s set';
      el.startMeta.textContent = '10 rounds · about 3 min';
    }
    show('intro');
  }

  function renderProgress() {
    el.progress.innerHTML = '';
    set.forEach((r, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--t', `var(--${TESTS[r.ti].id})`);
      if (i < scores.length) li.style.setProperty('--fill', `${Math.max(scores[i], 3)}%`);
      if (i === idx) li.dataset.state = 'current';
      el.progress.appendChild(li);
    });
  }

  function startDaily() {
    mode = 'daily';
    const rec = dayRec();
    if (rec && rec.scores.length >= ROUNDS) { scores = rec.scores.slice(); heads = (rec.heads || []).slice(); set = buildSet(today); renderEnd(); return; }
    set = buildSet(today);
    scores = rec ? rec.scores.slice() : [];
    heads = rec && rec.heads ? rec.heads.slice() : [];
    idx = scores.length;
    el.topMeta.textContent = `No. ${today} · ${fmtDate(new Date())}`;
    show('run'); resize(); startRound();
  }
  function startPractice() {
    mode = 'practice';
    set = buildSet((Math.random() * 2 ** 31) >>> 0);
    scores = []; heads = []; idx = 0;
    el.topMeta.textContent = 'Practice set';
    show('run'); resize(); startRound();
  }

  const api = {
    now: () => (performance.now() - mountT) / 1000,
    tag(s) { if (el.tag.textContent !== s) el.tag.textContent = s; el.tag.hidden = !s; },
    input() { state = 'input'; el.act.textContent = T.lockLabel || 'Lock in'; el.act.disabled = true; },
    ready(b) { if (state === 'input') el.act.disabled = !b; },
    done(res) { finishRound(res); },
  };

  function startRound() {
    clearTimeout(timer);
    const r = set[idx];
    T = TESTS[r.ti];
    el.rIdx.textContent = idx + 1;
    el.rTask.style.setProperty('--t', `var(--${T.id})`);
    el.verdict.style.setProperty('--t', `var(--${T.id})`);
    el.rName.textContent = T.name;
    el.rMeta.textContent = `Round ${r.k + 1} of 2 · ${T.unit}`;
    el.brief.textContent = T.brief;
    el.howto.textContent = T.howto;
    el.copy.hidden = false; el.verdict.hidden = true;
    el.act.textContent = 'Watch'; el.act.disabled = true;
    cv.setAttribute('aria-label', `${T.name}: ${T.brief}`);
    state = 'watch';
    api.tag('');
    renderProgress();
    readColors();
    mountT = performance.now();
    ctrl = T.mount(r.p, api);
  }

  function finishRound(res) {
    if (state === 'reveal' || state === 'next') return;
    state = 'reveal';
    el.act.disabled = true; el.act.textContent = 'Next';
    api.tag('');
    scores[idx] = res.score; heads[idx] = res.head;
    saveDay();
    timer = setTimeout(() => {
      el.vScore.textContent = res.score;
      el.vHead.textContent = res.head;
      el.vDetail.textContent = res.detail;
      el.copy.hidden = true; el.verdict.hidden = false;
      renderProgress();
      el.act.textContent = idx === ROUNDS - 1 ? 'See results' : 'Next';
      el.act.disabled = false;
      state = 'next';
      el.act.focus({ preventScroll: true });
    }, res.delay || 600);
  }

  el.act.addEventListener('click', () => {
    if (state === 'input' && ctrl.submit) finishRound(ctrl.submit());
    else if (state === 'next') {
      if (idx >= ROUNDS - 1) { ctrl = null; renderEnd(); }
      else { idx++; startRound(); }
    }
  });

  /* pointer input → controller, in board coordinates */
  cv.addEventListener('pointerdown', (e) => {
    if (!ctrl) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    pointerDown = true; ctrl.dragging = true;
    ctrl.down && ctrl.down(pointOf(e));
  });
  cv.addEventListener('pointermove', (e) => { if (ctrl && pointerDown) ctrl.move && ctrl.move(pointOf(e)); });
  const release = (e) => {
    if (!ctrl || !pointerDown) return;
    pointerDown = false; ctrl.dragging = false;
    ctrl.up && ctrl.up(pointOf(e));
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (el.run.hidden || !ctrl) return;
    if (e.key === ' ' && ctrl.keyDown && state === 'input') { e.preventDefault(); if (!e.repeat) ctrl.keyDown(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && !el.act.disabled && document.activeElement !== el.act) { e.preventDefault(); el.act.click(); }
  });
  document.addEventListener('keyup', (e) => { if (e.key === ' ' && ctrl && ctrl.keyUp) ctrl.keyUp(); });

  function loop() {
    if (ctrl && !el.run.hidden) {
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctrl.frame();
    }
    requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------- results */
  const RANKS = [
    [850, 'Plumb', 'Dead true. Your eye could hang a door.'],
    [700, 'True', 'Sharp instincts with a little drift.'],
    [550, 'Steady', 'Mostly right, now and then fooled.'],
    [400, 'Wobbly', 'Your gut and physics disagree on a few things.'],
    [0, 'Off-plumb', 'The world is stranger than it looks. Try a practice set.'],
  ];
  const rankOf = (n) => RANKS.find((r) => n >= r[0]);
  const band = (s) => (s >= 80 ? '🟩' : s >= 50 ? '🟨' : '🟥');

  function shareText(total) {
    const lines = [`Plumb ${mode === 'daily' ? `No. ${today}` : 'practice'} · ${total}/1000 · ${rankOf(total)[1]}`];
    TESTS.forEach((Ts, i) => lines.push(`${band(scores[i * 2])}${band(scores[i * 2 + 1])} ${Ts.name}`));
    if (/^https?:/.test(location.href)) lines.push(location.origin + location.pathname);
    return lines.join('\n');
  }

  function stats() {
    const days = Object.keys(data.days).map(Number).filter((d) => data.days[d].scores.length >= ROUNDS).sort((a, b) => a - b);
    const totals = days.map((d) => data.days[d].scores.reduce((a, b) => a + b, 0));
    let streak = 0;
    for (let d = today; data.days[d] && data.days[d].scores.length >= ROUNDS; d--) streak++;
    return {
      played: days.length,
      avg: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : '–',
      best: totals.length ? Math.max(...totals) : '–',
      streak,
    };
  }

  function renderEnd() {
    const total = scores.reduce((a, b) => a + b, 0);
    const [, rank, blurb] = rankOf(total);
    $('#endKicker').textContent = mode === 'daily' ? `No. ${today} · ${dateOf(today).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}` : 'Practice set';
    $('#endTotal').textContent = total;
    $('#endRank').textContent = rank;
    $('#endBlurb').textContent = blurb;

    const bars = $('#bars'); bars.innerHTML = '';
    const rows = $('#rows'); rows.innerHTML = '';
    TESTS.forEach((Ts, i) => {
      const a = scores[i * 2] || 0, b = scores[i * 2 + 1] || 0;
      const grp = document.createElement('div');
      grp.className = 'bars__group'; grp.style.setProperty('--t', `var(--${Ts.id})`);
      grp.innerHTML = `<div class="bars__cols"><i style="--h:${Math.max(a, 2)}%;animation-delay:${i * 90}ms"></i><i style="--h:${Math.max(b, 2)}%;animation-delay:${i * 90 + 45}ms"></i></div><span>${Ts.name}</span>`;
      bars.appendChild(grp);

      const li = document.createElement('li');
      li.style.setProperty('--t', `var(--${Ts.id})`);
      const note = [heads[i * 2], heads[i * 2 + 1]].filter(Boolean).join(' · ');
      li.innerHTML = `<i class="dot"></i><span class="name">${Ts.name}<small></small></span><span class="rounds">${a} + ${b}</span><span class="sum">${a + b}</span>`;
      li.querySelector('small').textContent = note;
      rows.appendChild(li);
    });

    const st = stats();
    $('#stats').hidden = mode !== 'daily';
    $('#stPlayed').textContent = st.played;
    $('#stAvg').textContent = st.avg;
    $('#stBest').textContent = st.best;
    $('#stStreak').textContent = st.streak;
    $('#againBtn').textContent = mode === 'daily' ? 'Play a practice set' : 'Another practice set';
    $('#shareText').hidden = true;
    $('#shareBtn').onclick = () => copyShare(shareText(total));
    el.topMeta.textContent = mode === 'daily' ? `No. ${today} · ${fmtDate(new Date())}` : 'Practice set';
    show('end');
    openBoard('#endBoardSlot');
    tick();
  }

  function tick() {
    const n = new Date();
    const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
    let s = Math.max(0, Math.floor((next - n) / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0'); s %= 3600;
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const nx = $('#next');
    nx.innerHTML = '';
    nx.append('Next set in ', Object.assign(document.createElement('b'), { textContent: `${hh}:${mm}:${ss}` }));
  }
  setInterval(() => { if (!el.end.hidden) tick(); }, 1000);

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }
  function copyShare(text) {
    const fallback = () => {
      const ta = $('#shareText');
      ta.value = text; ta.hidden = false; ta.focus(); ta.select();
      toast('Select the text and copy it');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('Copied'), fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  /* ------------------------------------------------------------ leaderboard
   * Scores go to the same Supabase project as Hexed, table plumb_scores
   * (see supabase-setup.sql). The key below is the publishable one: it can
   * only read scores and add today's, which the table's rules check.
   */
  const LB = {
    url: 'https://rzarchlzbysovqumzvyi.supabase.co',
    key: 'sb_publishable_Ssl9L8brbm2t8YLiRgnFEQ_yGmAYJN_',
  };
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const player = store.get('plumb:player', null) || { id: uuid(), name: '' };
  store.set('plumb:player', player);
  const posted = store.get('plumb:posted', {});

  async function sb(path, opts = {}) {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(`${LB.url}/rest/v1/${path}`, {
        ...opts, signal: ctl.signal,
        headers: { apikey: LB.key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      const text = await r.text();
      if (!r.ok) {
        const e = new Error(text || r.statusText); e.status = r.status;
        try { e.body = JSON.parse(text); } catch (_) { /* not JSON */ }
        throw e;
      }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(timeout); }
  }

  const B = { el: $('#board'), tab: 'today', req: 0 };
  const bEl = {
    list: $('#boardList'), note: $('#boardNote'), foot: $('#boardFoot'),
    namer: $('#namer'), nameIn: $('#nameIn'), nameErr: $('#nameErr'), nameGo: $('#nameGo'),
    today: $('#tabToday'), all: $('#tabAll'),
  };
  const TOP = 10;
  const cleanName = (v) => v.replace(/\s+/g, ' ').trim().slice(0, 20);
  const dayDone = () => { const r = dayRec(); return !!(r && r.scores.length >= ROUNDS); };
  const markPosted = () => { posted[today] = true; store.set('plumb:posted', posted); };

  async function postScore() {
    if (!dayDone() || posted[today] || !player.name) return;
    const rounds = dayRec().scores.slice(0, ROUNDS).map((v) => clamp(Math.round(v), 0, 100));
    const total = rounds.reduce((a, b) => a + b, 0);
    try {
      await sb('plumb_scores', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ day: today, player_id: player.id, name: player.name, total, rounds }),
      });
      markPosted();
    } catch (e) {
      if (e.status === 409) markPosted(); // already on the board
      else throw e;
    }
  }

  function updateNamer() {
    bEl.namer.hidden = !(dayDone() && !posted[today]);
    if (!bEl.namer.hidden && !bEl.nameIn.value) bEl.nameIn.value = player.name || '';
  }

  function boardRow(r, you) {
    const li = document.createElement('li');
    if (you) li.dataset.you = '';
    li.innerHTML = '<span class="rk"></span><span class="nm"></span><span class="ex"></span><span class="sc"></span>';
    li.children[0].textContent = r.rank;
    li.children[1].textContent = r.name;
    if (you) { const t = document.createElement('small'); t.textContent = 'you'; li.children[1].append(t); }
    li.children[2].textContent = r.extra || '';
    li.children[3].textContent = r.score;
    return li;
  }

  function renderBoard(rows, kind) {
    bEl.list.innerHTML = '';
    bEl.foot.textContent = '';
    if (!rows.length) {
      bEl.note.textContent = kind === 'today' ? 'No scores yet today. Be the first.' : 'No scores yet.';
      return;
    }
    let rank = 0, prev = null;
    rows.forEach((r, i) => { if (r.score !== prev) { rank = i + 1; prev = r.score; } r.rank = rank; });
    const me = rows.findIndex((r) => r.pid === player.id);
    rows.slice(0, TOP).forEach((r) => bEl.list.append(boardRow(r, r.pid === player.id)));
    if (me >= TOP) {
      if (me > TOP) { const gap = document.createElement('li'); gap.className = 'gap'; gap.textContent = '⋯'; bEl.list.append(gap); }
      bEl.list.append(boardRow(rows[me], true));
    }
    const n = rows.length;
    if (kind === 'today') {
      bEl.note.textContent = me >= 0
        ? `You’re #${rows[me].rank} of ${n} today.`
        : `${n} ${n === 1 ? 'player' : 'players'} so far today.`;
    } else {
      bEl.note.textContent = me >= 0
        ? `You’re #${rows[me].rank} of ${n} players, ranked by average score.`
        : `${n} ${n === 1 ? 'player' : 'players'}, ranked by average score.`;
    }
    if (n > TOP) bEl.foot.textContent = `Showing the top ${TOP}${me >= TOP ? ' and you' : ''}.`;
  }

  async function loadBoard() {
    const id = ++B.req;
    bEl.today.setAttribute('aria-selected', String(B.tab === 'today'));
    bEl.all.setAttribute('aria-selected', String(B.tab === 'all'));
    updateNamer();
    bEl.note.textContent = 'Loading…';
    bEl.list.innerHTML = ''; bEl.foot.textContent = '';
    try {
      let rows;
      if (B.tab === 'today') {
        const res = await sb(`plumb_scores?select=player_id,name,total,created_at&day=eq.${today}&order=total.desc,created_at.asc&limit=1000`);
        rows = res.map((r) => ({ pid: r.player_id, name: r.name, score: r.total }));
      } else {
        const res = await sb('plumb_player_stats?select=player_id,name,games,avg_total,best&order=avg_total.desc,games.desc&limit=1000');
        rows = res.map((r) => ({ pid: r.player_id, name: r.name, score: r.avg_total, extra: `${r.games} ${r.games === 1 ? 'game' : 'games'} · best ${r.best}` }));
      }
      if (id === B.req) renderBoard(rows, B.tab);
    } catch (e) {
      if (id !== B.req) return;
      const body = e.body ? JSON.stringify(e.body) : '';
      const missing = e.status === 404 || /PGRST205|42P01|does not exist|schema cache/i.test(body);
      bEl.note.textContent = missing
        ? 'The leaderboard isn’t switched on yet. Your scores are still saved on this device.'
        : 'Couldn’t reach the leaderboard. Check your connection, then reopen it.';
      bEl.namer.hidden = true;
    }
  }

  function openBoard(slot) {
    $(slot).appendChild(B.el);
    bEl.nameErr.hidden = true;
    (async () => {
      if (dayDone() && !posted[today] && player.name) { try { await postScore(); } catch (_) { /* the form stays up to retry */ } }
      loadBoard();
    })();
  }

  let lbFrom = 'intro';
  function showLeaderboard() {
    if (view === 'lbview') return;
    lbFrom = view;
    clearTimeout(timer);
    $('#lbKicker').textContent = `No. ${today} · ${fmtDate(new Date())}`;
    show('lbview');
    openBoard('#lbSlot');
  }
  function leaveLeaderboard() {
    if (lbFrom === 'end') renderEnd();
    else renderIntro();
  }

  bEl.today.addEventListener('click', () => { if (B.tab !== 'today') { B.tab = 'today'; loadBoard(); } });
  bEl.all.addEventListener('click', () => { if (B.tab !== 'all') { B.tab = 'all'; loadBoard(); } });
  bEl.namer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = cleanName(bEl.nameIn.value);
    const fail = (msg) => { bEl.nameErr.textContent = msg; bEl.nameErr.hidden = false; };
    if (!n) { fail('Type a name first.'); return; }
    bEl.nameErr.hidden = true;
    player.name = n; store.set('plumb:player', player);
    bEl.nameGo.disabled = true; bEl.nameGo.textContent = 'Posting…';
    try {
      await postScore();
      loadBoard();
    } catch (err) {
      fail(/check|violates|policy/i.test(err.message || '')
        ? 'This score can’t be posted. Scores only count on the day of the puzzle.'
        : 'Couldn’t post your score. Check your connection and try again.');
    } finally {
      bEl.nameGo.disabled = false; bEl.nameGo.textContent = 'Post score';
    }
  });
  $('#lbBtn').addEventListener('click', showLeaderboard);
  $('#lbBack').addEventListener('click', leaveLeaderboard);
  $('#lbSlot').appendChild(B.el);

  /* ------------------------------------------------------------------ wiring */
  el.startBtn.addEventListener('click', startDaily);
  el.practiceBtn.addEventListener('click', startPractice);
  $('#againBtn').addEventListener('click', startPractice);
  window.addEventListener('resize', resize);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', readColors);
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  readColors();
  renderIntro();
  requestAnimationFrame(loop);

  /* exposed for the self-test page only */
  window.__plumb = { buildSet, TESTS, GLASSES, levelFor, polyArea, clipPoly, rotPts, bankPath, curve, dayNo };
})();
