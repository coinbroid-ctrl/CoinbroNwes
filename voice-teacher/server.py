#!/usr/bin/env python3
"""Server guru bahasa Inggris berbasis suara.

  ANTHROPIC_API_KEY=... python voice-teacher/server.py     -> http://localhost:8000
  TEACHER_MOCK=1 python voice-teacher/server.py            -> guru tiruan, tanpa API key

Browser menangani mikrofon, pengenalan suara dan text-to-speech; server ini hanya
meneruskan giliran bicara ke Claude dan mengalirkan balasannya sebagai event SSE.
"""
import asyncio
import json
import os
from pathlib import Path

import anthropic
import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from teacher import TagStream, build_system, mock_reply

MODEL = os.environ.get("TEACHER_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("TEACHER_EFFORT", "low")  # balasan lisan pendek: effort rendah = jeda lebih singkat
MOCK = os.environ.get("TEACHER_MOCK") == "1"
MAX_MESSAGES = 40
# Model yang mendukung fallback sisi server bila sebuah permintaan ditolak classifier.
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"}

client = None if MOCK else anthropic.AsyncAnthropic()


def clean_messages(raw):
    msgs = [{"role": m["role"], "content": str(m["content"])[:4000]}
            for m in raw if m.get("role") in ("user", "assistant") and str(m.get("content", "")).strip()]
    msgs = msgs[-MAX_MESSAGES:]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


async def model_text(level, topic, messages):
    """Menghasilkan potongan teks balasan guru."""
    if MOCK:
        reply = mock_reply(messages)
        for i in range(0, len(reply), 24):
            await asyncio.sleep(0.01)
            yield reply[i:i + 24]
        return
    kwargs = dict(
        model=MODEL,
        max_tokens=8000,
        system=[{"type": "text", "text": build_system(level, topic), "cache_control": {"type": "ephemeral"}}],
        messages=messages,
    )
    if EFFORT:
        kwargs["output_config"] = {"effort": EFFORT}
    if MODEL in FALLBACK_MODELS:
        manager = client.beta.messages.stream(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
    else:
        manager = client.messages.stream(**kwargs)
    async with manager as stream:
        async for text in stream.text_stream:
            yield text
        final = await stream.get_final_message()
        if final.stop_reason == "refusal":
            yield '<say lang="id">Maaf, aku tidak bisa membahas itu. Kita lanjut topik lain ya.</say><say lang="en">What is your favorite food?</say>'


def sse(event):
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def turn(request):
    body = await request.json()
    messages = clean_messages(body.get("messages", []))
    if not messages or messages[-1]["role"] != "user":
        return JSONResponse({"error": "messages harus diakhiri giliran user"}, status_code=400)
    level, topic = str(body.get("level", "beginner")), str(body.get("topic", ""))[:80]

    async def events():
        parser = TagStream()
        try:
            async for chunk in model_text(level, topic, messages):
                for ev in parser.feed(chunk):
                    yield sse(ev)
            for ev in parser.finish():
                yield sse(ev)
            yield sse({"type": "done"})
        except anthropic.AuthenticationError:
            yield sse({"type": "error", "message": "API key tidak valid. Periksa ANTHROPIC_API_KEY di server."})
        except anthropic.RateLimitError:
            yield sse({"type": "error", "message": "Server sedang sibuk (rate limit). Coba lagi sebentar."})
        except anthropic.APIStatusError as e:
            yield sse({"type": "error", "message": f"Layanan AI bermasalah ({e.status_code})."})
        except anthropic.APIConnectionError:
            yield sse({"type": "error", "message": "Tidak bisa terhubung ke layanan AI."})
        except Exception as e:  # mis. API key belum diatur: tetap beri tahu klien, jangan putus diam-diam
            print(f"turn gagal: {e!r}")
            yield sse({"type": "error", "message": "Server guru belum siap. Periksa ANTHROPIC_API_KEY di server."})

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def health(request):
    return JSONResponse({"ok": True, "mock": MOCK, "model": "mock" if MOCK else MODEL})


app = Starlette(routes=[
    Route("/api/turn", turn, methods=["POST"]),
    Route("/api/health", health),
    Mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True)),
])

if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8000")))
