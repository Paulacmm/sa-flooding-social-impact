import base64
import io
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

MODEL_JSON = {
    "flooding_visible": "yes",
    "flood_extent": "widespread",
    "road_or_path_flooded": "yes",
    "moving_water_cues": "uncertain",
    "visible_debris": "no",
    "people_exposed": "no",
    "vehicles_exposed": "yes",
    "safe_dry_exit_visible": "uncertain",
    "observations": ["Water visible across a road", "One vehicle near water"],
    "uncertainties": ["Depth cannot be determined", "Current speed cannot be determined"],
    "summary": "A road appears to be flooded. One vehicle is visible nearby.",
    "potential_refuges": [{"label": "Upper floor", "bbox": [100, 100, 300, 400],
                           "evidence": "Above visible water", "limitations": "Access and stability unknown"}],
    "refuge_assessment": "The upper floor is elevated above visible water; access is unverified.",
    "change_from_before": "Water is more extensive after the event",
}


class FakeGB10(BaseHTTPRequestHandler):
    received = []

    def do_POST(self):
        size = int(self.headers["Content-Length"])
        data = json.loads(self.rfile.read(size))
        FakeGB10.received.append(data)
        body = json.dumps({
            "id": "test-completion", "object": "chat.completion", "created": 0,
            "model": "qwen3-vl-8b-instruct",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(MODEL_JSON)}, "finish_reason": "stop"}],
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def image_base64():
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (25, 117, 170)).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class RefugeParsingTests(unittest.TestCase):
    def setUp(self):
        import nbformat
        notebook = nbformat.read(server.NOTEBOOK, as_version=4)
        self.namespace = {"json": json}
        exec(notebook.cells[5].source, self.namespace)

    def test_invalid_boxes_are_not_shown(self):
        for box in ([400, 0, 100, 100], [-1, 0, 200, 200], [0, 0, 1001, 100],
                    [True, 0, 100, 100], [0, 0, float("nan"), 100], [0, 1]):
            with self.subTest(box=box):
                candidate = dict(MODEL_JSON["potential_refuges"][0], bbox=box)
                parsed = self.namespace["parse_response"](json.dumps(dict(MODEL_JSON, potential_refuges=[candidate])))
                self.assertEqual(parsed["potential_refuges"], [])
                self.assertIn("No potential refuge", parsed["refuge_assessment"])

    def test_missing_refuge_fields_are_supported(self):
        parsed = self.namespace["parse_response"]('{"summary": "Unclear image"}')
        self.assertEqual(parsed["potential_refuges"], [])
        self.assertIn("No potential refuge", parsed["refuge_assessment"])

    def test_valid_refuge_preserves_evidence(self):
        parsed = self.namespace["parse_response"](json.dumps(MODEL_JSON))
        self.assertEqual(parsed["potential_refuges"], MODEL_JSON["potential_refuges"])
        self.assertEqual(parsed["refuge_assessment"], MODEL_JSON["refuge_assessment"])


class FloodVisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model_server = ThreadingHTTPServer(("127.0.0.1", 0), FakeGB10)
        cls.model_thread = threading.Thread(target=cls.model_server.serve_forever, daemon=True)
        cls.model_thread.start()
        cls.model_env = patch.dict(os.environ, {
            "GB10_BASE_URL": f"http://127.0.0.1:{cls.model_server.server_port}/v1",
            "GB10_MODEL": "qwen3-vl-8b-instruct",
            "GB10_API_KEY": "test-key",
        })
        cls.model_env.start()
        cls.web_server = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.web_thread = threading.Thread(target=cls.web_server.serve_forever, daemon=True)
        cls.web_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.web_server.shutdown()
        cls.web_server.server_close()
        cls.model_env.stop()
        cls.model_server.shutdown()
        cls.model_server.server_close()

    def test_reject_invalid_image(self):
        payload = {"mode": "single", "images": [{"name": "bad.png", "data": base64.b64encode(b"junk").decode()}]}
        with self.assertRaises(server.RequestError):
            server.run_analysis(payload)

    def test_require_pair_for_comparison(self):
        with self.assertRaises(server.RequestError):
            server.validate_request({"mode": "before_after", "images": [{"data": image_base64()}]})

    def test_http_home_and_health(self):
        url = f"http://127.0.0.1:{self.web_server.server_port}"
        with urlopen(url) as reply:
            html = reply.read().decode()
        self.assertIn("FloodVision", html)
        self.assertIn("/app.js", html)
        with urlopen(url + "/api/health") as reply:
            health = json.load(reply)
        self.assertEqual(health["model"], "qwen3-vl-8b-instruct")

    def test_http_upload_response(self):
        url = f"http://127.0.0.1:{self.web_server.server_port}/api/analyze"
        payload = {
            "mode": "single", "images": [{"name": "test.png", "data": image_base64()}],
            "location": "San Antonio", "verified_dry_route": False,
            "dry_route_distance_m": None,
        }
        req = Request(url, data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(req) as reply:
            response = json.load(reply)
        self.assertEqual(response["report_count"], 1)
        self.assertEqual(response["reports"][0]["analysis"]["flooding_visible"], "yes")

    def test_notebook_execution_single_image(self):
        payload = {
            "mode": "single", "images": [{"name": "flood.png", "data": image_base64()}],
            "location": "San Antonio", "verified_dry_route": True, "dry_route_distance_m": 500,
        }
        output = server.run_analysis(payload)
        self.assertEqual(output["report_count"], 1)
        report = output["reports"][0]
        self.assertEqual(report["location"], "San Antonio")
        self.assertEqual(report["analysis"]["potential_refuges"][0]["bbox"], [100, 100, 300, 400])
        self.assertIn("Potential places of refuge", output["markdown"][0])
        self.assertIn("Access and stability unknown", output["markdown"][0])
        self.assertEqual(report["analysis"]["flood_extent"], "widespread")
        self.assertEqual(report["visual_hazard"]["score_type"], "illustrative_points_not_probability")
        self.assertEqual(report["dry_route_time"]["min_minutes"], 6.9)
        self.assertNotIn("/tmp/", json.dumps(output))
        self.assertIn("FloodVision GB10", output["markdown"][0])
        self.assertEqual(FakeGB10.received[-1]["model"], "qwen3-vl-8b-instruct")
        self.assertEqual(FakeGB10.received[-1]["messages"][1]["content"][-1]["type"], "image_url")

    def test_notebook_execution_before_after(self):
        payload = {
            "mode": "before_after", "images": [{"name": "before.png", "data": image_base64()}, {"name": "after.png", "data": image_base64()}],
            "location": "Kerr County", "verified_dry_route": False,
        }
        output = server.run_analysis(payload)
        self.assertEqual(output["report_count"], 1)
        self.assertIsNone(output["reports"][0]["dry_route_time"])
        images = [part for part in FakeGB10.received[-1]["messages"][1]["content"] if part["type"] == "image_url"]
        self.assertEqual(len(images), 2)


if __name__ == "__main__":
    unittest.main()
