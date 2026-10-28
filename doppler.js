// ドップラー効果シミュレーション
// 音源を画面中央に置き、4パターン（音源・観測者の静止/移動の組み合わせ）を再現する

const V = 340;              // 音速 [m/s]
const WAVE_PX = 150;        // 画面上での音速 [px/s]
const PX_PER_M = WAVE_PX / V;
const VIS_F = 2.5;          // 画面に描く波面の発生頻度 [回/s]（見やすさのため間引き）
const VIS_T = 1 / VIS_F;
const PREFILL = 7;          // 開始時にあらかじめ描いておく波面の時間 [s]

const sim = document.getElementById('sim');
const ctx = sim.getContext('2d');
const graph = document.getElementById('graph');
const gctx = graph.getContext('2d');
const W = sim.width, H = sim.height;
const CX = W / 2, CY = H / 2;

const $ = id => document.getElementById(id);

const params = {
  pattern: 1,
  f: 440,
  vs: 120,   // m/s
  vo: 80,    // m/s
  offset: 60,
  inline: false, // true: 観測者と音源が一直線上
  dir: 'opposite', // パターン④の向き: opposite 向かい合う / srcBehind 音源が後ろ / obsBehind 観測者が後ろ
  speed: 1,
};

let state;
let running = true;

// ---------- 初期化 ----------
function reset() {
  const p = params.pattern;
  const srcMoves = p === 2 || p === 4;
  const obsMoves = p === 3 || p === 4;
  const vs = srcMoves ? params.vs : 0;
  const vo = obsMoves ? params.vo : 0;

  // 音源は画面中央を基準に置く。移動する場合は左から中央を通過して右へ
  const src = {
    x: srcMoves ? CX - 360 : CX,
    y: CY,
    vx: vs * PX_PER_M, vy: 0,     // px/s
    vmx: vs, vmy: 0,               // m/s
  };
  // 観測者は右側。移動する場合は右から左へ音源とすれ違う
  const obs = {
    x: obsMoves ? W - 30 : (srcMoves ? CX + 120 : CX + 280),
    y: CY + (params.inline ? 0 : params.offset),
    vx: -vo * PX_PER_M, vy: 0,
    vmx: -vo, vmy: 0,
  };

  // パターン④で同じ向き（どちらも右向き）に進む場合は、後ろ側を左端に置く
  if (p === 4 && params.dir !== 'opposite') {
    obs.vx = -obs.vx; obs.vmx = -obs.vmx;
    const back = 40, front = CX - 200;
    src.x = params.dir === 'srcBehind' ? back : front;
    obs.x = params.dir === 'srcBehind' ? front : back;
  }

  state = {
    t: 0,
    src, obs,
    waves: [],
    nextEmit: 0,
    lastArrival: null,
    fTheo: null,
    fMeas: null,
    history: [],
    srcPath: { x0: src.x, y0: src.y },
    obsPath: { x0: obs.x, y0: obs.y },
  };

  // 過去から一定速度で動いてきたとして波面を事前に生成
  for (let k = Math.ceil(PREFILL / VIS_T); k >= 1; k--) {
    const te = -k * VIS_T;
    const w = {
      x: src.x + src.vx * te,
      y: src.y + src.vy * te,
      t0: te,
    };
    const r = WAVE_PX * (0 - te);
    w.prevG = Math.hypot(obs.x - w.x, obs.y - w.y) - r;
    w.passed = w.prevG <= 0;
    state.waves.push(w);
  }
  updateTheory();
  updateLabels();
}

// ---------- 物理更新 ----------
function step(dt) {
  const s = state;
  s.t += dt;
  s.src.x += s.src.vx * dt; s.src.y += s.src.vy * dt;
  s.obs.x += s.obs.vx * dt; s.obs.y += s.obs.vy * dt;

  // 波面の発生（発生時刻の音源位置を記録）
  while (s.nextEmit <= s.t) {
    const back = s.t - s.nextEmit;
    s.waves.push({
      x: s.src.x - s.src.vx * back,
      y: s.src.y - s.src.vy * back,
      t0: s.nextEmit,
      prevG: Infinity,
      passed: false,
    });
    s.nextEmit += VIS_T;
  }

  // 波面が観測者に届いたかを判定（フレーム内で線形補間して到達時刻を求める）
  for (const w of s.waves) {
    const r = WAVE_PX * (s.t - w.t0);
    const g = Math.hypot(s.obs.x - w.x, s.obs.y - w.y) - r;
    if (!w.passed && g <= 0) {
      w.passed = true;
      const frac = isFinite(w.prevG) && w.prevG > 0 ? w.prevG / (w.prevG - g) : 1;
      const ta = s.t - dt + frac * dt;
      if (s.lastArrival !== null && ta > s.lastArrival) {
        // 波面の発生間隔 VIS_T が到達間隔に伸び縮みした比 = f'/f
        s.fMeas = params.f * VIS_T / (ta - s.lastArrival);
      }
      s.lastArrival = ta;
    }
    w.prevG = g;
  }

  // 画面外に出た波面を削除
  const maxR = Math.hypot(W, H) * 1.6;
  s.waves = s.waves.filter(w => WAVE_PX * (s.t - w.t0) < maxR);

  updateTheory();
  s.history.push({ t: s.t, theo: s.fTheo, meas: s.fMeas });
  while (s.history.length && s.history[0].t < s.t - 25) s.history.shift();

  // 移動している物体が画面外に出たら最初からやり直す
  const out = o => o.x < -60 || o.x > W + 60;
  if ((s.src.vx !== 0 && out(s.src)) || (s.obs.vx !== 0 && out(s.obs))) reset();
}

// 理論値: いま観測者に届いている音が発せられた時の音源位置を使って
//   f' = f (V - vo・n) / (V - vs・n)   n: 音源(発音時)→観測者 の単位ベクトル
// 音源は等速なので、発音からの経過時間 τ は |D + vs τ| = V τ（D = 観測者 - 現在の音源）の正の解
function updateTheory() {
  const s = state;
  const Dx = s.obs.x - s.src.x, Dy = s.obs.y - s.src.y;
  const b = Dx * s.src.vx + Dy * s.src.vy;
  const a = WAVE_PX * WAVE_PX - (s.src.vx ** 2 + s.src.vy ** 2);
  const tau = (b + Math.sqrt(b * b + a * (Dx * Dx + Dy * Dy))) / a;
  if (tau > s.t + PREFILL) { s.fTheo = null; return; }
  const ex = s.src.x - s.src.vx * tau, ey = s.src.y - s.src.vy * tau;
  const dx = s.obs.x - ex, dy = s.obs.y - ey;
  const d = Math.hypot(dx, dy) || 1;
  const nx = dx / d, ny = dy / d;
  const vsn = s.src.vmx * nx + s.src.vmy * ny;   // 音源の観測者向き速度成分
  const von = s.obs.vmx * nx + s.obs.vmy * ny;   // 観測者の音源から遠ざかる向きの速度成分
  s.vsn = vsn; s.von = von;
  s.fTheo = params.f * (V - von) / (V - vsn);
}

// ---------- 描画 ----------
function draw() {
  const s = state;
  ctx.clearRect(0, 0, W, H);

  // グリッド
  ctx.strokeStyle = '#141b2a';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // 進路
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = '#2b3550';
  if (s.src.vx !== 0) { ctx.beginPath(); ctx.moveTo(0, s.src.y); ctx.lineTo(W, s.src.y); ctx.stroke(); }
  if (s.obs.vx !== 0) { ctx.beginPath(); ctx.moveTo(0, s.obs.y); ctx.lineTo(W, s.obs.y); ctx.stroke(); }
  ctx.setLineDash([]);

  // 波面
  const maxR = Math.hypot(W, H);
  for (const w of s.waves) {
    const r = WAVE_PX * (s.t - w.t0);
    if (r <= 0) continue;
    const a = Math.max(0.08, 1 - r / maxR);
    ctx.strokeStyle = w.passed ? `rgba(120,170,255,${a * 0.55})` : `rgba(140,200,255,${a})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w.x, w.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 音源と観測者を結ぶ線
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath(); ctx.moveTo(s.src.x, s.src.y); ctx.lineTo(s.obs.x, s.obs.y); ctx.stroke();
  ctx.setLineDash([]);

  // 音源
  // 一直線上でも重ならないよう、音源のラベルは上側・観測者のラベルは下側に描く
  drawBody(s.src.x, s.src.y, '#ff5d5d', speedLabel('音源 S', s.src.vmx, s.src.vmy), -18);
  drawArrow(s.src.x, s.src.y, s.src.vx, s.src.vy, '#ff9a9a');
  // 観測者
  drawBody(s.obs.x, s.obs.y, '#4fd1a5', speedLabel('観測者 O', s.obs.vmx, s.obs.vmy), 30);
  drawArrow(s.obs.x, s.obs.y, s.obs.vx, s.obs.vy, '#8fe8c8');

  drawGraph();
}

function drawBody(x, y, color, label, labelDy) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x, y + labelDy);
}

// 速さは名前と同じ行に書く（矢印の先に書くと近づいたとき他のラベルと重なるため）
function speedLabel(name, vx, vy) {
  const v = Math.hypot(vx, vy);
  return v === 0 ? name : `${name}  ${Math.round(v)} m/s`;
}

function drawArrow(x, y, vx, vy, color) {
  const len = Math.hypot(vx, vy);
  if (len === 0) return;
  const k = 0.9; // 矢印の長さ = 1秒弱で進む距離
  const ex = x + vx * k, ey = y + vy * k;
  const ang = Math.atan2(vy, vx);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - 10 * Math.cos(ang - 0.4), ey - 10 * Math.sin(ang - 0.4));
  ctx.lineTo(ex - 10 * Math.cos(ang + 0.4), ey - 10 * Math.sin(ang + 0.4));
  ctx.closePath(); ctx.fill();
}

// 観測振動数の時間変化グラフ
function drawGraph() {
  const s = state;
  const GW = graph.width, GH = graph.height;
  const padL = 56, padR = 12, padT = 14, padB = 22;
  gctx.clearRect(0, 0, GW, GH);

  const p = params.pattern;
  const vs = (p === 2 || p === 4) ? params.vs : 0;
  const vo = (p === 3 || p === 4) ? params.vo : 0;
  const fmax = params.f * (V + vo) / (V - vs);
  const fmin = params.f * (V - vo) / (V + vs);
  const yMax = fmax * 1.05, yMin = fmin * 0.95;
  const tSpan = 20;
  const t1 = Math.max(tSpan, s.t), t0 = t1 - tSpan;

  const X = t => padL + (t - t0) / tSpan * (GW - padL - padR);
  const Y = f => padT + (yMax - f) / (yMax - yMin) * (GH - padT - padB);

  // 軸と目盛
  gctx.font = '12px sans-serif';
  gctx.fillStyle = '#8a98b5';
  gctx.strokeStyle = '#263044';
  gctx.textAlign = 'right';
  for (const f of [fmin, params.f, fmax]) {
    const y = Y(f);
    gctx.beginPath(); gctx.moveTo(padL, y); gctx.lineTo(GW - padR, y); gctx.stroke();
    gctx.fillText(f.toFixed(0), padL - 6, y + 4);
  }
  gctx.textAlign = 'left';
  gctx.fillText("f' [Hz]（実線: 理論値 / 点: 測定値）  黄色の破線: 音源の振動数 f", padL + 4, GH - 6);

  gctx.setLineDash([5, 5]);
  gctx.strokeStyle = '#ffd166';
  gctx.beginPath(); gctx.moveTo(padL, Y(params.f)); gctx.lineTo(GW - padR, Y(params.f)); gctx.stroke();
  gctx.setLineDash([]);

  // 理論値
  gctx.strokeStyle = '#ff8c69';
  gctx.lineWidth = 2;
  gctx.beginPath();
  let started = false;
  for (const h of s.history) {
    if (h.t < t0 || h.theo === null) { started = false; continue; }
    const x = X(h.t), y = Y(h.theo);
    if (!started) { gctx.moveTo(x, y); started = true; } else gctx.lineTo(x, y);
  }
  gctx.stroke();
  gctx.lineWidth = 1;

  // 測定値（変化した点のみ）
  gctx.fillStyle = '#4fd1a5';
  let prev = null;
  for (const h of s.history) {
    if (h.t < t0 || h.meas === null || h.meas === prev) continue;
    prev = h.meas;
    gctx.beginPath(); gctx.arc(X(h.t), Y(h.meas), 3, 0, Math.PI * 2); gctx.fill();
  }
}

// ---------- 表示 ----------
function updateLabels() {
  const s = state;
  $('outF').textContent = params.f;
  $('outTheo').textContent = s.fTheo === null ? '—' : s.fTheo.toFixed(1);
  $('outMeas').textContent = s.fMeas === null ? '—' : s.fMeas.toFixed(1);

  // 距離の変化率で接近/後退を判定
  const dx = s.obs.x - s.src.x, dy = s.obs.y - s.src.y;
  const d = Math.hypot(dx, dy) || 1;
  const rate = ((s.obs.vx - s.src.vx) * dx + (s.obs.vy - s.src.vy) * dy) / d;
  let st;
  if (Math.abs(rate) < 1e-6) st = '距離は変化しない';
  else if (rate < 0) st = '近づいている（音が高く聞こえる）';
  else st = '遠ざかっている（音が低く聞こえる）';
  if (s.fTheo !== null) {
    if (s.fTheo > params.f + 0.05) st += ' ↑';
    else if (s.fTheo < params.f - 0.05) st += ' ↓';
  }
  $('outState').textContent = st;

  if (s.fTheo === null) {
    $('formula').textContent = '音がまだ観測者に届いていません';
  } else {
    // 観測者が音源に近づく向きの成分 = -von, 音源が観測者に近づく向きの成分 = vsn
    const uo = -s.von, us = s.vsn;
    $('formula').textContent =
      `f' = f × (V + u_o) / (V − u_s)\n` +
      `   = ${params.f} × (340 ${uo >= 0 ? '+' : '−'} ${Math.abs(uo).toFixed(1)})\n` +
      `     ${' '.repeat(String(params.f).length + 2)}/ (340 ${us >= 0 ? '−' : '+'} ${Math.abs(us).toFixed(1)})\n` +
      `   = ${s.fTheo.toFixed(1)} Hz\n` +
      `u_o: 観測者が音源へ近づく速度成分\n` +
      `u_s: 音源が観測者へ近づく速度成分`;
  }
}

// ---------- 音 ----------
let audio = null;
function toggleSound() {
  if (!audio) {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ac.destination);
    osc.start();
    audio = { ac, osc, gain, on: true };
  } else {
    audio.on = !audio.on;
    if (audio.on) audio.ac.resume(); else audio.ac.suspend();
  }
  $('btnSound').textContent = audio.on ? '🔇 音を止める' : '🔈 音を鳴らす';
}
function updateSound() {
  if (!audio || !audio.on) return;
  const f = state.fTheo ?? params.f;
  audio.osc.frequency.setTargetAtTime(f, audio.ac.currentTime, 0.02);
  audio.gain.gain.setTargetAtTime(state.fTheo === null ? 0 : 0.08, audio.ac.currentTime, 0.05);
}

// ---------- UI ----------
function syncControls() {
  const p = params.pattern;
  $('inVs').closest('label').classList.toggle('disabled', !(p === 2 || p === 4));
  $('inVo').closest('label').classList.toggle('disabled', !(p === 3 || p === 4));
  $('inVs').disabled = !(p === 2 || p === 4);
  $('inVo').disabled = !(p === 3 || p === 4);
  $('inOff').closest('label').classList.toggle('disabled', params.inline);
  $('inOff').disabled = params.inline;
  $('direction').classList.toggle('disabled', p !== 4);
  document.querySelectorAll('#direction input').forEach(r => { r.disabled = p !== 4; });
}

document.querySelectorAll('#direction input').forEach(r => {
  r.addEventListener('change', () => {
    if (r.checked) params.dir = r.value;
    reset();
  });
});

document.querySelectorAll('#arrangement input').forEach(r => {
  r.addEventListener('change', () => {
    params.inline = r.value === 'inline' && r.checked;
    syncControls();
    reset();
  });
});

document.querySelectorAll('#patterns button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#patterns button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    params.pattern = Number(btn.dataset.pattern);
    syncControls();
    reset();
  });
});

function bindRange(id, valId, key, resetOnChange, fmt = v => v) {
  $(id).addEventListener('input', e => {
    params[key] = Number(e.target.value);
    $(valId).textContent = fmt(params[key]);
    if (resetOnChange) reset();
  });
}
bindRange('inF', 'valF', 'f', false);
bindRange('inVs', 'valVs', 'vs', true);
bindRange('inVo', 'valVo', 'vo', true);
bindRange('inOff', 'valOff', 'offset', true);
bindRange('inSpeed', 'valSpeed', 'speed', false, v => v.toFixed(2).replace(/0$/, ''));

$('btnPlay').addEventListener('click', () => {
  running = !running;
  $('btnPlay').textContent = running ? '一時停止' : '再生';
});
$('btnReset').addEventListener('click', reset);
$('btnSound').addEventListener('click', toggleSound);

// ---------- メインループ ----------
let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000) * params.speed;
  lastTime = now;
  if (running) {
    // 到達判定の精度を保つため細かく分割して更新
    const sub = Math.ceil(dt / 0.01);
    for (let i = 0; i < sub; i++) step(dt / sub);
  }
  if (running) updateTheory();
  updateLabels();
  updateSound();
  draw();
  requestAnimationFrame(loop);
}

syncControls();
reset();
requestAnimationFrame(loop);
