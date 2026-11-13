"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Engine = require("../engine");
const Ai = require("../ai");

const catalog = require("../catalog");
const builtinScenario = require("../scenarios/iron-gate");
const scenario = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../scenarios/iron-gate.json"), "utf8")
);

function unitDef(id) {
  return catalog.units.find(function (unit) { return unit.id === id; });
}

function makeMap(rows, extra) {
  return Engine.normalizeMap(Object.assign({
    format: "panzerhammer-map-v1",
    id: "test",
    name: "Test field",
    provenance: "test",
    cols: rows[0].length,
    rows: rows.length,
    terrainRows: rows,
    objectives: [],
    maxTurns: 6,
    objectivesNeeded: 1
  }, extra || {}));
}

function battle(rows, order, extra) {
  const map = makeMap(rows, extra && extra.map);
  return Engine.createGame(Object.assign({
    catalog: catalog,
    map: map,
    order: order,
    seed: 7,
    rngQueue: extra && extra.rngQueue,
    maxTurns: extra && extra.maxTurns,
    needed: extra && extra.needed
  }, {}));
}

function piece(id, catalogId, side, col, row) {
  return { instanceId: id, catalogId: catalogId, side: side, col: col, row: row, name: id };
}

test("catalog conversions use repository characteristics", function () {
  const tactical = unitDef("tactical");
  assert.equal(tactical.source.stats.move, 7);
  assert.equal(tactical.source.stats.bs, 4);
  assert.equal(tactical.source.stats.t, 4);
  assert.equal(tactical.source.stats.w, 1);
  assert.equal(tactical.source.stats.sv, "3");
  assert.equal(tactical.source.profileFile, "Legiones Astartes.json");
  assert.equal(tactical.models, 10);
  assert.equal(tactical.ranged.name, "Bolter");
  assert.equal(tactical.ranged.rangeInches, 24);
  assert.equal(tactical.ranged.fallback, false);

  const card = Engine.describeUnit(tactical);
  assert.equal(card.move, 3);
  assert.equal(card.range, 3);
  assert.equal(card.hp, 10);
  assert.equal(card.mobility, "infantry");

  const breacher = Engine.describeUnit(unitDef("breacher"));
  assert.equal(unitDef("breacher").source.stats.modelType, "Infantry (Heavy)");
  assert.equal(breacher.move, 2);

  const predator = Engine.describeUnit(unitDef("predator"));
  assert.equal(unitDef("predator").source.stats.avF, 13);
  assert.equal(unitDef("predator").source.stats.hp, 5);
  assert.equal(predator.move, 5);
  assert.equal(predator.hp, 5);
  assert.equal(predator.mobility, "vehicle");
  assert.equal(predator.range, 6);

  const heavy = Engine.describeUnit(unitDef("heavy_support"));
  assert.equal(unitDef("heavy_support").ranged.name, "Lascannon");
  assert.equal(unitDef("heavy_support").ranged.rangeInches, 48);
  assert.equal(heavy.range, 6);
  assert.equal(heavy.attackRanged, 13);
  assert.equal(heavy.attackRangedMoved, 10);

  const sigismund = unitDef("sigismund");
  assert.equal(sigismund.ranged.fallback, true);
  assert.equal(sigismund.ranged.name, "Bolt Pistol");
  assert.equal(sigismund.melee.name, "Black Sword");
  assert.equal(sigismund.source.profileFile, "Imperial Fists.json");

  const rapier = unitDef("rapier");
  assert.equal(rapier.source.profileFile, "Solar Auxilia.json");
  assert.equal(rapier.ranged.name, "Laser Destroyer");
  assert.equal(rapier.ranged.rangeEstimated, false);
});

test("movement respects terrain, zones of control, and blocked ground", function () {
  const open = battle(
    ["......."],
    [piece("tac", "tactical", "player", 0, 0)]
  );
  const reaches = Engine.legalMoves(open, catalog, "tac").map(function (hex) { return hex.col + "," + hex.row; });
  assert.ok(reaches.indexOf("1,0") >= 0);
  assert.ok(reaches.indexOf("3,0") >= 0);
  assert.ok(reaches.indexOf("4,0") < 0);

  const walled = battle(
    [".w....."],
    [piece("tac", "tactical", "player", 0, 0)]
  );
  assert.equal(Engine.legalMoves(walled, catalog, "tac").some(function (hex) { return hex.col === 1; }), false);

  const woods = battle(
    [".t....", "......"],
    [piece("pred", "predator", "player", 0, 0)]
  );
  assert.equal(Engine.legalMoves(woods, catalog, "pred").some(function (hex) { return hex.col === 1 && hex.row === 0; }), false);
  const walked = Engine.moveUnit(woods, catalog, "pred", 2, 0);
  assert.equal(walked.ok, true);
  assert.equal(walked.state.units[0].col, 2);

  const rubble = battle(
    [".b....."],
    [piece("brc", "breacher", "player", 0, 0)]
  );
  const rubbleMoves = Engine.legalMoves(rubble, catalog, "brc");
  const ontoRubble = rubbleMoves.find(function (hex) { return hex.col === 1; });
  assert.equal(ontoRubble.cost, 2);
  assert.equal(rubbleMoves.some(function (hex) { return hex.col === 2; }), false);

  const zoc = battle(
    ["......."],
    [piece("tac", "tactical", "player", 0, 0), piece("foe", "tactical", "enemy", 2, 0)]
  );
  const zocMoves = Engine.legalMoves(zoc, catalog, "tac");
  assert.equal(zocMoves.some(function (hex) { return hex.col === 1 && hex.row === 0; }), true);
  assert.equal(zocMoves.some(function (hex) { return hex.col === 3; }), false);
  assert.equal(Engine.moveUnit(zoc, catalog, "tac", 2, 0).ok, false);

  const pinned = battle(
    ["......."],
    [piece("tac", "tactical", "player", 1, 0), piece("foe", "tactical", "enemy", 2, 0)]
  );
  const escape = Engine.legalMoves(pinned, catalog, "tac");
  assert.deepEqual(escape.map(function (hex) { return hex.col; }).sort(), [0]);
});

test("combat deals repository-derived damage and removes destroyed units", function () {
  const state = battle(
    [".."],
    [piece("tac", "tactical", "player", 0, 0), piece("foe", "tactical", "enemy", 1, 0)],
    { rngQueue: [6, 6, 1] }
  );
  const shot = Engine.attackUnit(state, catalog, "tac", "foe", "ranged");
  assert.equal(shot.ok, true);
  const foe = shot.state.units.find(function (unit) { return unit.instanceId === "foe"; });
  assert.equal(foe.hp, 6);
  assert.equal(foe.alive, true);
  assert.equal(Engine.attackUnit(shot.state, catalog, "tac", "foe", "ranged").ok, false);

  const saved = battle(
    [".."],
    [piece("tac", "tactical", "player", 0, 0), piece("foe", "tactical", "enemy", 1, 0)],
    { rngQueue: [6, 6, 6] }
  );
  const savedShot = Engine.attackUnit(saved, catalog, "tac", "foe", "ranged");
  assert.equal(savedShot.state.units[1].hp, 7);

  const lethal = battle(
    [".."],
    [piece("tac", "tactical", "player", 0, 0), piece("foe", "tactical", "enemy", 1, 0)],
    { rngQueue: [6, 6, 1] }
  );
  lethal.units[1].hp = 2;
  const killed = Engine.attackUnit(lethal, catalog, "tac", "foe", "ranged");
  const dead = killed.state.units.find(function (unit) { return unit.instanceId === "foe"; });
  assert.equal(dead.alive, false);
  assert.equal(dead.hp, 0);
  assert.equal(killed.state.outcome, "victory");

  const far = battle(
    ["......"],
    [piece("tac", "tactical", "player", 0, 0), piece("foe", "tactical", "enemy", 5, 0)]
  );
  assert.equal(Engine.legalAttacks(far, catalog, "tac").length, 0);
  assert.equal(Engine.attackUnit(far, catalog, "tac", "foe", "ranged").ok, false);

  const armour = battle(
    [".."],
    [piece("tac", "tactical", "player", 0, 0), piece("pred", "predator", "enemy", 1, 0)],
    { rngQueue: [6, 6] }
  );
  const glance = Engine.attackUnit(armour, catalog, "tac", "pred", "ranged");
  assert.equal(glance.state.units[1].hp, 5);
  assert.match(glance.state.log.join(" "), /fails to wound|Armour/);

  const tank = battle(
    [".."],
    [piece("las", "heavy_support", "player", 0, 0), piece("pred", "predator", "enemy", 1, 0)],
    { rngQueue: [6, 6] }
  );
  const pen = Engine.attackUnit(tank, catalog, "las", "pred", "ranged");
  assert.equal(pen.state.units[1].hp, 2);
  assert.equal(pen.state.units[1].alive, true);
});

test("turns, the AI reply, and victory conditions resolve", function () {
  const melee = battle(
    [".."],
    [piece("foe", "warsmith", "enemy", 1, 0), piece("tac", "tactical", "player", 0, 0)],
    { rngQueue: [6, 6, 1] }
  );
  const handed = Engine.endPlayerTurn(melee);
  assert.equal(handed.state.phase, "ai");
  const reply = Ai.aiActNext(handed.state, catalog);
  const player = reply.state.units.find(function (unit) { return unit.instanceId === "tac"; });
  assert.ok(player.hp < 10);
  assert.match(reply.state.log.join("\n"), /Warsmith|hits/);

  const march = battle(
    ["......."],
    [piece("foe", "tactical", "enemy", 0, 0), piece("tac", "tactical", "player", 6, 0)]
  );
  const aiPhase = Engine.endPlayerTurn(march).state;
  const stepped = Ai.aiActNext(aiPhase, catalog);
  const enemy = stepped.state.units.find(function (unit) { return unit.instanceId === "foe"; });
  assert.ok(enemy.col > 0);
  assert.equal(enemy.acted, true);
  const finished = Ai.runAiTurn(stepped.state, catalog);
  assert.equal(finished.phase, "player");
  assert.equal(finished.turn, 2);

  const clock = battle(
    ["....", "...."],
    [
      piece("tac", "tactical", "player", 0, 1),
      piece("foe", "tactical", "enemy", 3, 1)
    ],
    { maxTurns: 1, needed: 1, map: { objectives: [{ id: "far", name: "Far gate", col: 1, row: 1, owner: "enemy" }] } }
  );
  const expired = Ai.runAiTurn(Engine.endPlayerTurn(clock).state, catalog);
  assert.equal(expired.outcome, "defeat");
  assert.equal(expired.phase, "over");

  const held = battle(
    ["...."],
    [
      piece("tac", "tactical", "player", 0, 0),
      piece("foe", "tactical", "enemy", 3, 0)
    ],
    {
      maxTurns: 1,
      needed: 1,
      map: {
        objectives: [
          { id: "near", name: "Near gate", col: 0, row: 0, owner: "enemy" },
          { id: "other", name: "Other gate", col: 1, row: 0, owner: "enemy" }
        ]
      }
    }
  );
  const night = Ai.runAiTurn(Engine.endPlayerTurn(held).state, catalog);
  assert.equal(night.outcome, "victory");
  assert.match(night.outcomeText, /Night falls/);

  const sweep = battle(
    [".."],
    [piece("las", "heavy_support", "player", 0, 0), piece("pred", "predator", "enemy", 1, 0)],
    { rngQueue: [6, 6, 6, 6, 6, 6] }
  );
  sweep.units[1].hp = 1;
  const won = Engine.attackUnit(sweep, catalog, "las", "pred", "ranged");
  assert.equal(won.state.outcome, "victory");
  assert.equal(won.state.phase, "over");
  assert.equal(Engine.moveUnit(won.state, catalog, "las", 1, 0).ok, false);
});

test("built-in scenario script matches the importable JSON", function () {
  assert.deepEqual(builtinScenario, scenario);
});

test("every portrait and banner the catalog or scenario names is in this repo", function () {
  const root = path.join(__dirname, "..");
  const paths = new Set();
  catalog.units.forEach(function (unit) {
    if (unit.art) paths.add(unit.art);
  });
  Object.keys(catalog.factions).forEach(function (id) {
    const faction = catalog.factions[id];
    if (faction.banner) paths.add(faction.banner);
    if (faction.marine) paths.add(faction.marine);
  });
  scenario.order.forEach(function (unit) {
    if (unit.art) paths.add(unit.art);
  });
  assert.ok(paths.size > 0);
  paths.forEach(function (rel) {
    assert.equal(rel.indexOf(".."), -1, rel);
    assert.equal(fs.existsSync(path.join(root, rel)), true, "missing " + rel);
  });
});

test("iron gate scenario imports and the gate can be seen down the road", function () {
  const imported = Engine.interpretImport(scenario);
  assert.equal(imported.kind, "scenario");
  assert.equal(imported.map.provenance, "original-placeholder");
  assert.equal(imported.map.cols, 14);
  assert.equal(imported.map.rows, 11);
  const game = Engine.createGame({
    catalog: catalog,
    map: imported.map,
    order: imported.order,
    sides: imported.sides,
    seed: 3001
  });
  assert.equal(game.units.length, 14);
  assert.equal(game.phase, "player");
  assert.equal(Engine.summary(game).enemyUnits, 7);
  assert.equal(Engine.summary(game).held, 0);
  const west = game.objectives.find(function (objective) { return objective.id === "west"; });
  assert.equal(west.owner, "enemy");

  assert.equal(Engine.losClear(game, 6, 9, 6, 3), true);
  assert.equal(game.terrain[3][2], "rubble");
  var probe = game;
  var reached = false;
  for (var step = 0; step < 8 && !reached; step++) {
    var sig = probe.units.find(function (unit) { return unit.instanceId === "if-sigismund"; });
    if (sig.col === 2 && sig.row === 3) { reached = true; break; }
    var choices = Engine.legalMoves(probe, catalog, "if-sigismund");
    assert.ok(choices.length > 0, "Sigismund has a move on step " + step);
    choices.sort(function (a, b) {
      return Engine.hexDistance(a.col, a.row, 2, 3) - Engine.hexDistance(b.col, b.row, 2, 3);
    });
    probe = Engine.moveUnit(probe, catalog, "if-sigismund", choices[0].col, choices[0].row).state;
    var movedSig = probe.units.find(function (unit) { return unit.instanceId === "if-sigismund"; });
    movedSig.moved = false;
    movedSig.acted = false;
  }
  var sigEnd = probe.units.find(function (unit) { return unit.instanceId === "if-sigismund"; });
  assert.equal(sigEnd.col, 2);
  assert.equal(sigEnd.row, 3);
  const predatorMoves = Engine.legalMoves(game, catalog, "if-pred");
  assert.ok(predatorMoves.length > 0);
  assert.equal(Engine.legalMoves(game, catalog, "iw-vin").length, 0);

  assert.throws(function () { Engine.interpretImport({ format: "panzer-general" }); }, /Unsupported/);
  assert.throws(function () {
    Engine.normalizeMap({
      format: "panzerhammer-map-v1",
      cols: 3,
      rows: 1,
      terrainRows: [".."],
      objectives: []
    });
  }, /expected 3/);
  assert.throws(function () {
    Engine.normalizeMap({
      format: "panzerhammer-map-v1",
      cols: 2,
      rows: 1,
      terrainRows: ["w."],
      objectives: [{ id: "bad", name: "Bad", col: 0, row: 0, owner: "enemy" }]
    });
  }, /impassable/);
});
