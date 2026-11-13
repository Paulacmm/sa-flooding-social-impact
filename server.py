"""Local web server that executes FloodVision_Engine.ipynb for each analysis."""

import base64
import binascii
import json
import os
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import nbformat
from nbclient import NotebookClient
from PIL import Image, UnidentifiedImageError

ROOT = Path(__file__).resolve().parent
NOTEBOOK = ROOT / "FloodVision_Engine.ipynb"
ASSETS = {
    "/": (ROOT / "static" / "index.html", "text/html; charset=utf-8"),
    "/app.js": (ROOT / "static" / "app.js", "application/javascript; charset=utf-8"),
    "/styles.css": (ROOT / "static" / "styles.css", "text/css; charset=utf-8"),
}
LOCK = threading.Lock()
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
MAX_POST_BYTES = 30 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 25_000_000


class RequestError(Exception):
    pass


def validate_request(payload):
    if not isinstance(payload, dict):
        raise RequestError("Invalid request format")
    mode = payload.get("mode")
    images = payload.get("images")
    if mode not in ("single", "before_after"):
        raise RequestError("Choose single or before/after mode")
    if not isinstance(images, list) or not (1 <= len(images) <= MAX_IMAGES):
        raise RequestError("Upload between 1 and 4 images")
    if mode == "before_after" and len(images) != 2:
        raise RequestError("Before/after requires exactly two images")
    location = payload.get("location", "")
    if not isinstance(location, str) or len(location) > 160:
        raise RequestError("Location is too long")
    distance = payload.get("dry_route_distance_m")
    verified = payload.get("verified_dry_route") is True
    if distance is not None:
        if isinstance(distance, bool) or not isinstance(distance, (int, float)) or not (0 < distance <= 100_000):
            raise RequestError("Dry-route distance must be between 0 and 100,000 meters")
    if verified and distance is None:
        raise RequestError("Provide a measured distance for the verified dry route")
    if not verified:
        distance = None
    return {
        "mode": mode,
        "images": images,
        "location": location.strip() or "Not specified",
        "verified_dry_route": verified,
        "dry_route_distance_m": distance,
    }


def save_images(images, folder):
    paths = []
    total = 0
    for index, entry in enumerate(images, 1):
        if not isinstance(entry, dict) or not isinstance(entry.get("data"), str):
            raise RequestError("Every image must contain base64 data")
        value = entry["data"]
        if len(value) > 4 * (MAX_IMAGE_BYTES // 3 + 2):
            raise RequestError("Each image must be at most 8 MB")
        try:
            raw = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RequestError("Invalid image encoding") from exc
        if len(raw) > MAX_IMAGE_BYTES:
            raise RequestError("Each image must be at most 8 MB")
        total += len(raw)
        if total > MAX_TOTAL_IMAGE_BYTES:
            raise RequestError("Images exceed the 20 MB total limit")
        try:
            from io import BytesIO
            with Image.open(BytesIO(raw)) as image:
                kind = image.format
                image.verify()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
            raise RequestError("Only valid JPEG, PNG, or WebP images are supported") from exc
        if kind not in {"JPEG", "PNG", "WEBP"}:
            raise RequestError("Only JPEG, PNG, or WebP images are supported")
        ext = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}[kind]
        path = folder / f"image_{index:02d}{ext}"
        path.write_bytes(raw)
        paths.append(str(path))
    return paths


def execute_notebook(config_path, workdir):
    notebook = nbformat.read(NOTEBOOK, as_version=4)
    cells = [cell for cell in notebook.cells if "parameters" in cell.metadata.get("tags", [])]
    if len(cells) != 1:
        raise RuntimeError("Engine notebook must contain one parameters cell")
    cells[0].source = f"CONFIG_PATH = {json.dumps(str(config_path))}"
    runner = NotebookClient(notebook, timeout=240, kernel_name="python3", allow_errors=False,
                            resources={"metadata": {"path": str(workdir)}})
    runner.execute()


def run_analysis(payload):
    data = validate_request(payload)
    with tempfile.TemporaryDirectory(prefix="floodvision_") as directory:
        folder = Path(directory)
        images = save_images(data.pop("images"), folder)
        result_path = folder / "result.json"
        config_path = folder / "job.json"
        config_path.write_text(json.dumps({
            "mode": data["mode"],
            "image_paths": images,
            "location": data["location"],
            "verified_dry_route": data["verified_dry_route"],
            "dry_route_distance_m": data["dry_route_distance_m"],
            "result_file": str(result_path),
        }), encoding="utf-8")
        execute_notebook(config_path, folder)
        if not result_path.is_file():
            raise RuntimeError("Notebook did not produce a report")
        output = json.loads(result_path.read_text(encoding="utf-8"))
        output["report_count"] = len(output.get("reports", []))
        return output


class Handler(BaseHTTPRequestHandler):
    server_version = "FloodVision/1.0"

    def respond(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/health":
            self.respond(HTTPStatus.OK, {"status": "ready", "model": os.getenv("GB10_MODEL", "qwen3-vl-8b-instruct")})
            return
        item = ASSETS.get(path)
        if not item:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        file_path, content_type = item
        data = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if urlsplit(self.path).path != "/api/analyze":
            self.respond(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
            self.respond(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "Expected application/json"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > MAX_POST_BYTES:
                raise RequestError("Upload is too large or empty")
            raw = self.rfile.read(size)
            payload = json.loads(raw)
            data = validate_request(payload)
        except (ValueError, json.JSONDecodeError, RequestError) as exc:
            self.respond(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if not LOCK.acquire(blocking=False):
            self.respond(HTTPStatus.TOO_MANY_REQUESTS, {"error": "The model is analyzing another request. Try again shortly."})
            return
        try:
            self.respond(HTTPStatus.OK, run_analysis(payload))
        except RequestError as exc:
            self.respond(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:
            print(f"Notebook error: {type(exc).__name__}: {exc}", flush=True)
            self.respond(HTTPStatus.BAD_GATEWAY, {
                "error": "Analysis failed. Check that the GB10 IP, API key, and Qwen model are reachable. See server terminal for details."
            })
        finally:
            LOCK.release()


def main():
    host = os.getenv("WEB_HOST", "127.0.0.1")
    port = int(os.getenv("WEB_PORT", "8765"))
    with ThreadingHTTPServer((host, port), Handler) as server:
        print(f"FloodVision → http://{host}:{port}", flush=True)
        print(f"GB10 model → {os.getenv('GB10_BASE_URL', 'http://10.246.100.230/v1')}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
