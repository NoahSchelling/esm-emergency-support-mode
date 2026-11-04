"""Tests for prototype C-B.  Run: python3 -m unittest proto/c-b/test_c_b.py"""

from __future__ import annotations

import io
import json
import pathlib
import sys
import unittest
from contextlib import redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import check_examples  # noqa: E402
import fetch  # noqa: E402
import server  # noqa: E402
from bulletin import BulletinError, parse_bulletin  # noqa: E402
from paraphrase import ApiParaphraser, ExampleParaphraser, build_prompt, load_examples  # noqa: E402
from verifier import verify  # noqa: E402

BULLETINS = HERE / "bulletins"
KUMAMOTO = "20261103223117_0_VXSE53_270000.xml"
SHIZUOKA = "20261104094324_0_VPWW61_220000.xml"


def load(name: str):
    return parse_bulletin((BULLETINS / name).read_bytes(), name)


def mock_cancel_bulletin():
    """A MOCK cancellation built from a real bulletin (JMA's real ones were not available)."""
    data = (BULLETINS / KUMAMOTO).read_text("utf-8")
    head, _, rest = data.partition('<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/"')
    head = head.replace("<InfoType>発表</InfoType>", "<InfoType>取消</InfoType>")
    head = head.replace("４日０７時２８分ころ、地震がありました。", "震源・震度情報を取り消します。")
    body = ('<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">'
            "<Text>先ほどの、震源・震度情報を取り消します。</Text></Body></Report>")
    return parse_bulletin((head + body).encode("utf-8"), "mock_cancel.xml")


class ParseTest(unittest.TestCase):
    def test_all_bundled_bulletins_parse(self):
        names = sorted(p.name for p in BULLETINS.glob("*.xml"))
        self.assertEqual(len(names), 7)
        cats = [load(n).category for n in names]
        self.assertEqual(cats.count("earthquake"), 4)
        self.assertEqual(cats.count("warning"), 3)

    def test_earthquake_fields(self):
        b = load(KUMAMOTO)
        self.assertEqual(b.hypocenter, "熊本県熊本地方")
        self.assertEqual(b.magnitude, "2.5")
        self.assertEqual(b.depth_km, "10")
        self.assertEqual(b.max_intensity, "1")
        self.assertEqual(b.forecast_comments, ["この地震による津波の心配はありません。"])

    def test_warning_view_excludes_municipalities(self):
        b = load(SHIZUOKA)
        levels = {a.level for a in b.warning_areas}
        self.assertEqual(levels, {"気象警報・注意報（府県予報区等）", "気象警報・注意報（一次細分区域等）"})
        self.assertIn("伊豆市", b.all_names)  # known, but outside the view
        self.assertNotIn("伊豆市", {a.name for a in b.warning_areas})
        self.assertNotIn("雷注意報", b.all_names)  # kind names are not area names

    def test_dtd_refused(self):
        with self.assertRaises(BulletinError):
            parse_bulletin(b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x/>', "x.xml")

    def test_unsupported_bulletin(self):
        data = (BULLETINS / KUMAMOTO).read_text("utf-8").replace(
            "<Title>震源・震度に関する情報</Title>", "<Title>震度速報（模擬の別種）</Title>")
        with self.assertRaises(BulletinError):
            parse_bulletin(data.encode("utf-8"), "x.xml")


class ExamplesTest(unittest.TestCase):
    def test_examples_behave_as_documented(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(check_examples.run(BULLETINS, HERE / "examples.json"), 0)

    def test_every_bulletin_has_examples(self):
        names = {p.name for p in BULLETINS.glob("*.xml")}
        self.assertEqual(set(load_examples()), names)


class VerifierTest(unittest.TestCase):
    def test_cancel_requires_cancel_word(self):
        b = mock_cancel_bulletin()
        self.assertEqual(b.info_type, "取消")
        ok = "【震源・震度情報】11月4日7時31分に発表されました。先ほどの震源・震度情報は取り消されました。"
        self.assertTrue(verify(b, ok).ok, [c for c in verify(b, ok).failures()])
        silent = "【震源・震度情報】11月4日7時31分に発表されました。"
        res = verify(b, silent)
        self.assertFalse(res.ok)
        self.assertIn("取消・訂正", {c.name for c in res.failures()})

    def test_cancel_does_not_carry_old_facts(self):
        b = mock_cancel_bulletin()
        res = verify(b, "【震源・震度情報】11月4日7時31分に発表されました。先ほどの震源・震度情報は取り消されました。"
                        "最大震度1を熊本県熊本で観測しました。")
        self.assertFalse(res.ok)

    def test_non_normal_status_is_not_paraphrased(self):
        data = (BULLETINS / KUMAMOTO).read_text("utf-8").replace("<Status>通常</Status>", "<Status>訓練</Status>")
        b = parse_bulletin(data.encode("utf-8"), "mock_drill.xml")
        good = load_examples()[KUMAMOTO]["good"]
        res = verify(b, good)
        self.assertFalse(res.ok)
        self.assertEqual(res.failures()[0].name, "運用種別")

    def test_full_width_digits_are_normalized(self):
        b = load(KUMAMOTO)
        good = load_examples()[KUMAMOTO]["good"]
        wide = good.translate(str.maketrans("0123456789", "０１２３４５６７８９"))
        self.assertTrue(verify(b, wide).ok)

    def test_empty_paraphrase_blocked(self):
        self.assertFalse(verify(load(KUMAMOTO), "  ").ok)


class ParaphraserTest(unittest.TestCase):
    def test_api_paraphraser_has_no_transport(self):
        with self.assertRaises(NotImplementedError):
            ApiParaphraser().paraphrase(load(KUMAMOTO))

    def test_api_paraphraser_uses_injected_transport(self):
        seen = []
        p = ApiParaphraser(transport=lambda prompt: seen.append(prompt) or "dummy")
        self.assertEqual(p.paraphrase(load(KUMAMOTO)), "dummy")
        self.assertIn("予報・推測・助言・感想を足さない", seen[0])
        self.assertIn("熊本県熊本地方", seen[0])

    def test_prompt_contains_view(self):
        prompt = build_prompt(load(SHIZUOKA))
        self.assertIn("静岡県雷注意報", prompt)
        self.assertIn("心理的な助言や医療の助言を書かない", prompt)


class ServerTest(unittest.TestCase):
    def setUp(self):
        bulletins, errors, manifest = server.load_bulletins(BULLETINS)
        self.state = server.build_state(bulletins, errors, manifest, ExampleParaphraser(), load_examples())

    def test_all_good_examples_shown_with_report_time(self):
        self.assertEqual(len(self.state["items"]), 7)
        for item in self.state["items"]:
            self.assertTrue(item["paraphrase"]["shown"], item["source_name"])
            self.assertTrue(item["report_jst"])
            self.assertTrue(item["source_url"].startswith("https://www.data.jma.go.jp/"))

    def test_blocked_paraphrase_text_is_never_sent(self):
        class Bad:
            name = "bad"

            def paraphrase(self, b):
                return "【" + b.head_title + "】もう安全なので外に出てかまいません。"

        bulletins, errors, manifest = server.load_bulletins(BULLETINS)
        state = server.build_state(bulletins, errors, manifest, Bad(), load_examples())
        dumped = json.dumps(state["items"], ensure_ascii=False)
        self.assertNotIn("外に出てかまいません", dumped)
        for item in state["items"]:
            self.assertFalse(item["paraphrase"]["shown"])
            self.assertNotIn("text", item["paraphrase"])

    def test_selftest_has_no_text(self):
        self.assertEqual(len(self.state["selftest"]), 32)
        for t in self.state["selftest"]:
            self.assertTrue(t["blocked"], t["id"])
            self.assertNotIn("text", t)
        dumped = json.dumps(self.state["selftest"], ensure_ascii=False)
        self.assertNotIn("深呼吸をして", dumped)

    def test_api_mode_shows_no_paraphrase(self):
        bulletins, errors, manifest = server.load_bulletins(BULLETINS)
        state = server.build_state(bulletins, errors, manifest, ApiParaphraser(), load_examples())
        self.assertTrue(all(not i["paraphrase"]["shown"] for i in state["items"]))


class FetchTest(unittest.TestCase):
    def test_only_jma_host(self):
        fetch.check_url("https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml")
        fetch.check_url("https://www.data.jma.go.jp/developer/xml/data/" + KUMAMOTO)
        for bad in ("http://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
                    "https://example.com/developer/xml/feed/eqvol.xml",
                    "https://www.data.jma.go.jp/developer/xml/data/../../secret.xml",
                    "https://www.data.jma.go.jp/other/path.xml"):
            with self.assertRaises(fetch.FetchError, msg=bad):
                fetch.check_url(bad)

    def test_select(self):
        entries = [
            {"title": "震源・震度に関する情報", "updated": "2", "url": "q2"},
            {"title": "震度速報", "updated": "1", "url": "q1"},
            {"title": "気象警報・注意報（Ｒ０６）（暴風）", "updated": "3", "url": "w1"},
            {"title": "気象特別警報・警報・注意報", "updated": "4", "url": "old"},
        ]
        self.assertEqual(fetch.select(entries, 1, 5), ["q2", "w1"])


if __name__ == "__main__":
    unittest.main()
