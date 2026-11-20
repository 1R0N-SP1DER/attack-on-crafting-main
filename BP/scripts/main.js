// Attack on Crafting - behavior scripts. Entity logic that JSON alone can't do.
import { world, system, EntityDamageCause } from "@minecraft/server";
import * as MC from "@minecraft/server";

const T = 20; // ticks per second
const DIMS = ["overworld", "nether", "the_end"];
const WARHAMMER = "aot:war_hammer_titan";
const ATTACK = "aot:attack_titan";
const LARA = "aot:lara_tybur";
const EREN = "aot:eren_yeager";

// aot:state property drives client animations. Titans: 0 normal, 1 attack1, 2 attack2, 3 spawn.
// Lara: 0 normal, 1 shifting, 2 death. Eren: 0 normal, 1 punch.

const TITANS = {
  [WARHAMMER]: {
    spawnSeconds: 7.5, spawnFx: ["stk:t_trans4", "stk:t_trans"], spawnSound: "aot.titan_shift", lightning: false,
    cooldownSeconds: 4, sightRange: 10, strikeRange: 12, flyingDelta: 4, height: 20, radius: 3,
    weakPoints: true, hardened: true, // hardened skin: body hits mostly bounce off, weak points take full damage
    attacks: {
      // hammer slam: 500 damage in a 5x5 area where the hammer hits the ground
      slam: { state: 1, seconds: 3.4375, impactAt: 1.875, damage: 500, forward: 9, halfX: 2.5, halfZ: 2.5, below: 2, above: 4, sound: "aot.heavy_warhammer_attack", fx: "stk:t_trans4", shake: true },
      // swing: used when the target is above/flying around the titan. Damage/timing are placeholders to tune.
      swing: { state: 2, seconds: 3.21429, impactAt: 1.4, damage: 250, forward: 6, halfX: 7, halfZ: 7, below: 4, above: 16, sound: null, fx: null, shake: false },
    },
  },
  [ATTACK]: {
    spawnSeconds: 9.2, spawnFx: ["stk:t_trans4", "stk:t_trans"], spawnSound: "aot.titan_shift", lightning: false, // lightning set the titan on fire, so it stays off
    cooldownSeconds: 2, sightRange: 12, strikeRange: 6, flyingDelta: 99, height: 11.5, radius: 1.75,
    weakPoints: true,
    attacks: {
      // placeholder punch values to tune (no spec yet)
      slam: { state: 1, seconds: 1.0, impactAt: 0.5, damage: 30, forward: 4, halfX: 2.5, halfZ: 2.5, below: 2, above: 6, sound: null, fx: "stk:t_trans4", shake: false },
    },
  },
};

// Weak points (Attack Titan). Hit position is estimated by casting the attacker's view ray at the titan's body.
const WEAK = {
  napeKillDamage: 20,        // a single hit of at least this much on the nape kills the titan
  napeBand: [0.78, 0.97],    // nape height as a fraction of titan height (back of the neck)
  eyeBand: [0.80, 0.97],     // eyes: front of the head
  heelMax: 0.14,             // heels: lowest part of the legs, back/side
  stunSeconds: 5,            // eyes hit: stun duration
  slowSeconds: 10,           // one heel cut: slowed
  kneelSeconds: 20,          // both heels cut: kneels (frozen)
  healPerSecond: 50,         // titans heal quickly so nothing but a nape hit kills
  hardenedBounce: 0.9,       // hardened titans (Warhammer): this share of body-hit damage is healed back
  hardenedNapeBonus: 2,      // hardened titans: nape hits do this many times damage
};

// Debug: draws the weak-point zones as bright red dots around titans that have them.
// Toggle in game with:  /scriptevent aot:debug on   or   /scriptevent aot:debug off
let DEBUG_ZONES = true;
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "aot:debug") return;
  DEBUG_ZONES = ev.message.trim().toLowerCase() !== "off";
  safe(() => world.sendMessage(`[AoT] weak point debug ${DEBUG_ZONES ? "ON" : "OFF"}`));
});

function drawZones() {
  if (!DEBUG_ZONES) return;
  for (const dn of DIMS) {
    for (const t of safe(() => dimOf(dn).getEntities({ families: ["aot_titan"] })) ?? []) {
      const cfg = TITANS[t.typeId];
      if (!cfg?.weakPoints) continue;
      const c = t.location, r = cfg.radius + 0.6;
      const yaw = (t.getRotation().y * Math.PI) / 180;
      const fwd = { x: -Math.sin(yaw), z: Math.cos(yaw) }, rgt = { x: -fwd.z, z: fwd.x };
      const dot = (deg, f) => {
        const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
        safe(() => t.dimension.spawnParticle("aot:debug_point", { x: c.x + (fwd.x * ca + rgt.x * sa) * r, y: c.y + f * cfg.height, z: c.z + (fwd.z * ca + rgt.z * sa) * r }));
      };
      const band = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
      for (const f of band(WEAK.napeBand[0], WEAK.napeBand[1], 4)) for (const d of band(110, 250, 8)) dot(d, f);   // nape: back
      for (const f of band(WEAK.eyeBand[0], WEAK.eyeBand[1], 4)) for (const d of band(-70, 70, 8)) dot(d, f);     // eyes: front
      for (const f of band(0.02, WEAK.heelMax, 3)) for (const d of [70, 100, 130, 160, 200, 230, 260, 290]) dot(d, f); // heels: back/sides
    }
  }
}
system.runInterval(drawZones, 4);

const busyUntil = new Map();   // titan id -> tick it may act again
const legInjury = new Map();   // titan id -> { left: tick, right: tick }
const lastSeen = new Map();    // Lara/Eren id -> { dim, location, yaw }

const dimOf = (name) => world.getDimension(name);
const secs = (s) => Math.ceil(s * T);
function setState(e, v) { try { e.setProperty("aot:state", v); } catch (err) { console.warn(`setProperty failed: ${err}`); } }
function freeze(e, ticks) { try { e.addEffect("slowness", ticks, { amplifier: 250, showParticles: false }); } catch { /* ignore */ } }
function fam(e, f) { try { return e.getComponent("minecraft:type_family")?.hasTypeFamily(f) ?? false; } catch { return false; } }
function isHostileTarget(e) { return e.typeId === "minecraft:player" || (fam(e, "monster") && !fam(e, "aot_titan")); }
function safe(fn) { try { return fn(); } catch { return undefined; } }

function fx(dim, loc, particles, sound, lightning) {
  for (const p of particles ?? []) safe(() => dim.spawnParticle(p, loc));
  if (sound) safe(() => dim.playSound(sound, loc));
  if (lightning) safe(() => dim.runCommand(`summon lightning_bolt ${loc.x} ${loc.y} ${loc.z}`));
}

function nearestTarget(titan, range) {
  let best = null, bestD = Infinity;
  for (const e of titan.dimension.getEntities({ location: titan.location, maxDistance: range })) {
    if (e.id === titan.id || !isHostileTarget(e)) continue;
    const d = Math.hypot(e.location.x - titan.location.x, e.location.z - titan.location.z);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function faceToward(ent, target) {
  const yaw = (Math.atan2(-(target.location.x - ent.location.x), target.location.z - ent.location.z) * 180) / Math.PI;
  safe(() => ent.setRotation({ x: 0, y: yaw }));
  return yaw;
}

function doImpact(titan, yaw, a) {
  if (!titan.isValid) return;
  const rad = (yaw * Math.PI) / 180;
  const p = { x: titan.location.x - Math.sin(rad) * a.forward, y: titan.location.y, z: titan.location.z + Math.cos(rad) * a.forward };
  const dim = titan.dimension;
  for (const e of dim.getEntities({ location: p, maxDistance: Math.hypot(a.halfX, a.halfZ) + a.above + 2 })) {
    if (e.id === titan.id || !isHostileTarget(e)) continue;
    const dy = e.location.y - p.y;
    if (Math.abs(e.location.x - p.x) <= a.halfX && Math.abs(e.location.z - p.z) <= a.halfZ && dy >= -a.below && dy <= a.above) {
      safe(() => e.applyDamage(a.damage, { cause: EntityDamageCause.entityAttack, damagingEntity: titan }));
    }
  }
  if (a.fx) safe(() => dim.spawnParticle(a.fx, p));
  if (a.shake) safe(() => dim.runCommand(`camerashake add @a[x=${p.x},y=${p.y},z=${p.z},r=40] 0.6 0.6 positional`));
}

function startAttack(titan, cfg, a, target) {
  const yaw = faceToward(titan, target);
  busyUntil.set(titan.id, system.currentTick + secs(a.seconds) + secs(cfg.cooldownSeconds));
  setState(titan, a.state);
  freeze(titan, secs(a.seconds));
  if (a.sound) safe(() => titan.dimension.playSound(a.sound, titan.location));
  system.runTimeout(() => doImpact(titan, yaw, a), secs(a.impactAt));
  system.runTimeout(() => { if (titan.isValid) setState(titan, 0); }, secs(a.seconds));
}

// ---- titan AI tick
system.runInterval(() => {
  for (const dn of DIMS) {
    const titans = safe(() => dimOf(dn).getEntities({ families: ["aot_titan"] })) ?? [];
    for (const titan of titans) {
      const cfg = TITANS[titan.typeId];
      if (!cfg || (busyUntil.get(titan.id) ?? 0) > system.currentTick) continue;
      const target = nearestTarget(titan, cfg.strikeRange);
      if (!target) continue;
      const swing = cfg.attacks.swing && target.location.y - titan.location.y >= cfg.flyingDelta;
      startAttack(titan, cfg, swing ? cfg.attacks.swing : cfg.attacks.slam, target);
    }
  }
}, 5);

// ---- titan spawn effects (also used when Lara/Eren transform)
world.afterEvents.entitySpawn.subscribe((ev) => {
  const cfg = TITANS[ev.entity.typeId];
  if (!cfg || ev.cause !== "Spawned") return;
  const titan = ev.entity, ticks = secs(cfg.spawnSeconds);
  busyUntil.set(titan.id, system.currentTick + ticks + secs(cfg.cooldownSeconds));
  setState(titan, 3);
  freeze(titan, ticks);
  safe(() => titan.addEffect("resistance", ticks, { amplifier: 4, showParticles: false }));
  fx(titan.dimension, titan.location, cfg.spawnFx, cfg.spawnSound, cfg.lightning);
  system.runTimeout(() => { if (titan.isValid) setState(titan, 0); }, ticks);
});

// ---- weak points: nape / eyes / heels (Attack Titan)
function hitInfo(attacker, titan, cfg) {
  // Cast the attacker's view ray against a vertical cylinder around the titan.
  const o = attacker.getHeadLocation(), d = attacker.getViewDirection(), c = titan.location, r = cfg.radius + 0.6;
  const ox = o.x - c.x, oz = o.z - c.z;
  const A = d.x * d.x + d.z * d.z, B = 2 * (ox * d.x + oz * d.z), C = ox * ox + oz * oz - r * r;
  let t;
  if (A < 1e-6) t = Math.hypot(ox, oz);
  else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) t = Math.hypot(ox, oz) - r; // ray missed: use closest approach
    else t = Math.max(0, (-B - Math.sqrt(disc)) / (2 * A));
  }
  const hit = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  const f = (hit.y - c.y) / cfg.height;
  const yaw = (titan.getRotation().y * Math.PI) / 180;
  const fwd = { x: -Math.sin(yaw), z: Math.cos(yaw) };
  const rel = { x: hit.x - c.x, z: hit.z - c.z };
  const len = Math.hypot(rel.x, rel.z) || 1;
  const front = (rel.x * fwd.x + rel.z * fwd.z) / len;       // +1 front, -1 back
  const side = (rel.x * -fwd.z + rel.z * fwd.x) / len;       // sign picks left/right leg
  return { f, front, side, hit };
}

function healTitans() {
  for (const dn of DIMS) {
    for (const t of safe(() => dimOf(dn).getEntities({ type: ATTACK })) ?? []) {
      const h = t.getComponent("minecraft:health");
      if (h && h.currentValue < h.effectiveMax) {
        safe(() => h.setCurrentValue(Math.min(h.effectiveMax, h.currentValue + WEAK.healPerSecond)));
        const c = t.location, ch = TITANS[ATTACK].height;
        steamAt(t.dimension, { x: c.x + (Math.random() - 0.5) * 2.5, y: c.y + Math.random() * ch, z: c.z + (Math.random() - 0.5) * 2.5 }, 2); // steam while healing
      }
    }
  }
}
system.runInterval(healTitans, T);

const STEAM = "aot:steam"; // small steam puff, built from the t_trans4 smoke texture

function steamAt(dim, loc, n = 3) {
  for (let i = 0; i < n; i++) {
    safe(() => dim.spawnParticle(STEAM, { x: loc.x + (Math.random() - 0.5) * 0.6, y: loc.y + (Math.random() - 0.5) * 0.6, z: loc.z + (Math.random() - 0.5) * 0.6 }));
  }
}

world.afterEvents.entityHurt.subscribe((ev) => {
  const titan = ev.hurtEntity;
  const cfg = TITANS[titan.typeId];
  if (!cfg) return;
  const h = titan.getComponent("minecraft:health");
  const attacker = ev.damageSource.damagingEntity;
  let zone = null, where = { x: titan.location.x, y: titan.location.y + cfg.height * 0.5, z: titan.location.z };
  if (attacker && attacker.typeId === "minecraft:player") {
    const { f, front, side, hit } = hitInfo(attacker, titan, cfg);
    where = hit;
    if (cfg.weakPoints) {
      if (f >= WEAK.napeBand[0] && f <= WEAK.napeBand[1] && front < -0.2) zone = "nape";
      else if (f >= WEAK.eyeBand[0] && f <= WEAK.eyeBand[1] && front > 0.3) zone = "eyes";
      else if (f <= WEAK.heelMax && front < 0.4) zone = side < 0 ? "heelL" : "heelR";
    }
  }
  if (zone === "nape" && !cfg.hardened && ev.damage >= WEAK.napeKillDamage) {
    safe(() => titan.kill()); // critical nape hit: the titan dies, no steam
    return;
  }
  // steam where the titan was hit (the wound is healing)
  steamAt(titan.dimension, where, zone ? 2 : 1);
  if (!cfg.weakPoints) return;
  // everything else is healed back; weak-point side effects:
  if (h) {
    if (!cfg.hardened) safe(() => h.setCurrentValue(Math.min(h.effectiveMax, h.currentValue + ev.damage)));
    else if (!zone) safe(() => h.setCurrentValue(Math.min(h.effectiveMax, h.currentValue + ev.damage * WEAK.hardenedBounce)));
    else if (zone === "nape") safe(() => h.setCurrentValue(Math.max(1, h.currentValue - ev.damage * (WEAK.hardenedNapeBonus - 1))));
  }
  const now = system.currentTick;
  if (zone === "eyes") {
    busyUntil.set(titan.id, now + secs(WEAK.stunSeconds));
    freeze(titan, secs(WEAK.stunSeconds));
    safe(() => titan.addEffect("weakness", secs(WEAK.stunSeconds), { amplifier: 4, showParticles: false }));
  } else if (zone === "heelL" || zone === "heelR") {
    const inj = legInjury.get(titan.id) ?? {};
    inj[zone === "heelL" ? "left" : "right"] = now + secs(WEAK.slowSeconds);
    legInjury.set(titan.id, inj);
    if ((inj.left ?? 0) > now && (inj.right ?? 0) > now) {
      busyUntil.set(titan.id, now + secs(WEAK.kneelSeconds));
      freeze(titan, secs(WEAK.kneelSeconds)); // kneeling: no kneel animation yet, so it just stops
    } else {
      safe(() => titan.addEffect("slowness", secs(WEAK.slowSeconds), { amplifier: 3, showParticles: false }));
    }
  }
});

// ---- Eren: lethal hit turns him into the Attack Titan
function rememberPositions() {
  for (const dn of DIMS) {
    for (const t of [LARA, EREN]) {
      for (const e of safe(() => dimOf(dn).getEntities({ type: t })) ?? []) {
        lastSeen.set(e.id, { dim: dn, location: e.location, yaw: safe(() => e.getRotation().y) ?? 0 });
      }
    }
  }
}
system.runInterval(rememberPositions, 2);

function placeOf(ev) {
  const id = safe(() => ev.deadEntity.id);
  return lastSeen.get(id) ?? (safe(() => ({ dim: ev.deadEntity.dimension.id.replace("minecraft:", ""), location: ev.deadEntity.location, yaw: 0 })));
}

world.afterEvents.entityDie.subscribe((ev) => {
  const p = placeOf(ev);
  if (!p) return;
  safe(() => {
    const t = dimOf(p.dim).spawnEntity(ATTACK, p.location);
    safe(() => t.setRotation({ x: 0, y: p.yaw }));
  });
}, { entityTypes: [EREN] });

// Eren punch animation when he lands a hit
world.afterEvents.entityHitEntity.subscribe((ev) => {
  const a = ev.damagingEntity;
  if (a.typeId !== EREN) return;
  setState(a, 1);
  system.runTimeout(() => { if (a.isValid) setState(a, 0); }, T);
});

// ---- Lara: any hit makes her shift into the Warhammer Titan; a lethal hit plays the death animation first
const LARA_SHIFT = { shiftSeconds: 6.875, transformAt: 2.1, deathSeconds: 13, deathTransformAt: 9.8 };

function transformLara(lara, atSeconds, loc, dimName, yaw) {
  system.runTimeout(() => {
    if (lara.isValid) safe(() => lara.remove());
    safe(() => {
      const t = dimOf(dimName).spawnEntity(WARHAMMER, loc);
      safe(() => t.setRotation({ x: 0, y: yaw }));
    });
  }, secs(atSeconds));
}

world.afterEvents.entityHurt.subscribe((ev) => {
  const lara = ev.hurtEntity;
  if (lara.typeId !== LARA || (busyUntil.get(lara.id) ?? 0) > system.currentTick) return;
  const hp = safe(() => lara.getComponent("minecraft:health")?.currentValue);
  if (hp !== undefined && hp <= 0) return; // lethal hit: the entityDie handler below takes over
  busyUntil.set(lara.id, system.currentTick + secs(LARA_SHIFT.shiftSeconds));
  setState(lara, 1);
  freeze(lara, secs(LARA_SHIFT.shiftSeconds));
  safe(() => lara.addEffect("resistance", secs(LARA_SHIFT.shiftSeconds), { amplifier: 4, showParticles: false }));
  safe(() => lara.dimension.playSound("aot.titan_shift", lara.location));
  transformLara(lara, LARA_SHIFT.transformAt, lara.location, lara.dimension.id.replace("minecraft:", ""), lara.getRotation().y);
}, { entityTypes: [LARA] });

world.afterEvents.entityDie.subscribe((ev) => {
  // Killed before she could shift: bring her back for the death animation, then she shifts anyway.
  const p = placeOf(ev);
  if (!p) return;
  safe(() => {
    const lara = dimOf(p.dim).spawnEntity(LARA, p.location);
    busyUntil.set(lara.id, system.currentTick + secs(LARA_SHIFT.deathSeconds));
    safe(() => lara.setRotation({ x: 0, y: p.yaw }));
    setState(lara, 2);
    freeze(lara, secs(LARA_SHIFT.deathSeconds));
    safe(() => lara.addEffect("resistance", secs(LARA_SHIFT.deathSeconds), { amplifier: 4, showParticles: false }));
    safe(() => dimOf(p.dim).playSound("aot.lara_tybur_death", p.location));
    transformLara(lara, LARA_SHIFT.deathTransformAt, p.location, p.dim, p.yaw);
  });
}, { entityTypes: [LARA] });

// =====================================================================================
// Player titan form (Warhammer). Properties on the player: aot:form (0 human, 1 warhammer)
// and aot:phase (0 normal, 1 shifting in, 2 attacking, 3 ejecting).
// Shift in: right-click the Warhammer serum. Eject: hold sneak for 3 seconds.
// =====================================================================================
const FORM = {
  warhammer: {
    id: 1, serum: "aot:warhammer_serum", spawnSeconds: 7.5, ejectSeconds: 6,
    holdSneakTicks: 60,                       // hold sneak this long to eject
    healPerSecond: 4,                         // shifters heal fast, with steam
    damageTaken: 0.1,                         // share of damage actually taken in titan form (rest is healed back)
    slam: { state: 2, seconds: 3.4375, impactAt: 1.875, damage: 500, halfX: 2.5, halfZ: 2.5, below: 2, above: 4, sound: "aot.heavy_warhammer_attack", fx: "stk:t_trans4", shake: true },
    cooldownSeconds: 4,
  },
};
const formOf = (p) => safe(() => p.getProperty("aot:form")) ?? 0;
const setPhase = (p, v) => safe(() => p.setProperty("aot:phase", v));
const sneakTicks = new Map();
const formCooldown = new Map();

// no potion effects on shifters: movement is locked with input permissions instead
function lockMovement(p, ticks) {
  safe(() => p.inputPermissions.setPermissionCategory(MC.InputPermissionCategory.Movement, false));
  system.runTimeout(() => safe(() => p.inputPermissions.setPermissionCategory(MC.InputPermissionCategory.Movement, true)), ticks);
}

function shiftIn(p, f) {
  if (formOf(p) !== 0) return;
  safe(() => p.triggerEvent("aot:warhammer_on"));
  setPhase(p, 1);
  const ticks = secs(f.spawnSeconds);
  fx(p.dimension, p.location, ["stk:t_trans4", "stk:t_trans"], "aot.titan_shift", false);
  lockMovement(p, ticks);
  formCooldown.set(p.id, system.currentTick + ticks);
  system.runTimeout(() => { if (p.isValid && formOf(p) === f.id) setPhase(p, 0); }, ticks);
}

function eject(p, f) {
  if (formOf(p) !== f.id || safe(() => p.getProperty("aot:phase")) === 3) return;
  setPhase(p, 3);
  lockMovement(p, secs(f.ejectSeconds));
  system.runTimeout(() => {
    if (!p.isValid) return;
    safe(() => p.triggerEvent("aot:warhammer_off"));
    steamAt(p.dimension, { x: p.location.x, y: p.location.y + 1, z: p.location.z }, 4);
  }, secs(f.ejectSeconds));
}

// right-click the serum
world.afterEvents.itemUse.subscribe((ev) => {
  const p = ev.source;
  const f = Object.values(FORM).find((x) => x.serum === ev.itemStack?.typeId);
  if (!f || formOf(p) !== 0) return;
  safe(() => {
    const inv = p.getComponent("inventory").container, slot = p.selectedSlotIndex, it = inv.getItem(slot);
    if (it.amount > 1) { it.amount -= 1; inv.setItem(slot, it); } else inv.setItem(slot, undefined);
  });
  shiftIn(p, f);
});

// per-player tick: sneak-to-eject, healing with steam
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    const f = Object.values(FORM).find((x) => x.id === formOf(p));
    if (!f) { sneakTicks.delete(p.id); continue; }
    const phase = safe(() => p.getProperty("aot:phase")) ?? 0;
    if (phase === 0) {
      const n = p.isSneaking ? (sneakTicks.get(p.id) ?? 0) + 4 : 0;
      sneakTicks.set(p.id, n);
      if (n >= f.holdSneakTicks) { sneakTicks.set(p.id, 0); eject(p, f); }
    }
  }
}, 4);

system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    const f = Object.values(FORM).find((x) => x.id === formOf(p));
    if (!f) continue;
    const h = p.getComponent("minecraft:health");
    if (h && h.currentValue < h.effectiveMax) {
      safe(() => h.setCurrentValue(Math.min(h.effectiveMax, h.currentValue + f.healPerSecond)));
      steamAt(p.dimension, { x: p.location.x + (Math.random() - 0.5) * 3, y: p.location.y + Math.random() * 18, z: p.location.z + (Math.random() - 0.5) * 3 }, 2);
    }
  }
}, T);

// shifters take reduced damage (healed back, no potion effects) and steam where they are hurt
world.afterEvents.entityHurt.subscribe((ev) => {
  const p = ev.hurtEntity;
  const f = Object.values(FORM).find((x) => x.id === formOf(p));
  if (!f) return;
  const h = p.getComponent("minecraft:health");
  if (h) safe(() => h.setCurrentValue(Math.min(h.effectiveMax, h.currentValue + ev.damage * (1 - f.damageTaken))));
  steamAt(p.dimension, { x: p.location.x, y: p.location.y + 10, z: p.location.z }, 2);
}, { entityTypes: ["minecraft:player"] });

// attacking in titan form: hitting something slams the area around the target (500 in 5x5)
world.afterEvents.entityHitEntity.subscribe((ev) => {
  const p = ev.damagingEntity;
  if (p.typeId !== "minecraft:player") return;
  const f = Object.values(FORM).find((x) => x.id === formOf(p));
  if (!f || (formCooldown.get(p.id) ?? 0) > system.currentTick) return;
  const a = f.slam, at = ev.hitEntity.location;
  formCooldown.set(p.id, system.currentTick + secs(f.cooldownSeconds));
  setPhase(p, a.state);
  safe(() => p.dimension.playSound(a.sound, p.location));
  system.runTimeout(() => {
    if (!p.isValid) return;
    for (const e of p.dimension.getEntities({ location: at, maxDistance: Math.hypot(a.halfX, a.halfZ) + a.above + 2 })) {
      if (e.id === p.id || e.typeId === "minecraft:player" || e.typeId === "minecraft:item") continue;
      const dy = e.location.y - at.y;
      if (Math.abs(e.location.x - at.x) <= a.halfX && Math.abs(e.location.z - at.z) <= a.halfZ && dy >= -a.below && dy <= a.above) {
        safe(() => e.applyDamage(a.damage, { cause: EntityDamageCause.entityAttack, damagingEntity: p }));
      }
    }
    safe(() => p.dimension.spawnParticle(a.fx, at));
    safe(() => p.dimension.runCommand(`camerashake add @a[x=${at.x},y=${at.y},z=${at.z},r=40] 0.6 0.6 positional`));
  }, secs(a.impactAt));
  system.runTimeout(() => { if (p.isValid && formOf(p) === f.id) setPhase(p, 0); }, secs(a.seconds));
});

// dying or respawning resets the form
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (ev.initialSpawn || formOf(ev.player) === 0) return;
  safe(() => ev.player.triggerEvent("aot:warhammer_off"));
  safe(() => ev.player.inputPermissions.setPermissionCategory(MC.InputPermissionCategory.Movement, true));
});
