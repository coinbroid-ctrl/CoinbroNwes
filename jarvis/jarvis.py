#!/usr/bin/env python3
"""JARVIS - asisten AI harian (CLI): memori, tools (harga crypto, web, file, shell), mode CoinbroNews.

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
import subprocess
import sys
import xml.etree.ElementTree as ET
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

import anthropic

MODEL = os.environ.get("JARVIS_MODEL", "claude-sonnet-5-5")
DATA = Path(os.environ.get("JARVIS_HOME", Path.home() / ".jarvis"))
HISTORY = DATA / "history.json"
MEMORY = DATA / "memory.md"
LEGACY_DATA = Path(os.environ.get("ASSISTANT_HOME", Path.home() / ".coinbro_assistant"))
MAX_TURNS = 40  # pesan terakhir yang dikirim ke model

CHAT_PROMPT = """Kamu adalah J.A.R.V.I.S., asisten pribadi AI milik user (gaya Iron Man: sigap, cerdas, sedikit witty,
memanggil user "bos" atau "bro"). Kamu punya tools: harga crypto live, cari berita terbaru, baca halaman web, baca/tulis file
catatan, dan jalankan perintah shell (user akan diminta konfirmasi). Pakai tools kalau itu membuat jawaban
lebih akurat, jangan menebak data real-time. Kalau sesuatu di luar kemampuanmu, bilang terus terang.
Kamu teman ngobrol & asisten pribadi harian. Pakai bahasa Indonesia santai
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
"bukan saran finansial" bila membahas harga. Jangan mengarang data/angka. SEBELUM menulis, panggil tool search_news (dan crypto_price bila
relevan) untuk fakta terbaru, lalu sebutkan sumbernya. Kalau tidak yakin, katakan dan minta user verifikasi.
Hari ini: {today}.

Memori permanen tentang user:
{memory}
"""


NOTES = DATA / "notes"

TOOLS = [
    {"name": "crypto_price", "description": "Harga crypto live (USD) + perubahan 24 jam dari CoinGecko. ids contoh: bitcoin, ethereum, solana.",
     "input_schema": {"type": "object", "properties": {"ids": {"type": "string", "description": "id CoinGecko dipisah koma"}}, "required": ["ids"]}},
    {"name": "search_news", "description": "Cari berita terbaru di web (Google News). Balikin judul, sumber, tanggal, link. Pakai ini untuk berita/kejadian terkini.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}, "lang": {"type": "string", "enum": ["id", "en"], "description": "bahasa hasil, default id"}, "limit": {"type": "integer", "description": "jumlah hasil, default 8"}}, "required": ["query"]}},
    {"name": "fetch_url", "description": "Ambil isi teks sebuah halaman web (dipotong 6000 karakter).",
     "input_schema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
    {"name": "save_note", "description": "Simpan catatan (teks) ke file di folder notes Jarvis.",
     "input_schema": {"type": "object", "properties": {"name": {"type": "string"}, "content": {"type": "string"}}, "required": ["name", "content"]}},
    {"name": "read_note", "description": "Baca catatan; tanpa name = daftar semua catatan.",
     "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}}},
    {"name": "run_shell", "description": "Jalankan perintah shell di komputer user. Butuh konfirmasi user.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
]


def http_get(url, limit=6000):  # limit = jumlah karakter yang dikembalikan
    req = urllib.request.Request(url, headers={"User-Agent": "Jarvis/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read(600000).decode("utf-8", "ignore")[:limit]


def parse_news(xml_text, limit=8):
    items = []
    for it in ET.fromstring(xml_text).iter("item"):
        src = it.find("source")
        items.append(
            f"- {it.findtext('title', '')} | {src.text if src is not None else '?'} | "
            f"{it.findtext('pubDate', '')} | {it.findtext('link', '')}"
        )
        if len(items) >= limit:
            break
    return "\n".join(items) or "(tidak ada hasil)"


def search_news(query, lang="id", limit=8):
    hl, gl = ("id", "ID") if lang == "id" else ("en-US", "US")
    q = urllib.parse.quote(query)
    url = f"https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={gl}:{hl.split('-')[0]}"
    return parse_news(http_get(url, limit=500000), max(1, min(int(limit), 15)))


def run_tool(name, args):
    try:
        if name == "crypto_price":
            q = urllib.parse.quote(args["ids"].replace(" ", ""))
            return http_get(f"https://api.coingecko.com/api/v3/simple/price?ids={q}&vs_currencies=usd&include_24hr_change=true")
        if name == "search_news":
            return search_news(args["query"], args.get("lang", "id"), args.get("limit", 8))
        if name == "fetch_url":
            return http_get(args["url"])
        if name == "save_note":
            NOTES.mkdir(parents=True, exist_ok=True)
            (NOTES / (Path(args["name"]).name + ".md")).write_text(args["content"])
            return "tersimpan"
        if name == "read_note":
            if not args.get("name"):
                return "\n".join(p.stem for p in NOTES.glob("*.md")) or "(belum ada catatan)"
            return (NOTES / (Path(args["name"]).name + ".md")).read_text()
        if name == "run_shell":
            if input(f"\n[Jarvis mau jalankan] {args['command']}\nIzinkan? (y/N) ").strip().lower() != "y":
                return "ditolak user"
            r = subprocess.run(args["command"], shell=True, capture_output=True, text=True, timeout=60)
            return (r.stdout + r.stderr)[-4000:] or "(tanpa output)"
    except Exception as e:  # noqa: BLE001
        return f"error: {e}"
    return "tool tidak dikenal"


def migrate_legacy_data():
    """Salin data versi lama (~/.coinbro_assistant) ke folder Jarvis kalau belum ada."""
    if DATA.exists() or not LEGACY_DATA.is_dir():
        return
    DATA.mkdir(parents=True)
    for f in (LEGACY_DATA / "history.json", LEGACY_DATA / "memory.md"):
        if f.exists():
            (DATA / f.name).write_bytes(f.read_bytes())


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
    convo = list(recent)
    texts = []
    for _ in range(8):  # batas putaran tool
        with client.messages.stream(
            model=MODEL, max_tokens=2048, system=system_prompt(mode), messages=convo, tools=TOOLS
        ) as stream:
            for t in stream.text_stream:
                print(t, end="", flush=True)
                texts.append(t)
            final = stream.get_final_message()
        if final.stop_reason != "tool_use":
            break
        convo.append({"role": "assistant", "content": final.content})
        results = []
        for b in final.content:
            if b.type == "tool_use":
                print(f"\n[tool: {b.name}]")
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": run_tool(b.name, b.input)})
        convo.append({"role": "user", "content": results})
    print()
    return "".join(texts)


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Set dulu: export ANTHROPIC_API_KEY=sk-ant-...")
    client = anthropic.Anthropic()
    migrate_legacy_data()
    messages = load_json(HISTORY, [])
    mode = "chat"
    print(f"JARVIS online, bos ({len(messages)} pesan tersimpan). /exit untuk keluar.\n")

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
