'use strict';
/**
 * 소개 영상 v4 녹화: docs/assets/intro/intro.html 을 헤드리스 크롬에서 프레임 단위로 캡처하고
 * 내레이션·배경음(mix_audio.py)과 합쳐 MP4(소리 포함)와 README용 하이라이트 GIF를 만듭니다.
 *
 *   python3 scripts/intro-video/narrate.py      # 내레이션 합성 + timeline.js (MeloTTS 필요, 한 번만)
 *   node scripts/intro-video/record.cjs         # 프레임 녹화 + 오디오 믹스 + 인코딩
 *
 * 환경변수: INTRO_FPS(기본 30), INTRO_SCALE(기본 1.5 → 1920x1080), CHROME(크롬 경로),
 *   INTRO_GIF_ONLY=1(이미 녹화한 프레임으로 GIF만 다시 만들기)
 * 필요: google-chrome, ffmpeg, python3(numpy), Node 22 이상
 */
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'docs/assets');
const WORK = path.join(os.tmpdir(), 'dongguk-intro-v4');
const FRAMES = path.join(WORK, 'frames');
const FPS = Number(process.env.INTRO_FPS || 30);
const SCALE = Number(process.env.INTRO_SCALE || 1.5);
const W = 1280, H = 720;
const GIF_WIDTH = 800, GIF_FPS = 12;
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml'};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      const file = path.resolve(ASSETS, rel);
      if (!file.startsWith(ASSETS + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function cdp(ws) {
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result || {});
    } else if (msg.method) events.push(msg);
  });
  return {
    send(method, params = {}) {
      const thisId = ++id;
      return new Promise((resolve, reject) => { pending.set(thisId, {resolve, reject}); ws.send(JSON.stringify({id: thisId, method, params})); });
    },
    async until(method, timeoutMs = 30000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const i = events.findIndex((m) => m.method === method);
        if (i >= 0) return events.splice(i, 1)[0].params;
        await delay(30);
      }
      throw new Error(`timeout waiting for ${method}`);
    },
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {stdio: ['ignore', 'inherit', 'inherit']});
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

function timeline() {
  const src = fs.readFileSync(path.join(ASSETS, 'intro/timeline.js'), 'utf8');
  return JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
}

async function main() {
  const tl = timeline();
  if (process.env.INTRO_GIF_ONLY) return makeGif(tl);
  fs.rmSync(WORK, {recursive: true, force: true});
  fs.mkdirSync(FRAMES, {recursive: true});
  const server = await serve();
  const port = server.address().port;
  const debugPort = 20000 + Math.floor(Math.random() * 20000);
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(WORK, 'chrome')}`,
    `--window-size=${W},${H}`, 'about:blank',
  ], {stdio: 'ignore'});
  try {
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      try { page = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json())).find((x) => x.type === 'page'); } catch {}
      if (!page) await delay(100);
    }
    if (!page) throw new Error('chrome page target missing');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    const client = cdp(ws);
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {width: W, height: H, deviceScaleFactor: SCALE, mobile: false});
    const loaded = client.until('Page.loadEventFired');
    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/intro/intro.html?record`});
    await loaded;
    const ready = await client.send('Runtime.evaluate', {expression: 'window.ready', awaitPromise: true, returnByValue: true});
    if (!ready.result.value) console.warn('경고: Noto Sans KR 웹폰트를 받지 못했습니다.');
    const frames = Math.round(tl.duration * FPS);
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      await client.send('Runtime.evaluate', {expression: `render(${(i / FPS).toFixed(4)})`});
      const shot = await client.send('Page.captureScreenshot', {format: 'png', fromSurface: true});
      fs.writeFileSync(path.join(FRAMES, `f${String(i).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
      if (i % 300 === 0) console.error(`frame ${i}/${frames} (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    server.close();
  }

  const mix = path.join(WORK, 'mix.wav');
  await run('python3', [path.join(__dirname, 'mix_audio.py'), mix]);
  const input = ['-framerate', String(FPS), '-i', path.join(FRAMES, 'f%05d.png')];
  const mp4 = path.join(ASSETS, 'usage-demo.mp4');
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-i', mix,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-tune', 'animation',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', mp4]);
  const gif = await makeGif(tl);
  console.log(JSON.stringify({duration: tl.duration, fps: FPS, size: `${W * SCALE}x${H * SCALE}`, mp4Bytes: fs.statSync(mp4).size,
    gifBytes: fs.statSync(gif).size, framesDir: FRAMES}));
}

// README 하이라이트 GIF(소리 없음, 자막 포함): '질문 한 줄' 해결 장면 + 타대학 비교 장면을 이어 붙입니다.
async function makeGif(tl) {
  const L = Object.fromEntries(tl.lines.map((l) => [l.id, l]));
  const segs = [[L.n3.start - .8, tl.scenes.after[1]], [tl.scenes.compare[0], tl.scenes.compare[1]]];
  const input = ['-framerate', String(FPS), '-i', path.join(FRAMES, 'f%05d.png')];
  const gif = path.join(ASSETS, 'usage-demo.gif');
  const palette = path.join(WORK, 'palette.png');
  const parts = segs.map(([s, e], i) => `[0:v]trim=${s.toFixed(3)}:${e.toFixed(3)},setpts=PTS-STARTPTS[s${i}]`).join(';');
  const cat = `${parts};${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-filter_complex', `${cat},palettegen=stats_mode=diff:max_colors=160`, palette]);
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-i', palette, '-filter_complex', `${cat}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif]);
  console.error(`gif ${fs.statSync(gif).size} bytes, segments ${JSON.stringify(segs.map(([s, e]) => [+s.toFixed(2), +e.toFixed(2)]))}`);
  return gif;
}

main().catch((e) => { console.error(e); process.exit(1); });
