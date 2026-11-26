'use strict';
/**
 * docs/assets/usage-demo.html 을 헤드리스 크롬으로 프레임 캡처한 뒤
 * GIF·MP4로 만듭니다. 제품 코드 경로는 호출하지 않습니다.
 *
 *   node scripts/record-usage-demo.cjs
 */
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'docs/assets');
const FRAMES = '/tmp/dongguk-demo-frames';
const PORT = 8765;
const WIDTH = 960;
const HEIGHT = 540;
const FPS = 10;
const DURATION = 6.8;

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
    async until(method, timeoutMs = 10000) {
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
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {stdio: 'inherit'});
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

async function main() {
  fs.rmSync(FRAMES, {recursive: true, force: true});
  fs.rmSync('/tmp/dongguk-chrome-demo', {recursive: true, force: true});
  fs.mkdirSync(FRAMES, {recursive: true});
  const server = await serve();
  const chrome = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--disable-dev-shm-usage', '--remote-debugging-port=9222',
    `--user-data-dir=/tmp/dongguk-chrome-demo`,
    `--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=1',
    'about:blank',
  ], {stdio: 'ignore'});
  let page;
  for (let i = 0; i < 50; i++) {
    try {
      const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
      page = list.find((target) => target.type === 'page');
      if (page) break;
    } catch {}
    await delay(100);
  }
  if (!page) throw new Error('chrome page target missing');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const client = cdp(ws);
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  const loaded = client.until('Page.loadEventFired');
  await client.send('Page.navigate', {url: `http://127.0.0.1:${PORT}/usage-demo.html`});
  await loaded;
  const frames = Math.round(DURATION * FPS);
  for (let i = 0; i < frames; i++) {
    const shot = await client.send('Page.captureScreenshot', {format: 'png', fromSurface: true});
    fs.writeFileSync(path.join(FRAMES, `frame-${String(i).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
    await delay(1000 / FPS);
  }
  ws.close();
  chrome.kill('SIGKILL');
  server.close();

  const gif = path.join(ASSETS, 'usage-demo.gif');
  const mp4 = path.join(ASSETS, 'usage-demo.mp4');
  const palette = path.join(FRAMES, 'palette.png');
  await run('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, 'frame-%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  await run('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, 'frame-%04d.png'),
    '-vf', `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=48`, palette]);
  await run('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, 'frame-%04d.png'), '-i', palette,
    '-lavfi', `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif]);
  const gifBytes = fs.statSync(gif).size;
  const mp4Bytes = fs.statSync(mp4).size;
  console.log(JSON.stringify({gifBytes, mp4Bytes, frames}));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
