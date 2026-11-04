"""Prototype C-B: show JMA bulletins next to verified plain-language paraphrases.

  python3 proto/c-b/server.py [--port 8001] [--bulletins DIR] [--paraphraser examples|api]

Open http://127.0.0.1:8001/ . A paraphrase is sent to the browser only when
the verifier finds no mismatch; otherwise only the reasons are sent.
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.server
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bulletin import Bulletin, BulletinError, format_jst, parse_bulletin  # noqa: E402
from paraphrase import ApiParaphraser, ExampleParaphraser, load_examples  # noqa: E402
from verifier import verify  # noqa: E402

STATIC = HERE / "static"
SOURCE_NOTE = "出典：気象庁ホームページ"


def load_bulletins(directory: pathlib.Path) -> tuple[list[Bulletin], list[str], dict]:
    manifest_path = directory / "fetched.json"
    manifest = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {}
    bulletins, errors = [], []
    for path in sorted(directory.glob("*.xml")):
        info = manifest.get(path.name, {})
        try:
            bulletins.append(parse_bulletin(path.read_bytes(), path.name, info.get("url", "")))
        except BulletinError as e:
            errors.append(f"{path.name}: {e}")
    bulletins.sort(key=lambda b: b.report_datetime, reverse=True)
    return bulletins, errors, manifest


def paraphrase_item(b: Bulletin, paraphraser) -> dict:
    if b.status != "通常":
        return {"shown": False, "reason": f"運用種別が「{b.status}」の電文は言い換えません。", "checks": []}
    try:
        text = paraphraser.paraphrase(b)
    except NotImplementedError as e:
        return {"shown": False, "reason": f"言い換えを作れませんでした：{e}", "checks": []}
    if text is None:
        return {"shown": False, "reason": "この電文には言い換えの例文がありません。", "checks": []}
    res = verify(b, text)
    checks = [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in res.checks]
    if res.ok:
        return {"shown": True, "text": text, "checks": checks}
    # Mismatch: never send the paraphrase text.
    return {"shown": False, "reason": "照合で原文との食い違いが見つかったため、言い換えを表示しません。",
            "checks": checks}


def selftest(bulletins: list[Bulletin], examples: dict) -> list[dict]:
    """Deliberately wrong examples: report only whether they were blocked and why."""
    by_name = {b.source_name: b for b in bulletins}
    out = []
    for name, ex in sorted(examples.items()):
        b = by_name.get(name)
        if b is None:
            continue
        for bad in ex.get("bad", []):
            res = verify(b, bad["text"])
            out.append({
                "bulletin": b.head_title,
                "report_jst": format_jst(b.report_datetime),
                "id": bad["id"],
                "error": bad["error"],
                "blocked": not res.ok,
                "failed": [{"name": c.name, "detail": c.detail} for c in res.failures()],
            })
    return out


def build_state(bulletins, errors, manifest, paraphraser, examples) -> dict:
    items = []
    for b in bulletins:
        info = manifest.get(b.source_name, {})
        items.append({
            "source_name": b.source_name,
            "source_url": b.source_url,
            "fetched_at_utc": info.get("fetched_at_utc", ""),
            "category": b.category,
            "control_title": b.control_title,
            "head_title": b.head_title,
            "info_type": b.info_type,
            "status": b.status,
            "editorial_office": b.editorial_office,
            "report_datetime": b.report_datetime.isoformat(),
            "report_jst": format_jst(b.report_datetime),
            "view": b.view(),
            "paraphrase": paraphrase_item(b, paraphraser),
        })
    return {
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "paraphraser": paraphraser.name,
        "source_note": SOURCE_NOTE,
        "items": items,
        "load_errors": errors,
        "selftest": selftest(bulletins, examples),
    }


def make_handler(state: dict):
    class Handler(http.server.BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/api/items":
                body = json.dumps(state, ensure_ascii=False).encode("utf-8")
                return self._send(200, body, "application/json; charset=utf-8")
            files = {"/": ("index.html", "text/html; charset=utf-8"),
                     "/app.js": ("app.js", "text/javascript; charset=utf-8")}
            if path in files:
                name, ctype = files[path]
                return self._send(200, (STATIC / name).read_bytes(), ctype)
            return self._send(404, b"not found", "text/plain; charset=utf-8")

        def log_message(self, fmt, *args):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    return Handler


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8001)
    p.add_argument("--bulletins", type=pathlib.Path, default=HERE / "bulletins")
    p.add_argument("--examples", type=pathlib.Path, default=HERE / "examples.json")
    p.add_argument("--paraphraser", choices=("examples", "api"), default="examples",
                   help="examples: 例文を使う（既定）／api: API の形だけ（この試作では未接続）")
    a = p.parse_args(argv)

    bulletins, errors, manifest = load_bulletins(a.bulletins)
    examples = load_examples(a.examples)
    paraphraser = ExampleParaphraser(a.examples) if a.paraphraser == "examples" else ApiParaphraser()
    state = build_state(bulletins, errors, manifest, paraphraser, examples)
    for e in errors:
        print(f"読めなかった電文: {e}", file=sys.stderr)
    shown = sum(i["paraphrase"]["shown"] for i in state["items"])
    print(f"電文 {len(bulletins)} 件、言い換えを表示 {shown} 件。http://{a.host}:{a.port}/")
    server = http.server.ThreadingHTTPServer((a.host, a.port), make_handler(state))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
