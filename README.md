# CoinbroNwes — JARVIS, asisten AI harian (CLI)

Teman ngobrol + asisten konten CoinbroNews, dengan memori yang tersimpan antar hari.

```bash
pip install -r jarvis/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python jarvis/jarvis.py
```

Perintah: `/news <topik>`, `/chat`, `/remember <fakta>`, `/memory`, `/new`, `/exit`.
Data tersimpan di `~/.coinbro_jarvis/` (ubah dengan `JARVIS_HOME`).

## Kemampuan (tools)
Harga crypto live (CoinGecko), cari berita terbaru (Google News), baca halaman web, simpan/baca catatan, dan jalankan perintah shell (selalu minta konfirmasi `y/N`).
