"""Record comparator-v1 goldens by RUNNING PropertyScope's prototype comparator (M0.6).

Dev-only and local. It runs under the prototype's own uv environment inside the git-ignored
.reference/ folder (ADR 0001), imports the prototype at the pinned commit, and writes recorded
outputs under testdata/. It is never run in CI, and tests never read .reference/.

    cd .reference/propertyscope
    uv sync --locked --only-group visual --no-build
    uv run --no-sync python ../../tools/prototype-goldens/record.py --prototype . \
        --tracepilot ../tracepilot --artifacts ../artifacts --work ../m06 --out ../../testdata

The pixel hash here is an independent Python implementation of 02 §3, used to cross-check the
TypeScript one. Everything else is the prototype's own code; nothing is re-implemented.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import platform
import re
import shutil
import struct
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

PIN = "6378d8be5b1f418f72279e04b3de23d761b426d3"
RUN_ID = "36405830015"
BASE_SHA = "a2c66ece818dc2eb43d258aaec8ea1fc569fb0da"
HEAD_SHA = "8fc85c2df34f454d8eac5aa525a3398f45ef6bd5"
# ADR 0001: artifact name -> (artifact ID, SHA-256 of the zip).
ARTIFACTS = {
    "visual-base-fixture": ("10962062704", "b062b6a961b6c98dc663645e870b0671efac82122b192fa5cd2367d308e775a5"),
    "visual-base-stack": ("10962640673", "b6a7b4c7ceb3f8f5f9eb5da88c62d3d4c111197ccd8c3b3855a73d3cd885aad4"),
    "visual-head-fixture": ("10962785105", "1f382cc54aa35181c87237cc24ca0387e4016b311a41f1574ccc9346feb9dfa5"),
    "visual-head-stack": ("10962835047", "e711eb3ebdcd710f732b5194cf8bd58227748e7b4fb87d5a695d5e52b914fdc5"),
}
# ADR 0001 amendment (M0.6): TracePilot runs with real changes. PropertyScope's comparator runs on
# their screenshots; TracePilot's own published result is kept alongside as a cross-check.
TRACEPILOT_RUNS = {
    "36287837535": {
        "attempt": "1",
        "event": "push",
        "headSha": "3507148c340e89da29358e7f0751214bffc1d102",
        "artifacts": {
            "visual-base-1": ("10921730284", "bc65a6a8c9bb8928c773f6d68eecc33d3ef52a141d07274b73bdf70cc6d6bfec"),
            "visual-base-2": ("10921521173", "84b3e4626d5b3cf36b1bf36cf566d61982b2db3cfea1fb5f89599ec18a65ba96"),
            "visual-head-1": ("10921240812", "647368600e344c58e966ba9aeacd2f3d20142de701cc8517d574403dba67a30b"),
            "visual-head-2": ("10921760211", "44e8d95c18f7a1a885f6af743a65f17a3820d8f8e265c341435c25a3ffc378b8"),
        },
    },
    "36301239732": {
        "attempt": "1",
        "event": "pull_request",
        "headSha": "7e8380a52d84c39c28c4ffa3a66f3ffcdb9c17cf",
        "artifacts": {
            "visual-base-1": ("10925303368", "4af0538fb89be283c94edb1d42066314c50e9739889989d73b3b6d0c36d71831"),
            "visual-base-2": ("10926230874", "33e3f7e265f1a2b8f086ef6b09e357c921391605ff90bee4a37a0005ce8cefbb"),
            "visual-head-1": ("10925333267", "bd3b9f4ea664a2500ca5f3d16977289e9a6c8995f2df2202fc51dd286b0012fe"),
            "visual-head-2": ("10926195393", "3f6adb26fd1764bee04ac3dd71dc8ceb556db1ff1874cf427180996f2c7824d2"),
        },
    },
}
TRACEPILOT_MEMBER = re.compile(r"^(?:[a-z0-9][a-z0-9-]{0,63}\.png|capture-[0-9]+-[0-9]+\.json)$")
DOMAIN = b"pixelwatch:rgba8:v1\x00"
ANALYSIS_KEYS = ("threshold", "changed", "total", "percent", "bounds", "regions", "regionCount")
CROP_BAND = 256
MAX_CROPS = 3


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8", newline="\n")


# --- Independent pixel hash (02 §3) ---------------------------------------------------------


def hash_bytes(width: int, height: int, channels: int, data: bytes) -> tuple[str, bytes]:
    """Pure-Python reference: returns (hash, pre-hash message)."""
    if channels == 3:
        rgba = bytearray()
        for i in range(0, len(data), 3):
            rgba += data[i : i + 3] + b"\xff"
    else:
        rgba = bytearray(data)
    for i in range(0, len(rgba), 4):
        if rgba[i + 3] == 0:
            rgba[i : i + 3] = b"\x00\x00\x00"
    message = DOMAIN + struct.pack(">II", width, height) + bytes(rgba)
    return sha256(message), message


def hash_array(np: Any, pixels: Any) -> str:
    """Same rule on an (h, w, 4) uint8 array, for images too large for the byte loop."""
    height, width = pixels.shape[:2]
    normalized = pixels.copy()
    normalized[normalized[:, :, 3] == 0, :3] = 0
    return sha256(DOMAIN + struct.pack(">II", width, height) + np.ascontiguousarray(normalized).tobytes())


def vectors() -> dict[str, Any]:
    def vector(vid: str, description: str, width: int, height: int, channels: int, data: bytes, pin: bool = False) -> dict[str, Any]:
        digest, message = hash_bytes(width, height, channels, data)
        out: dict[str, Any] = {
            "id": vid,
            "description": description,
            "width": width,
            "height": height,
            "channels": channels,
            "data": data.hex(),
            "sha256": digest,
        }
        if pin:
            out["message"] = message.hex()
        return out

    grey258 = bytes([7, 7, 7, 255]) * 258
    six = bytes(range(1, 25))
    items = [
        vector("rgba-1x1", "one opaque red pixel", 1, 1, 4, bytes([255, 0, 0, 255]), pin=True),
        vector("rgb-1x1", "the same pixel as RGB", 1, 1, 3, bytes([255, 0, 0])),
        vector("dims-258x1", "258×1: width 0x00000102 must be big-endian", 258, 1, 4, grey258, pin=True),
        vector("dims-1x258", "the same bytes as 1×258", 1, 258, 4, grey258),
        vector("bytes-2x3", "24 bytes as 2×3", 2, 3, 4, six),
        vector("bytes-3x2", "the same 24 bytes as 3×2", 3, 2, 4, six),
        vector("bytes-1x6", "the same 24 bytes as 1×6", 1, 6, 4, six),
        vector("hidden-a", "RGB (10,20,30) under alpha 0", 1, 1, 4, bytes([10, 20, 30, 0])),
        vector("hidden-b", "RGB (200,100,50) under alpha 0", 1, 1, 4, bytes([200, 100, 50, 0])),
        vector("hidden-zero", "transparent black", 1, 1, 4, bytes([0, 0, 0, 0])),
        vector("alpha1-rgb", "RGB (10,20,30) at alpha 1", 1, 1, 4, bytes([10, 20, 30, 1])),
        vector("alpha1-zero", "black at alpha 1", 1, 1, 4, bytes([0, 0, 0, 1])),
        vector("alpha254", "RGB (10,20,30) at alpha 254", 1, 1, 4, bytes([10, 20, 30, 254])),
        vector("alpha255", "RGB (10,20,30) at alpha 255", 1, 1, 4, bytes([10, 20, 30, 255])),
        vector("rgb-2x2", "a 2×2 RGB image", 2, 2, 3, bytes(range(10, 22))),
        vector(
            "rgba-2x2",
            "the same 2×2 image as RGBA with alpha 255",
            2,
            2,
            4,
            b"".join(bytes(range(10, 22))[i : i + 3] + b"\xff" for i in range(0, 12, 3)),
        ),
    ]
    relations = [
        {"kind": "distinct", "ids": ["dims-258x1", "dims-1x258"], "why": "dimension byte order: 258×1 vs 1×258 (message pinned)"},
        {"kind": "distinct", "ids": ["bytes-2x3", "bytes-3x2", "bytes-1x6"], "why": "same byte count, different dimensions"},
        {"kind": "equal", "ids": ["hidden-a", "hidden-b", "hidden-zero"], "why": "hidden RGB under alpha 0 is ignored"},
        {"kind": "distinct", "ids": ["alpha1-rgb", "alpha1-zero"], "why": "alpha 1 keeps its RGB"},
        {"kind": "distinct", "ids": ["alpha254", "alpha255"], "why": "alpha 254 differs from alpha 255"},
        {"kind": "equal", "ids": ["rgb-1x1", "rgba-1x1"], "why": "RGB vs RGBA: RGB gets alpha 255 (1×1)"},
        {"kind": "equal", "ids": ["rgb-2x2", "rgba-2x2"], "why": "RGB vs RGBA: RGB gets alpha 255 (2×2)"},
    ]
    return {
        "comment": "Recorded by tools/prototype-goldens/record.py (independent Python implementation of 02 §3). Do not edit.",
        "domain": DOMAIN.decode("ascii").replace("\x00", "\\0"),
        "vectors": items,
        "relations": relations,
    }


# --- Prototype runs ---------------------------------------------------------------------------


def trim_analyses(analyses: dict[str, Any]) -> dict[str, Any]:
    return {key: {k: value[k] for k in ANALYSIS_KEYS} for key, value in analyses.items()}


def trim_row(row: dict[str, Any], review_keys: tuple[str, ...]) -> dict[str, Any]:
    out: dict[str, Any] = {"change": row["change"]}
    if "analyses" in row:
        out["analyses"] = trim_analyses(row["analyses"])
    if row.get("review"):
        out["review"] = {k: row["review"][k] for k in review_keys if k in row["review"]}
    return out


def run_compare(report: Any, base: Any, head: Any, images: Path) -> dict[str, Any]:
    """The prototype's own per-view comparison (report._compare) on decoded RGBA arrays."""
    row: dict[str, Any] = {"id": "case", "section": "case"}
    images.mkdir(parents=True, exist_ok=True)
    try:
        report._compare(row, {"base": base, "head": head}, images, set())
    except Exception as exc:  # recorded, not hidden: e.g. numpy broadcast errors on width changes
        return {"error": {"type": type(exc).__name__, "message": str(exc)}}
    return trim_row(row, ("areas", "areaCount", "key"))


def rgba(np: Any, colour: str) -> Any:
    return np.array([int(colour[i : i + 2], 16) for i in range(0, 8, 2)], dtype=np.uint8)


def expand(np: Any, image: dict[str, Any]) -> Any:
    pixels = np.empty((image["height"], image["width"], 4), dtype=np.uint8)
    pixels[:, :] = rgba(np, image["fill"])
    for x, y, w, h, colour in image.get("rects", []):
        pixels[y : y + h, x : x + w] = rgba(np, colour)
    return pixels


def normalize(np: Any, pixels: Any) -> Any:
    out = pixels.copy()
    out[out[:, :, 3] == 0, :3] = 0
    return out


def tiny(np: Any, report: Any, cases_path: Path, work: Path) -> dict[str, Any]:
    images = work / "tiny-img"
    images.mkdir(parents=True, exist_ok=True)
    cases = json.loads(cases_path.read_text(encoding="utf-8"))["cases"]
    recorded: dict[str, Any] = {}
    for case in cases:
        entry: dict[str, Any] = {"sides": {}}
        arrays: dict[str, Any] = {}
        for side in ("base", "head"):
            spec = case[side]
            if spec["state"] != "captured":
                continue
            arrays[side] = expand(np, spec["image"])
            entry["sides"][side] = {
                "width": spec["image"]["width"],
                "height": spec["image"]["height"],
                "pixelHash": hash_array(np, arrays[side]),
            }
        if len(arrays) == 2:
            entry["prototype"] = run_compare(report, arrays["base"], arrays["head"], images)
            normalized = {side: normalize(np, value) for side, value in arrays.items()}
            if any(not np.array_equal(normalized[s], arrays[s]) for s in arrays):
                # comparator-v1 D1: the prototype's comparison applied to alpha-normalized input.
                entry["prototypeOnNormalized"] = run_compare(report, normalized["base"], normalized["head"], images)
        recorded[case["id"]] = entry
    return recorded


def verify_zip(path: Path, expected: str) -> None:
    actual = sha256(path.read_bytes())
    if actual != expected:
        raise SystemExit(f"{path.name}: SHA-256 {actual} does not match ADR 0001 ({expected})")


def extract_inputs(extract: Any, zips: Path, base: Path, head: Path) -> None:
    for name, (_artifact_id, digest) in ARTIFACTS.items():
        archive = zips / f"{name}.zip"
        verify_zip(archive, digest)
        extract(archive, base if "-base-" in name else head)


def pr123(np: Any, modules: dict[str, Any], zips: Path, work: Path) -> tuple[dict[str, Any], Path, Path]:
    report, pngsafe = modules["report"], modules["pngsafe"]
    base, head = work / "base", work / "head"
    extract_inputs(modules["extract"], zips, base, head)
    output = work / "report"
    built = report.build_report(base_dir=base, head_dir=head, output=output, metadata={"expectedHeadSha": HEAD_SHA})
    views = []
    for row in built.rows:
        inputs: dict[str, Any] = {}
        for side, directory in (("base", base), ("head", head)):
            path = directory / f"{row['id']}.png"
            if not path.is_file():
                continue
            data = path.read_bytes()
            decoded = pngsafe.decode_png(data)
            inputs[side] = {
                "fileSha256": sha256(data),
                "width": int(decoded.shape[1]),
                "height": int(decoded.shape[0]),
                "pixelHash": hash_array(np, decoded),
            }
        views.append(
            {
                "id": row["id"],
                "provider": row["provider"],
                "section": row["section"],
                "inputs": inputs,
                "prototype": trim_row(row, ("areas", "areaCount", "key", "sameAs", "sharedWith")),
            }
        )
    local = {name: sha256((output / name).read_bytes()) for name in ("summary.json", "changes.json")}
    recorded = {
        "summary": built.summary,
        "metadata": {"baseSha": built.metadata.get("baseSha"), "headSha": built.metadata.get("headSha")},
        "localOutputSha256": local,
        "views": views,
    }
    return recorded, base, head


def probes(modules: dict[str, Any], base: Path, head: Path, work: Path) -> dict[str, Any]:
    """Mutated copies of the real inputs, one mutation per view, to record the prototype's states."""
    report = modules["report"]
    from PIL import Image

    pb, ph = work / "probe-base", work / "probe-head"
    shutil.copytree(base, pb)
    shutil.copytree(head, ph)
    fixture_ids = [c["id"] for c in json.loads((head / "capture-fixture.json").read_text(encoding="utf-8"))["cases"]]
    stack_ids = [c["id"] for c in json.loads((base / "capture-stack.json").read_text(encoding="utf-8"))["cases"]]
    names = [
        "head-png-deleted",
        "head-status-failed",
        "base-status-failed",
        "head-case-dropped",
        "base-case-dropped",
        "head-png-width-1441",
    ]
    targets = dict(zip(names, fixture_ids, strict=False))

    def edit_manifest(directory: Path, provider: str, change: Any) -> None:
        path = directory / f"capture-{provider}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["cases"] = [c for c in (change(c) for c in data["cases"]) if c is not None]
        path.write_text(json.dumps(data), encoding="utf-8")

    def set_status(view: str, status: str) -> Any:
        return lambda c: {**c, "status": status} if c["id"] == view else c

    def drop(view: str) -> Any:
        return lambda c: None if c["id"] == view else c

    (ph / f"{targets['head-png-deleted']}.png").unlink()
    edit_manifest(ph, "fixture", set_status(targets["head-status-failed"], "failed"))
    edit_manifest(pb, "fixture", set_status(targets["base-status-failed"], "failed"))
    edit_manifest(ph, "fixture", drop(targets["head-case-dropped"]))
    (ph / f"{targets['head-case-dropped']}.png").unlink()
    edit_manifest(pb, "fixture", drop(targets["base-case-dropped"]))
    (pb / f"{targets['base-case-dropped']}.png").unlink()
    wide_path = ph / f"{targets['head-png-width-1441']}.png"
    with Image.open(wide_path) as original:
        original.load()
        wide = Image.new(original.mode, (original.width + 1, original.height), (255,) * len(original.getbands()))
        wide.paste(original, (0, 0))
    buffer = io.BytesIO()
    wide.save(buffer, format="PNG")
    wide_path.write_bytes(buffer.getvalue())
    # A whole base part missing: the stack provider's base manifest and screenshots are gone.
    (pb / "capture-stack.json").unlink()
    for view in stack_ids:
        (pb / f"{view}.png").unlink(missing_ok=True)
    targets["base-part-missing"] = f"all {len(stack_ids)} stack views"

    built = report.build_report(base_dir=pb, head_dir=ph, output=work / "probe-report", metadata={"expectedHeadSha": HEAD_SHA})
    rows = {row["id"]: row for row in built.rows}

    def side(record: Any) -> Any:
        if record is None:
            return None
        return {"status": record["status"], "errors": record["errors"]}

    out = []
    for name, view in targets.items():
        views = [view] if view in rows else [v for v in stack_ids if v in rows]
        for vid in views[:1]:
            row = rows[vid]
            out.append({"probe": name, "view": vid, "change": row["change"], "base": side(row["base"]), "head": side(row["head"])})
    stack_changes = sorted({rows[v]["change"] for v in stack_ids if v in rows})
    return {"summary": built.summary, "probes": out, "basePartMissingChanges": stack_changes}


def extract_tracepilot(zips: Path, artifacts: dict[str, tuple[str, str]], base: Path, head: Path) -> None:
    """Flat, name-checked extraction (TracePilot manifests don't fit PropertyScope's extract())."""
    for name, (_artifact_id, digest) in artifacts.items():
        archive = zips / f"{name}.zip"
        verify_zip(archive, digest)
        target = base if "-base-" in name else head
        target.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                if member.filename.endswith(".failed.png"):
                    continue
                if not TRACEPILOT_MEMBER.fullmatch(member.filename):
                    raise SystemExit(f"{archive.name}: unexpected entry {member.filename[:80]!r}")
                if (target / member.filename).exists():
                    raise SystemExit(f"{archive.name}: {member.filename} appears in two shards")
                (target / member.filename).write_bytes(source.read(member))


def tracepilot_cases(directory: Path) -> tuple[dict[str, dict[str, Any]], set[str]]:
    cases: dict[str, dict[str, Any]] = {}
    shas: set[str] = set()
    for manifest in sorted(directory.glob("capture-*.json")):
        data = json.loads(manifest.read_text(encoding="utf-8"))
        shas.add(data["revisionSha"])
        for case in data["cases"]:
            if case["id"] in cases:
                raise SystemExit(f"{case['id']} appears twice in {directory.name}")
            cases[case["id"]] = {"shard": data["shard"], "status": case["status"], "missingFixtures": case.get("missingFixtures", [])}
    return cases, shas


def tracepilot_run(np: Any, modules: dict[str, Any], run_id: str, zips: Path, tracepilot: Path, work: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """PropertyScope's comparator (report._compare, pngsafe) on every captured TracePilot pair."""
    report, pngsafe = modules["report"], modules["pngsafe"]
    spec = TRACEPILOT_RUNS[run_id]
    base, head = work / f"tp-{run_id}" / "base", work / f"tp-{run_id}" / "head"
    extract_tracepilot(zips, spec["artifacts"], base, head)
    base_cases, base_shas = tracepilot_cases(base)
    head_cases, head_shas = tracepilot_cases(head)
    if head_shas != {spec["headSha"]} or len(base_shas) != 1:
        raise SystemExit(f"run {run_id}: unexpected revision SHAs base={base_shas} head={head_shas}")
    published = json.loads(git(tracepilot, "show", f"origin/gh-pages:visual/runs/{run_id}/changes.json"))
    published_views = {v["id"]: v for v in published["views"]}

    views = []
    for view_id in sorted(set(base_cases) | set(head_cases)):
        entry: dict[str, Any] = {"id": view_id, "states": {}, "inputs": {}}
        arrays: dict[str, Any] = {}
        for side, directory, cases in (("base", base, base_cases), ("head", head, head_cases)):
            case = cases.get(view_id)
            entry["states"][side] = None if case is None else {"shard": case["shard"], "status": case["status"]}
            path = directory / f"{view_id}.png"
            if case is None or case["status"] != "captured" or case["missingFixtures"] or not path.is_file():
                continue
            data = path.read_bytes()
            try:
                decoded = pngsafe.decode_png(data)
            except ValueError as exc:
                entry["inputs"][side] = {"fileSha256": sha256(data), "rejected": str(exc)}
                continue
            arrays[side] = decoded
            entry["inputs"][side] = {
                "fileSha256": sha256(data),
                "width": int(decoded.shape[1]),
                "height": int(decoded.shape[0]),
                "pixelHash": hash_array(np, decoded),
            }
        if len(arrays) == 2:
            entry["prototype"] = run_compare(report, arrays["base"], arrays["head"], work / "tp-img")
        mine = published_views.get(view_id)
        entry["tracepilotPublished"] = None if mine is None else {"change": mine.get("change"), "changedPixels": mine.get("changedPixels")}
        views.append(entry)

    compared = [v for v in views if "prototype" in v]
    agree = [
        v
        for v in compared
        if v["tracepilotPublished"] is not None
        and v["tracepilotPublished"]["change"] == v["prototype"]["change"]
        and v["tracepilotPublished"]["changedPixels"] == v["prototype"]["analyses"]["0"]["changed"]
    ]
    summary: dict[str, int] = {}
    for v in compared:
        summary[v["prototype"]["change"]] = summary.get(v["prototype"]["change"], 0) + 1
    recorded = {
        "source": {
            "repository": "https://github.com/MattShelton04/TracePilot",
            "run": run_id,
            "attempt": spec["attempt"],
            "event": spec["event"],
            "baseSha": next(iter(base_shas)),
            "headSha": spec["headSha"],
            "artifacts": [{"name": n, "id": aid, "zipSha256": d} for n, (aid, d) in spec["artifacts"].items()],
            "publishedResult": f"gh-pages visual/runs/{run_id}/changes.json at {git(tracepilot, 'rev-parse', 'origin/gh-pages')}",
        },
        "summary": {"compared": len(compared), "notCompared": len(views) - len(compared), **dict(sorted(summary.items()))},
        "crossCheck": {"compared": len(compared), "agreeWithTracePilotPublished": len(agree)},
        "views": views,
    }
    return recorded, [
        {"source": f"tracepilot-{run_id}", "view": v, "base": base / f"{v['id']}.png", "head": head / f"{v['id']}.png"}
        for v in compared
    ]


def crops(np: Any, modules: dict[str, Any], candidates: list[dict[str, Any]], out_dir: Path, work: Path) -> dict[str, Any]:
    """A 1440-wide band around the largest t0 region of a few changed/subtle views, same rect on both sides."""
    report, pngsafe = modules["report"], modules["pngsafe"]
    from PIL import Image

    usable = [
        c
        for c in candidates
        if c["view"]["prototype"].get("change") in ("changed", "subtle")
        and c["view"]["inputs"]["base"]["height"] == c["view"]["inputs"]["head"]["height"]
        and c["view"]["prototype"]["analyses"]["0"]["regions"]
    ]
    key = lambda c: (-c["view"]["prototype"]["analyses"]["0"]["regions"][0]["pixels"], c["source"], c["view"]["id"])  # noqa: E731
    subtle = sorted((c for c in usable if c["view"]["prototype"]["change"] == "subtle"), key=key)[:1]
    changed = sorted((c for c in usable if c["view"]["prototype"]["change"] == "changed"), key=key)
    by_source: list[dict[str, Any]] = []
    for c in changed:  # the largest change from each run first, for variety
        if all(p["source"] != c["source"] for p in by_source):
            by_source.append(c)
    chosen = (subtle + by_source + [c for c in changed if c not in by_source])[:MAX_CROPS]

    crop_dir = out_dir / "crops"
    if crop_dir.exists():
        shutil.rmtree(crop_dir)
    crop_dir.mkdir(parents=True)
    recorded = []
    for c in chosen:
        view = c["view"]
        region = view["prototype"]["analyses"]["0"]["regions"][0]
        height = view["inputs"]["base"]["height"]
        band = min(CROP_BAND, height)
        y = max(0, min(region["y"] - 32, height - band))
        entry: dict[str, Any] = {
            "id": f"{c['source'].split('-')[-1]}-{view['id']}",
            "source": c["source"],
            "view": view["id"],
            "rect": {"x": 0, "y": y, "width": 1440, "height": band},
            "sides": {},
        }
        arrays = {}
        for side in ("base", "head"):
            decoded = pngsafe.decode_png(c[side].read_bytes())
            crop = np.ascontiguousarray(decoded[y : y + band, :, :])
            if not (crop[:, :, 3] == 255).all():
                raise SystemExit(f"{view['id']}: crop has non-opaque pixels; can't store it as RGB")
            buffer = io.BytesIO()
            Image.fromarray(np.ascontiguousarray(crop[:, :, :3])).save(buffer, format="PNG", compress_level=9)
            name = f"{entry['id']}-{side}.png"
            (crop_dir / name).write_bytes(buffer.getvalue())
            arrays[side] = crop
            entry["sides"][side] = {
                "file": f"crops/{name}",
                "fileSha256": sha256(buffer.getvalue()),
                "sourceFileSha256": view["inputs"][side]["fileSha256"],
                "width": 1440,
                "height": band,
                "pixelHash": hash_array(np, crop),
            }
        entry["prototype"] = run_compare(report, arrays["base"], arrays["head"], work / "crop-img")
        recorded.append(entry)
    return {"crops": recorded}


# --- Main ------------------------------------------------------------------------------------


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    parser.add_argument("--prototype", type=Path, required=True, help="PropertyScope checkout at the pinned commit")
    parser.add_argument("--tracepilot", type=Path, required=True, help="TracePilot clone (for its published gh-pages results)")
    parser.add_argument("--artifacts", type=Path, required=True, help=".reference/artifacts")
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="the PixelWatch testdata/ directory")
    args = parser.parse_args()
    prototype = args.prototype.resolve()

    commit = git(prototype, "rev-parse", "HEAD")
    if commit != PIN:
        raise SystemExit(f"prototype is at {commit}, expected {PIN} (ADR 0001)")
    if git(prototype, "status", "--porcelain"):
        raise SystemExit("prototype checkout has local changes; refusing to record")

    sys.path.insert(0, str(prototype))
    import numpy as np
    import PIL
    from scripts.visual import pixels, pngsafe, report
    from scripts.visual.extract import extract

    modules = {"report": report, "pngsafe": pngsafe, "extract": extract}
    work = args.work.resolve()
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    out = args.out.resolve()
    artifacts = args.artifacts.resolve()

    uv = subprocess.run(["uv", "--version"], check=False, capture_output=True, text=True).stdout.strip()
    recorded_with = {
        "prototype": {"repository": "https://github.com/MattShelton04/41026ASDProject", "commit": commit},
        "constants": {
            "THRESHOLDS": list(pixels.THRESHOLDS),
            "SUBTLE_MAX_PIXELS": pixels.SUBTLE_MAX_PIXELS,
            "SUBTLE_MAX_DELTA": pixels.SUBTLE_MAX_DELTA,
            "TILE": pixels.TILE,
            "MAX_REGIONS": pixels.MAX_REGIONS,
        },
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pillow": PIL.__version__,
            "uv": uv,
        },
    }
    comparator = out / "comparator"

    write_json(out / "pixel-hash" / "vectors.json", vectors())

    write_json(
        comparator / "tiny" / "prototype.json",
        {
            "comment": "Recorded by tools/prototype-goldens/record.py from the prototype's report._compare. Do not edit.",
            "recordedWith": recorded_with,
            "cases": tiny(np, report, comparator / "tiny" / "cases.json", work),
        },
    )

    pr_dir = comparator / "propertyscope-pr123"
    recorded, base, head = pr123(np, modules, artifacts / "ps-36405830015-zips", work)
    source = {
        "repository": "https://github.com/MattShelton04/41026ASDProject",
        "run": RUN_ID,
        "attempt": "1",
        "baseSha": BASE_SHA,
        "headSha": HEAD_SHA,
        "artifacts": [{"name": name, "id": aid, "zipSha256": digest} for name, (aid, digest) in ARTIFACTS.items()],
    }
    write_json(
        pr_dir / "prototype.json",
        {
            "comment": "Recorded by tools/prototype-goldens/record.py from the prototype's build_report. Do not edit.",
            "recordedWith": recorded_with,
            "source": source,
            **recorded,
        },
    )
    write_json(
        pr_dir / "state-probes.json",
        {
            "comment": "Recorded by tools/prototype-goldens/record.py: build_report on mutated copies of the PR #123 inputs. Do not edit.",
            "recordedWith": recorded_with,
            "source": source,
            **probes(modules, base, head, work),
        },
    )

    candidates: list[dict[str, Any]] = []
    for run_id in TRACEPILOT_RUNS:
        tp, tp_candidates = tracepilot_run(np, modules, run_id, artifacts / f"tp-{run_id}-zips", args.tracepilot.resolve(), work)
        candidates += tp_candidates
        write_json(
            comparator / f"tracepilot-{run_id}" / "prototype.json",
            {
                "comment": "Recorded by tools/prototype-goldens/record.py: PropertyScope's report._compare on TracePilot captures. Do not edit.",
                "recordedWith": recorded_with,
                **tp,
            },
        )
        print(f"TracePilot {run_id}: {tp['summary']} cross-check {tp['crossCheck']}")

    write_json(
        comparator / "crops" / "crops.json",
        {
            "comment": "Recorded by tools/prototype-goldens/record.py: report._compare on real crops. Do not edit.",
            "recordedWith": recorded_with,
            **crops(np, modules, candidates, comparator / "crops", work),
        },
    )
    print(f"recorded with {recorded_with['environment']}")
    print(f"PR #123 summary: {recorded['summary']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
