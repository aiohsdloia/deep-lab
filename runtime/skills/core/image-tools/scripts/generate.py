#!/usr/bin/env python3
"""生图 (image generation) — draw an image through the configured generation model.

Uses the images API (NOT chat) of the model configured at 设置 → 模型
(multimodal.json "generate"; falls back to a cogview-* model, default
zhipu/cogview-3-flash). Saves the result under figures/ in the workspace.
The API key is never printed.

Usage:
  python3 generate.py --prompt "一只熊猫在竹林里" [--size 1024x1024] [--out figures/panda.png]
"""

import argparse
import io
import json
import pathlib
import urllib.request

from _config import (load_config, load_multimodal, post_json,
                     provider_options, resolve_generate_model)


def generate(args) -> str:
    config = load_config()
    mm = load_multimodal()
    model_key = resolve_generate_model(config, mm, args.model)
    provider, model = model_key.split("/", 1)
    base, key = provider_options(config, provider)

    payload = {"model": model, "prompt": args.prompt, "size": args.size}
    resp = post_json(base, "images/generations", payload, key, timeout=args.timeout)
    try:
        url = resp["data"][0]["url"]
    except (KeyError, IndexError, TypeError):
        raise SystemExit(
            f"ERROR: unexpected API response: {json.dumps(resp)[:500]}"
        ) from None

    out = pathlib.Path(args.out)
    if out.suffix.lower() == "":
        out = out.with_suffix(".png")
    out.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "openlab-image-tools"})
    with urllib.request.urlopen(req, timeout=args.timeout) as r:
        raw = r.read()
    # the API often returns JPEG regardless of the URL/extension: normalize so
    # the saved file's format matches its content.
    try:
        from PIL import Image
        buf = io.BytesIO(raw)
        im = Image.open(buf)
        ext = (im.format or "").lower()
        if ext in ("png", "jpeg", "jpg", "webp", "gif", "bmp"):
            if out.suffix.lower() != f".{ext}":
                out = out.with_suffix(f".{ext}")
        out.write_bytes(raw)
    except Exception:
        out.write_bytes(raw)
    return str(out)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--size", default="1024x1024")
    parser.add_argument("--model")
    parser.add_argument("--out", default="figures/generated.png")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args(argv)

    dest = generate(args)
    print(dest)


if __name__ == "__main__":
    main()
