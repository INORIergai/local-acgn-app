# -*- coding: utf-8 -*-
"""Breeze-TTS-2 常驻推理 worker（stdin/stdout 逐行 JSON 协议）。

背景（2026-10-08 round85）：
  旧接入方式是「每次合成 spawn 一个 infer.py」，每次都要重新把 7GB 模型灌进显存
  （约 1~2 分钟），小说朗读点开始后 2 分钟没声音、合成速度和测试结果对不上，
  都是这一个根因。本 worker 把模型常驻显存，只在首次启动时加载一次。

协议（stdout 每行一个 JSON，stderr 全部重定向到日志文件）：
  启动阶段主动上报：
    {"type":"status","stage":"starting","msg":"..."}
    {"type":"status","stage":"loading","msg":"加载模型权重…"}
    {"type":"status","stage":"warming","msg":"预热 CUDA 内核…"}
    {"type":"ready"}
  请求（从 stdin 读入）：
    {"id":"r1","cmd":"synth","text":"...","voice":"穗穗","output":"D:\\...\\x.wav","seed":42}
    {"id":"r2","cmd":"ping"}
    {"id":"r3","cmd":"shutdown"}
  应答：
    {"id":"r1","ok":true,"path":"...","durationSec":3.2,"sampleRate":24000}
    {"id":"r2","ok":true}
    {"id":"r1","ok":false,"error":"..."}
  合成途中可有多条进度：
    {"id":"r1","type":"progress","chunks":2,"seconds":1.5}
  round87 真流式：每个 audio chunk 产出即推（base64 PCM16LE，wav 落盘照旧）：
    {"id":"r1","type":"audio","sr":24000,"pcm":"<base64>"}

用法（breeze-engine.js 负责 spawn）：
  python breeze_worker.py <MODEL_DIR> --repo <BREEZE_ROOT> --log <logfile>
"""

import os
import sys
import json
import time
import base64
import argparse
import traceback
from dataclasses import replace
from pathlib import Path

import numpy as np
import soundfile as sf  # noqa: E402  （infer.py 同款写盘通道）


def emit(obj):
    """往 stdout 写一行 JSON 并立刻 flush（Node 侧逐行解析）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", type=Path)
    ap.add_argument("--repo", type=Path, required=True, help="breeze-tts 仓库根目录（import breeze_infer 用）")
    ap.add_argument("--log", type=Path, default=None, help="stderr 日志文件")
    ap.add_argument("--eager", action="store_true", help="禁用 fast 内核（调试用）")
    args = ap.parse_args()

    # stderr 全部进日志文件，绝不污染 stdout 的 JSON 通道
    if args.log:
        try:
            args.log.parent.mkdir(parents=True, exist_ok=True)
            sys.stderr = open(args.log, "a", encoding="utf-8", buffering=1)
        except Exception:
            sys.stderr = open(os.devnull, "w")

    # Windows Inductor 溢出规避（与 server_streaming_tts.py 一致）
    os.environ.setdefault("TORCHINDUCTOR_USE_STATIC_CUDA_LAUNCHER", "0")
    sys.path.insert(0, str(args.repo))
    os.chdir(str(args.repo))

    t0 = time.perf_counter()
    emit({"type": "status", "stage": "loading", "msg": "加载 Breeze-TTS-2 模型权重…"})

    try:
        from breeze_infer.runtime import (
            load_runtime, resolve_device, set_all_seeds,
            update_generation_config_for_breeze,
        )
        from breeze_infer.templates import get_template, prepare_inputs, select_template_name
        from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig
        from models.warmup_profile import load_warmup_profile
    except Exception:
        emit({"type": "status", "stage": "error",
              "msg": "依赖导入失败：" + traceback.format_exc(limit=3).replace("\n", " ")[:300]})
        emit({"ready": False, "error": traceback.format_exc(limit=1)})
        return

    try:
        tokenizer, model, audio_tokenizer = load_runtime(
            args.model, device=resolve_device(), attn_implementation="eager"
        )
        update_generation_config_for_breeze(model)

        # 与 server_streaming_tts.py 完全一致的实测最优组合
        config = FastStreamingConfig(
            max_new_tokens=1500,
            max_seq_len=2048,
            fast_all=False if args.eager else None,
            fast_backbone_decode=not args.eager,
            fast_codec=not args.eager,
            repetition_penalty=1.1,
        )
        runtime = FastBreezeStreamingRuntime(model, audio_tokenizer, config, tokenizer=tokenizer)

        if runtime.fast_enabled and not args.eager:
            emit({"type": "status", "stage": "warming", "msg": "预热 CUDA 内核（仅首次）…"})
            profile = load_warmup_profile(Path("configs") / "fast.json")
            profile = replace(profile, codec_chunk_frames=runtime.codec_chunk_frames)
            runtime.warmup_from_profile(profile)

        load_s = time.perf_counter() - t0
        emit({"type": "status", "stage": "ready",
              "msg": "模型就绪（加载耗时 %.0f 秒）" % load_s})
        emit({"type": "ready", "loadSec": round(load_s, 1),
              "sampleRate": int(getattr(runtime, "sample_rate", 24000))})
    except Exception:
        msg = traceback.format_exc(limit=5)
        print(msg, file=sys.stderr)
        emit({"type": "status", "stage": "error",
              "msg": "模型加载失败：" + str(msg).replace("\n", " ")[:300]})
        emit({"type": "load_error", "error": str(msg)[-800:]})
        return

    # ---------- 请求循环 ----------
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
        seed = int(req.get("seed") or 42)
        if not text:
            emit({"id": rid, "ok": False, "error": "合成文本为空"})
            continue

        try:
            t1 = time.perf_counter()
            request = {"id": "worker-req", "text": text, "speaker": "S0"}
            ref_audio = req.get("refAudio")
            ref_text = req.get("refText")
            if ref_audio:
                if not Path(ref_audio).is_file():
                    raise FileNotFoundError("参考音频不存在: " + str(ref_audio))
                request["ref_audio_path"] = str(ref_audio)
                request["ref_text"] = str(ref_text or "").strip()
            inputs = prepare_inputs(
                tokenizer, audio_tokenizer, model,
                [request],
                get_template(select_template_name(request)),
                guidance_scale=1.0,
                guidance_scale_ref=None,
                guidance_scale_ins=None,
            )
            set_all_seeds(seed)
            out.parent.mkdir(parents=True, exist_ok=True)
            n_chunks = 0
            n_frames = 0
            sr = int(getattr(runtime, "sample_rate", 24000))
            with sf.SoundFile(out, mode="w", samplerate=sr, channels=1, subtype="PCM_16") as f:
                for chunk in runtime.iter_audio_chunks(inputs, request_id="worker-req", seed=seed):
                    f.write(chunk.audio)
                    n_chunks += 1
                    n_frames += len(chunk.audio)
                    # round87 真流式：每个 audio chunk 产出的同时就推 base64 PCM16 给
                    # Node（wav 落盘照旧做缓存）—— 首包延迟从「整块合成完」降到首个 chunk。
                    try:
                        a = np.asarray(chunk.audio, dtype=np.float32).reshape(-1)
                        pcm = (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                        emit({"id": rid, "type": "audio", "sr": sr,
                              "pcm": base64.b64encode(pcm).decode("ascii")})
                    except Exception:
                        pass  # 流式推送失败不影响落盘与最终 ok
                    if n_chunks % 4 == 0:
                        emit({"id": rid, "type": "progress",
                              "chunks": n_chunks, "seconds": round(n_frames / sr, 2)})
            emit({"id": rid, "ok": True, "path": str(out),
                  "durationSec": round(n_frames / sr, 2), "sampleRate": sr,
                  "genSec": round(time.perf_counter() - t1, 2)})
        except Exception:
            msg = traceback.format_exc(limit=5)
            print(msg, file=sys.stderr)
            emit({"id": rid, "ok": False, "error": str(msg)[-600:]})


if __name__ == "__main__":
    main()
