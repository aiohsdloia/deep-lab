"""Shared config + HTTP helpers for the image-tools skill.

Loads the app's model config without ever printing an API key:

  - opencode.json  (provider.<id>.options: baseURL, apiKey; models list)
  - multimodal.json ({"vision": "provider/model" | null, "generate": ...})

Config lives under $XDG_CONFIG_HOME/opencode (the app sets XDG_CONFIG_HOME to its
private profile); falls back to ~/.config/opencode when unset.
"""

import json
import os
import urllib.error
import urllib.request
from pathlib import Path


def xdg_opencode_dir() -> Path:
    if os.environ.get("XDG_CONFIG_HOME"):
        return Path(os.environ["XDG_CONFIG_HOME"]) / "opencode"
    return Path.home() / ".config" / "opencode"


def load_config() -> dict:
    path = xdg_opencode_dir() / "opencode.json"
    if not path.exists():
        raise SystemExit(
            f"ERROR: {path} not found. Configure a provider (设置 → 模型) first."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def load_multimodal() -> dict:
    path = xdg_opencode_dir() / "multimodal.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {}


def provider_options(config: dict, provider: str) -> tuple[str, str]:
    """Return (baseURL, apiKey) for a provider, or raise a friendly error."""
    prov = config.get("provider", {}).get(provider)
    if not prov or not prov.get("options"):
        raise SystemExit(
            f"ERROR: provider '{provider}' is not configured in opencode.json. "
            "Add it in 设置 → 模型 first."
        )
    opts = prov["options"]
    base = (opts.get("baseURL") or "").rstrip("/")
    key = opts.get("apiKey") or ""
    if not base or not key:
        raise SystemExit(f"ERROR: provider '{provider}' is missing baseURL/apiKey.")
    return base, key


VISION_HINTS = ("4v", "vision", "v-flash", "-v", "vl")


def find_vision_model(config: dict) -> str | None:
    """Pick the first vision-capable model across providers.

    Prefers a zhipu glm-4.6v-flash / glm-4v-flash, then any model whose name
    looks vision-capable. Returns 'provider/model' or None.
    """
    preferred = []
    others = []
    for pid, prov in config.get("provider", {}).items():
        for mid in (prov.get("models") or {}):
            name = mid.lower()
            if any(h in name for h in VISION_HINTS):
                entry = f"{pid}/{mid}"
                (preferred if ("glm-4.6v" in name or "glm-4v" in name)
                 else others).append(entry)
    return (preferred or others)[0] if (preferred or others) else None


def resolve_vision_model(config: dict, multimodal: dict, override: str | None) -> str:
    if override:
        return override
    key = multimodal.get("vision")
    if key and "/" in key:
        return key
    found = find_vision_model(config)
    if found:
        return found
    raise SystemExit(
        "ERROR: no vision model configured. Pick an image-understanding model "
        "(e.g. zhipu/glm-4.6v-flash) in 设置 → 模型, or pass --model provider/model."
    )


def resolve_generate_model(config: dict, multimodal: dict, override: str | None) -> str:
    if override:
        return override
    key = multimodal.get("generate")
    if key and "/" in key:
        return key
    for pid, prov in config.get("provider", {}).items():
        for mid in (prov.get("models") or {}):
            if "cogview" in mid.lower():
                return f"{pid}/{mid}"
    raise SystemExit(
        "ERROR: no image-generation model configured (e.g. zhipu/cogview-3-flash)."
    )


def post_json(base_url: str, api_path: str, payload: dict, api_key: str,
              timeout: int = 180) -> dict:
    req = urllib.request.Request(
        f"{base_url}/{api_path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise SystemExit(
            f"ERROR: API {e.code} from {base_url}/{api_path}:\n{body[:800]}"
        ) from None
    except urllib.error.URLError as e:
        raise SystemExit(f"ERROR: network failure: {e.reason}") from None


def extract_chat_text(resp: dict) -> str:
    try:
        return resp["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise SystemExit(
            f"ERROR: unexpected API response: {json.dumps(resp)[:500]}"
        ) from None
