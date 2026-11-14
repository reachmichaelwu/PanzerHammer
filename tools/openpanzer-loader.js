// Read an Open Panzer scenario XML file and build a PanzerHammer battle on that terrain.
// The XML shape is the one tools/map/mapconvert.py writes: a <map> with rows, cols,
// an image path, and <hex terrain road name victory> entries. Omitted hexes are clear.
// This file is original. It does not include Open Panzer source.
//
// PG2 terrain ids, and the road bitfield (any non-zero value is a road or crossing):
//   0 clear, 1 city, 2 airfield, 3 forest, 4 bocage, 5 hill, 6 mountain, 7 sand,
//   8 swamp, 9 ocean, 10 river, 11 fortification, 12 port, 13 stream,
//   14 escarpment, 15 impassable river, 16 rough.
// Road bits point at edges: N=1, NE=2, SE=8, S=16, SW=32, NW=128.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OpenPanzerLoader = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TERRAIN_ID = {
    0: "clear",
    1: "rubble",
    2: "clear",
    3: "woods",
    4: "woods",
    5: "rubble",
    6: "wall",
    7: "clear",
    8: "trench",
    9: "water",
    10: "water",
    11: "fort",
    12: "rubble",
    13: "trench",
    14: "wall",
    15: "water",
    16: "rubble"
  };

  var LETTER = {
    clear: ".",
    road: "r",
    rubble: "b",
    woods: "t",
    fort: "f",
    wall: "w",
    gate: "g",
    water: "u",
    trench: "n"
  };

  // Passability must stay aligned with engine.js TERRAIN. 1 means the unit may deploy.
  var ENTER = {
    clear: { infantry: 1, walker: 1, vehicle: 1 },
    road: { infantry: 1, walker: 1, vehicle: 1 },
    rubble: { infantry: 1, walker: 1, vehicle: 1 },
    woods: { infantry: 1, walker: 1, vehicle: 0 },
    fort: { infantry: 1, walker: 1, vehicle: 0 },
    wall: { infantry: 0, walker: 0, vehicle: 0 },
    gate: { infantry: 1, walker: 1, vehicle: 1 },
    water: { infantry: 0, walker: 0, vehicle: 0 },
    trench: { infantry: 1, walker: 1, vehicle: 1 }
  };

  var ROSTER = [
    { instanceId: "if-sigismund", catalogId: "sigismund", side: "player", token: "SIG", name: "Sigismund", mobility: "infantry" },
    { instanceId: "if-phalanx", catalogId: "phalanx_warder", side: "player", token: "PHX", name: "Phalanx Warders", mobility: "infantry" },
    { instanceId: "if-breach", catalogId: "breacher", side: "player", token: "BRC", name: "Breacher Squad", mobility: "infantry" },
    { instanceId: "if-tac", catalogId: "tactical", side: "player", token: "TAC", name: "Tactical Squad", mobility: "infantry", art: "legions/Imperialfist_Marine.jpg" },
    { instanceId: "if-heavy", catalogId: "heavy_support", side: "player", token: "LAS", name: "Heavy Support Squad", mobility: "infantry" },
    { instanceId: "if-pred", catalogId: "predator", side: "player", token: "PRD", name: "Predator", mobility: "vehicle" },
    { instanceId: "if-con", catalogId: "contemptor", side: "player", token: "CON", name: "Contemptor Dreadnought", mobility: "walker" },
    { instanceId: "iw-war", catalogId: "warsmith", side: "enemy", token: "WSM", name: "Warsmith", mobility: "infantry" },
    { instanceId: "iw-tyr", catalogId: "tyrant_siege_term", side: "enemy", token: "TYR", name: "Tyrant Siege Terminators", mobility: "infantry" },
    { instanceId: "iw-tac", catalogId: "tactical", side: "enemy", token: "TAC", name: "Tactical Squad", mobility: "infantry", art: "legions/ironwarrior_marine.jpg" },
    { instanceId: "iw-heavy", catalogId: "heavy_support", side: "enemy", token: "LAS", name: "Heavy Support Squad", mobility: "infantry" },
    { instanceId: "iw-vin", catalogId: "vindicator", side: "enemy", token: "VIN", name: "Vindicator", mobility: "vehicle" },
    { instanceId: "iw-cat", catalogId: "cataphractii", side: "enemy", token: "CAT", name: "Cataphractii Terminators", mobility: "infantry" },
    { instanceId: "iw-rap", catalogId: "rapier", side: "enemy", token: "RPR", name: "Auxilia Rapier", mobility: "infantry" }
  ];

  function decodeXml(value) {
    return String(value)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function parseAttributes(source) {
    var attrs = {};
    var re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var match;
    while ((match = re.exec(source))) {
      attrs[match[1]] = decodeXml(match[2] !== undefined ? match[2] : match[3]);
    }
    return attrs;
  }

  function parseXml(xml) {
    var text = String(xml).replace(/^\uFEFF/, "");
    var i = 0;

    function skip() {
      while (i < text.length) {
        if (text.substr(i, 4) === "<!--") {
          var comment = text.indexOf("-->", i + 4);
          i = comment < 0 ? text.length : comment + 3;
          continue;
        }
        if (text.substr(i, 2) === "<?") {
          var decl = text.indexOf("?>", i + 2);
          i = decl < 0 ? text.length : decl + 2;
          continue;
        }
        if (/\s/.test(text.charAt(i))) {
          i += 1;
          continue;
        }
        break;
      }
    }

    function parseElement() {
      skip();
      if (i >= text.length || text.charAt(i) !== "<") {
        throw new Error("Expected a tag in the Open Panzer scenario.");
      }
      if (text.substr(i, 2) === "</") return null;
      var close = text.indexOf(">", i + 1);
      if (close < 0) throw new Error("Unclosed tag in the Open Panzer scenario.");
      var raw = text.slice(i + 1, close).trim();
      i = close + 1;
      var selfClosing = /\/$/.test(raw);
      if (selfClosing) raw = raw.replace(/\/$/, "").trim();
      var name = raw.split(/\s/)[0];
      if (!name) throw new Error("Empty tag in the Open Panzer scenario.");
      var children = [];
      if (!selfClosing) {
        while (i < text.length) {
          skip();
          if (text.substr(i, 2) === "</") {
            var end = text.indexOf(">", i + 2);
            if (end < 0) throw new Error("Unclosed tag " + name + ".");
            var endName = text.slice(i + 2, end).trim();
            if (endName !== name) throw new Error("Mismatched tag " + endName + ".");
            i = end + 1;
            break;
          }
          if (text.charAt(i) === "<") {
            var child = parseElement();
            if (child) children.push(child);
          } else {
            var next = text.indexOf("<", i);
            i = next < 0 ? text.length : next;
          }
        }
      }
      return { name: name, attrs: parseAttributes(raw), children: children };
    }

    skip();
    var root = parseElement();
    if (!root || root.name !== "map") throw new Error("Open Panzer scenario is missing a map element.");
    return root;
  }

  function cellTerrain(terrainId, roadValue) {
    if (!Object.prototype.hasOwnProperty.call(TERRAIN_ID, terrainId)) {
      throw new Error("Unknown Panzer General terrain id " + terrainId + ".");
    }
    if (roadValue) return "road";
    return TERRAIN_ID[terrainId];
  }

  function integerAttr(attrs, name, label) {
    if (attrs[name] === undefined || attrs[name] === "") {
      throw new Error(label + " is missing " + name + ".");
    }
    var value = Number(attrs[name]);
    if (!Number.isInteger(value)) throw new Error(label + " has a bad " + name + ".");
    return value;
  }

  function slug(value) {
    var text = String(value || "field").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return text || "field";
  }

  function middleTurn(turnsAttr) {
    var turns = String(turnsAttr || "").split(",").map(function (part) {
      return Number(part.trim());
    }).filter(function (value) { return Number.isInteger(value) && value > 0; });
    if (!turns.length) return 10;
    var mid = turns[Math.floor((turns.length - 1) / 2)];
    if (mid < 6) return 6;
    if (mid > 24) return 24;
    return mid;
  }

  function localImage(imageAttr, imageDir) {
    if (!imageDir) return "";
    var base = String(imageAttr || "").split(/[/\\]/).pop();
    if (!base || base.indexOf("..") >= 0 || !/^[A-Za-z0-9_. -]+$/.test(base)) return "";
    return String(imageDir).replace(/\/$/, "") + "/" + base;
  }

  function explicitImage(value) {
    var text = String(value || "").trim();
    if (!text || text.indexOf("..") >= 0) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return "";
    if (text.charAt(0) === "/" || text.charAt(0) === "\\") return "";
    if (!/^[A-Za-z0-9_./ -]+$/.test(text)) return "";
    return text;
  }

  function canEnter(ground, mobility) {
    return !!(ENTER[ground] && ENTER[ground][mobility]);
  }

  function bandCells(terrain, side, mobility, occupied) {
    var rows = terrain.length;
    var cols = terrain[0].length;
    var band = Math.max(2, Math.ceil(rows * 0.3));
    function collect(minRow, maxRow) {
      var found = [];
      for (var row = minRow; row <= maxRow; row++) {
        for (var col = 0; col < cols; col++) {
          if (occupied[col + "," + row]) continue;
          if (!canEnter(terrain[row][col], mobility)) continue;
          found.push({ col: col, row: row });
        }
      }
      found.sort(function (a, b) { return a.col - b.col || a.row - b.row; });
      return found;
    }
    var home = side === "player"
      ? collect(Math.max(0, rows - band), rows - 1)
      : collect(0, Math.min(rows - 1, band - 1));
    if (home.length) return home;
    if (side === "player") return collect(Math.floor(rows / 2), rows - 1);
    return collect(0, Math.ceil(rows / 2) - 1);
  }

  function takeFarthest(cells, occupied, anchors) {
    var pool = cells.filter(function (cell) { return !occupied[cell.col + "," + cell.row]; });
    if (!pool.length) return null;
    if (!anchors.length) return pool[Math.floor((pool.length - 1) / 2)];
    var best = null;
    var bestDistance = -1;
    pool.forEach(function (cell) {
      var distance = Infinity;
      anchors.forEach(function (anchor) {
        var step = Math.abs(anchor.col - cell.col) + Math.abs(anchor.row - cell.row);
        if (step < distance) distance = step;
      });
      if (distance > bestDistance || (distance === bestDistance && best && (cell.col < best.col || (cell.col === best.col && cell.row < best.row)))) {
        bestDistance = distance;
        best = cell;
      }
    });
    return best;
  }

  function deploy(terrain, objectives, reserveObjectives) {
    var occupied = {};
    if (reserveObjectives) {
      objectives.forEach(function (objective) {
        occupied[objective.col + "," + objective.row] = true;
      });
    }
    var placed = {};
    ["player", "enemy"].forEach(function (side) {
      var roster = ROSTER.filter(function (unit) { return unit.side === side; });
      var anchors = [];
      var vehiclesFirst = roster.filter(function (unit) { return unit.mobility === "vehicle"; })
        .concat(roster.filter(function (unit) { return unit.mobility !== "vehicle"; }));
      vehiclesFirst.forEach(function (unit) {
        var cells = bandCells(terrain, side, unit.mobility, occupied);
        var spot = takeFarthest(cells, occupied, anchors);
        if (!spot) return;
        occupied[spot.col + "," + spot.row] = true;
        placed[unit.instanceId] = spot;
        anchors.push(spot);
      });
    });
    return ROSTER.filter(function (unit) { return placed[unit.instanceId]; }).map(function (unit) {
      var spot = placed[unit.instanceId];
      var entry = {
        instanceId: unit.instanceId,
        catalogId: unit.catalogId,
        side: unit.side,
        col: spot.col,
        row: spot.row,
        token: unit.token,
        name: unit.name
      };
      if (unit.art) entry.art = unit.art;
      return entry;
    });
  }

  function bothSides(order) {
    return order.some(function (unit) { return unit.side === "player"; }) &&
      order.some(function (unit) { return unit.side === "enemy"; });
  }

  function fallbackObjective(terrain) {
    var rows = terrain.length;
    var cols = terrain[0].length;
    var midRow = Math.floor(rows / 2);
    var midCol = Math.floor(cols / 2);
    var best = null;
    var bestDistance = Infinity;
    for (var row = 0; row < rows; row++) {
      for (var col = 0; col < cols; col++) {
        if (!canEnter(terrain[row][col], "infantry")) continue;
        var distance = Math.abs(row - midRow) + Math.abs(col - midCol);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { col: col, row: row };
        }
      }
    }
    if (!best) return [];
    return [{ id: "center", name: "Center", col: best.col, row: best.row, owner: "enemy" }];
  }

  function parseOpenPanzerXml(xml, options) {
    options = options || {};
    var root = parseXml(xml);
    var cols = integerAttr(root.attrs, "cols", "Map");
    var rows = integerAttr(root.attrs, "rows", "Map");
    if (cols < 2 || rows < 2 || cols > 80 || rows > 80) {
      throw new Error("Map size " + cols + "×" + rows + " is outside the 2..80 range.");
    }
    var grid = [];
    for (var row = 0; row < rows; row++) {
      var line = [];
      for (var col = 0; col < cols; col++) line.push("clear");
      grid.push(line);
    }
    var names = {};
    var victory = [];
    root.children.forEach(function (el) {
      if (el.name !== "hex") return;
      var col = integerAttr(el.attrs, "col", "Hex");
      var hexRow = integerAttr(el.attrs, "row", "Hex");
      if (col < 0 || hexRow < 0 || col >= cols || hexRow >= rows) {
        throw new Error("Hex " + col + "," + hexRow + " is outside the map.");
      }
      var terrainId = el.attrs.terrain === undefined || el.attrs.terrain === "" ? 0 : Number(el.attrs.terrain);
      if (!Number.isInteger(terrainId)) throw new Error("Hex " + col + "," + hexRow + " has a bad terrain id.");
      var road = el.attrs.road === undefined || el.attrs.road === "" ? 0 : Number(el.attrs.road);
      if (!Number.isFinite(road)) throw new Error("Hex " + col + "," + hexRow + " has a bad road value.");
      grid[hexRow][col] = cellTerrain(terrainId, road !== 0);
      if (el.attrs.name) names[col + "," + hexRow] = el.attrs.name;
      if (el.attrs.victory !== undefined && el.attrs.victory !== "") victory.push({ col: col, row: hexRow });
    });

    var objectives = victory.filter(function (hex) {
      return canEnter(grid[hex.row][hex.col], "infantry");
    }).map(function (hex) {
      return {
        id: "vp-" + hex.col + "-" + hex.row,
        name: names[hex.col + "," + hex.row] || "Strongpoint",
        col: hex.col,
        row: hex.row,
        owner: "enemy"
      };
    });
    objectives.sort(function (a, b) { return a.row - b.row || a.col - b.col; });
    if (objectives.length > 12) {
      var kept = [];
      for (var i = 0; i < 12; i++) {
        kept.push(objectives[Math.round(i * (objectives.length - 1) / 11)]);
      }
      var seen = {};
      objectives = kept.filter(function (objective) {
        if (seen[objective.id]) return false;
        seen[objective.id] = true;
        return true;
      });
    }
    if (!objectives.length) objectives = fallbackObjective(grid);

    var order = deploy(grid, objectives, true);
    if (!bothSides(order)) order = deploy(grid, objectives, false);
    if (!bothSides(order)) throw new Error("This map has no room to deploy both forces.");

    var terrainRows = grid.map(function (line) {
      return line.map(function (ground) { return LETTER[ground]; }).join("");
    });
    var name = root.attrs.name || "Open Panzer field";
    var needed = Math.max(1, Math.ceil(objectives.length / 2));
    var image = explicitImage(options.image) || localImage(root.attrs.image, options.imageDir);
    return {
      format: "panzerhammer-scenario-v1",
      seed: 3001,
      sides: {
        player: { id: "imperial_fists", label: "Imperial Fists" },
        enemy: { id: "iron_warriors", label: "Iron Warriors" }
      },
      order: order,
      map: {
        format: "panzerhammer-map-v1",
        id: options.id || slug(name),
        name: name,
        briefing: "Imperial Fists and Iron Warriors deploy on privately loaded Open Panzer terrain (" + name + "). Strongpoints are that scenario's victory hexes. The Panzer General order of battle is not used.",
        provenance: "private-open-panzer",
        provenanceNote: "Converted locally for private play from an Open Panzer scenario XML file. Panzer General 2 maps are Ubisoft copyright and are not part of the public PanzerHammer repository.",
        cols: cols,
        rows: rows,
        maxTurns: middleTurn(root.attrs.turns),
        objectivesNeeded: needed,
        terrainRows: terrainRows,
        objectives: objectives,
        image: image
      }
    };
  }

  return {
    TERRAIN_ID: TERRAIN_ID,
    cellTerrain: cellTerrain,
    parseOpenPanzerXml: parseOpenPanzerXml
  };
});
