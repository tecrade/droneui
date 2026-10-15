import re
import json
import math
import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("drone-bridge")

ESP32_HOST = "http://192.168.4.1"

# Global client reference created inside lifespan context manager
client: httpx.AsyncClient = None

# Shared in-memory state for instantaneous frontend serving (<1ms response time)
latest_telemetry = {
    "roll": 0.0, "pitch": 0.0, "yawrate": 0.0,
    "desiredRoll": 0.0, "desiredPitch": 0.0, "desiredYawRate": 0.0,
    "rollError": 0.0, "pitchError": 0.0, "yawError": 0.0,
    "rollKp": 5.0, "pitchKp": 5.0, "yawKp": 2.0,
    "rollKi": 0.0, "pitchKi": 0.0, "yawKi": 0.0,
    "rollKd": 0.0, "pitchKd": 0.0, "yawKd": 0.0,
    "rollPID": 0.0, "pitchPID": 0.0, "yawPID": 0.0,
    "leftMotorPWM": 1000, "rightMotorPWM": 1000,
    "leftServoPWM": 1500, "rightServoPWM": 1500,
    "pitchServoScale": 100, "yawServoScale": 100,
    "armed": False,
    "_online": False
}

sim_angle = 0.0

def sanitize_telemetry(data: dict) -> dict:
    """Ensures all numerical values are finite floats (replaces inf/nan with 0.0)"""
    sanitized = {}
    for k, v in data.items():
        if isinstance(v, (float, int)):
            if math.isinf(v) or math.isnan(v):
                sanitized[k] = 0.0
            else:
                sanitized[k] = float(v)
        else:
            sanitized[k] = v
    return sanitized

def repair_and_parse_json(text: str) -> dict:
    """
    Strips 'response-' prefix, repairs unquoted inf/nan, and fixes missing commas in ESP32 JSON response.
    Example corrupt string:
      response-{"roll":inf,"pitch":inf,"rollKp":5.00"rollPID":300.00}
    """
    clean = text.strip()
    if clean.startswith("response-"):
        clean = clean[9:].strip()
        
    # Replace unquoted inf, -inf, nan, ovf with 0.0
    clean = re.sub(r':\s*(-?inf|-?nan|ovf)\b', ': 0.0', clean, flags=re.IGNORECASE)
    
    # Repair missing commas between key-value pairs (e.g. 2.00"rollPID" -> 2.00,"rollPID")
    clean = re.sub(r'([0-9a-zA-Z\.\-]+)\s*"([a-zA-Z0-9_]+)":', r'\1, "\2":', clean)

    try:
        raw_dict = json.loads(clean)
    except json.JSONDecodeError as err:
        logger.warning(f"JSON repair fallback needed: {err}")
        # Secondary fallback regex if json.loads still fails
        # Fix: use \2 (not $2) for regex backreference
        repaired = re.sub(r'([0-9a-zA-Z\.\-]+)\s*"([a-zA-Z0-9_]+)":', r'\1,"\2":', clean)
        raw_dict = json.loads(repaired)

    return sanitize_telemetry(raw_dict)

async def drone_telemetry_loop():
    """Background worker that continuously polls ESP32 at ~10 Hz without blocking FastAPI endpoints"""
    global latest_telemetry, client
    url = f"{ESP32_HOST}/telemetry"
    logger.info("Starting dedicated background ESP32 telemetry worker loop...")
    while True:
        try:
            if client is not None:
                resp = await client.get(url)
                if resp.status_code == 200:
                    # ESP32 is reachable — mark online regardless of parse result
                    if "roll" in resp.text or "response-" in resp.text:
                        try:
                            data = repair_and_parse_json(resp.text)
                            data["_online"] = True
                            latest_telemetry = data
                            logger.debug(f"Telemetry OK: roll={data.get('roll', '?')}")
                        except Exception as parse_err:
                            # ESP32 is online but response was unparseable — keep old data, mark online
                            logger.warning(f"Parse error (ESP32 still online): {parse_err} | raw: {resp.text[:80]}")
                            latest_telemetry["_online"] = True
                    else:
                        # Got HTTP 200 but unexpected format — still mark online
                        logger.warning(f"Unexpected ESP32 response (marking online): {resp.text[:80]}")
                        latest_telemetry["_online"] = True
                else:
                    logger.warning(f"ESP32 HTTP error: {resp.status_code}")
                    latest_telemetry["_online"] = False
            else:
                latest_telemetry["_online"] = False
        except Exception as e:
            logger.warning(f"Telemetry worker error: {e}")
            latest_telemetry["_online"] = False
        
        await asyncio.sleep(0.1) # 10 Hz refresh rate

@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    client = httpx.AsyncClient(timeout=1.5)
    task = asyncio.create_task(drone_telemetry_loop())
    yield
    task.cancel()
    await client.aclose()

app = FastAPI(title="Drone Telemetry FastAPI Bridge", lifespan=lifespan)

# Enable CORS for React frontend (localhost:5173 / localhost:5174)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "esp32_host": ESP32_HOST,
        "online": latest_telemetry.get("_online", False)
    }

@app.get("/telemetry")
@app.get("/api/telemetry")
async def get_telemetry():
    """Instant <1ms response served directly from Python in-memory state"""
    return latest_telemetry

@app.get("/kp")
@app.get("/api/kp")
async def update_kp(
    roll: float = Query(..., description="Roll Kp"),
    pitch: float = Query(..., description="Pitch Kp"),
    yaw: float = Query(..., description="Yaw Kp")
):
    if client is None:
        raise HTTPException(status_code=500, detail="HTTP client not initialized")
    url = f"{ESP32_HOST}/kp?roll={roll}&pitch={pitch}&yaw={yaw}"
    try:
        resp = await client.get(url)
        resp.raise_for_status()
        text = resp.text.strip()
        return {"status": "success", "response": text}
    except Exception as e:
        logger.error(f"Failed to update Kp on ESP32: {e}")
        raise HTTPException(status_code=502, detail=f"ESP32 Update Failed: {str(e)}")

@app.get("/ki")
@app.get("/api/ki")
async def update_ki(
    roll: float = Query(..., description="Roll Ki"),
    pitch: float = Query(..., description="Pitch Ki"),
    yaw: float = Query(..., description="Yaw Ki")
):
    if client is None:
        raise HTTPException(status_code=500, detail="HTTP client not initialized")
    url = f"{ESP32_HOST}/ki?roll={roll}&pitch={pitch}&yaw={yaw}"
    try:
        resp = await client.get(url)
        resp.raise_for_status()
        text = resp.text.strip()
        return {"status": "success", "response": text}
    except Exception as e:
        logger.error(f"Failed to update Ki on ESP32: {e}")
        raise HTTPException(status_code=502, detail=f"ESP32 Update Failed: {str(e)}")

@app.get("/kd")
@app.get("/api/kd")
async def update_kd(
    roll: float = Query(..., description="Roll Kd"),
    pitch: float = Query(..., description="Pitch Kd"),
    yaw: float = Query(..., description="Yaw Kd")
):
    if client is None:
        raise HTTPException(status_code=500, detail="HTTP client not initialized")
    url = f"{ESP32_HOST}/kd?roll={roll}&pitch={pitch}&yaw={yaw}"
    try:
        resp = await client.get(url)
        resp.raise_for_status()
        text = resp.text.strip()
        return {"status": "success", "response": text}
    except Exception as e:
        logger.error(f"Failed to update Kd on ESP32: {e}")
        raise HTTPException(status_code=502, detail=f"ESP32 Update Failed: {str(e)}")

@app.get("/servoScale")
@app.get("/api/servoScale")
async def update_servo_scale(
    pitch: int = Query(..., description="Pitch Servo Scale"),
    yaw: int = Query(..., description="Yaw Servo Scale")
):
    if client is None:
        raise HTTPException(status_code=500, detail="HTTP client not initialized")
    url = f"{ESP32_HOST}/servoScale?pitch={pitch}&yaw={yaw}"
    try:
        resp = await client.get(url)
        resp.raise_for_status()
        text = resp.text.strip()
        return {"status": "success", "response": text}
    except Exception as e:
        logger.error(f"Failed to update Servo Scale on ESP32: {e}")
        raise HTTPException(status_code=502, detail=f"ESP32 Update Failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8001, reload=True)

