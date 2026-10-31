#!/usr/bin/env python3
"""Asisten AI harian (CLI) dengan memori jangka panjang + mode CoinbroNews.

Perintah di dalam chat:
  /news <topik>   mode konten CoinbroNews (Binance Square + tweet)
  /chat           kembali ke mode ngobrol santai
  /remember <x>   simpan fakta penting ke memori permanen
  /memory         lihat memori
  /new            mulai sesi baru (memori permanen tetap ada)
  /exit           keluar
"""
import json
import os
import sys
from datetime import date
from pathlib import Path

import anthropic

MODEL = os.environ.get("ASSISTANT_MODEL", "claude-sonnet-5-5")
DATA = Path(os.environ.get("ASSISTANT_HOME", Path.home() / ".coinbro_assistant"))
HISTORY = DATA / "history.json"
MEMORY = DATA / "memory.md"
MAX_TURNS = 40  # pesan terakhir yang dikirim ke model

CHAT_PROMPT = """Kamu adalah teman ngobrol & asisten pribadi harian. Pakai bahasa Indonesia santai
(gue/lo boleh, ikut gaya user), jawab singkat dan to the point, jujur, tidak menjilat.
Bantu apa saja: curhat ringan, rencana harian, ide, belajar, coding, crypto.
Hari ini: {today}.

Memori permanen tentang user:
{memory}
"""

NEWS_PROMPT = """Kamu adalah penulis konten CoinbroNews (crypto, AI, Web3, geopolitik).
Untuk setiap topik yang diberikan, hasilkan DUA output:
1. Post Binance Square: hook kuat di baris pertama, 3-5 poin singkat, insight/dampak ke market,
   penutup dengan pertanyaan untuk memancing komentar, 3-5 hashtag.
2. Tweet/X: maksimal 280 karakter, hook tajam, 1-2 hashtag.
Gaya: lugas, tidak lebay, tanpa janji profit atau financial advice; beri disclaimer singkat
"bukan saran finansial" bila membahas harga. Jangan mengarang data/angka; kalau tidak yakin
soal fakta terbaru, katakan dan minta user verifikasi sumbernya.
Hari ini: {today}.

Memori permanen tentang user:
{memory}
"""


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def system_prompt(mode):
    memory = MEMORY.read_text().strip() if MEMORY.exists() else "(kosong)"
    tpl = NEWS_PROMPT if mode == "news" else CHAT_PROMPT
    return tpl.format(today=date.today().isoformat(), memory=memory or "(kosong)")


def save_history(messages):
    DATA.mkdir(parents=True, exist_ok=True)
    HISTORY.write_text(json.dumps(messages, ensure_ascii=False, indent=1))


def ask(client, messages, mode):
    recent = messages[-MAX_TURNS:]
    while recent and recent[0]["role"] != "user":  # harus mulai dari pesan user
        recent = recent[1:]
    out = []
    with client.messages.stream(
        model=MODEL, max_tokens=2048, system=system_prompt(mode), messages=recent
    ) as stream:
        for text in stream.text_stream:
            print(text, end="", flush=True)
            out.append(text)
    print()
    return "".join(out)


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Set dulu: export ANTHROPIC_API_KEY=sk-ant-...")
    client = anthropic.Anthropic()
    messages = load_json(HISTORY, [])
    mode = "chat"
    print(f"Asisten siap ({len(messages)} pesan tersimpan). /exit untuk keluar.\n")

    while True:
        try:
            line = input("lo> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            continue
        cmd, _, arg = line.partition(" ")
        arg = arg.strip()

        if cmd == "/exit":
            break
        if cmd == "/new":
            messages = []
            save_history(messages)
            print("Sesi baru dimulai.")
            continue
        if cmd == "/memory":
            print(MEMORY.read_text() if MEMORY.exists() else "(kosong)")
            continue
        if cmd == "/remember":
            if arg:
                DATA.mkdir(parents=True, exist_ok=True)
                with MEMORY.open("a") as f:
                    f.write(f"- {arg}\n")
                print("Disimpan.")
            continue
        if cmd == "/chat":
            mode = "chat"
            print("Mode: ngobrol santai.")
            continue
        if cmd == "/news":
            mode = "news"
            if not arg:
                print("Mode: CoinbroNews. Kirim topiknya.")
                continue
            line = arg

        messages.append({"role": "user", "content": line})
        try:
            reply = ask(client, messages, mode)
        except anthropic.APIError as e:
            messages.pop()
            print(f"[error API: {e}]")
            continue
        messages.append({"role": "assistant", "content": reply})
        save_history(messages)


if __name__ == "__main__":
    main()
