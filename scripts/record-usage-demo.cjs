'use strict';
/**
 * docs/assets/usage-demo.html(앱 예시 화면: Claude·ChatGPT·팀 메신저)을 헤드리스 크롬으로
 * 프레임 단위 녹화해 미리보기 MP4·GIF를 만듭니다. 결과는 임시 폴더에만 씁니다.
 * README 소개 영상(v3)은 scripts/intro-video/record.cjs 가 만들며, 이 화면을 iframe으로 재사용합니다.
 *
 *   node scripts/record-usage-demo.cjs
 *
 * 필요: google-chrome(또는 CHROME 환경변수), ffmpeg, Node 22 이상(WebSocket 내장).
 * 프레임마다 window.render(t)를 호출하므로 실행 속도와 무관하게 결과가 같습니다.
 * 한글 웹폰트(Noto Sans KR)를 받으려면 네트워크가 필요하며, 없으면 시스템 Noto CJK로 대체됩니다.
 */
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'docs/assets');
const WORK = path.join(os.tmpdir(), 'dongguk-demo');
const FRAMES = path.join(WORK, 'frames');
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = Number(process.env.DEMO_FPS || 25);
const GIF_FPS = 10;
const GIF_WIDTH = Number(process.env.DEMO_GIF_WIDTH || 800);
// README GIF가 5MB를 넘으면 앞부분(소개+Claude)만 담은 짧은 GIF를 따로 만듭니다.
const SHORT_GIF_END = 23.2;
const GIF_LIMIT = 5 * 1024 * 1024;

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result || {});
    } else if (msg.method) events.push(msg);
  });
  return {
    send(method, params = {}) {
      const thisId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(thisId, {resolve, reject});
        ws.send(JSON.stringify({id: thisId, method, params}));
      });
    },
    async until(method, timeoutMs = 20000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const index = events.findIndex((msg) => msg.method === method);
        if (index >= 0) return events.splice(index, 1)[0].params;
        await delay(30);
      }
      throw new Error(`timeout waiting for ${method}`);
    },
  };
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(ASSETS, 'usage-demo.html');
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {stdio: ['ignore', 'ignore', 'inherit']});
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

async function makeGif(out, seconds) {
  const palette = path.join(WORK, 'palette.png');
  const input = ['-framerate', String(FPS), '-i', path.join(FRAMES, 'frame-%05d.png')];
  const trim = seconds ? `trim=0:${seconds},` : '';
  const base = `${trim}fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-vf', `${base},palettegen=stats_mode=diff:max_colors=160`, palette]);
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-i', palette,
    '-lavfi', `${base}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, out]);
  return fs.statSync(out).size;
}

async function main() {
  fs.rmSync(WORK, {recursive: true, force: true});
  fs.mkdirSync(FRAMES, {recursive: true});
  const server = await serve();
  const port = server.address().port;
  const debugPort = 20000 + Math.floor(Math.random() * 20000);
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--disable-dev-shm-usage', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(WORK, 'chrome')}`,
    `--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=1',
    'about:blank',
  ], {stdio: 'ignore'});
  try {
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      try {
        const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
        page = list.find((target) => target.type === 'page');
      } catch {}
      if (!page) await delay(100);
    }
    if (!page) throw new Error('chrome page target missing');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    const client = cdp(ws);
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false});
    const loaded = client.until('Page.loadEventFired');
    await client.send('Page.navigate', {url: `http://127.0.0.1:${port}/usage-demo.html?record`});
    await loaded;
    const ready = await client.send('Runtime.evaluate', {expression: 'window.ready.then(() => [window.DURATION, document.fonts.check("16px \\"Noto Sans KR\\"")])', awaitPromise: true, returnByValue: true});
    const [duration, webFont] = ready.result.value;
    if (!webFont) console.warn('경고: Noto Sans KR 웹폰트를 받지 못해 시스템 글꼴로 녹화합니다.');
    const frames = Math.round(duration * FPS);
    for (let i = 0; i < frames; i++) {
      await client.send('Runtime.evaluate', {expression: `render(${(i / FPS).toFixed(4)})`});
      const shot = await client.send('Page.captureScreenshot', {format: 'png', fromSurface: true});
      fs.writeFileSync(path.join(FRAMES, `frame-${String(i).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
    }
    ws.close();

    const mp4 = path.join(WORK, 'app-screens.mp4');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, 'frame-%05d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    const gif = path.join(WORK, 'app-screens.gif');
    const gifBytes = await makeGif(gif);
    const shortGif = path.join(WORK, 'app-screens-short.gif');
    let shortGifBytes = null;
    if (gifBytes > GIF_LIMIT) shortGifBytes = await makeGif(shortGif, SHORT_GIF_END);
    else fs.rmSync(shortGif, {force: true});
    console.log(JSON.stringify({frames, fps: FPS, duration, webFont, mp4Bytes: fs.statSync(mp4).size, gifBytes, shortGifBytes, framesDir: FRAMES}));
  } finally {
    chrome.kill('SIGKILL');
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
