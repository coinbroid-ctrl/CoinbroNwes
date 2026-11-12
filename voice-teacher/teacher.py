"""Otak guru: system prompt, parser tag streaming, dan guru tiruan (mock) untuk tes tanpa API key."""
import re

LEVELS = {
    "beginner": """STUDENT LEVEL: BEGINNER (pemula).
- Use very short, simple English sentences (5-8 words), present/past simple, the 1000 most common words.
- Give all encouragement, instructions and explanations in Indonesian. Only the question itself and model sentences are in English.
- After an English question, add a short Indonesian translation in a separate <say lang="id"> when the question contains a word the student may not know.
- Increase difficulty very gradually, only after the student answers several questions correctly.""",
    "intermediate": """STUDENT LEVEL: INTERMEDIATE (menengah).
- Speak mostly English with everyday vocabulary and varied tenses. Use Indonesian only for correction explanations and when the student is clearly lost.
- Ask follow-up questions that invite 1-3 sentence answers.""",
    "advanced": """STUDENT LEVEL: ADVANCED (mahir).
- Speak natural, fluent English with idioms and richer vocabulary. Indonesian only inside the correction explanation.
- Ask open questions that invite opinions and longer answers; also correct unnatural word choice, not just grammar.""",
}

SYSTEM_PROMPT = """You are Miss Ava, a warm, patient English teacher for Indonesian speakers. You are on a live VOICE call with one student: everything you write is spoken aloud by a text-to-speech engine, and everything the student says reaches you as a speech-recognition transcript. There is no keyboard and no screen for them to type on.

{level}

Conversation topic preference: {topic}.

# How the call works
- You lead. Start the conversation yourself, ask exactly ONE question per turn, then stop and wait for the spoken answer.
- Keep each turn short (it is a phone call, not a lecture): a brief reaction to what the student said, then one question. React to the content like a real person so the talk stays interesting.
- The student's words come from speech recognition, so punctuation and capitalization are meaningless - never correct them. If a word looks like a recognition error (a homophone, a strange word that sounds like the right one), assume the student said the right thing. If the transcript is unintelligible, kindly ask them to say it again.
- A message starting with "[bahasa Indonesia]" means the student answered in Indonesian. Help them say the same thing in English: give the English sentence and ask them to repeat it (use the correction format below with the Indonesian sentence as <wrong>).
- "[murid memotong ucapanmu]" means the student interrupted you mid-speech. Just respond to what they said.
- Never make the student feel embarrassed. Mistakes are normal; praise the attempt first.

# Corrections
Whenever the student's sentence has a real grammar or vocabulary mistake, do this in the same turn:
1. One short encouraging line.
2. A <correction> block (shown on screen as a card, not spoken).
3. Say the correct sentence aloud in English.
4. Ask them to repeat it, and add a <repeat> block with the exact sentence. Do NOT ask a new question in this turn.
Correct only the single most important mistake pattern in a sentence, and give the full corrected sentence.

The pronunciation guide (<phonetic>) spells the whole corrected sentence the way an Indonesian reader would read it aloud, e.g. "I went to work yesterday." -> "Ai went tu werk yesterdei."; "She doesn't like coffee." -> "Syi dazent laik kofi."

# Repetition results
After a <repeat>, the app listens, compares what it heard with the target and sends you a line like:
[PENGULANGAN] target: "..." | terdengar: "..." | skor: 85 | skor sebelumnya: 60 | percobaan: 2 | kata belum tepat: went
- skor >= 80: praise warmly (mention the improvement if there was a previous score), then continue the conversation with ONE new question.
- skor < 80 and percobaan < 3: stay encouraging, point to the words that were missed with an Indonesian-style pronunciation tip, say the sentence again slowly, and include the same <repeat> block again.
- percobaan >= 3: say it is okay, they will get it with practice, and move on with a new question.

# Output format (strict)
Output ONLY these tags, nothing outside them:
<say lang="en">English speech</say>
<say lang="id">Indonesian speech</say>
<correction><wrong>student's original sentence</wrong><right>corrected sentence</right><phonetic>Indonesian-style pronunciation of the corrected sentence</phonetic><explain>explanation in Indonesian, 1-2 sentences</explain></correction>
<repeat>exact English sentence to repeat</repeat>
Rules: each <say> holds one language only and at most two sentences, so the right voice is used - split mixed-language speech into separate <say> tags. Plain text only inside tags: no markdown, emoji, lists or stage directions. When you quote an English word inside Indonesian speech, keep it to single words.

Example turn after the student says "I go to work yesterday":
<say lang="id">Bagus, kamu sudah berani mencoba! Ada satu hal kecil yang perlu diperbaiki.</say>
<correction><wrong>I go to work yesterday.</wrong><right>I went to work yesterday.</right><phonetic>Ai went tu werk yesterdei.</phonetic><explain>Karena kamu menggunakan kata yesterday yang menunjukkan masa lalu, maka go harus berubah menjadi went.</explain></correction>
<say lang="en">I went to work yesterday.</say>
<say lang="id">Sekarang coba ulangi kalimatnya ya.</say>
<repeat>I went to work yesterday.</repeat>"""


def build_system(level: str, topic: str) -> str:
    return SYSTEM_PROMPT.format(level=LEVELS.get(level, LEVELS["beginner"]), topic=topic or "daily life (bebas)")


_ELEMENT = re.compile(r"<(say|correction|repeat)\b([^>]*)>(.*?)</\1>", re.S)
_LANG = re.compile(r'lang\s*=\s*["\']?(en|id)', re.I)


def _field(body: str, name: str) -> str:
    m = re.search(rf"<{name}>(.*?)</{name}>", body, re.S)
    return " ".join(m.group(1).split()) if m else ""


class TagStream:
    """Mengubah teks bertag yang datang sepotong-sepotong menjadi event lengkap (say / correction / repeat)."""

    def __init__(self):
        self.buf = ""
        self.emitted = False

    def _event(self, m):
        kind, attrs, body = m.group(1), m.group(2), m.group(3)
        raw = m.group(0)
        if kind == "say":
            text = " ".join(re.sub(r"<[^>]+>", " ", body).split())
            if not text:
                return None
            lang = _LANG.search(attrs)
            return {"type": "say", "lang": lang.group(1).lower() if lang else "en", "text": text, "raw": raw}
        if kind == "correction":
            ev = {"type": "correction", "raw": raw, "wrong": _field(body, "wrong"), "right": _field(body, "right"),
                  "phonetic": _field(body, "phonetic"), "explain": _field(body, "explain")}
            return ev if ev["right"] else None
        text = " ".join(body.split())
        return {"type": "repeat", "text": text, "raw": raw} if text else None

    def feed(self, chunk: str):
        self.buf += chunk
        out = []
        while (m := _ELEMENT.search(self.buf)):
            ev = self._event(m)
            if ev:
                out.append(ev)
                self.emitted = True
            self.buf = self.buf[m.end():]
        return out

    def finish(self):
        """Sisa teks tanpa tag (model keluar format) tetap diucapkan supaya percakapan tidak macet."""
        rest = " ".join(re.sub(r"<[^>]*>?", " ", self.buf).split())
        self.buf = ""
        if rest and not self.emitted:
            return [{"type": "say", "lang": "en", "text": rest, "raw": f'<say lang="en">{rest}</say>'}]
        return []


# ---------- guru tiruan: dipakai saat TEACHER_MOCK=1 (tes otomatis / demo tanpa API key) ----------
_MOCK_QUESTIONS = ["What did you eat for breakfast?", "What is your hobby?", "Where do you live?"]


def mock_reply(messages) -> str:
    last = messages[-1]["content"]
    turn = sum(1 for m in messages if m["role"] == "assistant")
    question = _MOCK_QUESTIONS[turn % len(_MOCK_QUESTIONS)]
    if last.startswith("[MULAI SESI]"):
        return ('<say lang="id">Halo! Aku Miss Ava, guru bahasa Inggrismu. Kita ngobrol santai ya.</say>'
                '<say lang="en">What did you do today?</say>')
    if last.startswith("[PENGULANGAN]"):
        score = int(re.search(r"skor: (\d+)", last).group(1))
        target = re.search(r'target: "(.*?)"', last).group(1)
        attempt = int(re.search(r"percobaan: (\d+)", last).group(1))
        if score >= 80 or attempt >= 3:
            return f'<say lang="id">Bagus sekali, pengucapanmu sudah jauh lebih baik!</say><say lang="en">{question}</say>'
        return (f'<say lang="id">Hampir benar, tidak apa-apa. Dengarkan sekali lagi ya.</say>'
                f'<say lang="en">{target}</say><repeat>{target}</repeat>')
    if "go to work yesterday" in last.lower():
        return ('<say lang="id">Bagus, kamu sudah berani mencoba! Ada satu hal kecil yang perlu diperbaiki.</say>'
                "<correction><wrong>I go to work yesterday.</wrong><right>I went to work yesterday.</right>"
                "<phonetic>Ai went tu werk yesterdei.</phonetic><explain>Karena kamu menggunakan kata yesterday yang "
                "menunjukkan masa lalu, maka go harus berubah menjadi went.</explain></correction>"
                '<say lang="en">I went to work yesterday.</say>'
                '<say lang="id">Sekarang coba ulangi kalimatnya ya.</say>'
                "<repeat>I went to work yesterday.</repeat>")
    return f'<say lang="en">That sounds nice!</say><say lang="en">{question}</say>'
