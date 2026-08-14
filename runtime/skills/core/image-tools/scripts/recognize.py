#!/usr/bin/env python3
"""识图 (image recognition) — read an image through the configured vision model.

Routes the image to the image-understanding model configured at 设置 → 模型
(multimodal.json "vision"; falls back to a discovered vision model, default
zhipu/glm-4.6v-flash). The main model does not need vision: this tool relays the
image and returns the vision model's answer. The API key is never printed.

Modes:
  describe <image> [--lang zh|en]           general recognition & description
  ocr      <image> [--lang zh|en]           verbatim text extraction (Chinese + Latin)
  read     <image> [--kind chart|table|figure|auto] [--lang zh|en]
                                            structured reading of figures/tables/plots

Options: --model provider/model, --prompt "…", --max-dim N, --timeout N
"""

import argparse
import base64
import io
import mimetypes
import os
import sys
from pathlib import Path

from _config import (extract_chat_text, load_config, load_multimodal,
                     post_json, provider_options, resolve_vision_model)

PROMPTS = {
    "describe_zh": "请仔细识别这张图片并给出详细、结构化的中文描述：画面主体与内容、人物/物体/场景、"
                   "图中出现的所有文字、图表或数据，以及整体布局。",
    "describe_en": "Look at this image carefully and give a detailed, structured description: "
                   "main subjects, objects/people/scene, all visible text, any chart or data, and overall layout.",
    "ocr_zh": "请逐字识别并转写图片中的所有文字，保持原有的段落与阅读顺序，使用中文标点规范化，"
              "不要省略、不要改写、不要添加解释。若含英文/数字，一并保留。",
    "ocr_en": "Transcribe ALL text in this image verbatim, preserving paragraph order and line breaks. "
              "Do not omit, paraphrase, or annotate. Keep numbers and symbols as-is.",
    "read_zh": "请识别并结构化提取这张图片（可能是图表/表格/示意图/论文插图）的信息：标题、坐标轴标签与单位、"
               "图例、关键数据或数据表（尽量逐项列出）、结论性内容。输出用 Markdown 表格/列表。",
    "read_en": "Extract the structured content of this figure/table/plot: title, axis labels and units, "
               "legend, key data (list values where legible), and conclusions. Use Markdown tables/lists.",
}


def prepare_image(path: str, max_dim: int = 2048, max_bytes: int = 4_500_000):
    """Return (mime, bytes). Downscale/re-encode only when needed."""
    raw = Path(path).read_bytes()
    mime = mimetypes.guess_type(path)[0] or "image/png"
    if len(raw) <= max_bytes and max_dim is None:
        return mime, raw
    try:
        from PIL import Image
    except ImportError:
        return mime, raw
    try:
        im = Image.open(io.BytesIO(raw))
        if im.mode in ("RGBA", "P", "LA", "CMYK"):
            im = im.convert("RGB")
        if max_dim and max(im.size) > max_dim:
            im.thumbnail((max_dim, max_dim), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88)
        jpeg = buf.getvalue()
        return ("image/jpeg", jpeg)
    except Exception:
        return mime, raw


def build_message(prompt: str, mime: str, data: bytes) -> dict:
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url",
             "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}},
        ],
    }


def run_vision(args, prompt: str) -> str:
    config = load_config()
    mm = load_multimodal()
    model_key = resolve_vision_model(config, mm, args.model)
    provider, model = model_key.split("/", 1)
    base, key = provider_options(config, provider)

    mime, data = prepare_image(args.image, max_dim=args.max_dim)
    payload = {
        "model": model,
        "messages": [build_message(prompt, mime, data)],
    }
    resp = post_json(base, "chat/completions", payload, key, timeout=args.timeout)
    text = extract_chat_text(resp)
    if args.verbose:
        print(f"# read by {model_key} via {base}", file=sys.stderr)
    return text


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="mode", required=True)

    for name in ("describe", "ocr", "read"):
        p = sub.add_parser(name, help=f"{name} an image")
        p.add_argument("image")
        p.add_argument("--lang", choices=("zh", "en"), default="zh")
        p.add_argument("--model")
        p.add_argument("--prompt")
        p.add_argument("--kind", choices=("auto", "chart", "table", "figure"), default="auto")
        p.add_argument("--max-dim", type=int, default=2048)
        p.add_argument("--timeout", type=int, default=180)
        p.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    if args.mode == "describe":
        prompt = args.prompt or PROMPTS[f"describe_{args.lang}"]
    elif args.mode == "ocr":
        prompt = args.prompt or PROMPTS[f"ocr_{args.lang}"]
    else:  # read
        base_prompt = PROMPTS[f"read_{args.lang}"]
        kind = "" if args.kind == "auto" else f"（图片类型：{args.kind}）"
        prompt = args.prompt or base_prompt + kind

    print(run_vision(args, prompt))


if __name__ == "__main__":
    main()
