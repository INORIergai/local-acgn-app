# -*- coding: utf-8 -*-
"""IndexTTS-2 常驻推理 worker（stdin/stdout 逐行 JSON 协议，与 breeze_worker.py 同款）。

背景（2026-10-08 round85）：
  indextts-engine.js 的 synthesize 原来是个空壳 —— 直接返回一个从不落盘的
  wav 路径，前端拿到 code:0 但 /api/tts/audio 404，用户侧表现为「选了
  IndexTTS 引擎就永远没声音」。本 worker 让 IndexTTS-2 模型常驻显存
  （冷启动加载约 1~3 分钟），加载/就绪状态实时上报供前端显示。

协议见 breeze_worker.py 头注释，两者完全一致。
"""

import os
import sys
import json
import time
import argparse
import traceback
from pathlib import Path


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", required=True, help="index-tts-main 代码根目录")
    ap.add_argument("--model", required=True, help="checkpoints/IndexTTS-2 目录")
    ap.add_argument("--log", type=Path, default=None)
    args = ap.parse_args()

    if args.log:
        try:
            args.log.parent.mkdir(parents=True, exist_ok=True)
            sys.stderr = open(args.log, "a", encoding="utf-8", buffering=1)
        except Exception:
            sys.stderr = open(os.devnull, "w")

    # 全部本地文件，禁止再联网（bench_indextts.py 同款）
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    sys.path.insert(0, args.code)
    os.chdir(args.code)

    t0 = time.perf_counter()
    emit({"type": "status", "stage": "loading", "msg": "加载 IndexTTS-2 模型权重…"})

    try:
        import torch
        # round88：本机权重是 IndexTTS-2（text_embedding 12001），代码里的 infer_v2_5 是
        # 2.5 系前端（58836 词表）→ token 越界 CUDA device-side assert。必须走 infer_v2（2.0 系）。
        from indextts.infer_v2 import IndexTTS2
    except Exception:
        emit({"type": "status", "stage": "error",
              "msg": "依赖导入失败：" + traceback.format_exc(limit=3).replace("\n", " ")[:300]})
        emit({"type": "load_error", "error": traceback.format_exc(limit=1)})
        return

    try:
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        tts = IndexTTS2(cfg_path=os.path.join(args.model, "config.yaml"),
                        model_dir=args.model, use_fp16=(device != "cpu"),
                        device=device, use_cuda_kernel=False, use_qwen_emo=False)
        load_s = time.perf_counter() - t0
        emit({"type": "status", "stage": "ready",
              "msg": "模型就绪（加载耗时 %.0f 秒）" % load_s})
        emit({"type": "ready", "loadSec": round(load_s, 1), "sampleRate": 22050})
    except Exception:
        msg = traceback.format_exc(limit=5)
        print(msg, file=sys.stderr)
        emit({"type": "status", "stage": "error",
              "msg": "模型加载失败：" + str(msg).replace("\n", " ")[:300]})
        emit({"type": "load_error", "error": str(msg)[-800:]})
        return

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"id": None, "ok": False, "error": "请求不是合法 JSON: " + str(e)})
            continue

        rid = req.get("id")
        cmd = req.get("cmd", "synth")

        if cmd == "ping":
            emit({"id": rid, "ok": True})
            continue
        if cmd == "shutdown":
            emit({"id": rid, "ok": True, "bye": True})
            break
        if cmd != "synth":
            emit({"id": rid, "ok": False, "error": "未知 cmd: " + str(cmd)})
            continue

        text = str(req.get("text") or "").strip()
        out = Path(req.get("output") or "output.wav")
        ref = req.get("refAudio")
        if not text:
            emit({"id": rid, "ok": False, "error": "合成文本为空"})
            continue
        if not ref or not Path(ref).is_file():
            emit({"id": rid, "ok": False, "error": "缺少可用参考音频（IndexTTS-2 为零样本克隆，必须给 3~10s 人声参考）"})
            continue

        try:
            t1 = time.perf_counter()
            out.parent.mkdir(parents=True, exist_ok=True)
            tts.infer(spk_audio_prompt=str(ref), text=text,
                      output_path=str(out), verbose=False)
            dur = 0.0
            try:
                import soundfile as sf
                info = sf.info(str(out))
                dur = round(float(info.duration), 2)
            except Exception:
                pass
            emit({"id": rid, "ok": True, "path": str(out), "durationSec": dur,
                  "genSec": round(time.perf_counter() - t1, 2)})
        except Exception:
            msg = traceback.format_exc(limit=5)
            print(msg, file=sys.stderr)
            emit({"id": rid, "ok": False, "error": str(msg)[-600:]})


if __name__ == "__main__":
    main()
