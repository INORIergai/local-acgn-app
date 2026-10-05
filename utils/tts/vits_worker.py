# -*- coding: utf-8 -*-
"""
round74 · VITS 常驻worker（被 Node 通过 stdin/stdout 逐行 JSON 驱动）

为什么不每次起一个进程：
  实测模型加载 1.3s，而合成只要 0.06s。每次现起进程的话，读 100 段文字要多花 130s。
  所以这里做成**长驻常驻**：Node 启动它一次，之后用一行一个 JSON 通信。

协议（每行一个 JSON，UTF-8，无换行符嵌套）：
  Node → Python:
    {"id":1,"op":"ping"}
    {"id":2,"op":"load"}                                  加载模型
    {"id":3,"op":"voices"}                                 取音色列表
    {"id":4,"op":"synth","text":"...","speaker":0,"noise":0.6,
     "noise_w":0.668,"length":1.2,"lang":"zh","out":"C:\\...\\a.wav"}
  Python → Node:
    {"id":1,"ok":true,"result":{"ready":true}}
    {"id":3,"ok":true,"result":{"speakers":[{"id":0,"name":"特别周"},…]}}
    {"id":4,"ok":true,"result":{"path":"…","seconds":5.02,"sr":22050}}

⚠️ 两个必须避开的坑（Alife 原代码就踩了）：
  1. `hps.data.train.segment_size` 是错的 —— `train` 是 **顶层** 属性。
     照抄 VITS 自带 app.py 的写法会直接 AttributeError（已实测）。
  2. Windows 控制台默认 GBK，中文/日文音色名会乱码。
     Node 侧必须设 PYTHONIOENCODING=utf-8 / PYTHONUTF8=1 / PYTHONUNBUFFERED=1。
"""
import sys
import os
import json
import time
import logging
import traceback

# 必须在 import VITS 之前定死标准输出编码，否则 speakers_list 里的日文会炸
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace', newline='\n')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# ★ numba / librosa 这些库在 import 时会往 stdout 打 DEBUG
#   （实测能看到 "DEBUG:numba.core.byteflow:bytecode dump:" + 几百行字节码转储）。
#   stdout 是我们的 JSON 通道，被污染后 Node 侧读到的全是垃圾行。
#   对策：import 期间把 stdout 整体让给 stderr，import 完再换回来。
#   同时把 numba 日志压到 WARNING（Alife 的 VITS 代码里也有这一行，别漏）。
logging.getLogger('numba').setLevel(logging.WARNING)
try:
    logging.getLogger('numba.core').setLevel(logging.WARNING)
except Exception:
    pass

VITS_DIR = None
_net = None
_hps = None
_speakers = []
_synth = None
_load_error = ''
_load_info = {}


def _log(msg):
    """日志走 stderr，绝不能污染 stdout（stdout 是 JSON 通道）。"""
    try:
        sys.stderr.write('[vits] %s\n' % msg)
        sys.stderr.flush()
    except Exception:
        pass


def send(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    except Exception:
        pass


def load_model():
    # ★ _speakers 必须也在 global 里 —— 漏了会被当成本地变量，函数一返回就丢，
    #   表现为「合成正常但音色列表永远 0 个」。
    global _net, _hps, _synth, _load_error, _load_info, _speakers
    if _net is not None:
        return
    if not VITS_DIR:
        raise RuntimeError('VITS 目录未设置')
    os.chdir(VITS_DIR)
    if VITS_DIR not in sys.path:
        sys.path.insert(0, VITS_DIR)

    # ★ import 期间 stdout 让给 stderr（numba 会往 stdout 打几百行 DEBUG）
    _real_stdout = sys.stdout
    try:
        sys.stdout = sys.stderr
        import torch
        import utils
        import commons
        from models import SynthesizerTrn
        from text import text_to_sequence
    finally:
        sys.stdout = _real_stdout

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    t0 = time.perf_counter()
    hps = utils.get_hparams_from_file('./model/config.json')
    # ★ train 是顶层属性，不是 hps.data.train（app.py 这里的写法是错的）
    net = SynthesizerTrn(
        len(hps.symbols),
        hps.data.filter_length // 2 + 1,
        hps.train.segment_size // hps.data.hop_length,
        n_speakers=hps.data.n_speakers,
        **hps.model)
    utils.load_checkpoint('./model/G_953000.pth', net, None)
    net.eval().to(device)

    def _synth_impl(text, speaker=0, noise=0.6, noise_w=0.668, length=1.2, lang='zh'):
        from torch import no_grad, LongTensor
        t = text.replace('\n', ' ').replace('\r', '')
        if lang != 'zh':
            t = t                      # 其它语言不加 [ZH] 标记
        else:
            t = '[ZH]%s[ZH]' % t
        text_norm, _ = text_to_sequence(t, hps.symbols, hps.data.text_cleaners)
        if hps.data.add_blank:
            text_norm = commons.intersperse(text_norm, 0)
        stn = LongTensor(text_norm)
        with no_grad():
            x = stn.unsqueeze(0).to(device)
            xl = LongTensor([stn.size(0)]).to(device)
            sid = LongTensor([int(speaker)]).to(device)
            audio = net.infer(x, xl, sid=sid, noise_scale=noise,
                              noise_scale_w=noise_w, length_scale=length)[0][0, 0]
            audio = audio.data.cpu().float().numpy()
        return audio, int(hps.data.sampling_rate)

    _net = net
    _hps = hps
    _synth = _synth_impl
    _log('模型已加载 %.1fs | device=%s | n_speakers=%d'
         % (time.perf_counter() - t0, device, hps.data.n_speakers))

    # 音色列表
    sp = os.path.join(VITS_DIR, 'speakers_list.txt')
    _load_info = {'speakers_file': sp, 'speakers_file_exists': os.path.exists(sp)}
    if os.path.exists(sp):
        raw = ''
        with open(sp, 'rb') as f:
            raw = f.read()
        # 实测这个文件是 UTF-8；万一不是，用 replace 兜住，不要让整个加载失败
        for enc in ('utf-8', 'gbk', 'shift_jis'):
            try:
                text = raw.decode(enc)
                break
            except Exception:
                continue
        else:
            text = raw.decode('utf-8', errors='replace')
        # 文件里每行形如 '0: 特别周'，序号已存在 id 里，名字里不要再重复一遍
        _speakers = []
        for i, ln in enumerate(text.splitlines()):
            ln = ln.strip()
            if not ln:
                continue
            if ':' in ln[:5]:
                head, tail = ln.split(':', 1)
                if head.strip().isdigit() and tail.strip():
                    ln = tail.strip()
            _speakers.append({'id': i, 'name': ln})
    _load_info['speakers_count'] = len(_speakers)
    _load_info['load_seconds'] = round(time.perf_counter() - t0, 2)
    _load_info['device'] = str(device)
    _log('模型已加载 %.1fs | device=%s | n_speakers=%d | 音色列表 %d 条'
         % (time.perf_counter() - t0, device, hps.data.n_speakers, len(_speakers)))


def write_wav(path, audio, sr):
    import numpy as np
    import wave
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype('int16')
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def handle(req):
    op = req.get('op', '')
    if op == 'ping':
        return {'ready': _net is not None, 'speakers': len(_speakers),
                'dir': VITS_DIR, 'err': _load_error}
    if op == 'load':
        load_model()
        return {'loaded': True, 'speakers': len(_speakers),
                'sr': int(_hps.data.sampling_rate) if _hps else 0,
                'info': _load_info}
    if op == 'voices':
        if _net is None:
            load_model()
        return {'speakers': _speakers, 'sr': int(_hps.data.sampling_rate)}
    if op == 'synth':
        if _net is None:
            load_model()
        text = (req.get('text') or '').strip()
        if not text:
            raise ValueError('文本为空')
        out = req.get('out')
        if not out:
            raise ValueError('缺少输出路径')
        t0 = time.perf_counter()
        audio, sr = _synth(
            text,
            speaker=int(req.get('speaker') or 0),
            noise=float(req.get('noise') if req.get('noise') is not None else 0.6),
            noise_w=float(req.get('noise_w') if req.get('noise_w') is not None else 0.668),
            length=float(req.get('length') if req.get('length') is not None else 1.2),
            lang=req.get('lang') or 'zh')
        write_wav(out, audio, sr)
        return {'path': out, 'seconds': round(len(audio) / float(sr), 3), 'sr': sr,
                'elapsed': round(time.perf_counter() - t0, 3)}
    if op == 'bye':
        send({'id': req.get('id'), 'ok': True, 'result': {'bye': True}})
        sys.exit(0)
    raise ValueError('未知 op: %s' % op)


def main():
    global VITS_DIR
    # 第一个 argv 是 VITS 目录
    VITS_DIR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('VITS_DIR')
    send({'ok': True, 'result': {'booted': True, 'dir': VITS_DIR}})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            send({'id': rid, 'ok': True, 'result': handle(req)})
        except Exception as e:
            send({'id': rid, 'ok': False,
                  'error': str(e),
                  'trace': traceback.format_exc()[-1200:]})
    # stdin 关闭 = Node 端退出
    _log('stdin 关闭，worker 退出')


if __name__ == '__main__':
    main()
