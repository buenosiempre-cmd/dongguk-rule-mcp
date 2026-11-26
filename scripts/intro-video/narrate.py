#!/usr/bin/env python3
"""소개 영상 v3 내레이션을 합성하고 화면 타이밍(timeline.js)을 만듭니다.

  python3 scripts/intro-video/narrate.py --engine melo   # MeloTTS(MIT), 기본
  python3 scripts/intro-video/narrate.py --engine edge   # edge-tts(시험용, 배포 조건 불명확)

입력: docs/assets/intro/narration.json
출력: docs/assets/intro/narration/<id>.opus(96kbps), docs/assets/intro/timeline.js
화면 장면 시작·끝과 자막 시각은 실제 음성 길이에서 계산합니다.

MeloTTS(https://github.com/myshell-ai/MeloTTS, 코드·모델 MIT) 준비 예(Python 3.10, CPU):
  uv venv -p 3.10 .venv && . .venv/bin/activate
  uv pip install torch==2.2.2 torchaudio==2.2.2 --index-url https://download.pytorch.org/whl/cpu
  git clone https://github.com/myshell-ai/MeloTTS && uv pip install -e ./MeloTTS python-mecab-ko "setuptools<70"
  python -m unidic download   # nltk cmudict·averaged_perceptron_tagger(_eng) 데이터도 필요
음성을 다시 합성하지 않고 대본 간격만 바꿀 때는 --timeline-only 를 씁니다(narration/durations.json 사용).
"""
import argparse, json, os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
INTRO = os.path.join(ROOT, 'docs', 'assets', 'intro')
OUT = os.path.join(INTRO, 'narration')
SR = 44100

# 장면이 첫 내레이션보다 얼마나 먼저 시작하는지(초)
SCENE_LEAD = {'before': None, 'after': 1.1, 'how': 0.9, 'anywhere': 0.9, 'cta': 1.0}
TAIL = 3.0


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


DURS = {}


def to_opus(wav, ln_id):
    # 타이밍은 인코딩 전 음성 길이로 잡고 durations.json에 남깁니다(opus 앞뒤 패딩 영향 없음).
    DURS[ln_id] = round(duration(wav), 6)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '96k', os.path.join(OUT, f'{ln_id}.opus')], check=True)
    os.remove(wav)


def normalize(src, dst, speed=1.0):
    """44.1kHz 모노, 앞뒤 무음 정리, 음량 정규화."""
    af = ['silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05',
          'areverse', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08', 'areverse',
          'loudnorm=I=-18:TP=-2:LRA=7']
    if speed != 1.0:
        af.insert(0, f'atempo={speed}')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-af', ','.join(af), '-ar', str(SR), '-ac', '1', dst], check=True)


def synth_melo(lines, speed):
    from melo.api import TTS
    model = TTS(language='KR', device='cpu')
    spk = model.hps.data.spk2id['KR']
    for ln in lines:
        raw = os.path.join(OUT, f"{ln['id']}.raw.wav")
        model.tts_to_file(ln['tts'], spk, raw, speed=speed, quiet=True)
        wav = os.path.join(OUT, f"{ln['id']}.wav")
        normalize(raw, wav)
        os.remove(raw)
        to_opus(wav, ln['id'])


def synth_edge(lines, voice, edge_bin):
    for ln in lines:
        raw = os.path.join(OUT, f"{ln['id']}.raw.mp3")
        subprocess.run([edge_bin, '--voice', voice, '--rate', '-4%', '--text', ln['tts'], '--write-media', raw], check=True)
        wav = os.path.join(OUT, f"{ln['id']}.wav")
        normalize(raw, wav)
        os.remove(raw)
        to_opus(wav, ln['id'])


def build_timeline(lines, engine):
    dpath = os.path.join(OUT, 'durations.json')
    if DURS:
        json.dump(DURS, open(dpath, 'w'), indent=1)
    durs = json.load(open(dpath))
    t = 0.0
    out = []
    for ln in lines:
        t += ln['gapBefore']
        d = durs[ln['id']]
        out.append({'id': ln['id'], 'scene': ln['scene'], 'start': round(t, 3), 'end': round(t + d, 3), 'sub': ln['sub']})
        t += d
    scenes = {}
    order = ['before', 'after', 'how', 'anywhere', 'cta']
    for name in order:
        first = next(x for x in out if x['scene'] == name)
        scenes[name] = [0.0 if SCENE_LEAD[name] is None else round(first['start'] - SCENE_LEAD[name], 3)]
    for a, b in zip(order, order[1:]):
        scenes[a].append(scenes[b][0])
    total = round(out[-1]['end'] + TAIL, 3)
    scenes['cta'].append(total)
    tl = {'engine': engine, 'duration': total, 'scenes': scenes, 'lines': out}
    with open(os.path.join(INTRO, 'timeline.js'), 'w', encoding='utf-8') as f:
        f.write('// narrate.py 가 만든 파일입니다. 직접 고치지 마세요.\n')
        f.write('window.TIMELINE = ' + json.dumps(tl, ensure_ascii=False, indent=1) + ';\n')
    return tl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--engine', choices=['melo', 'edge'], default='melo')
    ap.add_argument('--speed', type=float, default=0.95)
    ap.add_argument('--voice', default='ko-KR-SunHiNeural')
    ap.add_argument('--edge-bin', default='edge-tts')
    ap.add_argument('--timeline-only', action='store_true')
    a = ap.parse_args()
    lines = json.load(open(os.path.join(INTRO, 'narration.json'), encoding='utf-8'))['lines']
    os.makedirs(OUT, exist_ok=True)
    if not a.timeline_only:
        if a.engine == 'melo':
            synth_melo(lines, a.speed)
        else:
            synth_edge(lines, a.voice, a.edge_bin)
    tl = build_timeline(lines, a.engine)
    json.dump(tl, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
