#!/usr/bin/env python3
"""소개 영상 v3 오디오: 배경음을 직접 합성하고 내레이션과 섞습니다.

  python3 scripts/intro-video/mix_audio.py [출력.wav]

배경음은 이 스크립트가 사인파·잡음으로 직접 만듭니다(외부 음원 없음).
입력: docs/assets/intro/timeline.js, docs/assets/intro/narration/*.opus
"""
import json, os, sys, wave
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
INTRO = os.path.join(ROOT, 'docs', 'assets', 'intro')
SR = 44100


def load_timeline():
    src = open(os.path.join(INTRO, 'timeline.js'), encoding='utf-8').read()
    return json.loads(src[src.index('{'):src.rindex('}') + 1])


def read_audio(path):
    import subprocess
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x); acc = 0.0
    for i in range(len(x)):  # 짧은 신호에만 사용
        acc = (1 - a) * x[i] + a * acc; y[i] = acc
    return y


def env(n, attack, release):
    e = np.ones(n, dtype=np.float32)
    a, r = min(int(attack * SR), n // 2), min(int(release * SR), n // 2)
    if a: e[:a] = np.linspace(0, 1, a)
    if r: e[-r:] = np.minimum(e[-r:], np.linspace(1, 0, r))
    return e


def note(freq, dur, amp, attack=1.2, release=1.8, bright=0.25):
    n = int(dur * SR); t = np.arange(n) / SR
    det = 1 + 0.0025 * np.sin(2 * np.pi * 0.21 * t)
    s = np.sin(2 * np.pi * freq * det * t) + bright * np.sin(2 * np.pi * 2 * freq * t) * 0.5 + bright * 0.2 * np.sin(2 * np.pi * 3 * freq * t)
    return (s * env(n, attack, release) * amp).astype(np.float32)


def pluck(freq, amp=0.18, dur=1.4):
    n = int(dur * SR); t = np.arange(n) / SR
    s = (np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * 2 * freq * t)) * np.exp(-t * 4.5)
    s[:200] *= np.linspace(0, 1, 200)
    return (s * amp).astype(np.float32)


def hz(m):
    return 440 * 2 ** ((m - 69) / 12)


def add(buf, sig, at):
    i = int(at * SR)
    if i >= len(buf): return
    j = min(len(buf), i + len(sig)); buf[i:j] += sig[: j - i]


def build_music(tl, n):
    L = np.zeros(n, dtype=np.float32); R = np.zeros(n, dtype=np.float32)
    sc = tl['scenes']; total = tl['duration']
    rng = np.random.default_rng(7)
    # 1) 문제 장면: 낮은 드론 + 째깍 소리(시간이 흐르는 느낌)
    a, b = sc['before']
    drone = note(hz(45), b - a + 0.6, 0.10, attack=1.5, release=0.6, bright=0.1) + note(hz(52), b - a + 0.6, 0.05, attack=2.0, release=0.6, bright=0.05)
    add(L, drone, a); add(R, drone, a)
    tick = (rng.standard_normal(int(0.012 * SR)) * np.exp(-np.linspace(0, 6, int(0.012 * SR)))).astype(np.float32) * 0.06
    t = a + 1.0; k = 0
    while t < b - 0.3:
        g = 0.6 + 0.4 * (t - a) / (b - a)
        add(L if k % 2 else R, tick * g, t); t += 0.5; k += 1
    # 2) 전환 효과음(휙): 장면 경계마다 걸러진 잡음
    for name in ['after', 'how', 'anywhere', 'cta']:
        at = sc[name][0] - 0.35; m = int(0.9 * SR)
        nz = rng.standard_normal(m).astype(np.float32)
        nz = lowpass(nz, 1800) * np.hanning(m).astype(np.float32) * 0.22
        add(L, nz, at); add(R, nz[::-1].copy(), at)
    # 3) 해결 장면부터: 밝은 패드 화성 진행 + 잔잔한 뜯는 소리
    start = sc['after'][0]
    prog = [[57, 60, 64, 71], [53, 57, 60, 64], [48, 55, 60, 64], [55, 59, 62, 67]]  # Am(add9) F C G
    bar = 4.0; t = start; i = 0
    while t < total - 1.0:
        chord = prog[i % 4]; d = max(0.5, min(bar + 1.5, total - t))
        for m_ in chord:
            sig = note(hz(m_), d, 0.035, attack=1.0, release=1.6, bright=0.3)
            add(L, sig * 1.0, t); add(R, sig * 0.85, t + 0.01)
        bass = note(hz(chord[0] - 12), d, 0.05, attack=0.6, release=1.4, bright=0.15)
        add(L, bass, t); add(R, bass, t)
        if t > sc['after'][0] + 1.5 and t < sc['cta'][0] + 6:
            for s, m_ in enumerate([chord[0] + 12, chord[2] + 12, chord[1] + 12, chord[3] + 12]):
                p = pluck(hz(m_)); add(L if s % 2 else R, p, t + s * 1.0); add(R if s % 2 else L, p * 0.4, t + s * 1.0 + 0.12)
        t += bar; i += 1
    # 마지막 화음
    end_chord = [45, 57, 64, 69, 72]
    for m_ in end_chord:
        sig = note(hz(m_), 4.0, 0.04, attack=0.3, release=3.0, bright=0.25)
        add(L, sig, total - 4.2); add(R, sig, total - 4.2)
    fade = env(n, 0.5, 1.5); return L * fade, R * fade


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join('/tmp', 'dongguk-intro-mix.wav')
    tl = load_timeline(); n = int((tl['duration'] + 0.2) * SR)
    voice = np.zeros(n, dtype=np.float32)
    for ln in tl['lines']:
        add(voice, read_audio(os.path.join(INTRO, 'narration', f"{ln['id']}.opus")), ln['start'])
    L, R = build_music(tl, n)
    # 내레이션이 나올 때 배경음을 낮춤(부드러운 더킹)
    active = np.zeros(n, dtype=np.float32)
    for ln in tl['lines']:
        active[int((ln['start'] - 0.25) * SR): int((ln['end'] + 0.3) * SR)] = 1
    k = int(0.25 * SR); kern = np.ones(k, dtype=np.float32) / k
    active = np.convolve(active, kern, mode='same')
    duck = 1.0 - 0.55 * active
    mixL = voice * 0.95 + L * duck; mixR = voice * 0.95 + R * duck
    peak = max(np.abs(mixL).max(), np.abs(mixR).max())
    if peak > 0.97: mixL, mixR = mixL / peak * 0.97, mixR / peak * 0.97
    st = np.stack([mixL, mixR], axis=1)
    with wave.open(out, 'w') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype(np.int16).tobytes())
    print(json.dumps({'out': out, 'seconds': round(n / SR, 2), 'peak': round(float(peak), 3)}))


if __name__ == '__main__':
    main()
