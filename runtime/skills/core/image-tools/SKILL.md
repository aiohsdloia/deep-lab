---
name: image-tools
description: "Use whenever an image needs to be recognized or understood (识图/看图/读图 — a pasted/shown/screenshot image, a workspace figure, a chart/table/photo: describe it, OCR its text, or read it structurally) or generated (画一张…图 / 生成图片 / create an image). If the current main model cannot see an image directly, this skill is how you read it — NEVER answer 'I can't view images'; run the recognition scripts (which route the image to the configured vision model) and report what it shows. Image models are NOT streaming chat models, so never chat with them; always go through the scripts below."
---

# Image tools (识图 / 生图)

Two distinct tasks, both driven by the models configured in **设置 → 模型 →
多模态模型** and persisted by the app at
`$XDG_CONFIG_HOME/opencode/multimodal.json` (the app sets `XDG_CONFIG_HOME` to
its private profile; fall back to `~/.config/opencode` when unset). The API
keys live in the same folder's `opencode.json` under `provider.<id>.options`
(`baseURL`, `apiKey`). **Never print, log, or echo an API key.**

Scripts are in `scripts/` next to this file. Run them from any working
directory; they resolve config themselves.

## 1. 识图 — recognizing / reading an image

Call `scripts/recognize.py`. It sends the image to the configured
image-understanding model (`multimodal.json` → `vision`, default fallback
`zhipu/glm-4.6v-flash`) and prints the model's answer. The main model does not
need vision — it relays the image and returns the answer.

```bash
python3 scripts/recognize.py describe <image.png> [--lang zh|en] [--prompt "…"]
python3 scripts/recognize.py ocr      <image.png> [--lang zh|en]   # verbatim text, 中文+英文
python3 scripts/recognize.py read     <image.png> [--kind chart|table|figure]   # structured figure/table
```

| mode      | use for                                                            |
|-----------|--------------------------------------------------------------------|
| `describe`| general recognition: subject, objects, scene, layout, embedded text |
| `ocr`     | transcribe ALL text verbatim, preserving order/paragraphs (good for screenshots, scanned text) |
| `read`    | extract structure from a chart / table / plot / scientific figure: title, axes+units, legend, data, conclusions |

Options: `--model provider/model` (override the configured vision model),
`--prompt "…"` (custom instruction), `--max-dim N` (default 2048; large images
are downscaled/re-encoded to fit API limits), `--timeout N`.

Workflow when the user points at an image (attached or a workspace path) and the
main model cannot see it:

1. `python3 scripts/recognize.py describe <path> --lang zh` (or the mode the
   task needs).
2. Report the result to the user, reference the image path so it is presented,
   and state which model read it.

## 2. 生图 — generating an image

**Never chat with an image-generation model** (e.g. `cogview-3-flash`): image
models are not streaming chat models, so a chat turn fails with *"model does not
support SSE"*. Generate through the images API instead:

```bash
python3 scripts/generate.py --prompt "一只熊猫在竹林中" [--size 1024x1024] [--out figures/xxx.png]
```

The result is saved (default `figures/generated.png` in the workspace) and its
path printed. Present the saved file as an artifact so it shows in the
workspace; state the prompt + model used.

## Configuration

- `multimodal.json` → `{"vision": "provider/model" | null, "generate": "provider/model" | null}`.
  If null, the scripts auto-pick a vision model (glm-4.6v-flash / glm-4v-flash)
  or a cogview-* generation model from `opencode.json` providers.
- If no provider has a suitable model, tell the user to configure one in
  设置 → 模型 and save the multimodal choice.

## Correctness

- **识别 (recognize)** → the image-understanding model via `chat/completions`
  with an image data URL. **生成 (generate)** → the generation model via
  `images/generations`. Never swap the two APIs.
- Large images are downscaled/re-encoded automatically (max 2048 px, ≤ ~4.5 MB)
  so requests fit model input limits.
- Always save generated images under `figures/` in the workspace; never outside.
- The API key must never appear in your messages, the report, or any file you
  write to the workspace.

## Regression tests

```bash
python3 tests/test_recognize.py    # mocked network; config resolution, prompts,
                                   # image downscaling, and no-key-leakage
```
