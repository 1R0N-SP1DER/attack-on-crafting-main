#!/usr/bin/env python3
"""Validate the add-on packs. Exits non-zero on errors (warnings never fail the build)."""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors, warnings = [], []


def load(p):
    try:
        return json.loads(p.read_text())
    except Exception as e:
        errors.append(f"{p.relative_to(ROOT)}: invalid JSON ({e})")


for pack in ("RP", "BP"):
    m = load(ROOT / pack / "manifest.json") if (ROOT / pack / "manifest.json").exists() else None
    if m is None:
        errors.append(f"{pack}/manifest.json missing")
    else:
        for k in ("format_version", "header", "modules"):
            if k not in m:
                errors.append(f"{pack}/manifest.json missing '{k}'")

for p in sorted(ROOT.glob("RP/**/*.json")) + sorted(ROOT.glob("BP/**/*.json")):
    if load(p) is None:
        continue

geo_ids = {}
for p in ROOT.glob("RP/models/**/*.geo.json"):
    j = load(p)
    if not j:
        continue
    for g in j.get("minecraft:geometry", []):
        gid = g.get("description", {}).get("identifier")
        if not gid:
            errors.append(f"{p.name}: geometry without identifier")
        elif gid in geo_ids:
            errors.append(f"duplicate geometry id {gid} ({p.name}, {geo_ids[gid]})")
        else:
            geo_ids[gid] = p.name
        names = [b["name"] for b in g.get("bones", [])]
        if len(set(names)) != len(names):
            warnings.append(f"{p.name}: duplicate bone names")
        for b in g.get("bones", []):
            if "parent" in b and b["parent"] not in names:
                errors.append(f"{p.name}: bone '{b['name']}' has missing parent '{b['parent']}'")

anim_ids = {}
for p in ROOT.glob("RP/animations/**/*.json"):
    j = load(p)
    if not j:
        continue
    for k in j.get("animations", {}):
        if k in anim_ids:
            errors.append(f"duplicate animation id '{k}' ({p.name}, {anim_ids[k]})")
        else:
            anim_ids[k] = p.name
        if k != k.strip() or " " in k:
            warnings.append(f"animation id '{k}' ({p.name}) contains spaces; rename before using in entity files")

for p in ROOT.glob("RP/particles/*.json"):
    j = load(p)
    if j and "particle_effect" not in j:
        errors.append(f"{p.name}: no particle_effect")

# ---- cross references: entities, controllers, sounds, particles, scripts
import re
part_ids = set()
for p in ROOT.glob("RP/particles/*.json"):
    j = load(p)
    if j:
        part_ids.add(j["particle_effect"]["description"]["identifier"])
snd = (load(ROOT / "RP/sound_definitions.json") or {}).get("sound_definitions", {}) if (ROOT / "RP/sound_definitions.json").exists() else {}
ctrl_ids = set()
for p in ROOT.glob("RP/animation_controllers/*.json"):
    j = load(p)
    if j:
        ctrl_ids |= set(j.get("animation_controllers", {}))
bp_ids = set()
for p in ROOT.glob("BP/entities/*.json"):
    j = load(p)
    if j:
        bp_ids.add(j["minecraft:entity"]["description"]["identifier"])
for p in ROOT.glob("RP/entity/*.entity.json"):
    j = load(p)
    if not j:
        continue
    d = j["minecraft:client_entity"]["description"]
    if d["identifier"] not in bp_ids:
        errors.append(f"{p.name}: no behavior entity with id {d['identifier']}")
    for g in d.get("geometry", {}).values():
        if g not in geo_ids:
            errors.append(f"{p.name}: geometry {g} not found")
    for t in d.get("textures", {}).values():
        if not (ROOT / "RP" / (t + ".png")).exists():
            errors.append(f"{p.name}: texture {t}.png not found")
    for k, a in d.get("animations", {}).items():
        if a not in anim_ids and a not in ctrl_ids:
            errors.append(f"{p.name}: animation '{k}' -> {a} not found")
for p in ROOT.glob("BP/scripts/**/*.js"):
    txt = p.read_text()
    for sid in re.findall(r'"(aot\.[a-z0-9_]+)"', txt):
        if sid not in snd:
            errors.append(f"{p.name}: sound event {sid} not in sound_definitions.json")
    for pid in re.findall(r'"((?:stk:[a-z0-9_]+)|(?:aot:debug_point))"', txt):
        if pid not in part_ids:
            errors.append(f"{p.name}: particle {pid} not found in RP/particles")
bpm = load(ROOT / "BP/manifest.json") or {}
for m in bpm.get("modules", []):
    if m.get("type") == "script" and not (ROOT / "BP" / m["entry"]).exists():
        errors.append(f"BP script entry {m['entry']} missing")

for w in warnings:
    print("WARN ", w)
for e in errors:
    print("ERROR", e)
print(f"{len(geo_ids)} geometries, {len(anim_ids)} animations, {len(errors)} errors, {len(warnings)} warnings")
sys.exit(1 if errors else 0)
