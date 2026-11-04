#!/usr/bin/env python3
"""Prototype C-A: relay the JMA disaster-prevention XML feed and show the
*state of the information* (freshness, possible stall), not a judgement.

Standard library only. See docs/proto/c-a.md for how to run it.

Safety floor (see CLAUDE.md):
- BW-S1: we only relay what the feed says. No own forecast, no own warning,
  no interpretation of the content. Text is passed through as-is.
- BW-S3: "no new warning received" is never turned into "safe".
- Mock data is never mixed with live data. Once live data has been received,
  we never fall back to mock (that would hide a real outage).
"""

import argparse
import json
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}

# Feed URLs were fetched successfully on 2026-11-04
# (see docs/research/jma_data.md, section 1.2).
FEEDS = [
    ("extra", "随時（気象警報など）", "https://www.data.jma.go.jp/developer/xml/feed/extra.xml"),
    ("eqvol", "地震火山", "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml"),
]
# Only follow detail links on this host (feed content is external input).
ALLOWED_DETAIL_PREFIX = "https://www.data.jma.go.jp/"
ATOM = "{http://www.w3.org/2005/Atom}"
USER_AGENT = "hackathon-tomato-proto-c-a/0.1"
MAX_BYTES = 5 * 1024 * 1024
MAX_ENTRIES = 200
MAX_DETAILS_PER_POLL = 5


def now_ms():
    return int(time.time() * 1000)


def parse_time_ms(text):
    """ISO 8601 -> epoch ms. Returns None if it cannot be parsed."""
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None  # refuse to guess the time zone
    return int(dt.timestamp() * 1000)


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def child(el, name):
    """First direct child with the given local name (namespace-agnostic)."""
    if el is None:
        return None
    for c in el:
        if local_name(c.tag) == name:
            return c
    return None


def child_text(el, name):
    c = child(el, name)
    return c.text.strip() if c is not None and c.text else None


def is_warning_type(title):
    # Prototype rule: the *type name* contains "警報". This is a filter on the
    # name, not a judgement of the content. Production should use type codes.
    return bool(title) and "警報" in title


# ---------------------------------------------------------------- parsing

def parse_atom(data):
    """Parse an Atom feed. Returns (feed_updated_ms, [entry, ...])."""
    root = ET.fromstring(data)
    feed_updated = parse_time_ms(root.findtext(ATOM + "updated"))
    entries = []
    for e in root.findall(ATOM + "entry"):
        link_el = e.find(ATOM + "link")
        entries.append({
            "id": (e.findtext(ATOM + "id") or "").strip(),
            "title": (e.findtext(ATOM + "title") or "").strip(),
            "updated": parse_time_ms(e.findtext(ATOM + "updated")),
            "author": (e.findtext(ATOM + "author/" + ATOM + "name") or "").strip(),
            "content": (e.findtext(ATOM + "content") or "").strip(),
            "link": link_el.get("href") if link_el is not None else None,
        })
    return feed_updated, [x for x in entries if x["id"]]


def parse_detail(data):
    """Pick a few fields out of one XML message.

    The structure (Control/Head/Body) is an assumption that has NOT been
    verified against real data yet. Anything missing is returned as None so
    the screen can say "could not be read" instead of guessing.
    """
    root = ET.fromstring(data)
    control = child(root, "Control")
    head = child(root, "Head")
    # Area names from the first Headline/Information block that has any.
    # In real warning messages (checked 2026-11-04) the first block is the
    # broadest level (prefecture); later blocks repeat finer levels.
    areas = []
    headline = child(head, "Headline")
    for info in (headline if headline is not None else []):
        if local_name(info.tag) != "Information":
            continue
        for el in info.iter():
            if local_name(el.tag) == "Area":
                name = child_text(el, "Name")
                if name and name not in areas:
                    areas.append(name)
        if areas:
            break
    areas = areas[:20]
    return {
        "status": child_text(control, "Status"),
        "title": child_text(head, "Title"),
        "report_datetime": parse_time_ms(child_text(head, "ReportDateTime")),
        "info_type": child_text(head, "InfoType"),
        "headline_text": child_text(headline, "Text"),
        "areas": areas,
        "error": None,
    }


# ---------------------------------------------------------------- sources

def _read_limited(resp):
    data = resp.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("response too large")
    return data


class LiveSource:
    is_mock = False

    def __init__(self, timeout):
        self.timeout = timeout
        self.last_modified = {}

    def fetch_feed(self, name, url):
        """Returns bytes, or None when the server says 304 Not Modified."""
        headers = {"User-Agent": USER_AGENT}
        if name in self.last_modified:
            headers["If-Modified-Since"] = self.last_modified[name]
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = _read_limited(resp)
                lm = resp.headers.get("Last-Modified")
                if lm:
                    self.last_modified[name] = lm
                return data
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return None
            raise

    def fetch_detail(self, url):
        if not url or not url.startswith(ALLOWED_DETAIL_PREFIX):
            raise ValueError("detail link is not on the allowed host")
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return _read_limited(resp)


class MockSource:
    """Generates obviously fake feeds in memory.

    Every title, area and office name says it is mock data, so a screenshot
    cannot be mistaken for a real announcement.
    """
    is_mock = True

    TYPES = {
        "extra": ["模擬電文：気象情報", "模擬電文：天気概況"],
        "eqvol": ["模擬電文：震度速報", "模擬電文：震源に関する情報"],
    }
    WARNING_TYPE = "模擬電文：気象警報・注意報"
    AREAS = ["模擬地域A", "模擬地域B", "模擬地域C"]

    def __init__(self, new_entry_every=3):
        self.lock = threading.Lock()
        self.calls = {}
        self.entries = {}   # feed name -> list of entry dicts (newest first)
        self.details = {}   # link -> detail dict
        self.seq = 0
        self.new_entry_every = max(1, new_entry_every)
        self.pending_warning = False

    def inject_warning(self):
        with self.lock:
            self.pending_warning = True

    def _add(self, feed, title):
        self.seq += 1
        t = now_ms()
        link = "mock://detail/%d" % self.seq
        entry = {
            "id": "urn:mock:%d" % self.seq,
            "title": title,
            "updated": t,
            "author": "模擬官署",
            "content": "これは模擬データです。気象庁の発表ではありません。（模擬番号 %d）" % self.seq,
            "link": link,
        }
        self.entries.setdefault(feed, []).insert(0, entry)
        del self.entries[feed][30:]
        self.details[link] = {
            "status": "通常",
            "title": title,
            "report_datetime": t,
            "info_type": "発表",
            "headline_text": "これは模擬データです。気象庁の発表ではありません。",
            "areas": [self.AREAS[self.seq % len(self.AREAS)]],
        }

    def fetch_feed(self, name, url):
        with self.lock:
            n = self.calls.get(name, 0)
            self.calls[name] = n + 1
            types = self.TYPES.get(name, ["模擬電文"])
            if n == 0:
                # Seed a couple of entries so the screen is not empty.
                for t in types:
                    self._add(name, t)
            elif n % self.new_entry_every == 0:
                self._add(name, types[n % len(types)])
            if name == "extra" and self.pending_warning:
                self.pending_warning = False
                self._add(name, self.WARNING_TYPE)
            return self._to_atom(name).encode("utf-8")

    def _to_atom(self, name):
        def esc(s):
            return (s.replace("&", "&amp;").replace("<", "&lt;")
                    .replace(">", "&gt;").replace('"', "&quot;"))

        def iso(ms):
            return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()

        parts = ['<?xml version="1.0" encoding="UTF-8"?>',
                 '<feed xmlns="http://www.w3.org/2005/Atom">',
                 "<title>模擬フィード（%s）</title>" % esc(name),
                 # The feed itself is "updated" on every call, like a feed
                 # that is refreshed regularly even when nothing new happens.
                 "<updated>%s</updated>" % iso(now_ms())]
        for e in self.entries.get(name, []):
            parts.append(
                "<entry><title>%s</title><id>%s</id><updated>%s</updated>"
                "<author><name>%s</name></author>"
                '<link type="application/xml" href="%s"/>'
                '<content type="text">%s</content></entry>'
                % (esc(e["title"]), esc(e["id"]), iso(e["updated"]),
                   esc(e["author"]), esc(e["link"]), esc(e["content"])))
        parts.append("</feed>")
        return "".join(parts)

    def fetch_detail(self, url):
        with self.lock:
            d = self.details.get(url)
        if d is None:
            raise ValueError("unknown mock detail")
        return d  # already parsed; see Monitor._detail_for


# ---------------------------------------------------------------- monitor

class Monitor:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.started_at = now_ms()
        self.source = None
        self.source_reason = None
        self.source_detail = None
        if args.source == "mock":
            self.source = MockSource(args.mock_every)
            self.source_reason = "起動時の指定（--source mock）"
        elif args.source == "live":
            self.source = LiveSource(args.timeout)
        # "auto": decided on the first poll.
        self.ever_live_ok = False
        self.last_attempt_at = None
        self.last_fetch_ok_at = None
        self.last_received_at = None
        self.last_error = None
        self.feeds = {name: {"name": name, "label": label, "url": url,
                             "last_ok_at": None, "last_changed_at": None,
                             "feed_updated": None, "error": None}
                      for name, label, url in FEEDS}
        self.entries = {}
        self.details = {}
        self.demo_stall = None
        self.demo_stall_since = None

    # -- polling

    def run_forever(self):
        while True:
            try:
                self.poll_once()
            except Exception as e:  # keep the loop alive no matter what
                with self.lock:
                    self.last_error = "内部エラー: %s" % e
            self.wake.wait(self.args.poll)
            self.wake.clear()

    def poll_once(self):
        if self.source is None:  # auto mode, first poll
            live = LiveSource(self.args.timeout)
            ok = self._poll_with(live)
            if ok:
                self.source = live
                return
            with self.lock:
                reason = self.last_error
                self.source = MockSource(self.args.mock_every)
                self.source_reason = "実データを取得できなかったため"
                self.source_detail = reason
                # Forget the failed live attempt so the screen is consistent.
                for f in self.feeds.values():
                    f["error"] = None
                self.last_error = None
        self._poll_with(self.source)

    def _poll_with(self, source):
        t = now_ms()
        with self.lock:
            self.last_attempt_at = t
            stall = self.demo_stall
        if stall == "fail":
            with self.lock:
                for f in self.feeds.values():
                    f["error"] = "（デモ）人工的に取得を失敗させています"
                self.last_error = "（デモ）人工的に取得を失敗させています"
            return False

        all_ok = True
        errors = []
        for name, f in self.feeds.items():
            try:
                if stall == "freeze":
                    data = None  # behave like "fetched, nothing changed"
                else:
                    data = source.fetch_feed(name, f["url"])
                changed = False
                if data is not None:
                    feed_updated, entries = parse_atom(data)
                    with self.lock:
                        if feed_updated is not None and feed_updated != f["feed_updated"]:
                            changed = True
                        f["feed_updated"] = feed_updated or f["feed_updated"]
                        for e in entries:
                            if e["id"] not in self.entries:
                                e["feed"] = name
                                e["first_seen"] = t
                                self.entries[e["id"]] = e
                                changed = True
                with self.lock:
                    f["last_ok_at"] = t
                    f["error"] = None
                    if changed:
                        f["last_changed_at"] = t
                        self.last_received_at = t
            except Exception as e:
                all_ok = False
                msg = "%s: %s" % (type(e).__name__, e)
                errors.append("%s: %s" % (name, msg))
                with self.lock:
                    f["error"] = msg
        if stall != "freeze":
            self._fetch_details(source)
        with self.lock:
            if all_ok:
                self.last_fetch_ok_at = t
                self.last_error = None
                if not source.is_mock:
                    self.ever_live_ok = True
            else:
                self.last_error = " / ".join(errors)
            self._trim()
        return all_ok

    def _fetch_details(self, source):
        """Fetch details for the newest entries that do not have one yet."""
        with self.lock:
            todo = sorted((e for e in self.entries.values() if e["id"] not in self.details),
                          key=lambda e: e["updated"] or 0, reverse=True)[:MAX_DETAILS_PER_POLL]
        for e in todo:
            try:
                raw = source.fetch_detail(e["link"])
                d = dict(raw) if isinstance(raw, dict) else parse_detail(raw)
                d["error"] = None
            except Exception as ex:
                d = {"error": "%s: %s" % (type(ex).__name__, ex)}
            with self.lock:
                self.details[e["id"]] = d

    def _trim(self):
        if len(self.entries) <= MAX_ENTRIES:
            return
        keep = sorted(self.entries.values(), key=lambda e: e["updated"] or 0,
                      reverse=True)[:MAX_ENTRIES]
        ids = {e["id"] for e in keep}
        self.entries = {k: v for k, v in self.entries.items() if k in ids}
        self.details = {k: v for k, v in self.details.items() if k in ids}

    # -- demo controls

    def set_stall(self, mode):
        with self.lock:
            self.demo_stall = mode
            self.demo_stall_since = now_ms() if mode else None
        self.wake.set()

    # -- status for the screen

    def status(self):
        with self.lock:
            mock = self.source.is_mock if self.source is not None else None
            ordered = sorted(self.entries.values(),
                             key=lambda e: e["updated"] or 0, reverse=True)

            def view(e):
                v = dict(e)
                v["detail"] = self.details.get(e["id"])
                v["is_warning_type"] = is_warning_type(e["title"])
                v["mock"] = bool(mock)
                return v

            t = now_ms()
            window_start = t - self.args.warning_window * 1000
            warnings = [view(e) for e in ordered
                        if is_warning_type(e["title"]) and (e["updated"] or 0) >= window_start]
            return {
                "server_time": t,
                "source": {
                    "mode": "pending" if mock is None else ("mock" if mock else "live"),
                    "reason": self.source_reason,
                    "detail": self.source_detail,
                },
                "poll_interval": self.args.poll,
                "stale_after": self.args.stale_after,
                "warning_window": self.args.warning_window,
                "started_at": self.started_at,
                "last_attempt_at": self.last_attempt_at,
                "last_fetch_ok_at": self.last_fetch_ok_at,
                "last_received_at": self.last_received_at,
                "last_error": self.last_error,
                "feeds": list(self.feeds.values()),
                "latest": view(ordered[0]) if ordered else None,
                "recent": [view(e) for e in ordered[:10]],
                "warnings_in_window": warnings[:10],
                "demo": {
                    "enabled": self.args.demo,
                    "stall": self.demo_stall,
                    "stall_since": self.demo_stall_since,
                    "can_inject_warning": bool(self.args.demo and mock),
                },
            }


# ---------------------------------------------------------------- HTTP

def make_handler(monitor):
    class Handler(BaseHTTPRequestHandler):
        server_version = "proto-c-a"

        def log_message(self, fmt, *a):
            pass  # keep the console quiet

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/status":
                return self._json(200, monitor.status())
            if path in STATIC_FILES:
                fname, ctype = STATIC_FILES[path]
                return self._send(200, (STATIC_DIR / fname).read_bytes(), ctype)
            self._json(404, {"error": "not found"})

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            if not monitor.args.demo:
                return self._json(403, {"error": "demo controls are disabled (start with --demo)"})
            if path == "/api/demo/stall-fail":
                monitor.set_stall("fail")
            elif path == "/api/demo/stall-freeze":
                monitor.set_stall("freeze")
            elif path == "/api/demo/resume":
                monitor.set_stall(None)
            elif path == "/api/demo/inject-warning":
                if not isinstance(monitor.source, MockSource):
                    return self._json(409, {"error": "only available with mock data"})
                monitor.source.inject_warning()
                monitor.wake.set()
            else:
                return self._json(404, {"error": "not found"})
            self._json(200, {"ok": True})

    return Handler


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Prototype C-A: JMA feed relay and information state viewer")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--source", choices=["auto", "live", "mock"], default="auto",
                   help="auto: try live once at start, use mock if that fails (default)")
    p.add_argument("--poll", type=float, default=60, help="seconds between fetches (default 60)")
    p.add_argument("--stale-after", type=float, default=600,
                   help="seconds without new data before showing a possible stall (default 600)")
    p.add_argument("--warning-window", type=float, default=3600,
                   help="seconds to look back for warning-type messages (default 3600)")
    p.add_argument("--timeout", type=float, default=15, help="HTTP timeout seconds")
    p.add_argument("--mock-every", type=int, default=3,
                   help="mock: add a new entry every N fetches (default 3)")
    p.add_argument("--demo", action="store_true", help="enable demo controls on the screen")
    return p.parse_args(argv)


def main():
    args = parse_args()
    monitor = Monitor(args)
    threading.Thread(target=monitor.run_forever, daemon=True).start()
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(monitor))
    print("proto c-a: http://%s:%d/  (source=%s, poll=%ss, stale-after=%ss, demo=%s)"
          % (args.host, args.port, args.source, args.poll, args.stale_after, args.demo))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
