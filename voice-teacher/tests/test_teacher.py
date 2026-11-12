"""python voice-teacher/tests/test_teacher.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from teacher import TagStream, build_system, mock_reply  # noqa: E402


def collect(text, size):
    p, out = TagStream(), []
    for i in range(0, len(text), size):
        out += p.feed(text[i:i + size])
    return out + p.finish()


def test_streaming_any_chunk_size():
    raw = mock_reply([{"role": "user", "content": "I go to work yesterday"}])
    for size in (1, 7, 24, 10_000):
        ev = collect(raw, size)
        assert [e["type"] for e in ev] == ["say", "correction", "say", "say", "repeat"], size
        assert ev[0]["lang"] == "id" and ev[2]["lang"] == "en"
        c = ev[1]
        assert c["wrong"] == "I go to work yesterday." and c["right"] == "I went to work yesterday."
        assert c["phonetic"] == "Ai went tu werk yesterdei." and "yesterday" in c["explain"]
        assert ev[4]["text"] == "I went to work yesterday."
        assert "".join(e["raw"] for e in ev) == raw


def test_untagged_text_is_still_spoken():
    assert collect("Hello there!", 5) == [
        {"type": "say", "lang": "en", "text": "Hello there!", "raw": '<say lang="en">Hello there!</say>'}]


def test_system_prompt_levels():
    assert "BEGINNER" in build_system("beginner", "") and "ADVANCED" in build_system("advanced", "travel")
    assert "BEGINNER" in build_system("nonsense", "")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
