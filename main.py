import base64
import io
import json
import re
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from openai import OpenAI

app = FastAPI(title="Flood Severity & Evacuation Assessment")

# Configuración de tu cliente OpenAI local (GB10)
IP_ADDRESS = "http://10.246.100.230/v1"
client = OpenAI(base_url=IP_ADDRESS, api_key="usaadatathon")

# Montar carpeta estática para servir el HTML
app.mount("/static", StaticFiles(directory="static"), name="static")


def preprocess_pil_to_data_url(
    pil_img: Image.Image,
    max_side: int = 1024,
    fmt: str = "JPEG",
    jpeg_quality: int = 90,
) -> str:
    """Replica el preprocesamiento de tu notebook para imágenes subidas vía web."""
    img = pil_img.convert("RGB")
    w, h = img.size
    if max(w, h) > max_side:
        scale = max_side / float(max(w, h))
        new_w = int(round(w * scale))
        new_h = int(round(h * scale))
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    img.save(buffer, format=fmt, quality=jpeg_quality)
    b64_str = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/{fmt.lower()};base64,{b64_str}"


@app.get("/", response_class=HTMLResponse)
async def serve_home():
    with open("static/index.html", "r", encoding="utf-8") as f:
        return f.read()


@app.post("/analyze")
async def analyze_flood_image(file: UploadFile = File(...)):
    if not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="El archivo debe ser una imagen.")

    try:
        contents = await file.read()
        pil_img = Image.open(io.BytesIO(contents))
        img_url = preprocess_pil_to_data_url(
            pil_img, max_side=1024, fmt="JPEG", jpeg_quality=90
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error procesando la imagen: {str(e)}")

    prompt = """
Analyze this flood image and return ONLY a valid JSON object (no markdown fences, no extra text) with the following exact keys:

1. "severity": Must be strictly one of "Low", "Medium", or "High".
2. "reasons": An array of exactly 3 strings explaining why you categorized it that way. STRICT RULE: Each string MUST be between 7 and 10 words long.
3. "evacuation_zones": A clear, specific description of where people in the image can safely evacuate (e.g., specific rooftops, elevated structures, unflooded streets/areas visible in the image) and exact directional guidance within the frame.
4. "estimated_water_depth": Estimated depth range using visual cues like tires, doors, knees, or street signs (e.g., "0.3m - 0.6m (Knee-deep / Submerging car tires)").
5. "infrastructure_hazards": Visible risks such as downed power lines, submerged electrical boxes, fast-moving currents, or structural damage.
6. "vehicle_passability": One of "Passable for all vehicles", "High-clearance / Emergency vehicles only", or "Impassable / Boat or air rescue only".
7. "rescue_priority": A score from 1 to 10 (10 being immediate life-threatening emergency) with a brief 1-sentence justification.
8. "vulnerable_targets": Mention if stranded people, vehicles, or residential first floors appear directly threatened.
"""

    try:
        resp = client.chat.completions.create(
            model="qwen3-vl-8b-instruct",
            messages=[
                {
                    "role": "system",
                    "content": "You are an emergency response and flood assessment AI. Always respond in strict JSON format.",
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": img_url}},
                    ],
                },
            ],
            temperature=0.2,
            max_tokens=512,
        )

        raw_content = resp.choices[0].message.content.strip()

        # Limpiar posibles bloques markdown ```json ... ``` si el modelo los incluye
        cleaned_json = re.sub(r"^```(?:json)?|```$", "", raw_content, flags=re.MULTILINE).strip()
        parsed_data = json.loads(cleaned_json)
        return {"status": "success", "report": parsed_data}

    except json.JSONDecodeError:
        # Fallback en caso de que el modelo no devuelva JSON puro
        return {
            "status": "partial",
            "raw_text": raw_content,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error conectando con el modelo: {str(e)}")