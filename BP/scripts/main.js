// Attack on Crafting - behavior scripts. Entity logic that JSON alone can't do.
import { world, system, EntityDamageCause } from "@minecraft/server";

const T = 20; // ticks per second

// aot:state property drives client animations: 0 normal, 1 attack1, 2 attack2, 3 spawn
const TITANS = {
  "aot:war_hammer_titan": {
    spawnSeconds: 7.5,
    spawnFx: ["stk:t_trans4", "stk:t_trans"],
    spawnSound: "aot.titan_shift",
    cooldownSeconds: 4,
    attacks: {
      // hammer slam: 500 damage in a 5x5 area where the hammer hits the ground
      slam: { state: 1, seconds: 3.4375, impactAt: 1.875, damage: 500, forward: 9, halfX: 2.5, halfZ: 2.5, below: 2, above: 4, sound: "aot.heavy_warhammer_attack", fx: "stk:t_trans4", shake: true },
      // swing: used when the target is above/flying around the titan. Damage/timing are placeholders to tune.
      swing: { state: 2, seconds: 3.21429, impactAt: 1.4, damage: 250, forward: 6, halfX: 7, halfZ: 7, below: 4, above: 16, sound: null, fx: null, shake: false },
    },
    sightRange: 10,
    slamRange: 12,
    flyingDelta: 4, // target this many blocks above the titan -> swing
  },
};

const busyUntil = new Map(); // entity id -> tick when it may act again

function setState(entity, v) {
  try { entity.setProperty("aot:state", v); } catch (e) { console.warn(`setProperty failed: ${e}`); }
}

function freeze(entity, ticks) {
  try { entity.addEffect("slowness", ticks, { amplifier: 250, showParticles: false }); } catch (e) { /* ignore */ }
}

function isHostileTarget(e) {
  if (e.typeId === "minecraft:player") return true;
  try { return e.getComponent("minecraft:type_family")?.hasTypeFamily("monster") && !e.getComponent("minecraft:type_family")?.hasTypeFamily("aot_titan"); } catch { return false; }
}

function nearestTarget(titan, range) {
  const found = titan.dimension.getEntities({ location: titan.location, maxDistance: range });
  let best = null, bestD = Infinity;
  for (const e of found) {
    if (e.id === titan.id || !isHostileTarget(e)) continue;
    const dx = e.location.x - titan.location.x, dz = e.location.z - titan.location.z;
    const d = Math.hypot(dx, dz);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best ? { entity: best, dist: bestD } : null;
}

function faceToward(titan, target) {
  const dx = target.location.x - titan.location.x, dz = target.location.z - titan.location.z;
  const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
  try { titan.setRotation({ x: 0, y: yaw }); } catch (e) { /* ignore */ }
  return yaw;
}

function doImpact(titan, yaw, a) {
  if (!titan.isValid) return;
  const rad = (yaw * Math.PI) / 180;
  const p = { x: titan.location.x - Math.sin(rad) * a.forward, y: titan.location.y, z: titan.location.z + Math.cos(rad) * a.forward };
  const dim = titan.dimension;
  const hits = dim.getEntities({ location: p, maxDistance: Math.hypot(a.halfX, a.halfZ) + a.above + 2 });
  for (const e of hits) {
    if (e.id === titan.id || !isHostileTarget(e)) continue;
    const dx = Math.abs(e.location.x - p.x), dz = Math.abs(e.location.z - p.z), dy = e.location.y - p.y;
    if (dx <= a.halfX && dz <= a.halfZ && dy >= -a.below && dy <= a.above) {
      try { e.applyDamage(a.damage, { cause: EntityDamageCause.entityAttack, damagingEntity: titan }); } catch (err) { console.warn(`applyDamage failed: ${err}`); }
    }
  }
  if (a.fx) { try { dim.spawnParticle(a.fx, p); } catch (e) { /* ignore */ } }
  if (a.shake) { try { dim.runCommand(`camerashake add @a[x=${p.x},y=${p.y},z=${p.z},r=40] 0.6 0.6 positional`); } catch (e) { /* ignore */ } }
}

function startAttack(titan, cfg, a, target) {
  const yaw = faceToward(titan, target);
  const now = system.currentTick;
  busyUntil.set(titan.id, now + Math.ceil(a.seconds * T) + Math.ceil(cfg.cooldownSeconds * T));
  setState(titan, a.state);
  freeze(titan, Math.ceil(a.seconds * T));
  if (a.sound) { try { titan.dimension.playSound(a.sound, titan.location); } catch (e) { /* ignore */ } }
  system.runTimeout(() => doImpact(titan, yaw, a), Math.ceil(a.impactAt * T));
  system.runTimeout(() => { if (titan.isValid) setState(titan, 0); }, Math.ceil(a.seconds * T));
}

system.runInterval(() => {
  for (const dim of ["overworld", "nether", "the_end"]) {
    let titans;
    try { titans = world.getDimension(dim).getEntities({ families: ["aot_titan"] }); } catch { continue; }
    for (const titan of titans) {
      const cfg = TITANS[titan.typeId];
      if (!cfg) continue;
      if ((busyUntil.get(titan.id) ?? 0) > system.currentTick) continue;
      const t = nearestTarget(titan, cfg.slamRange);
      if (!t) continue;
      const dy = t.entity.location.y - titan.location.y;
      const a = dy >= cfg.flyingDelta ? cfg.attacks.swing : cfg.attacks.slam;
      startAttack(titan, cfg, a, t.entity);
    }
  }
}, 5);

world.afterEvents.entitySpawn.subscribe((ev) => {
  const cfg = TITANS[ev.entity.typeId];
  if (!cfg || ev.cause !== "Spawned") return;
  const titan = ev.entity;
  const ticks = Math.ceil(cfg.spawnSeconds * T);
  busyUntil.set(titan.id, system.currentTick + ticks + Math.ceil(cfg.cooldownSeconds * T));
  setState(titan, 3);
  freeze(titan, ticks);
  try { titan.addEffect("resistance", ticks, { amplifier: 4, showParticles: false }); } catch (e) { /* ignore */ }
  for (const fx of cfg.spawnFx) { try { titan.dimension.spawnParticle(fx, titan.location); } catch (e) { /* ignore */ } }
  try { titan.dimension.playSound(cfg.spawnSound, titan.location); } catch (e) { /* ignore */ }
  system.runTimeout(() => { if (titan.isValid) setState(titan, 0); }, ticks);
});
