"""Paraphrase generators.

The generator is swappable. Every generator returns plain text or None; the
caller must always run verifier.verify() on the result before showing it.

  * ExampleParaphraser: returns hand-written examples from examples.json.
    In this prototype the examples were written by Claude Code (no API call).
  * ApiParaphraser: the shape of an LLM-backed generator. It builds the prompt
    and hands it to an injected `transport` callable. No transport (and no API
    key) is provided in this prototype, so it raises NotImplementedError.

Out of scope on purpose (BW-S4): no generator may add mental-health or medical
advice. The verifier blocks such words, but the instruction is also part of
the prompt below.
"""

from __future__ import annotations

import json
import pathlib
from typing import Callable, Protocol

from bulletin import Bulletin

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_EXAMPLES = HERE / "examples.json"


class Paraphraser(Protocol):
    name: str

    def paraphrase(self, bulletin: Bulletin) -> str | None:
        ...


class ExampleParaphraser:
    """Looks up a pre-written paraphrase by bulletin file name."""

    name = "例文（Claude Code が作成。API は使っていない）"

    def __init__(self, path: pathlib.Path = DEFAULT_EXAMPLES):
        self.examples = load_examples(path)

    def paraphrase(self, bulletin: Bulletin) -> str | None:
        ex = self.examples.get(bulletin.source_name)
        return ex["good"] if ex else None


PROMPT_RULES = """\
次の気象庁の発表を、平易な日本語に言い換えてください。守ること：
- 下の「原文」にある事実だけを書く。予報・推測・助言・感想を足さない。
- 「安全」「安心」など、危険がないと受け取れる言葉を使わない。
- 心理的な助言や医療の助言を書かない。
- 情報の種類（原文の「情報の種類」）をそのまま書く。
- 発表時刻を「M月D日H時MM分」の形で書く。発生時刻があればそれも書く。
- 数は算用数字で書く。数値・時刻・地域名・震度・警報や注意報の名前・状態（発表・継続・解除など）は原文のとおりに書く。
- 地域と震度、地域と警報・注意報の名前と状態は、同じ文の中に書く。
- 付加文は、原文の文をそのまま書く。
- 原文の「情報の形態」が「取消」なら取消であること、「訂正」なら訂正であることを書く。それ以外なら、取消・訂正という言葉を使わない。
"""


def build_prompt(bulletin: Bulletin) -> str:
    lines = [f"{row['label']}：{row['value']}" for row in bulletin.view()]
    return PROMPT_RULES + "\n原文：\n" + "\n".join(lines) + "\n\n言い換え："


class ApiParaphraser:
    """Shape of an API-backed generator. The transport is injected by the caller.

    transport(prompt: str) -> str  sends the prompt to a model and returns its text.
    Credentials, if any, belong to the transport and must never be stored in
    this repository.
    """

    name = "API（この試作では未接続）"

    def __init__(self, transport: Callable[[str], str] | None = None):
        self.transport = transport

    def paraphrase(self, bulletin: Bulletin) -> str | None:
        if self.transport is None:
            raise NotImplementedError("この試作では API を呼びません（transport が未設定）")
        return self.transport(build_prompt(bulletin))


def load_examples(path: pathlib.Path = DEFAULT_EXAMPLES) -> dict:
    data = json.loads(path.read_text("utf-8"))
    return data["bulletins"]
