# FloodVision GB10 — Web + JupyterLab

A local web application that receives flood photographs, runs a Jupyter notebook using `nbclient`, calls an OpenAI-compatible Qwen3-VL model on GB10, and displays structured reports in the browser.

## Requirements

- Python 3.10 or later
- Network access to the GB10 server at `http://10.246.100.230/v1` (or your own model endpoint)
- `qwen3-vl-8b-instruct` available on that endpoint

## Run on macOS or Linux

```bash
unzip FloodVision_GB10_Web.zip
cd FloodVision_Web
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export GB10_BASE_URL="http://10.246.100.230/v1"
export GB10_API_KEY="usaadatathon"
export GB10_MODEL="qwen3-vl-8b-instruct"
python server.py
```

Open **http://127.0.0.1:8765** in your browser. To stop, press **Ctrl+C** in the terminal.

`WEB_HOST` defaults to `127.0.0.1` so the interface is available only on your own machine. To allow other trusted devices to connect over a LAN, set `WEB_HOST=0.0.0.0` before launching. **The prototype does not have user authentication. Do not expose it to the public internet.**

If you are on campus or a hackathon network, the private `10.246.100.230` address may only be accessible from that same network or its VPN.

## How it works

```text
Browser (static/index.html, static/app.js)
            |  POST /api/analyze (uploaded images and options)
            v
server.py — validates files and creates a temporary job
            |  nbclient.execute()
            v
FloodVision_Engine.ipynb
            |  OpenAI-compatible chat completion with image_url content
            v
GB10 / Qwen3-VL-8B-Instruct
            |  structured JSON observations
            v
Notebook — hazard indicator, optional dry-route time, report text
            |  writes result.json
            v
server.py — returns JSON to browser
            v
Browser — report cards, evidence lists, JSON / Markdown downloads
```

`FloodVision_Engine.ipynb` is adapted from the previously created `FloodVision_GB10_English_Simple.ipynb`. The same image-prompting, JSON parsing, visual hazard scoring, and report-generation functions are retained. The server passes a job configuration to the notebook's tagged `parameters` cell, executes it with a temporary Jupyter kernel, then reads its JSON result file.

## Web features

- Upload **1–4 images** for individual analyses; one report per image.
- A focused individual-image workflow with plain-language findings, score explanations, and visible uncertainties.
- The before/after selector and decorative radar have been removed from the web interface; the notebook and API retain comparison compatibility.
- Supported formats: JPEG, PNG, WebP; up to 8 MB each, 20 MB combined.
- Potential refuge candidates with approximate image boxes, visible evidence, and explicit access/structural uncertainties. Candidates are not verified safe destinations or routes.
- Download reports in JSON and Markdown.
- Images and intermediate job files are removed after the request finishes.

## Run the notebook independently in JupyterLab

The engine notebook can also be opened in JupyterLab. Create `demo_config.json` in the notebook's working directory:

```json
{
  "mode": "single",
  "image_paths": ["/absolute/path/to/flood_photo.jpg"],
  "location": "San Antonio, TX",
  "verified_dry_route": false,
  "dry_route_distance_m": null,
  "result_file": "report.json"
}
```

Run all cells of `FloodVision_Engine.ipynb`. It will create `report.json` in the same working directory. You can also inspect the original `FloodVision_GB10_English_Simple.ipynb`, included for reference.

## Test

```bash
python -m unittest discover -s tests -v
```

The tests include a local mock OpenAI-compatible server and verify actual notebook execution for single-image and before/after cases, including a full HTTP upload-to-report flow. Tests do not verify live GB10 connectivity or model accuracy.

## Safety and limitations

The 0–100 index is **an illustrative, rule-based visual hazard indicator**, not a statistical injury/death probability, flood depth measurement, or certified safety judgment. No photograph can reliably establish a safe route, water depth, current, or real evacuation time. Walking-time estimates only apply to a separately verified dry route at assumed walking speeds of 0.6–1.2 m/s. Do not walk or drive through floodwater. This is a hackathon prototype, not an emergency response tool.

## Troubleshooting

- **"Analysis failed"**: Confirm `GB10_BASE_URL`, network/VPN access, and the deployed `GB10_MODEL`; read the `server.py` terminal for details.
- **Python packages missing inside Jupyter**: Ensure `python -m pip install -r requirements.txt` and the notebook kernel use the same virtual environment.
- **Other people cannot open the site**: The default host is localhost. On a trusted LAN only, configure `WEB_HOST=0.0.0.0` and use your machine's LAN IP.
- **First request is slow**: Every analysis starts a fresh isolated Python kernel to execute the notebook. Inference speed depends on the GB10 model server.
