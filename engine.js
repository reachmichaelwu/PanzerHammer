// PanzerHammer battle engine.
// Hex movement, range, combat, objectives, and turn resolution.
// This is a simplified conversion of catalog characteristics, not the
// Horus Heresy tabletop rules. See README.md for the formulas.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PanzerHammer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TERRAIN = {
    clear:  { name: "Ash plain",    infantry: 1, walker: 1, vehicle: 1 },
    road:   { name: "Processional", infantry: 1, walker: 1, vehicle: 1 },
    rubble: { name: "Rubble",       infantry: 2, walker: 2, vehicle: 3 },
    woods:  { name: "Thorn scrub",  infantry: 2, walker: 2, vehicle: null },
    fort:   { name: "Bastion",      infantry: 1, walker: 1, vehicle: null },
    wall:   { name: "Curtain wall", infantry: null, walker: null, vehicle: null },
    gate:   { name: "Iron gate",    infantry: 1, walker: 1, vehicle: 1 },
    water:  { name: "Chem-drain",   infantry: null, walker: null, vehicle: null },
    trench: { name: "Trench",       infantry: 1, walker: 2, vehicle: 3 }
  };

  var COVER = {
    clear: 0, road: 0, rubble: 1, woods: 2, fort: 3, wall: 0, gate: 2, water: 0, trench: 2
  };

  var LETTERS = {
    ".": "clear",
    "r": "road",
    "b": "rubble",
    "t": "woods",
    "f": "fort",
    "w": "wall",
    "g": "gate",
    "u": "water",
    "n": "trench"
  };

  // Pointy-top odd-r neighbors. Even row, then odd row.
  var NEIGHBORS = [
    [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]],
    [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]]
  ];

  function fail(reason, state) {
    return { ok: false, reason: reason, state: state, events: [] };
  }

  function ok(state, events) {
    return { ok: true, reason: "", state: state, events: events || state.lastEvents || [] };
  }

  function cloneState(state) {
    return {
      id: state.id,
      name: state.name,
      briefing: state.briefing,
      provenance: state.provenance,
      seed: state.seed,
      rngState: state.rngState,
      rngQueue: (state.rngQueue || []).slice(),
      turn: state.turn,
      maxTurns: state.maxTurns,
      needed: state.needed,
      phase: state.phase,
      outcome: state.outcome,
      outcomeText: state.outcomeText || "",
      cols: state.cols,
      rows: state.rows,
      terrain: state.terrain,
      sides: state.sides,
      objectives: state.objectives.map(function (o) { return Object.assign({}, o); }),
      units: state.units.map(function (u) { return Object.assign({}, u); }),
      log: state.log.slice(),
      lastEvents: []
    };
  }

  function pushEvents(state, events) {
    state.lastEvents = events.slice();
    events.forEach(function (event) { state.log.push(event.text); });
    if (state.log.length > 100) state.log.splice(0, state.log.length - 100);
  }

  function catalogMap(catalog) {
    var map = {};
    (catalog.units || []).forEach(function (unit) { map[unit.id] = unit; });
    return map;
  }

  function parseNum(value) {
    if (value === undefined || value === null || value === "-" || value === "") return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function mobilityOf(def) {
    var stats = def.source.stats;
    if (stats.isVehicle) return "vehicle";
    if (/walker/i.test(stats.modelType || "")) return "walker";
    return "infantry";
  }

  function hexMove(stats) {
    var inches = Number(stats.move) || 0;
    var hexes = Math.max(2, Math.round(inches / 2.5));
    if (/heavy/i.test(stats.modelType || "")) hexes = Math.max(2, hexes - 1);
    return hexes;
  }

  function hitPoints(def) {
    var stats = def.source.stats;
    if (stats.isVehicle) return Number(stats.hp) || 1;
    var models = Number(def.models) || 1;
    var wounds = Number(stats.w) || 1;
    if (models <= 1) return wounds;
    return models * wounds;
  }

  function rangeHexes(weapon) {
    if (!weapon) return 1;
    if (weapon.template) return 1;
    var inches = Number(weapon.rangeInches);
    if (!Number.isFinite(inches) || inches <= 0) return 1;
    return Math.max(1, Math.round(inches / 8));
  }

  function isHeavyRanged(def) {
    var type = def.ranged && def.ranged.type;
    return type === "Heavy" || type === "Ordnance" || type === "Barrage";
  }

  function saveBonus(sv) {
    var n = parseNum(sv);
    if (n === null) return 0;
    if (n <= 2) return 3;
    if (n === 3) return 2;
    if (n === 4) return 1;
    return 0;
  }

  function defenseScore(def, terrainId) {
    var stats = def.source.stats;
    var cover = COVER[terrainId] || 0;
    if (stats.isVehicle) {
      var front = Number(stats.avF) || Number(stats.t) || 10;
      return (front - 5) + Math.floor(cover / 2);
    }
    var inv = parseNum(stats.inv) !== null ? 1 : 0;
    return (Number(stats.t) || 0) + saveBonus(stats.sv) + inv + cover;
  }

  function attackScore(def, mode, moved) {
    if (mode === "melee") {
      var melee = def.melee;
      var stats = def.source.stats;
      var ws = melee ? Number(melee.ws) : Number(stats.ws) || 0;
      var attacks = melee ? Number(melee.a) : Number(stats.a) || 1;
      var strength = melee ? Number(melee.s) : Number(stats.s) || 0;
      return ws + attacks + Math.floor(strength / 2);
    }
    var weapon = def.ranged;
    var bs = Number(def.source.stats.bs) || 0;
    var score = Number(weapon.shots) + Number(weapon.s) + Math.floor(bs / 2) + (Number(weapon.damage) || 1);
    if (moved && isHeavyRanged(def)) score -= 3;
    return score;
  }

  function rawDamage(margin) {
    if (margin >= 14) return 4;
    if (margin >= 11) return 3;
    if (margin >= 8) return 2;
    if (margin >= 5) return 1;
    return 0;
  }

  function weaponAp(def, mode) {
    if (mode === "melee") return def.melee ? def.melee.ap : "-";
    return def.ranged ? def.ranged.ap : "-";
  }

  function weaponStrength(def, mode) {
    if (mode === "melee") {
      if (def.melee && Number.isFinite(Number(def.melee.s))) return Number(def.melee.s);
      return Number(def.source.stats.s) || 0;
    }
    return Number(def.ranged.s) || 0;
  }

  function bestSave(def, ap) {
    var stats = def.source.stats;
    if (stats.isVehicle) return null;
    var sv = parseNum(stats.sv);
    var inv = parseNum(stats.inv);
    var apNum = parseNum(ap);
    var options = [];
    if (sv !== null && !(apNum !== null && apNum <= sv)) options.push(sv);
    if (inv !== null) options.push(inv);
    if (!options.length) return null;
    return Math.min.apply(null, options);
  }

  function applyVehicleCap(damage, strength, avF) {
    if (!Number.isFinite(avF)) return damage;
    if (strength >= avF) return damage;
    if (strength >= avF - 4) return damage > 0 ? Math.max(1, damage - 1) : 0;
    if (strength >= avF - 8) return damage > 0 ? 1 : 0;
    return 0;
  }

  function describeUnit(def) {
    var stats = def.source.stats;
    var chars = def.source.characteristics || {};
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      models: def.models,
      points: def.points,
      art: def.art,
      mobility: mobilityOf(def),
      move: hexMove(stats),
      hp: hitPoints(def),
      range: rangeHexes(def.ranged),
      ranged: def.ranged,
      melee: def.melee,
      attackRanged: attackScore(def, "ranged", false),
      attackRangedMoved: attackScore(def, "ranged", true),
      attackMelee: attackScore(def, "melee", false),
      defense: defenseScore(def, "clear"),
      heavyRanged: isHeavyRanged(def),
      characteristics: chars,
      stats: stats,
      profileName: def.source.profileName,
      profileFile: def.source.profileFile,
      profileId: def.source.profileId
    };
  }

  function oddrToCube(col, row) {
    var x = col - (row - (row & 1)) / 2;
    var z = row;
    var y = -x - z;
    return { x: x, y: y, z: z };
  }

  function cubeToOddr(cube) {
    var col = cube.x + (cube.z - (cube.z & 1)) / 2;
    return { col: col, row: cube.z };
  }

  function hexDistance(colA, rowA, colB, rowB) {
    var a = oddrToCube(colA, rowA);
    var b = oddrToCube(colB, rowB);
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
  }

  function cubeRound(cube) {
    var rx = Math.round(cube.x);
    var ry = Math.round(cube.y);
    var rz = Math.round(cube.z);
    var xDiff = Math.abs(rx - cube.x);
    var yDiff = Math.abs(ry - cube.y);
    var zDiff = Math.abs(rz - cube.z);
    if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
    else if (yDiff > zDiff) ry = -rx - rz;
    else rz = -rx - ry;
    return { x: rx, y: ry, z: rz };
  }

  function cubeLine(colA, rowA, colB, rowB) {
    var a = oddrToCube(colA, rowA);
    var b = oddrToCube(colB, rowB);
    var n = hexDistance(colA, rowA, colB, rowB);
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = n === 0 ? 0 : i / n;
      var cube = cubeRound({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t
      });
      var hex = cubeToOddr(cube);
      out.push({ col: hex.col, row: hex.row });
    }
    return out;
  }

  function inBounds(state, col, row) {
    return col >= 0 && row >= 0 && col < state.cols && row < state.rows;
  }

  function terrainAt(state, col, row) {
    if (!inBounds(state, col, row)) return null;
    return state.terrain[row][col];
  }

  function unitById(state, id) {
    for (var i = 0; i < state.units.length; i++) {
      if (state.units[i].instanceId === id) return state.units[i];
    }
    return null;
  }

  function unitOn(state, col, row) {
    for (var i = 0; i < state.units.length; i++) {
      var unit = state.units[i];
      if (unit.alive && unit.col === col && unit.row === row) return unit;
    }
    return null;
  }

  function living(state, side) {
    return state.units.filter(function (unit) { return unit.alive && (!side || unit.side === side); });
  }

  function neighbors(col, row) {
    var dirs = NEIGHBORS[row & 1];
    return dirs.map(function (dir) { return { col: col + dir[0], row: row + dir[1] }; });
  }

  function enemyZoc(state, unit, col, row) {
    var around = neighbors(col, row);
    for (var i = 0; i < around.length; i++) {
      var other = unitOn(state, around[i].col, around[i].row);
      if (other && other.side !== unit.side) return true;
    }
    return false;
  }

  function stepCost(state, catalogById, unit, col, row) {
    var terrain = terrainAt(state, col, row);
    if (!terrain) return null;
    var def = catalogById[unit.catalogId];
    var table = TERRAIN[terrain];
    if (!table) return null;
    return table[mobilityOf(def)];
  }

  function activationError(state, unit) {
    if (!unit) return "No such unit.";
    if (state.outcome || state.phase === "over") return "The battle is already decided.";
    if (!unit.alive) return "That unit has been destroyed.";
    if (unit.acted) return "That unit has already finished its activation.";
    if (state.phase === "player" && unit.side !== "player") return "Those warriors answer to the other commander.";
    if (state.phase === "ai" && unit.side !== "enemy") return "The enemy is resolving its orders.";
    return null;
  }

  function legalMoves(state, catalog, instanceId) {
    var byId = catalogMap(catalog);
    var unit = unitById(state, instanceId);
    var error = activationError(state, unit);
    if (error || unit.moved) return [];
    var budget = hexMove(byId[unit.catalogId].source.stats);
    var startKey = unit.col + "," + unit.row;
    var startZoc = enemyZoc(state, unit, unit.col, unit.row);
    var best = {};
    best[startKey] = 0;
    var queue = [{ cost: 0, col: unit.col, row: unit.row }];
    while (queue.length) {
      queue.sort(function (a, b) { return a.cost - b.cost; });
      var current = queue.shift();
      var currentKey = current.col + "," + current.row;
      if (current.cost !== best[currentKey]) continue;
      var fromStart = current.col === unit.col && current.row === unit.row;
      var next = neighbors(current.col, current.row);
      for (var i = 0; i < next.length; i++) {
        var hex = next[i];
        if (!inBounds(state, hex.col, hex.row)) continue;
        if (unitOn(state, hex.col, hex.row)) continue;
        var cost = stepCost(state, byId, unit, hex.col, hex.row);
        if (cost === null || cost === undefined) continue;
        var spent = current.cost + cost;
        if (spent > budget) continue;
        var zoc = enemyZoc(state, unit, hex.col, hex.row);
        if (fromStart && startZoc && zoc) continue;
        var key = hex.col + "," + hex.row;
        if (best[key] !== undefined && best[key] <= spent) continue;
        best[key] = spent;
        // Entering an enemy zone of control ends the move.
        if (!zoc) queue.push({ cost: spent, col: hex.col, row: hex.row });
      }
    }
    delete best[startKey];
    return Object.keys(best).map(function (key) {
      var parts = key.split(",");
      return { col: Number(parts[0]), row: Number(parts[1]), cost: best[key] };
    });
  }

  function blocksSight(state, col, row) {
    var terrain = terrainAt(state, col, row);
    if (terrain === "wall" || terrain === "woods") return true;
    if (unitOn(state, col, row)) return true;
    return false;
  }

  function losClear(state, fromCol, fromRow, toCol, toRow) {
    var line = cubeLine(fromCol, fromRow, toCol, toRow);
    for (var i = 1; i < line.length - 1; i++) {
      var hex = line[i];
      if (!inBounds(state, hex.col, hex.row)) return false;
      if (blocksSight(state, hex.col, hex.row)) return false;
    }
    return true;
  }

  function legalAttacks(state, catalog, instanceId) {
    var byId = catalogMap(catalog);
    var unit = unitById(state, instanceId);
    var error = activationError(state, unit);
    if (error) return [];
    var attacker = byId[unit.catalogId];
    var ranged = rangeHexes(attacker.ranged);
    var attacks = [];
    living(state).forEach(function (target) {
      if (target.side === unit.side) return;
      var distance = hexDistance(unit.col, unit.row, target.col, target.row);
      if (distance < 1) return;
      var defender = byId[target.catalogId];
      var terrain = terrainAt(state, target.col, target.row);
      if (distance === 1) {
        attacks.push(attackOption(unit, attacker, target, defender, terrain, distance, "melee"));
      }
      if (distance <= ranged && losClear(state, unit.col, unit.row, target.col, target.row)) {
        attacks.push(attackOption(unit, attacker, target, defender, terrain, distance, "ranged"));
      }
    });
    return attacks;
  }

  function attackOption(unit, attacker, target, defender, terrain, distance, mode) {
    var preview = resolveStrike(attacker, defender, terrain, mode, unit.moved, { attack: [4, 3], save: 1 });
    return {
      targetId: target.instanceId,
      targetName: target.name,
      mode: mode,
      distance: distance,
      terrain: terrain,
      weapon: mode === "melee"
        ? (attacker.melee ? attacker.melee.name : "Close combat")
        : attacker.ranged.name,
      expected: preview.damage,
      heavyPenalty: mode === "ranged" && unit.moved && isHeavyRanged(attacker)
    };
  }

  function drawD6(state) {
    if (state.rngQueue && state.rngQueue.length) return state.rngQueue.shift();
    state.rngState = (Math.imul(state.rngState >>> 0, 1664525) + 1013904223) >>> 0;
    return 1 + (state.rngState % 6);
  }

  function resolveStrike(attacker, defender, terrain, mode, moved, rolls) {
    var score = attackScore(attacker, mode, moved);
    var defense = defenseScore(defender, terrain);
    var margin = rolls.attack[0] + rolls.attack[1] + score - defense;
    var damage = rawDamage(margin);
    var strength = weaponStrength(attacker, mode);
    var vehicleNote = "";
    if (defender.source.stats.isVehicle) {
      var before = damage;
      damage = applyVehicleCap(damage, strength, Number(defender.source.stats.avF));
      if (before !== damage) vehicleNote = " Armour faces the shot.";
    }
    var saveTarget = damage > 0 ? bestSave(defender, weaponAp(attacker, mode)) : null;
    var saved = false;
    if (saveTarget !== null && rolls.save >= saveTarget) {
      saved = true;
      damage = Math.max(0, damage - 1);
    }
    return {
      damage: damage,
      margin: margin,
      score: score,
      defense: defense,
      saveTarget: saveTarget,
      saved: saved,
      rolls: rolls,
      vehicleNote: vehicleNote
    };
  }

  function sideLabel(state, side) {
    return (state.sides && state.sides[side] && state.sides[side].label) || side;
  }

  function syncObjectives(state) {
    var events = [];
    state.objectives.forEach(function (objective) {
      var occupier = unitOn(state, objective.col, objective.row);
      if (!occupier || occupier.side === objective.owner) return;
      objective.owner = occupier.side;
      events.push({
        type: "capture",
        text: occupier.name + " seizes " + objective.name + " for the " + sideLabel(state, occupier.side) + "."
      });
    });
    return events;
  }

  function heldBy(state, side) {
    return state.objectives.filter(function (objective) { return objective.owner === side; }).length;
  }

  function setOutcome(state, outcome, text) {
    state.outcome = outcome;
    state.outcomeText = text;
    state.phase = "over";
    return [{ type: outcome, text: text }];
  }

  function eliminationEvents(state) {
    if (living(state, "player").length === 0) {
      return setOutcome(state, "defeat", "Every Imperial Fists unit has fallen. The Iron Gate holds.");
    }
    if (living(state, "enemy").length === 0) {
      return setOutcome(state, "victory", "The Iron Warriors are broken. The processional is yours.");
    }
    return null;
  }

  function moveUnit(state, catalog, instanceId, col, row) {
    var current = unitById(state, instanceId);
    var error = activationError(state, current);
    if (error) return fail(error, state);
    if (current.moved) return fail("That unit has already moved.", state);
    var choices = legalMoves(state, catalog, instanceId);
    var choice = null;
    for (var i = 0; i < choices.length; i++) {
      if (choices[i].col === col && choices[i].row === row) choice = choices[i];
    }
    if (!choice) return fail("That hex is not a legal move.", state);
    var next = cloneState(state);
    var unit = unitById(next, instanceId);
    var terrain = terrainAt(next, col, row);
    unit.col = col;
    unit.row = row;
    unit.moved = true;
    var events = [{
      type: "move",
      unitId: instanceId,
      text: unit.name + " moves onto " + TERRAIN[terrain].name.toLowerCase() + " (" + choice.cost + " MP)."
    }];
    events = events.concat(syncObjectives(next));
    var eliminated = eliminationEvents(next);
    if (eliminated) events = events.concat(eliminated);
    pushEvents(next, events);
    return ok(next, events);
  }

  function attackUnit(state, catalog, instanceId, targetId, mode) {
    var current = unitById(state, instanceId);
    var error = activationError(state, current);
    if (error) return fail(error, state);
    var choices = legalAttacks(state, catalog, instanceId);
    var choice = null;
    for (var i = 0; i < choices.length; i++) {
      if (choices[i].targetId === targetId && choices[i].mode === mode) choice = choices[i];
    }
    if (!choice) return fail("That attack is not legal.", state);
    var next = cloneState(state);
    var attackerUnit = unitById(next, instanceId);
    var target = unitById(next, targetId);
    var byId = catalogMap(catalog);
    var attackRolls = [drawD6(next), drawD6(next)];
    var terrain = terrainAt(next, target.col, target.row);
    var probe = resolveStrike(
      byId[attackerUnit.catalogId],
      byId[target.catalogId],
      terrain,
      mode,
      attackerUnit.moved,
      { attack: attackRolls, save: 1 }
    );
    var saveRoll = 1;
    if (probe.saveTarget !== null && probe.damage > 0) saveRoll = drawD6(next);
    var strike = resolveStrike(
      byId[attackerUnit.catalogId],
      byId[target.catalogId],
      terrain,
      mode,
      attackerUnit.moved,
      { attack: attackRolls, save: saveRoll }
    );
    attackerUnit.acted = true;
    target.hp -= strike.damage;
    var weapon = choice.weapon;
    var events = [];
    if (strike.damage > 0) {
      events.push({
        type: "damage",
        unitId: instanceId,
        targetId: targetId,
        damage: strike.damage,
        text: attackerUnit.name + " hits " + target.name + " with " + weapon + " for " + strike.damage + " damage" +
          (strike.saved ? " (save reduced it)" : "") + ". " + Math.max(0, target.hp) + " HP remain." + strike.vehicleNote
      });
    } else {
      events.push({
        type: "miss",
        unitId: instanceId,
        targetId: targetId,
        damage: 0,
        text: attackerUnit.name + " fires " + weapon + " at " + target.name + " and fails to wound." +
          (strike.saved ? " A save shrugs the blow." : "") + strike.vehicleNote
      });
    }
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      events.push({
        type: "destroyed",
        targetId: targetId,
        text: target.name + " is destroyed and removed from the field."
      });
    }
    events = events.concat(syncObjectives(next));
    var eliminated = eliminationEvents(next);
    if (eliminated) events = events.concat(eliminated);
    pushEvents(next, events);
    return ok(next, events);
  }

  function restUnit(state, catalog, instanceId) {
    var current = unitById(state, instanceId);
    var error = activationError(state, current);
    if (error) return fail(error, state);
    var next = cloneState(state);
    var unit = unitById(next, instanceId);
    unit.acted = true;
    unit.moved = true;
    var events = [{ type: "rest", unitId: instanceId, text: unit.name + " holds position." }];
    pushEvents(next, events);
    return ok(next, events);
  }

  function endPlayerTurn(state) {
    if (state.outcome || state.phase === "over") return fail("The battle is already decided.", state);
    if (state.phase !== "player") return fail("It is not your orders phase.", state);
    var next = cloneState(state);
    next.phase = "ai";
    next.units.forEach(function (unit) {
      if (unit.side === "enemy") {
        unit.moved = false;
        unit.acted = false;
      }
    });
    var events = [{ type: "phase", text: "Turn " + next.turn + " — the Iron Warriors reply." }];
    pushEvents(next, events);
    return ok(next, events);
  }

  function finishAiPhase(state) {
    if (state.phase !== "ai") return fail("The enemy phase is not running.", state);
    if (state.outcome) return ok(state, []);
    var next = cloneState(state);
    var events = [];
    var eliminated = eliminationEvents(next);
    if (eliminated) {
      pushEvents(next, eliminated);
      return ok(next, eliminated);
    }
    var held = heldBy(next, "player");
    var total = next.objectives.length;
    if (total > 0 && held === total) {
      events = setOutcome(next, "victory", "All " + total + " strongpoints are in Imperial Fists hands.");
      pushEvents(next, events);
      return ok(next, events);
    }
    if (next.turn >= next.maxTurns) {
      if (held >= next.needed) {
        events = setOutcome(
          next,
          "victory",
          "Night falls with " + held + " of " + total + " strongpoints held. The gate is yours."
        );
      } else {
        events = setOutcome(
          next,
          "defeat",
          "Night falls with only " + held + " of " + total + " strongpoints held. The Iron Warriors keep the wall."
        );
      }
      pushEvents(next, events);
      return ok(next, events);
    }
    next.turn += 1;
    next.phase = "player";
    next.units.forEach(function (unit) {
      if (unit.side === "player" && unit.alive) {
        unit.moved = false;
        unit.acted = false;
      }
    });
    events.push({
      type: "phase",
      text: "Turn " + next.turn + " — Imperial Fists. Strongpoints held: " + held + " of " + total + "."
    });
    pushEvents(next, events);
    return ok(next, events);
  }

  function normalizeMap(doc) {
    if (!doc || typeof doc !== "object") throw new Error("Map file is empty.");
    if (doc.format !== "panzerhammer-map-v1") {
      throw new Error("Unsupported map format. Expected panzerhammer-map-v1.");
    }
    var cols = doc.cols;
    var rows = doc.rowsCount || doc.rowsLength;
    var sourceRows = doc.terrainRows || doc.rows;
    if (!Array.isArray(sourceRows)) throw new Error("Map is missing terrain rows.");
    if (!cols) cols = sourceRows[0] ? sourceRows[0].length : 0;
    if (!doc.rowsCount && typeof doc.rows === "number") {
      // A numeric rows field is the height. Terrain then lives on terrainRows.
    }
    var height = typeof doc.rows === "number" ? doc.rows : sourceRows.length;
    if (Array.isArray(doc.rows)) {
      sourceRows = doc.rows;
      height = sourceRows.length;
      if (!doc.cols) cols = sourceRows[0].length;
    }
    if (!cols || !height) throw new Error("Map has no cells.");
    if (sourceRows.length !== height) throw new Error("Terrain row count does not match rows.");
    var terrain = sourceRows.map(function (row, index) {
      var cells = Array.isArray(row) ? row.slice() : String(row).split("");
      if (cells.length !== cols) {
        throw new Error("Terrain row " + index + " has " + cells.length + " cells, expected " + cols + ".");
      }
      return cells.map(function (cell) {
        var id = LETTERS[cell] || (TERRAIN[cell] ? cell : null);
        if (!id) throw new Error("Unknown terrain '" + cell + "' in row " + index + ".");
        return id;
      });
    });
    var objectives = (doc.objectives || []).map(function (objective) {
      if (!objective || typeof objective.col !== "number" || typeof objective.row !== "number") {
        throw new Error("Objective is missing a hex.");
      }
      if (objective.col < 0 || objective.row < 0 || objective.col >= cols || objective.row >= height) {
        throw new Error("Objective " + (objective.name || objective.id) + " is outside the map.");
      }
      var ground = terrain[objective.row][objective.col];
      if (TERRAIN[ground].infantry === null) {
        throw new Error("Objective " + (objective.name || objective.id) + " sits on impassable ground.");
      }
      if (objective.owner !== "player" && objective.owner !== "enemy") {
        throw new Error("Objective owner must be player or enemy.");
      }
      return {
        id: String(objective.id || objective.name),
        name: String(objective.name || objective.id),
        col: objective.col,
        row: objective.row,
        owner: objective.owner
      };
    });
    return {
      format: "panzerhammer-map-v1",
      id: String(doc.id || "map"),
      name: String(doc.name || "Untitled field"),
      briefing: String(doc.briefing || ""),
      provenance: String(doc.provenance || "unspecified"),
      provenanceNote: String(doc.provenanceNote || ""),
      cols: cols,
      rows: height,
      terrain: terrain,
      objectives: objectives,
      maxTurns: Number(doc.maxTurns) || 10,
      needed: Number(doc.objectivesNeeded || doc.needed) || 2
    };
  }

  function interpretImport(doc) {
    if (!doc || typeof doc !== "object") throw new Error("Import file is empty.");
    if (doc.format === "panzerhammer-scenario-v1") {
      if (!doc.map) throw new Error("Scenario is missing a map.");
      if (!Array.isArray(doc.order)) throw new Error("Scenario is missing an order of battle.");
      return {
        kind: "scenario",
        map: normalizeMap(doc.map),
        order: doc.order,
        sides: doc.sides || null,
        seed: doc.seed
      };
    }
    if (doc.format === "panzerhammer-map-v1") {
      return { kind: "map", map: normalizeMap(doc), order: null, sides: null };
    }
    throw new Error("Unsupported file. Use panzerhammer-map-v1 or panzerhammer-scenario-v1.");
  }

  function createGame(options) {
    var catalog = options.catalog;
    var byId = catalogMap(catalog);
    var map = options.map.format === "panzerhammer-map-v1" && options.map.terrain
      ? options.map
      : normalizeMap(options.map);
    var order = options.order || [];
    if (!order.length) throw new Error("The scenario has no units.");
    var seen = {};
    var occupied = {};
    var units = order.map(function (entry) {
      var def = byId[entry.catalogId];
      if (!def) throw new Error("Unknown catalog unit " + entry.catalogId + ".");
      if (def.source.stats.isFlyer) throw new Error(def.name + " is a flyer and cannot deploy on this map.");
      if (seen[entry.instanceId]) throw new Error("Duplicate unit id " + entry.instanceId + ".");
      seen[entry.instanceId] = true;
      if (entry.side !== "player" && entry.side !== "enemy") throw new Error("Unit side must be player or enemy.");
      var key = entry.col + "," + entry.row;
      if (occupied[key]) throw new Error("Two units cannot deploy on the same hex.");
      var ground = map.terrain[entry.row] && map.terrain[entry.row][entry.col];
      if (!ground) throw new Error(def.name + " deploys outside the map.");
      if (TERRAIN[ground][mobilityOf(def)] == null) {
        throw new Error(def.name + " cannot deploy on " + TERRAIN[ground].name + ".");
      }
      occupied[key] = true;
      var hp = hitPoints(def);
      return {
        instanceId: entry.instanceId,
        catalogId: entry.catalogId,
        name: entry.name || def.name,
        token: entry.token || def.name.slice(0, 3).toUpperCase(),
        art: entry.art || def.art,
        side: entry.side,
        col: entry.col,
        row: entry.row,
        hp: hp,
        maxHp: hp,
        moved: false,
        acted: false,
        alive: true
      };
    });
    var seed = options.seed === undefined ? 30 : (options.seed >>> 0);
    var state = {
      id: map.id,
      name: map.name,
      briefing: map.briefing,
      provenance: map.provenance,
      seed: seed,
      rngState: seed || 1,
      rngQueue: options.rngQueue ? options.rngQueue.slice() : [],
      turn: 1,
      maxTurns: options.maxTurns || map.maxTurns,
      needed: options.needed || map.needed,
      phase: "player",
      outcome: null,
      outcomeText: "",
      cols: map.cols,
      rows: map.rows,
      terrain: map.terrain,
      sides: options.sides || {
        player: { id: "imperial_fists", label: "Imperial Fists" },
        enemy: { id: "iron_warriors", label: "Iron Warriors" }
      },
      objectives: map.objectives.map(function (objective) { return Object.assign({}, objective); }),
      units: units,
      log: [],
      lastEvents: []
    };
    var events = [];
    if (state.briefing) events.push({ type: "briefing", text: state.briefing });
    events.push({
      type: "phase",
      text: "Turn 1 — Imperial Fists. Hold " + state.needed + " of " + state.objectives.length +
        " strongpoints by the end of turn " + state.maxTurns + ", or take every strongpoint sooner."
    });
    events = events.concat(syncObjectives(state));
    pushEvents(state, events);
    return state;
  }

  function summary(state) {
    return {
      turn: state.turn,
      maxTurns: state.maxTurns,
      phase: state.phase,
      outcome: state.outcome,
      outcomeText: state.outcomeText,
      held: heldBy(state, "player"),
      objectives: state.objectives.length,
      needed: state.needed,
      playerUnits: living(state, "player").length,
      enemyUnits: living(state, "enemy").length
    };
  }

  return {
    TERRAIN: TERRAIN,
    COVER: COVER,
    LETTERS: LETTERS,
    normalizeMap: normalizeMap,
    interpretImport: interpretImport,
    createGame: createGame,
    describeUnit: describeUnit,
    hexDistance: hexDistance,
    cubeLine: cubeLine,
    hexMove: hexMove,
    hitPoints: hitPoints,
    rangeHexes: rangeHexes,
    attackScore: attackScore,
    defenseScore: defenseScore,
    mobilityOf: mobilityOf,
    resolveStrike: resolveStrike,
    legalMoves: legalMoves,
    legalAttacks: legalAttacks,
    losClear: losClear,
    moveUnit: moveUnit,
    attackUnit: attackUnit,
    restUnit: restUnit,
    endPlayerTurn: endPlayerTurn,
    finishAiPhase: finishAiPhase,
    summary: summary,
    catalogMap: catalogMap,
    cloneState: cloneState
  };
});
