"""Tests for prototype C-A. Run: python3 -m unittest proto/c-a/test_server.py"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


def args(**kw):
    a = server.parse_args(["--source", "mock", "--demo"])
    for k, v in kw.items():
        setattr(a, k, v)
    return a


class FailingSource:
    is_mock = False

    def fetch_feed(self, name, url):
        raise OSError("blocked")

    def fetch_detail(self, url):
        raise OSError("blocked")


class ParseTests(unittest.TestCase):
    def test_parse_atom(self):
        data = (b'<?xml version="1.0" encoding="UTF-8"?>'
                b'<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-04T00:00:00Z</updated>'
                b'<entry><title>T</title><id>urn:x:1</id><updated>2026-11-04T00:00:00Z</updated>'
                b'<author><name>A</name></author><link href="https://example.invalid/x.xml"/>'
                b'<content type="text">C</content></entry></feed>')
        updated, entries = server.parse_atom(data)
        self.assertEqual(updated, 1793750400000)
        self.assertEqual(entries[0]["title"], "T")
        self.assertEqual(entries[0]["author"], "A")

    def test_parse_items_from_real_warning_sample(self):
        # Real JMA message saved in data/samples (Hiroshima, 2026-11-04).
        sample = Path(__file__).resolve().parents[2] / "data" / "samples" / "20261104083155_0_VPWW53_340000.xml"
        d = server.parse_detail(sample.read_bytes())
        self.assertTrue(d["items"])
        first = d["items"][0]
        self.assertEqual(first["type"], "気象警報・注意報（府県予報区等）")
        self.assertEqual(first["area_code"], "340000")
        self.assertEqual(first["kinds"][0], {"name": "乾燥注意報", "status": "解除"})
        self.assertTrue(all(i["area_code"] and i["kinds"] for i in d["items"]))

    def test_parse_items_tsunami_shape_and_limits(self):
        xml = ('<Report><Head><Title>津波警報・注意報・予報a</Title></Head><Body><Tsunami><Forecast>'
               '<Item><Area><Name>静岡県</Name><Code>380</Code></Area><Category><Kind><Name>大津波警報</Name>'
               '<Code>52</Code></Kind><LastKind><Name>津波警報</Name></LastKind></Category></Item>'
               '<Item><Area><Name>X</Name></Area></Item>'
               '</Forecast></Tsunami></Body></Report>').encode("utf-8")
        d = server.parse_detail(xml)
        self.assertEqual(len(d["items"]), 1)
        self.assertEqual(d["items"][0]["area_code"], "380")
        self.assertEqual(d["items"][0]["kinds"][0]["name"], "大津波警報")
        self.assertEqual(server.parse_items(None), [])

    def test_parse_items_tsunami_max_height(self):
        ns = 'xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/"'
        def item(code, height):
            return (f'<Item><Area><Name>A{code}</Name><Code>{code}</Code></Area><Category><Kind><Name>大津波警報</Name></Kind></Category>'
                    f'<MaxHeight>{height}</MaxHeight></Item>')
        xml = (f'<Report {ns}><Body><Tsunami><Forecast>'
               + item('380', '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="３ｍ">3</jmx_eb:TsunamiHeight>')
               + item('250', '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="１０ｍ超" condition="以上">10</jmx_eb:TsunamiHeight>')
               + item('312', '<jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="巨大">NaN</jmx_eb:TsunamiHeight>')
               + '<Item><Area><Name>B</Name><Code>311</Code></Area><Category><Kind><Name>津波注意報</Name></Kind></Category></Item>'
               + '</Forecast></Tsunami></Body></Report>').encode("utf-8")
        items = {i["area_code"]: i for i in server.parse_detail(xml)["items"]}
        self.assertEqual(items["380"]["max_height"]["value_m"], 3.0)
        self.assertEqual(items["380"]["max_height"]["description"], "３ｍ")
        self.assertFalse(items["380"]["max_height"]["unbounded"])
        self.assertTrue(items["250"]["max_height"]["unbounded"])
        self.assertIsNone(items["312"]["max_height"]["value_m"])
        self.assertTrue(items["312"]["max_height"]["unbounded"])
        self.assertNotIn("max_height", items["311"])

    def test_parse_detail_missing_parts_are_none(self):
        d = server.parse_detail(b"<Report><Head><Title>x</Title></Head></Report>")
        self.assertIsNone(d["status"])
        self.assertIsNone(d["report_datetime"])
        self.assertEqual(d["areas"], [])

    def test_parse_detail_namespaced(self):
        xml = ('<Report xmlns="urn:a"><Control><Status>訓練</Status></Control>'
               '<Head xmlns="urn:b"><ReportDateTime>2026-11-04T09:00:00+09:00</ReportDateTime>'
               '<InfoType>発表</InfoType><Headline><Text>h</Text><Information><Item><Areas>'
               '<Area><Name>地域1</Name></Area><Area><Name>地域2</Name></Area>'
               '</Areas></Item></Information></Headline></Head></Report>').encode("utf-8")
        d = server.parse_detail(xml)
        self.assertEqual(d["status"], "訓練")
        self.assertEqual(d["info_type"], "発表")
        self.assertEqual(d["areas"], ["地域1", "地域2"])
        self.assertEqual(d["report_datetime"], 1793750400000)

    def test_parse_detail_uses_first_information_block_only(self):
        # Shape seen in a real warning message on 2026-11-04 (names replaced).
        xml = ('<Report><Control><Status>通常</Status></Control><Head><Headline>'
               '<Information type="p"><Item><Areas><Area><Name>県</Name></Area></Areas></Item></Information>'
               '<Information type="c"><Item><Areas><Area><Name>市</Name></Area></Areas></Item></Information>'
               '</Headline></Head></Report>').encode("utf-8")
        self.assertEqual(server.parse_detail(xml)["areas"], ["県"])

    def test_naive_time_is_rejected(self):
        self.assertIsNone(server.parse_time_ms("2026-11-04T09:00:00"))

    def test_warning_type(self):
        self.assertTrue(server.is_warning_type("気象警報・注意報"))
        self.assertFalse(server.is_warning_type("気象注意報"))


class MonitorTests(unittest.TestCase):
    def test_mock_receives_and_marks_mock(self):
        m = server.Monitor(args())
        m.poll_once()
        s = m.status()
        self.assertEqual(s["source"]["mode"], "mock")
        self.assertIsNotNone(s["last_received_at"])
        self.assertTrue(s["latest"]["mock"])
        self.assertEqual(s["warnings_in_window"], [])

    def test_current_keeps_warnings_after_they_leave_recent(self):
        m = server.Monitor(args())
        tsunami = {"title": "津波警報・注意報・予報a", "status": "通常", "report_datetime": 1000,
                   "items": [{"area_code": "380", "kinds": [{"name": "大津波警報", "status": None}]}], "error": None}
        m._update_current({"id": "t1", "title": "津波警報・注意報・予報a", "author": "気象庁", "updated": 1000}, tsunami)
        # many other messages afterwards (other offices, other kinds)
        for i in range(30):
            m._update_current({"id": "w%d" % i, "title": "気象警報・注意報（Ｒ０６）", "author": "office%d" % i, "updated": 2000 + i},
                              {"title": "気象警報・注意報（Ｒ０６）", "status": "通常", "report_datetime": 2000 + i,
                               "items": [{"area_code": str(i), "kinds": [{"name": "大雨警報", "status": None}]}], "error": None})
        cur = m.status()["current"]
        self.assertEqual(len(cur), 31)  # one per office, and the tsunami one
        self.assertIn("大津波警報", [it["kinds"][0]["name"] for c in cur for it in c["detail"]["items"]])
        # tsunami information replaces the warning message (same group); an older one does not
        info = dict(tsunami, title="津波情報a", report_datetime=1500,
                    items=[{"area_code": "380", "kinds": [{"name": "津波警報", "status": None}]}])
        m._update_current({"id": "t2", "title": "津波情報a", "author": "気象庁", "updated": 1500}, info)
        m._update_current({"id": "t0", "title": "津波警報・注意報・予報a", "author": "気象庁", "updated": 900}, dict(tsunami, report_datetime=900))
        ts = [c for c in m.status()["current"] if "津波" in c["title"]]
        self.assertEqual(len(ts), 1)
        self.assertEqual(ts[0]["detail"]["items"][0]["kinds"][0]["name"], "津波警報")
        # training messages and messages without items are not kept
        m._update_current({"id": "x", "title": "津波警報・注意報・予報a", "author": "気象庁", "updated": 9000},
                          dict(tsunami, status="訓練", report_datetime=9000))
        self.assertEqual([c for c in m.status()["current"] if "津波" in c["title"]][0]["id"], "t2")

    def test_detail_priority_tsunami_first(self):
        self.assertEqual(server.detail_priority("津波情報a"), 0)
        self.assertEqual(server.detail_priority("気象警報・注意報（Ｒ０６）"), 1)
        self.assertEqual(server.detail_priority("震度速報"), 2)

    def test_inject_warning(self):
        m = server.Monitor(args())
        m.poll_once()
        m.source.inject_warning()
        m.poll_once()
        self.assertEqual(len(m.status()["warnings_in_window"]), 1)

    def test_stall_fail_keeps_last_received(self):
        m = server.Monitor(args())
        m.poll_once()
        before = m.status()["last_received_at"]
        m.set_stall("fail")
        m.poll_once()
        s = m.status()
        self.assertEqual(s["last_received_at"], before)
        self.assertIn("デモ", s["last_error"])

    def test_stall_freeze_fetch_ok_but_nothing_received(self):
        m = server.Monitor(args())
        m.poll_once()
        before = m.status()["last_received_at"]
        m.set_stall("freeze")
        m.poll_once()
        s = m.status()
        self.assertEqual(s["last_received_at"], before)
        self.assertIsNone(s["last_error"])

    def test_live_failure_never_falls_back_to_mock(self):
        m = server.Monitor(args(source="live"))
        m.source = FailingSource()
        m.poll_once()
        s = m.status()
        self.assertEqual(s["source"]["mode"], "live")
        self.assertIsNone(s["last_received_at"])
        self.assertIn("blocked", s["last_error"])

    def test_live_detail_link_must_be_on_allowed_host(self):
        src = server.LiveSource(timeout=1)
        with self.assertRaises(ValueError):
            src.fetch_detail("http://127.0.0.1/secret")


if __name__ == "__main__":
    unittest.main()
