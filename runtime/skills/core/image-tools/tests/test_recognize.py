#!/usr/bin/env python3
"""Tests for the image-tools scripts (识图 / 生图). No network access.

Run: python3 tests/test_recognize.py
"""

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import _config            # noqa: E402
import recognize          # noqa: E402
import generate           # noqa: E402

FAKE_BASE = "https://example.invalid/api"
FAKE_KEY = "sk-FAKE-KEY-SECRET"


def make_config_dir():
    td = Path(tempfile.mkdtemp())
    cfg = td / "opencode"
    cfg.mkdir()
    (cfg / "opencode.json").write_text(json.dumps({
        "provider": {
            "zhipu": {
                "models": {"glm-4.6v-flash": {}, "glm-4v-flash": {}, "cogview-3-flash": {}},
                "options": {"baseURL": FAKE_BASE, "apiKey": FAKE_KEY},
            }
        }
    }), encoding="utf-8")
    return cfg


class ConfigTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.cfgdir = make_config_dir()
        os.environ["XDG_CONFIG_HOME"] = str(cls.cfgdir.parent)

    def test_vision_from_multimodal(self):
        (self.cfgdir / "multimodal.json").write_text(
            json.dumps({"vision": "zhipu/glm-4v-flash", "generate": "zhipu/cogview-3-flash"}))
        config = _config.load_config()
        mm = _config.load_multimodal()
        self.assertEqual(_config.resolve_vision_model(config, mm, None), "zhipu/glm-4v-flash")

    def test_vision_fallback_discovery(self):
        (self.cfgdir / "multimodal.json").write_text(json.dumps({"vision": None}))
        config = _config.load_config()
        mm = _config.load_multimodal()
        self.assertEqual(_config.resolve_vision_model(config, mm, None), "zhipu/glm-4.6v-flash")

    def test_generate_model(self):
        (self.cfgdir / "multimodal.json").write_text(json.dumps({"generate": None}))
        config = _config.load_config()
        mm = _config.load_multimodal()
        self.assertEqual(_config.resolve_generate_model(config, mm, None), "zhipu/cogview-3-flash")


class RecognizeTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.cfgdir = make_config_dir()
        (cls.cfgdir / "multimodal.json").write_text(
            json.dumps({"vision": "zhipu/glm-4.6v-flash"}))
        os.environ["XDG_CONFIG_HOME"] = str(cls.cfgdir.parent)
        # a tiny real image
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), (120, 30, 60)).save(buf, "PNG")
        cls.img = Path(tempfile.mkdtemp()) / "t.png"
        cls.img.write_bytes(buf.getvalue())

    def _capture(self, mode, args):
        calls = {}

        def fake_post(base_url, api_path, payload, api_key, timeout=180):
            calls["url"] = f"{base_url}/{api_path}"
            calls["payload"] = payload
            calls["key"] = api_key
            return {"choices": [{"message": {"content": "RESPONSE_TEXT"}}]}

        with mock.patch.object(recognize, "post_json", side_effect=fake_post):
            out = io.StringIO()
            sys.stdout = out
            try:
                recognize.main([mode, str(self.img), *args])
            finally:
                sys.stdout = sys.__stdout__
        self.assertIn("RESPONSE_TEXT", out.getvalue())
        self.assertNotIn(FAKE_KEY, out.getvalue(), "API key must not leak")
        return calls

    def test_describe_sends_image(self):
        c = self._capture("describe", ["--lang", "zh"])
        self.assertTrue(c["url"].endswith("/chat/completions"))
        self.assertEqual(c["payload"]["model"], "glm-4.6v-flash")
        content = c["payload"]["messages"][0]["content"]
        texts = [x["text"] for x in content if x["type"] == "text"]
        self.assertTrue(any("详细" in t for t in texts))
        img = [x for x in content if x["type"] == "image_url"][0]
        self.assertTrue(img["image_url"]["url"].startswith("data:image/"), "image sent as data URL")
        self.assertIn(";base64,", img["image_url"]["url"])

    def test_ocr_prompt(self):
        c = self._capture("ocr", [])
        texts = [x["text"] for x in c["payload"]["messages"][0]["content"]
                 if x["type"] == "text"]
        self.assertTrue(any("逐字" in t for t in texts))

    def test_read_kind_suffix(self):
        c = self._capture("read", ["--kind", "table"])
        texts = [x["text"] for x in c["payload"]["messages"][0]["content"]
                 if x["type"] == "text"]
        self.assertTrue(any("table" in t or "表格" in t for t in texts))

    def test_prepare_image_downscales(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (4000, 3000), (10, 20, 30)).save(buf, "PNG")
        big = Path(tempfile.mkdtemp()) / "big.png"
        big.write_bytes(buf.getvalue())
        mime, data = recognize.prepare_image(str(big), max_dim=1024)
        im = Image.open(io.BytesIO(data))
        self.assertLessEqual(max(im.size), 1024)
        self.assertEqual(mime, "image/jpeg")


class GenerateTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.cfgdir = make_config_dir()
        (cls.cfgdir / "multimodal.json").write_text(
            json.dumps({"generate": "zhipu/cogview-3-flash"}))
        os.environ["XDG_CONFIG_HOME"] = str(cls.cfgdir.parent)

    def test_generate_flow(self):
        calls = {}

        def fake_post(base_url, api_path, payload, api_key, timeout=180):
            calls["url"] = f"{base_url}/{api_path}"
            calls["payload"] = payload
            calls["key"] = api_key
            return {"data": [{"url": "https://example.invalid/pic.png"}]}

        def fake_urlopen(req, timeout=180):
            return io.BytesIO(b"\x89PNG-fake-bytes")

        out = Path(tempfile.mkdtemp()) / "figures" / "g.png"
        with mock.patch.object(generate, "post_json", side_effect=fake_post), \
             mock.patch.object(urllib.request, "urlopen", side_effect=fake_urlopen), \
             mock.patch.object(sys, "stdout", io.StringIO()) as cap:
            generate.main(["--prompt", "熊猫", "--out", str(out)])
        printed = cap.getvalue()
        self.assertEqual(Path(out).read_bytes(), b"\x89PNG-fake-bytes")
        self.assertTrue(calls["url"].endswith("/images/generations"))
        self.assertEqual(calls["payload"]["prompt"], "熊猫")
        self.assertEqual(calls["payload"].get("apiKey"), None, "key not in payload")
        self.assertNotIn(FAKE_KEY, printed, "API key must not leak to output")


if __name__ == "__main__":
    unittest.main(verbosity=2)
