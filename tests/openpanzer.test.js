"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Engine = require("../engine");
const loader = require("../tools/openpanzer-loader");
const catalog = require("../catalog");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/synthetic-openpanzer.xml"), "utf8");

function terrainAt(scenario, col, row) {
  return scenario.map.terrainRows[row].charAt(col);
}

function mobility(def) {
  const stats = def.source.stats;
  if (stats.isVehicle) return "vehicle";
  if (/walker/i.test(stats.modelType || "")) return "walker";
  return "infantry";
}

test("synthetic open panzer xml becomes a panzerhammer battlefield", function () {
  const scenario = loader.parseOpenPanzerXml(fixture, { id: "synthetic-drill" });
  assert.equal(scenario.format, "panzerhammer-scenario-v1");
  assert.equal(scenario.map.provenance, "private-open-panzer");
  assert.equal(scenario.map.id, "synthetic-drill");
  assert.equal(scenario.map.cols, 8);
  assert.equal(scenario.map.rows, 8);
  assert.equal(scenario.map.maxTurns, 8);
  assert.equal(scenario.map.objectivesNeeded, 1);
  assert.equal(scenario.map.image, "");
  assert.equal(scenario.map.terrainRows[2].length, 8);

  assert.equal(terrainAt(scenario, 0, 0), "t");
  assert.equal(terrainAt(scenario, 1, 0), "r");
  assert.equal(terrainAt(scenario, 2, 0), "u");
  assert.equal(terrainAt(scenario, 3, 0), "r");
  assert.equal(terrainAt(scenario, 4, 0), ".");
  assert.equal(terrainAt(scenario, 1, 1), "b");
  assert.equal(terrainAt(scenario, 4, 1), "w");
  assert.equal(terrainAt(scenario, 2, 2), "n");
  assert.equal(terrainAt(scenario, 3, 3), "f");
  assert.equal(terrainAt(scenario, 0, 4), "u");
  assert.equal(terrainAt(scenario, 5, 4), "t");
  assert.equal(terrainAt(scenario, 1, 5), "r");
  assert.equal(terrainAt(scenario, 6, 5), "u");
  assert.equal(terrainAt(scenario, 2, 6), "n");
  assert.equal(terrainAt(scenario, 7, 7), "b");

  assert.deepEqual(scenario.map.objectives.map(function (objective) {
    return [objective.name, objective.col, objective.row, objective.owner];
  }), [
    ["North Yard", 1, 1, "enemy"],
    ["Keep", 3, 3, "enemy"]
  ]);

  const seen = {};
  scenario.order.forEach(function (unit) {
    const key = unit.col + "," + unit.row;
    assert.equal(seen[key], undefined);
    seen[key] = unit.instanceId;
    const def = catalog.units.find(function (entry) { return entry.id === unit.catalogId; });
    const ground = Engine.normalizeMap(scenario.map).terrain[unit.row][unit.col];
    assert.notEqual(Engine.TERRAIN[ground][mobility(def)], null);
  });
  assert.equal(scenario.order.filter(function (unit) { return unit.side === "player"; }).length, 7);
  assert.equal(scenario.order.filter(function (unit) { return unit.side === "enemy"; }).length, 7);
  const playerRow = scenario.order.filter(function (unit) { return unit.side === "player"; })
    .reduce(function (sum, unit) { return sum + unit.row; }, 0) / 7;
  const enemyRow = scenario.order.filter(function (unit) { return unit.side === "enemy"; })
    .reduce(function (sum, unit) { return sum + unit.row; }, 0) / 7;
  assert.ok(playerRow > enemyRow);

  const game = Engine.createGame({
    catalog: catalog,
    map: Engine.normalizeMap(scenario.map),
    order: scenario.order,
    sides: scenario.sides,
    seed: scenario.seed
  });
  assert.equal(game.units.length, 14);
  assert.equal(game.image, "");
  assert.ok(Engine.legalMoves(game, catalog, "if-sigismund").length > 0);
  assert.equal(Engine.summary(game).enemyUnits, 7);
});

test("a local image path is kept and a remote or parent path is dropped", function () {
  const withImage = loader.parseOpenPanzerXml(fixture, { imageDir: "private-maps/images" });
  assert.equal(withImage.map.image, "private-maps/images/not-real.png");
  const explicit = loader.parseOpenPanzerXml(fixture, { image: "private-maps/images/drill.png" });
  assert.equal(explicit.map.image, "private-maps/images/drill.png");
  const remote = loader.parseOpenPanzerXml(fixture, { image: "https://example.com/map.png" });
  assert.equal(remote.map.image, "");
  const parent = loader.parseOpenPanzerXml(fixture, { image: "../secret.png" });
  assert.equal(parent.map.image, "");

  const kept = Engine.normalizeMap(Object.assign({}, withImage.map, { terrainRows: withImage.map.terrainRows }));
  assert.equal(kept.image, "private-maps/images/not-real.png");
  const dropped = Engine.normalizeMap({
    format: "panzerhammer-map-v1",
    cols: 1,
    rows: 1,
    terrainRows: ["."],
    objectives: [],
    image: "http://example.com/map.png"
  });
  assert.equal(dropped.image, "");
});

test("unknown terrain, a hex outside the map, and an impassable victory are rejected or skipped", function () {
  assert.throws(function () {
    loader.parseOpenPanzerXml(
      "<map name=\"Bad\" rows=\"4\" cols=\"4\"><hex row=\"0\" col=\"0\" terrain=\"99\"/></map>"
    );
  }, /Unknown Panzer General terrain/);
  assert.throws(function () {
    loader.parseOpenPanzerXml(
      "<map name=\"Bad\" rows=\"4\" cols=\"4\"><hex row=\"0\" col=\"4\" terrain=\"1\"/></map>"
    );
  }, /outside the map/);

  const ocean = loader.parseOpenPanzerXml(
    "<map name=\"Water\" rows=\"4\" cols=\"4\" turns=\"9\">" +
      "<hex row=\"0\" col=\"0\" terrain=\"9\" name=\"Deep\" victory=\"1\"/>" +
      "<hex row=\"1\" col=\"1\" terrain=\"0\"/>" +
    "</map>"
  );
  assert.equal(ocean.map.objectives.some(function (objective) { return objective.name === "Deep"; }), false);
  assert.ok(ocean.map.objectives.length >= 1);
  assert.equal(ocean.map.maxTurns, 9);
});

test("private-maps is gitignored", function () {
  const ignore = fs.readFileSync(path.join(__dirname, "../.gitignore"), "utf8");
  assert.match(ignore, /^private-maps\/$/m);
});
