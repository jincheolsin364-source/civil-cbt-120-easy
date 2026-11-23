import gzip
import hashlib
import io
import json
import os
import sys
import threading
import wave
from collections import OrderedDict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8120"))
COMPRESS_EXTS = {".html", ".css", ".js", ".json", ".svg"}

VOICE_PROFILES = [
    {"id": "F5", "name": "다정한 선생님 (F5 · 부드럽고 따뜻한 여성)", "gender": "F", "default": True},
    {"id": "F2", "name": "친근한 선생님 (F2 · 밝고 명랑한 여성)", "gender": "F"},
    {"id": "F1", "name": "차분한 선생님 (F1 · 안정적이고 편안한 여성)", "gender": "F"},
    {"id": "F4", "name": "강의형 선생님 (F4 · 깔끔하고 또렷한 여성)", "gender": "F"},
    {"id": "F3", "name": "아나운서 (F3 · 명확한 방송형 여성)", "gender": "F"},
]
VALID_VOICES = {v["id"] for v in VOICE_PROFILES}


class SupertonicEngine:
    """Thread-safe local Supertonic ONNX TTS engine (MIT / OpenRAIL-M, copyright-free)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._synth_lock = threading.Lock()
        self._tts = None
        self._styles = {}
        self._cache = OrderedDict()  # key -> wav_bytes (LRU max 300)
        self._max_cache = 300
        self.available = False
        self.error = None

    def load(self):
        with self._lock:
            if self._tts is not None:
                return True
            try:
                from supertonic import TTS
                print("[TTS] Loading Supertone Supertonic ONNX model...", flush=True)
                self._tts = TTS(auto_download=True)
                for vp in VOICE_PROFILES:
                    self._styles[vp["id"]] = self._tts.get_voice_style(vp["id"])
                self.available = True
                print("[TTS] Supertonic ready! Default voice: F5 (다정한 여성, 44.1kHz -> 22.05kHz WAV)", flush=True)
                return True
            except Exception as e:
                self.error = str(e)
                self.available = False
                print(f"[TTS] Failed to load Supertonic: {e}", flush=True)
                return False

    def _wav_bytes_from_float(self, wav: np.ndarray, src_sr: int) -> bytes:
        arr = np.asarray(wav, dtype=np.float32).reshape(-1)
        if arr.size == 0:
            return b""

        # Trim excessive leading/trailing silence (keep smooth 35ms breath pad)
        abs_a = np.abs(arr)
        nz = np.where(abs_a > 0.008)[0]
        if nz.size > 0:
            pad = int(src_sr * 0.035)
            start = max(0, int(nz[0]) - pad)
            end = min(arr.size, int(nz[-1]) + pad)
            arr = arr[start:end]

        # Apply tiny 12ms fade-in/out so chained segments connect smoothly without clicks
        fade = min(int(src_sr * 0.012), arr.size // 4)
        if fade > 1:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
            arr = arr.copy()
            arr[:fade] *= ramp
            arr[-fade:] *= ramp[::-1]

        # Gentle peak loudness normalization (-1.5 dBFS) so voice is warm and clear
        peak = float(np.max(np.abs(arr))) if arr.size else 0.0
        if peak > 1e-4:
            arr = arr * (0.84 / peak)

        # Downsample 44100 -> 22050 (2x) cleanly for fast transfer & crystal-clear voice
        out_sr = src_sr
        if src_sr == 44100 and arr.size >= 4:
            even_len = (arr.size // 2) * 2
            arr = 0.5 * (arr[:even_len:2] + arr[1:even_len:2])
            out_sr = 22050

        pcm16 = np.clip(arr * 32767.0, -32768, 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(out_sr)
            wf.writeframes(pcm16.tobytes())
        return buf.getvalue()

    def synthesize_wav(self, text: str, voice: str = "F5", speed: float = 1.05) -> bytes:
        if not self.available and not self.load():
            raise RuntimeError(self.error or "Supertonic unavailable")

        voice = voice if voice in VALID_VOICES else "F5"
        speed = float(min(1.5, max(0.8, speed)))
        clean = " ".join((text or "").split()).strip()
        if not clean:
            return b""

        key = hashlib.sha1(f"{voice}|{speed:.2f}|{clean}".encode("utf-8")).hexdigest()
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]

        # Synthesize continuously with smooth natural pause (0.11s) and wide chunk limit (260 chars)
        with self._synth_lock:
            wav, _ = self._tts.synthesize(
                text=clean,
                voice_style=self._styles[voice],
                lang="ko",
                total_steps=6,
                speed=speed,
                max_chunk_length=260,
                silence_duration=0.11,
            )
            sr = int(getattr(self._tts, "sample_rate", 44100))

        wav_bytes = self._wav_bytes_from_float(wav, sr)
        with self._lock:
            self._cache[key] = wav_bytes
            while len(self._cache) > self._max_cache:
                self._cache.popitem(last=False)
        return wav_bytes


ENGINE = SupertonicEngine()


class CivilCBTHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _send_json(self, obj: dict, status: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        if self.path.startswith("/images/") or self.path.startswith("/data/sessions/") or self.path.startswith("/data/subjects/"):
            self.send_header("Cache-Control", "public, max-age=86400")
        elif not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(403, "Directory listing disabled")
        return None

    def _is_forbidden_path(self, path_only: str) -> bool:
        parts = [p for p in path_only.split("/") if p]
        if any(p.startswith(".") for p in parts):
            return True
        low = path_only.lower()
        if low.endswith((".py", ".pyc", ".bat", ".log", ".env")) or "/__pycache__/" in low:
            return True
        return False

    def do_GET(self):
        path_only = self.path.split("?", 1)[0]

        if self._is_forbidden_path(path_only):
            return self._send_json({"error": "Forbidden"}, 403)

        if path_only == "/api/tts/info":
            return self._send_json({
                "available": ENGINE.available,
                "engine": "Supertone Supertonic (ONNX)",
                "license": "MIT / OpenRAIL-M (저작권 무료 · 상업/개인 이용 가능)",
                "defaultVoice": "F5",
                "voices": VOICE_PROFILES,
            })

        if path_only == "/":
            path_only = "/index.html"
        local_path = self.translate_path(path_only)
        _, ext = os.path.splitext(local_path.lower())

        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        if accepts_gzip and ext in COMPRESS_EXTS and os.path.isfile(local_path):
            try:
                with open(local_path, "rb") as f:
                    raw = f.read()
                gz = gzip.compress(raw, compresslevel=5)
                ctype = self.guess_type(local_path)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Vary", "Accept-Encoding")
                self.send_header("Content-Length", str(len(gz)))
                self.end_headers()
                self.wfile.write(gz)
                return
            except Exception:
                pass
        return super().do_GET()

    def do_POST(self):
        path_only = self.path.split("?", 1)[0]
        if path_only != "/api/tts":
            return self._send_json({"error": "Not Found"}, 404)

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(min(length, 65536))
            payload = json.loads(raw.decode("utf-8"))
            text = str(payload.get("text", "")).strip()
            voice = str(payload.get("voice", "F5")).strip()
            speed = float(payload.get("speed", 1.05))
            if not text:
                return self._send_json({"error": "Empty text"}, 400)
            if len(text) > 2000:
                return self._send_json({"error": "Text too long (max 2000 chars)"}, 413)

            wav_bytes = ENGINE.synthesize_wav(text=text, voice=voice, speed=speed)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(wav_bytes)
        except Exception as e:
            self._send_json({"error": str(e)}, 500)

    def log_message(self, fmt, *args):
        sys.stdout.write(f"{self.address_string()} - {fmt % args}\n")
        sys.stdout.flush()


if __name__ == "__main__":
    # Warm-load Supertonic in background thread so HTTP server opens port 8120 instantly!
    threading.Thread(target=ENGINE.load, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), CivilCBTHandler)
    print(f"Civil CBT Fast Server + Supertonic AI Voice running at http://localhost:{PORT}/", flush=True)
    httpd.serve_forever()
