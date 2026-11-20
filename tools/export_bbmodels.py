#!/usr/bin/env python3
"""Export Blockbench .bbmodel files (Bedrock format) from models/ into the resource pack.

Writes, per model:
  RP/models/entity/<slug>.geo.json
  RP/animations/<slug>.animation.json   (only if the model has animations)
  RP/textures/entity/<slug>.png
Loose .particle.json / animation controller / animation json files in models/ are copied
to the matching RP folder. Duplicate models (same geometry id) are skipped and reported.
Usage: python3 tools/export_bbmodels.py
"""
import base64, hashlib, json, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "models"
RP = ROOT / "RP"
NS = "aot"


def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def bname(n):
    if " " not in n.strip():
        return n.strip()
    parts = n.split()
    return parts[0].lower() + "".join(w.capitalize() for w in parts[1:])


def num(v):
    return round(float(v), 5)


def neg(v):
    try:
        return -float(v) if float(v) != 0 else 0
    except (TypeError, ValueError):
        s = str(v).strip()
        return s if s == "" else f"-({s})"


def val(v):
    try:
        return num(v)
    except (TypeError, ValueError):
        return str(v)


def build_geo(d, ident):
    elements = {e["uuid"]: e for e in d["elements"]}
    bones, order = [], []
    res = d.get("resolution", {"width": 64, "height": 64})

    def cube_json(e, bone_pivot):
        o, t = e["from"], e["to"]
        infl = e.get("inflate", 0) or 0
        c = {
            "origin": [num(-t[0] - infl), num(o[1] - infl), num(o[2] - infl)],
            "size": [num(t[0] - o[0]), num(t[1] - o[1]), num(t[2] - o[2])],
        }
        if infl:
            c["inflate"] = num(infl)
        rot = e.get("rotation")
        if rot and any(rot):
            c["pivot"] = [num(-e["origin"][0]), num(e["origin"][1]), num(e["origin"][2])]
            c["rotation"] = [num(-rot[0]), num(-rot[1]), num(rot[2])]
        if e.get("box_uv", True):
            c["uv"] = [num(x) for x in e.get("uv_offset", [0, 0])]
            if e.get("mirror_uv"):
                c["mirror"] = True
        else:
            uv = {}
            for face, f in e.get("faces", {}).items():
                if f.get("texture") is None:
                    continue
                u = f["uv"]
                uv[face] = {
                    "uv": [num(u[0]), num(u[1])],
                    "uv_size": [num(u[2] - u[0]), num(u[3] - u[1])],
                }
            c["uv"] = uv
        return c

    def walk(nodes, parent):
        cubes = []
        for n in nodes:
            if isinstance(n, str):
                if n in elements:
                    cubes.append(cube_json(elements[n], None))
            else:
                name = bname(n["name"])
                bone = {"name": name, "pivot": [num(-n["origin"][0]), num(n["origin"][1]), num(n["origin"][2])]}
                if parent:
                    bone["parent"] = parent
                rot = n.get("rotation")
                if rot and any(rot):
                    bone["rotation"] = [num(-rot[0]), num(-rot[1]), num(rot[2])]
                bones.append(bone)
                idx = len(bones) - 1
                sub = walk(n.get("children", []), name)
                if sub:
                    bones[idx]["cubes"] = sub
        return cubes

    loose = walk(d["outliner"], None)
    if loose:
        bones.insert(0, {"name": "root_loose", "pivot": [0, 0, 0], "cubes": loose})
    return {
        "format_version": "1.12.0",
        "minecraft:geometry": [{
            "description": {
                "identifier": ident,
                "texture_width": res["width"],
                "texture_height": res["height"],
                "visible_bounds_width": 4,
                "visible_bounds_height": 4,
                "visible_bounds_offset": [0, 1, 0],
            },
            "bones": bones,
        }],
    }


def group_names(d):
    out = {}

    def walk(nodes):
        for n in nodes:
            if isinstance(n, dict):
                out[n["uuid"]] = bname(n["name"])
                walk(n.get("children", []))
    walk(d["outliner"])
    return out


def anim_id(model_slug, name, used, suffix=""):
    tail = slug(name.split(".")[-1]) or "anim"
    base = f"animation.{NS}.{model_slug}.{tail}{suffix}"
    out, i = base, 2
    while out in used:
        out, i = f"{base}_{i}", i + 1
    used.add(out)
    return out


def build_anims(d, model_slug):
    names = group_names(d)
    anims = {}
    used = set()
    for a in d.get("animations", []):
        entry = {"loop": {"loop": True, "hold": "hold_on_last_frame", "once": False}.get(a.get("loop"), False) if a.get("loop") == "loop" else (
            "hold_on_last_frame" if a.get("loop") == "hold" else False)}
        if a.get("length"):
            entry["animation_length"] = num(a["length"])
        bones = {}
        for uid, an in a.get("animators", {}).items():
            if an.get("type") != "bone":
                continue
            bname = names.get(uid, an.get("name"))
            chans = {}
            for kf in an.get("keyframes", []):
                ch = kf["channel"]
                if ch not in ("rotation", "position", "scale"):
                    continue
                dp = kf["data_points"][0]
                x, y, z = dp.get("x", 0), dp.get("y", 0), dp.get("z", 0)
                if ch == "rotation":
                    arr = [neg(x), neg(y), val(z)]
                elif ch == "position":
                    arr = [neg(x), val(y), val(z)]
                else:
                    arr = [val(x), val(y), val(z)]
                if kf.get("interpolation") in ("catmullrom",):
                    arr = {"post": arr, "lerp_mode": "catmullrom"}
                chans.setdefault(ch, {})[f"{round(float(kf['time']), 5)}"] = arr
            if chans:
                bones[bname] = {c: dict(sorted(v.items(), key=lambda kv: float(kv[0]))) for c, v in chans.items()}
        if bones:
            entry["bones"] = bones
        anims[anim_id(model_slug, a["name"], used)] = entry
    return {"format_version": "1.8.0", "animations": anims}


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1))


IMAGE_RULES = {
    # file stem in models/ -> (destination under RP/, remove black background?)
    "ray2": ("textures/particle/ray2.png", False),
    "titan_shifter_serum": ("textures/entity/titan_shifter_serum.png", True),
}


def black_to_transparent(im, thresh=28):
    """Flood-fill near-black pixels connected to the border into transparency."""
    w, h = im.size
    px = im.load()
    seen = [[False] * h for _ in range(w)]
    stack = [(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)]
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or seen[x][y]:
            continue
        r, g, b, a = px[x, y]
        if max(r, g, b) > thresh:
            continue
        seen[x][y] = True
        px[x, y] = (0, 0, 0, 0)
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return im


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def export_assets(report):
    """Sounds (mp3/m4a/wav -> mono ogg) and pack icon (-> 256x256 png). Re-encodes only when the
    source file changed (hash stamps), so the CI diff check stays stable."""
    stamp_file = RP / "sounds" / ".source_hashes.json"
    stamps = json.loads(stamp_file.read_text()) if stamp_file.exists() else {}
    defs = {}
    for f in sorted(SRC.glob("*")):
        if f.suffix.lower() not in (".mp3", ".m4a", ".wav", ".ogg"):
            continue
        s = slug(f.stem)
        out = RP / "sounds" / NS / f"{s}.ogg"
        h = sha(f)
        if stamps.get(s) != h or not out.exists():
            if not shutil.which("ffmpeg"):
                report.append(f"NO FFMPEG: cannot convert {f.name}")
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(f), "-ac", "1", "-c:a", "libvorbis", "-q:a", "4", str(out)])
            if r.returncode:
                report.append(f"FAILED to convert {f.name}")
                continue
            stamps[s] = h
        defs[f"{NS}.{s}"] = {"category": "neutral", "max_distance": 64, "sounds": [{"name": f"sounds/{NS}/{s}", "volume": 1.0}]}
        report.append(f"SOUND {f.name} -> sounds/{NS}/{s}.ogg (event {NS}.{s})")
    if defs:
        write(RP / "sound_definitions.json", {"format_version": "1.14.0", "sound_definitions": defs})
        stamp_file.parent.mkdir(parents=True, exist_ok=True)
        stamp_file.write_text(json.dumps(stamps, indent=1, sort_keys=True))
    for img in sorted(list(SRC.glob("*.jpg")) + list(SRC.glob("*.png"))):
        rule = IMAGE_RULES.get(img.stem)
        if not rule:
            continue
        dest, clear_bg = RP / rule[0], rule[1]
        key = "img_" + img.stem
        h = sha(img)
        if stamps.get(key) != h or not dest.exists():
            from PIL import Image
            im = Image.open(img).convert("RGBA")
            if clear_bg:
                im = black_to_transparent(im)
            dest.parent.mkdir(parents=True, exist_ok=True)
            im.save(dest)
            stamps[key] = h
            stamp_file.parent.mkdir(parents=True, exist_ok=True)
            stamp_file.write_text(json.dumps(stamps, indent=1, sort_keys=True))
        report.append(f"IMAGE {img.name} -> RP/{rule[0]}" + (" (black background removed)" if clear_bg else ""))
    for ic in sorted(SRC.glob("pack_icon.*")):
        out = RP / "pack_icon.png"
        h = sha(ic)
        if stamps.get("pack_icon") != h or not out.exists():
            from PIL import Image
            im = Image.open(ic).convert("RGB")
            w, h2 = im.size
            m = min(w, h2)
            im = im.crop(((w - m) // 2, (h2 - m) // 2, (w - m) // 2 + m, (h2 - m) // 2 + m)).resize((256, 256), Image.LANCZOS)
            out.parent.mkdir(parents=True, exist_ok=True)
            im.save(out)
            stamps["pack_icon"] = h
            stamp_file.parent.mkdir(parents=True, exist_ok=True)
            stamp_file.write_text(json.dumps(stamps, indent=1, sort_keys=True))
        (ROOT / "BP").mkdir(exist_ok=True)
        shutil.copyfile(out, ROOT / "BP" / "pack_icon.png")
        report.append(f"ICON {ic.name} -> RP/pack_icon.png, BP/pack_icon.png (256x256)")
        break


TITAN_SCALE = 11.0   # player scale in Warhammer form: eye height 1.62 * 11 ~= 17.9 blocks = Warhammer eye line at 2x model size
TITAN_RENDER = 2.0 / TITAN_SCALE  # model render scale so the final titan is 2x the model (entity scale multiplies it)


def patch_player(report):
    """Take the vanilla player.entity.json pushed to models/ and add the Warhammer titan form."""
    src = SRC / "player.entity.json"
    if not src.exists():
        report.append("NO models/player.entity.json: titan form skipped")
        return
    j = json.loads(src.read_text())
    d = j["minecraft:client_entity"]["description"]
    d["geometry"]["titan"] = "geometry.aot.war_hammer_titan"
    d["textures"]["titan"] = "textures/entity/war_hammer_titan"
    for k in ("idle", "walk", "attack1", "spawn", "eject"):
        d["animations"][f"aot_wh_{k}"] = f"animation.aot.war_hammer_titan.{k}"
    d["animations"]["aot_titan_ctrl"] = "controller.animation.aot.player_titan"
    d["scripts"]["scale"] = f"q.property('aot:form') == 1 ? {TITAN_RENDER:.4f} : 0.9375"
    init = d["scripts"].setdefault("initialize", [])
    if not any("melee_spear_equipped" in x for x in init):
        init.append("variable.melee_spear_equipped = 0.0;")  # game-side animations expect it; the sample file predates it
    d["scripts"].setdefault("animate", []).append({"aot_titan_ctrl": "q.property('aot:form') == 1"})
    rcs = []
    for rc in d["render_controllers"]:
        if isinstance(rc, dict):
            rcs.append({k: f"({v}) && q.property('aot:form') == 0" for k, v in rc.items()})
        else:
            rcs.append({rc: "q.property('aot:form') == 0"})
    rcs.append({"controller.render.aot.player_titan": "!variable.is_first_person && q.property('aot:form') == 1"})
    d["render_controllers"] = rcs
    write(RP / "entity" / "player.entity.json", j)
    report.append("PLAYER player.entity.json patched with Warhammer titan form")


def main():
    seen = {}
    report = []
    for f in sorted(SRC.glob("*.bbmodel")):
        d = json.loads(f.read_text())
        if d.get("meta", {}).get("model_format") not in ("bedrock", "bedrock_old"):
            report.append(f"SKIP {f.name}: format {d.get('meta', {}).get('model_format')}")
            continue
        gid = d.get("geometry_name") or d.get("model_identifier") or f.stem
        s = slug(gid)
        if s in seen:
            report.append(f"DUPLICATE {f.name} has same model id as {seen[s]} - skipped (identify which to keep)")
            continue
        seen[s] = f.name
        write(RP / "models/entity" / f"{s}.geo.json", build_geo(d, f"geometry.{NS}.{s}"))
        if d.get("animations"):
            write(RP / "animations" / f"{s}.animation.json", build_anims(d, s))
        tex = d.get("textures", [])
        if tex and tex[0].get("source", "").startswith("data:image/png;base64,"):
            p = RP / "textures/entity" / f"{s}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(base64.b64decode(tex[0]["source"].split(",", 1)[1]))
        else:
            report.append(f"NO TEXTURE embedded in {f.name}")
        report.append(f"OK {f.name} -> geometry.{NS}.{s}, {len(d.get('animations', []))} anims")
    for f in sorted(SRC.glob("*.json")):
        j = json.loads(f.read_text())
        if "particle_effect" in j:
            dest = RP / "particles" / f.name
        elif "animation_controllers" in j:
            report.append(f"NOT EXPORTED {f.name}: placeholder controller (empty animation refs), needs rewriting")
            continue
        elif "animations" in j:
            ms = slug(re.sub(r"\.animation.*$", "", f.stem))
            used = set()
            j["animations"] = {anim_id(ms, k, used, "_alt"): v for k, v in j["animations"].items()}
            dest = RP / "animations" / f"{ms}_alt.animation.json"
        else:
            report.append(f"UNKNOWN json {f.name}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(j, indent=1))
        report.append(f"COPY {f.name} -> {dest.relative_to(ROOT)}")
    export_assets(report)
    patch_player(report)
    print("\n".join(report))


if __name__ == "__main__":
    sys.exit(main())
