"""Run the verifier over every paraphrase example and report the outcome.

  python3 proto/c-b/check_examples.py [--verbose]

Exit code 0 only if:
  * every "good" example passes,
  * every "bad" example is blocked, by (at least) the checks listed in "expect",
  * every "known_misses" example still passes (so the documented blind spots
    stay accurate; if one starts failing, update docs/proto/c-b.md).
"""

from __future__ import annotations

import argparse
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bulletin import parse_bulletin  # noqa: E402
from paraphrase import load_examples  # noqa: E402
from verifier import verify  # noqa: E402


def run(bulletin_dir: pathlib.Path, examples_path: pathlib.Path, verbose: bool = False) -> int:
    examples = load_examples(examples_path)
    problems = 0
    counts = {"good": 0, "bad": 0, "miss": 0}
    for name, ex in sorted(examples.items()):
        path = bulletin_dir / name
        b = parse_bulletin(path.read_bytes(), name)
        print(f"== {name}  {b.head_title}（{b.info_type}）")

        res = verify(b, ex["good"])
        counts["good"] += 1
        mark = "OK " if res.ok else "NG "
        problems += not res.ok
        print(f"  {mark} 正しい例: {'通過' if res.ok else '止めた'}")
        for c in res.checks if verbose or not res.ok else []:
            print(f"        [{'o' if c.ok else 'x'}] {c.name}: {c.detail}")

        for bad in ex.get("bad", []):
            counts["bad"] += 1
            res = verify(b, bad["text"])
            failed = {c.name for c in res.failures()}
            missing = [e for e in bad.get("expect", []) if e not in failed]
            good = not res.ok and not missing
            problems += not good
            print(f"  {'OK ' if good else 'NG '} 誤りの例 {bad['id']}: {bad['error']}")
            print(f"        → {'止めた' if not res.ok else '通してしまった'}"
                  + (f"（期待した確認で止まらず: {'、'.join(missing)}）" if missing else ""))
            for c in res.failures():
                print(f"        [x] {c.name}: {c.detail}")

        for miss in ex.get("known_misses", []):
            counts["miss"] += 1
            res = verify(b, miss["text"])
            still_missed = res.ok
            problems += not still_missed
            print(f"  {'OK ' if still_missed else 'NG '} 見逃す例 {miss['id']}: {miss['error']}")
            print("        → " + ("通した（既知の見逃し）" if still_missed
                                  else "止めた（文書の『見逃しうる誤り』を見直すこと）"))
            for c in res.failures():
                print(f"        [x] {c.name}: {c.detail}")

    print()
    print(f"正しい例 {counts['good']} 件、誤りの例 {counts['bad']} 件、見逃す例 {counts['miss']} 件。"
          f"期待と違った結果: {problems} 件")
    return 0 if problems == 0 else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--bulletins", type=pathlib.Path, default=HERE / "bulletins")
    p.add_argument("--examples", type=pathlib.Path, default=HERE / "examples.json")
    p.add_argument("--verbose", "-v", action="store_true", help="通過した確認も表示する")
    a = p.parse_args(argv)
    return run(a.bulletins, a.examples, a.verbose)


if __name__ == "__main__":
    sys.exit(main())
