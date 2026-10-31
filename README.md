# CoinbroNwes — Asisten AI harian (CLI)

Teman ngobrol + asisten konten CoinbroNews, dengan memori yang tersimpan antar hari.

```bash
pip install -r assistant/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python assistant/chat.py
```

Perintah: `/news <topik>`, `/chat`, `/remember <fakta>`, `/memory`, `/new`, `/exit`.
Data tersimpan di `~/.coinbro_assistant/` (ubah dengan `ASSISTANT_HOME`).
