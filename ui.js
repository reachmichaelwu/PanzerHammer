(function () {
  "use strict";

  var Engine = window.PanzerHammer;
  var Ai = window.PanzerHammerAi;
  var catalog = window.PANZERHAMMER_CATALOG;
  var byId = Engine.catalogMap(catalog);

  var canvas = document.getElementById("map");
  var ctx = canvas.getContext("2d");
  var game = null;
  var builtIn = null;
  var activeDoc = null;
  var selected = null;
  var inspected = null;
  var attackTarget = null;
  var hover = null;
  var layout = null;
  var busy = false;
  var toastTimer = 0;

  var FILL = {
    clear: ["#8b7352", "#6d5a40"],
    road: ["#cbb892", "#a89068"],
    rubble: ["#6c5b49", "#514536"],
    woods: ["#3e5344", "#2b3b30"],
    fort: ["#8d7b62", "#5e5142"],
    wall: ["#2a2623", "#161412"],
    gate: ["#d2b36a", "#8a6232"],
    water: ["#3c5964", "#243b44"],
    trench: ["#5a4636", "#3a2d22"]
  };

  function asset(path) {
    if (!path) return "";
    return String(path).split("/").map(function (part) { return encodeURIComponent(part); }).join("/");
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function unitAt(col, row) {
    for (var i = 0; i < game.units.length; i++) {
      var unit = game.units[i];
      if (unit.alive && unit.col === col && unit.row === row) return unit;
    }
    return null;
  }

  function findUnit(id) {
    for (var i = 0; i < game.units.length; i++) {
      if (game.units[i].instanceId === id) return game.units[i];
    }
    return null;
  }

  function defOf(unit) {
    return byId[unit.catalogId];
  }

  function setToast(text) {
    var el = document.getElementById("toast");
    el.textContent = text || "";
    clearTimeout(toastTimer);
    if (text) toastTimer = setTimeout(function () { el.textContent = ""; }, 4200);
  }

  function applyResult(result) {
    if (!result.ok) {
      setToast(result.reason);
      return;
    }
    game = result.state;
    var last = result.events && result.events.length ? result.events[result.events.length - 1].text : "";
    if (last) setToast(last);
    var current = selected && findUnit(selected);
    if (!current || !current.alive || current.acted) attackTarget = null;
    render();
  }

  function computeLayout() {
    var frame = canvas.parentElement.clientWidth || 640;
    var maxWidth = Math.max(280, frame - 2);
    var minSize = 20;
    var maxSize = 34;
    var size = maxSize;
    function measures(next) {
      var padX = next * Math.sqrt(3) / 2 + 12;
      var padY = next + 12;
      var width = Math.ceil(padX + next * Math.sqrt(3) * game.cols + 12);
      var height = Math.ceil(padY + next * (1.5 * (game.rows - 1) + 1) + 12);
      return { size: next, padX: padX, padY: padY, width: width, height: height };
    }
    var box = measures(size);
    if (box.width > maxWidth) {
      var factor = Math.sqrt(3) / 2 + Math.sqrt(3) * game.cols;
      size = (maxWidth - 24) / factor;
    }
    if (size < minSize) size = minSize;
    if (size > maxSize) size = maxSize;
    return measures(size);
  }

  function resizeCanvas() {
    layout = computeLayout();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(layout.width * dpr);
    canvas.height = Math.round(layout.height * dpr);
    canvas.style.width = layout.width + "px";
    canvas.style.height = layout.height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function center(col, row) {
    return {
      x: layout.padX + layout.size * Math.sqrt(3) * (col + 0.5 * (row & 1)),
      y: layout.padY + layout.size * 1.5 * row
    };
  }

  function corners(x, y, size) {
    var points = [];
    for (var i = 0; i < 6; i++) {
      var angle = Math.PI / 180 * (60 * i - 30);
      points.push([x + size * Math.cos(angle), y + size * Math.sin(angle)]);
    }
    return points;
  }

  function trace(points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (var i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
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

  function pixelToHex(mx, my) {
    var x = (mx - layout.padX) / layout.size;
    var y = (my - layout.padY) / layout.size;
    var q = (Math.sqrt(3) / 3) * x - (1 / 3) * y;
    var r = (2 / 3) * y;
    var cube = cubeRound({ x: q, y: -q - r, z: r });
    return {
      col: cube.x + (cube.z - (cube.z & 1)) / 2,
      row: cube.z
    };
  }

  function drawTerrainMark(id, x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = "rgba(246, 240, 230, 0.35)";
    ctx.fillStyle = "rgba(246, 240, 230, 0.28)";
    ctx.lineWidth = 1.25;
    if (id === "woods") {
      for (var i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * size * 0.28, size * 0.2);
        ctx.lineTo(i * size * 0.28 - size * 0.16, size * 0.42);
        ctx.lineTo(i * size * 0.28 + size * 0.16, size * 0.42);
        ctx.fill();
      }
    } else if (id === "water") {
      ctx.beginPath();
      ctx.moveTo(-size * 0.4, 0);
      ctx.bezierCurveTo(-size * 0.2, -size * 0.16, size * 0.05, size * 0.16, size * 0.4, 0);
      ctx.stroke();
    } else if (id === "wall") {
      ctx.fillRect(-size * 0.42, -size * 0.08, size * 0.84, size * 0.16);
    } else if (id === "gate") {
      ctx.strokeRect(-size * 0.22, -size * 0.28, size * 0.44, size * 0.56);
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.28);
      ctx.lineTo(0, size * 0.28);
      ctx.stroke();
    } else if (id === "fort") {
      ctx.strokeRect(-size * 0.22, -size * 0.22, size * 0.44, size * 0.44);
    } else if (id === "road") {
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.45);
      ctx.lineTo(0, size * 0.45);
      ctx.stroke();
    } else if (id === "trench") {
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(-size * 0.35, size * 0.12);
      ctx.lineTo(size * 0.35, size * 0.12);
      ctx.stroke();
    } else if (id === "rubble") {
      ctx.fillRect(-size * 0.2, -size * 0.05, size * 0.12, size * 0.1);
      ctx.fillRect(size * 0.05, size * 0.08, size * 0.14, size * 0.1);
    }
    ctx.restore();
  }

  function drawMap() {
    ctx.clearRect(0, 0, layout.width, layout.height);
    var moves = [];
    var attacks = [];
    if (game.phase === "player" && selected && !busy) {
      var active = findUnit(selected);
      if (active && active.alive && !active.acted && active.side === "player") {
        moves = Engine.legalMoves(game, catalog, selected);
        attacks = Engine.legalAttacks(game, catalog, selected);
      }
    }
    var moveKeys = {};
    moves.forEach(function (hex) { moveKeys[hex.col + "," + hex.row] = true; });
    var attackKeys = {};
    attacks.forEach(function (attack) {
      var target = findUnit(attack.targetId);
      if (target) attackKeys[target.col + "," + target.row] = true;
    });

    for (var row = 0; row < game.rows; row++) {
      for (var col = 0; col < game.cols; col++) {
        var terrain = game.terrain[row][col];
        var point = center(col, row);
        var poly = corners(point.x, point.y, layout.size * 0.96);
        var colors = FILL[terrain] || FILL.clear;
        var gradient = ctx.createLinearGradient(point.x, point.y - layout.size, point.x, point.y + layout.size);
        gradient.addColorStop(0, colors[0]);
        gradient.addColorStop(1, colors[1]);
        trace(poly);
        ctx.fillStyle = gradient;
        ctx.fill();
        if (moveKeys[col + "," + row]) {
          ctx.fillStyle = "rgba(96, 176, 112, 0.42)";
          ctx.fill();
        }
        if (attackKeys[col + "," + row]) {
          ctx.fillStyle = "rgba(196, 72, 54, 0.38)";
          ctx.fill();
        }
        ctx.strokeStyle = "rgba(20, 16, 12, 0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
        var objective = null;
        for (var o = 0; o < game.objectives.length; o++) {
          if (game.objectives[o].col === col && game.objectives[o].row === row) objective = game.objectives[o];
        }
        if (!unitAt(col, row)) drawTerrainMark(terrain, point.x, point.y, layout.size);
        if (objective) {
          ctx.beginPath();
          ctx.moveTo(point.x, point.y - layout.size * 0.58);
          ctx.lineTo(point.x + layout.size * 0.14, point.y - layout.size * 0.28);
          ctx.lineTo(point.x - layout.size * 0.14, point.y - layout.size * 0.28);
          ctx.closePath();
          ctx.fillStyle = objective.owner === "player" ? "#e2b657" : "#d4654e";
          ctx.fill();
          ctx.strokeStyle = "#1a1612";
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = "#1a1612";
          ctx.font = "700 " + Math.max(9, Math.round(layout.size * 0.28)) + "px Source Sans 3, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          var mark = objective.id === "west" ? "W" : objective.id === "east" ? "E" : "G";
          ctx.fillText(mark, point.x, point.y - layout.size * 0.4);
        }
        if (hover && hover.col === col && hover.row === row) {
          trace(poly);
          ctx.strokeStyle = "rgba(246, 240, 230, 0.85)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    game.units.forEach(function (unit) {
      if (!unit.alive) return;
      var point = center(unit.col, unit.row);
      var radius = layout.size * 0.46;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = unit.side === "player" ? "#3a2e18" : "#3a221c";
      ctx.fill();
      ctx.lineWidth = unit.instanceId === selected || unit.instanceId === inspected ? 3.5 : 2;
      ctx.strokeStyle = unit.side === "player" ? "#e2b657" : "#d4654e";
      ctx.stroke();
      ctx.fillStyle = "#f6f0e6";
      ctx.font = "700 " + Math.max(10, Math.round(layout.size * 0.32)) + "px Source Sans 3, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(unit.token, point.x, point.y - 2);
      var bar = radius * 1.3;
      var ratio = unit.maxHp ? Math.max(0, unit.hp / unit.maxHp) : 0;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(point.x - bar / 2, point.y + radius * 0.35, bar, 4);
      ctx.fillStyle = ratio > 0.4 ? "#e2b657" : "#d4654e";
      ctx.fillRect(point.x - bar / 2, point.y + radius * 0.35, bar * ratio, 4);
    });
  }

  function formatChars(chars) {
    if (!chars) return "";
    return Object.keys(chars).map(function (key) { return key + " " + chars[key]; }).join(" · ");
  }

  function renderCard() {
    var card = document.getElementById("unit-card");
    card.replaceChildren();
    var unit = inspected && findUnit(inspected);
    if (!unit) {
      var empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Select a unit on the map or in the roster to read its catalog profile.";
      card.appendChild(empty);
      return;
    }
    var def = defOf(unit);
    var described = Engine.describeUnit(def);
    var img = document.createElement("img");
    img.alt = "";
    img.src = asset(unit.art || def.art);
    var body = document.createElement("div");
    var title = document.createElement("h2");
    title.textContent = unit.name;
    var meta = document.createElement("p");
    meta.className = "meta";
    var side = game.sides[unit.side] ? game.sides[unit.side].label : unit.side;
    meta.textContent = side + " · " + (def.category || described.mobility) + (unit.alive ? "" : " · destroyed");
    var hp = document.createElement("p");
    hp.className = "stats";
    hp.textContent = "HP " + unit.hp + "/" + unit.maxHp + " · Move " + described.move +
      " · Range " + described.range + " · Ranged " + described.attackRanged +
      (def.melee ? " · Melee " + described.attackMelee : " · No melee row") +
      " · Defense " + described.defense;
    var source = document.createElement("p");
    source.className = "source";
    source.textContent = (def.source.profileName || def.name) + " — " + formatChars(def.source.characteristics);
    var weapon = document.createElement("p");
    weapon.className = "source";
    var rangeNote = def.ranged.rangeEstimated ? " Range is estimated." : "";
    var fallback = def.ranged.fallback ? " Shooting profile is a flagged Bolt Pistol fallback." : "";
    weapon.textContent = "Shoots " + def.ranged.name + " (" + def.ranged.rangeLabel + ", " + def.ranged.type + ")." +
      rangeNote + fallback + (def.melee ? " Strikes with " + def.melee.name + "." : "");
    body.append(title, meta, hp, source, weapon);
    var bar = document.createElement("div");
    bar.className = "hp";
    var fill = document.createElement("span");
    fill.style.width = (unit.maxHp ? Math.max(0, unit.hp / unit.maxHp) * 100 : 0) + "%";
    bar.appendChild(fill);
    body.appendChild(bar);
    card.append(img, body);
  }

  function renderWeapons() {
    var box = document.getElementById("weapons");
    box.replaceChildren();
    if (!selected || !attackTarget || game.phase !== "player" || busy) return;
    var attacks = Engine.legalAttacks(game, catalog, selected).filter(function (attack) {
      return attack.targetId === attackTarget;
    });
    attacks.forEach(function (attack) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "danger";
      button.textContent = (attack.mode === "melee" ? "Strike" : "Fire") + " · " + attack.weapon +
        " · typical " + attack.expected;
      button.addEventListener("click", function () {
        applyResult(Engine.attackUnit(game, catalog, selected, attack.targetId, attack.mode));
      });
      box.appendChild(button);
    });
  }

  function renderRoster() {
    var root = document.getElementById("roster");
    root.replaceChildren();
    ["player", "enemy"].forEach(function (side) {
      var heading = document.createElement("h3");
      heading.textContent = game.sides[side].label;
      root.appendChild(heading);
      game.units.filter(function (unit) { return unit.side === side; }).forEach(function (unit) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "unit-btn " + side + (unit.alive ? "" : " dead") +
          (unit.instanceId === selected || unit.instanceId === inspected ? " active" : "");
        var name = document.createElement("span");
        name.textContent = unit.token + " " + unit.name;
        var hp = document.createElement("span");
        hp.textContent = unit.alive ? unit.hp + "/" + unit.maxHp : "lost";
        button.append(name, hp);
        button.addEventListener("click", function () {
          inspected = unit.instanceId;
          if (unit.side === "player" && unit.alive && !unit.acted && game.phase === "player") {
            selected = unit.instanceId;
            attackTarget = null;
          }
          render();
        });
        root.appendChild(button);
      });
    });
  }

  function renderLog() {
    var log = document.getElementById("log");
    log.replaceChildren();
    game.log.slice(-12).forEach(function (line) {
      var p = document.createElement("p");
      p.textContent = line;
      log.appendChild(p);
    });
    log.scrollTop = log.scrollHeight;
  }

  function renderStatus() {
    var summary = Engine.summary(game);
    var turn = document.getElementById("turn-label");
    turn.textContent = "Turn " + summary.turn + " of " + summary.maxTurns + " · " +
      summary.held + "/" + summary.objectives + " strongpoints";
    var chip = document.getElementById("phase-chip");
    chip.className = "chip";
    if (summary.outcome) {
      chip.textContent = summary.outcome === "victory" ? "Victory" : "Defeat";
      chip.classList.add("over", summary.outcome);
      setToast(summary.outcomeText);
    } else if (summary.phase === "ai" || busy) {
      chip.textContent = "Iron Warriors acting";
      chip.classList.add("enemy");
    } else {
      chip.textContent = "Your orders";
    }
    document.getElementById("end-turn").disabled = busy || summary.phase !== "player" || !!summary.outcome;
    document.getElementById("hold").disabled = busy || !selected || summary.phase !== "player" || !!summary.outcome;
    var active = selected && findUnit(selected);
    document.getElementById("hold").disabled = document.getElementById("hold").disabled || !active || !active.alive || active.acted;
    canvas.setAttribute("aria-label", document.getElementById("battle-name").textContent + ". " + turn.textContent);
    var hint = document.getElementById("hint");
    if (hover && hover.col >= 0 && hover.col < game.cols && hover.row >= 0 && hover.row < game.rows) {
      var terrain = Engine.TERRAIN[game.terrain[hover.row][hover.col]];
      var occ = unitAt(hover.col, hover.row);
      var objectiveHere = game.objectives.find(function (item) { return item.col === hover.col && item.row === hover.row; });
      hint.textContent = terrain.name +
        (objectiveHere ? " · " + objectiveHere.name + " (" + (objectiveHere.owner === "player" ? "Fists" : "Iron Warriors") + ")" : "") +
        (occ ? " · " + occ.name : "");
    }
  }

  function render() {
    if (!game) return;
    resizeCanvas();
    drawMap();
    renderStatus();
    renderCard();
    renderWeapons();
    renderRoster();
    renderLog();
  }

  function onCanvasClick(event) {
    if (!game || busy || game.outcome || game.phase !== "player") return;
    var rect = canvas.getBoundingClientRect();
    var mx = (event.clientX - rect.left) * (layout.width / rect.width);
    var my = (event.clientY - rect.top) * (layout.height / rect.height);
    var hex = pixelToHex(mx, my);
    if (hex.col < 0 || hex.row < 0 || hex.col >= game.cols || hex.row >= game.rows) return;
    var occupant = unitAt(hex.col, hex.row);
    if (occupant && occupant.side === "player") {
      inspected = occupant.instanceId;
      if (!occupant.acted) {
        selected = occupant.instanceId;
        attackTarget = null;
      }
      render();
      return;
    }
    if (selected) {
      var active = findUnit(selected);
      if (active && active.alive && !active.acted) {
        var moves = Engine.legalMoves(game, catalog, selected);
        var move = moves.find(function (item) { return item.col === hex.col && item.row === hex.row; });
        if (move && !occupant) {
          attackTarget = null;
          applyResult(Engine.moveUnit(game, catalog, selected, hex.col, hex.row));
          return;
        }
        if (occupant && occupant.side === "enemy") {
          inspected = occupant.instanceId;
          var attacks = Engine.legalAttacks(game, catalog, selected).filter(function (attack) {
            return attack.targetId === occupant.instanceId;
          });
          if (attacks.length === 1) {
            attackTarget = null;
            applyResult(Engine.attackUnit(game, catalog, selected, occupant.instanceId, attacks[0].mode));
            return;
          }
          attackTarget = attacks.length > 1 ? occupant.instanceId : null;
          if (!attacks.length) setToast(active.name + " cannot reach " + occupant.name + " from here.");
          render();
          return;
        }
      }
    }
    if (occupant) {
      inspected = occupant.instanceId;
      render();
    }
  }

  async function endTurn() {
    if (!game || busy || game.phase !== "player" || game.outcome) return;
    busy = true;
    render();
    var step = Engine.endPlayerTurn(game);
    game = step.state;
    render();
    var wait = reducedMotion() ? 0 : 420;
    while (game.phase === "ai" && !game.outcome) {
      if (wait) await delay(wait);
      step = Ai.aiActNext(game, catalog);
      game = step.state;
      if (step.events && step.events.length) setToast(step.events[step.events.length - 1].text);
      render();
    }
    busy = false;
    selected = null;
    attackTarget = null;
    render();
  }

  function boot(doc, seed) {
    activeDoc = doc;
    var imported = Engine.interpretImport(doc);
    if (!imported.order) throw new Error("That file has terrain but no order of battle.");
    game = Engine.createGame({
      catalog: catalog,
      map: imported.map,
      order: imported.order,
      sides: imported.sides,
      seed: seed
    });
    document.getElementById("battle-name").textContent = game.name;
    document.getElementById("battle-sub").textContent = game.provenance === "original-placeholder"
      ? "Original fortress field. A placeholder, because Panzer Marshal map licensing is unclear."
      : "Imported battlefield · " + (game.provenance || "custom");
    selected = game.units.find(function (unit) { return unit.side === "player" && unit.alive; });
    selected = selected ? selected.instanceId : null;
    inspected = selected;
    attackTarget = null;
    render();
  }

  function importDocument(doc) {
    var imported = Engine.interpretImport(doc);
    if (imported.kind === "scenario") {
      boot(doc, imported.seed === undefined ? (Date.now() % 100000) : imported.seed);
      setToast("Scenario imported.");
      return;
    }
    var order = game.units.map(function (unit) {
      return {
        instanceId: unit.instanceId,
        catalogId: unit.catalogId,
        side: unit.side,
        col: unit.col,
        row: unit.row,
        name: unit.name,
        token: unit.token,
        art: unit.art
      };
    });
    var next = Engine.createGame({
      catalog: catalog,
      map: imported.map,
      order: order,
      sides: game.sides,
      seed: game.seed,
      maxTurns: imported.map.maxTurns,
      needed: imported.map.needed
    });
    game = next;
    document.getElementById("battle-name").textContent = game.name;
    document.getElementById("battle-sub").textContent = "Imported map. The previous order of battle was redeployed on the new field.";
    setToast("Map imported. Units were redeployed on their recorded hexes.");
    render();
  }

  function openCodex() {
    var body = document.getElementById("codex-body");
    body.replaceChildren();
    var inBattle = {};
    if (game) game.units.forEach(function (unit) { inBattle[unit.catalogId] = true; });
    catalog.units.forEach(function (def) {
      var described = Engine.describeUnit(def);
      var button = document.createElement("button");
      button.type = "button";
      button.className = "unit-btn";
      button.textContent = def.name + (inBattle[def.id] ? " · on the field" : " · codex only");
      var detail = document.createElement("div");
      detail.hidden = true;
      var lines = [
        formatChars(def.source.characteristics),
        "Profile " + (def.source.profileName || "") + " from " + (def.source.profileFile || def.source.statsFile) + ".",
        "PanzerHammer: move " + described.move + ", range " + described.range + " hexes, HP " + described.hp +
          ", ranged score " + described.attackRanged + " (" + described.attackRangedMoved + " after moving), melee score " +
          described.attackMelee + ", defense " + described.defense + " on clear ground.",
        "Weapon " + def.ranged.name + " from " + def.ranged.weaponTable + ". Range " + def.ranged.rangeLabel +
          (def.ranged.rangeEstimated ? " (estimated)" : " from " + def.ranged.rangeSource) + ".",
        def.melee ? "Melee row " + def.melee.name + " from " + def.melee.weaponTable + "." : "No melee row in the charge table; close combat uses model WS, A, and S.",
        def.points ? "Points base " + def.points.base + " for " + def.points.minModels + " model(s)." : ""
      ];
      lines.forEach(function (line) {
        if (!line) return;
        var p = document.createElement("p");
        p.className = "source";
        p.textContent = line;
        detail.appendChild(p);
      });
      button.addEventListener("click", function () { detail.hidden = !detail.hidden; });
      body.append(button, detail);
    });
    document.getElementById("codex").hidden = false;
  }

  document.getElementById("end-turn").addEventListener("click", endTurn);
  document.getElementById("hold").addEventListener("click", function () {
    if (!selected) return;
    applyResult(Engine.restUnit(game, catalog, selected));
  });
  document.getElementById("restart").addEventListener("click", function () {
    var doc = activeDoc || builtIn;
    if (!doc) return;
    boot(doc, game ? game.seed : 3001);
    setToast("The Iron Gate is redeployed.");
  });
  document.getElementById("reshuffle").addEventListener("click", function () {
    var source = activeDoc || builtIn;
    if (!source) return;
    boot(source, (Date.now() >>> 0) % 100000);
    setToast("Same battle, new combat rolls. Seed " + game.seed + ".");
  });
  document.getElementById("help-open").addEventListener("click", function () { document.getElementById("help").hidden = false; });
  document.getElementById("help-close").addEventListener("click", function () { document.getElementById("help").hidden = true; });
  document.getElementById("codex-open").addEventListener("click", openCodex);
  document.getElementById("codex-close").addEventListener("click", function () { document.getElementById("codex").hidden = true; });
  document.getElementById("import-btn").addEventListener("click", function () {
    document.getElementById("import-file").click();
  });
  document.getElementById("import-file").addEventListener("change", function (event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        importDocument(JSON.parse(String(reader.result)));
      } catch (error) {
        setToast(error.message || "Could not import that file.");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  });
  canvas.addEventListener("click", onCanvasClick);
  canvas.addEventListener("mousemove", function (event) {
    if (!layout || !game) return;
    var rect = canvas.getBoundingClientRect();
    var hex = pixelToHex(
      (event.clientX - rect.left) * (layout.width / rect.width),
      (event.clientY - rect.top) * (layout.height / rect.height)
    );
    if (!hover || hover.col !== hex.col || hover.row !== hex.row) {
      hover = hex;
      drawMap();
      renderStatus();
    }
  });
  window.addEventListener("resize", function () { if (game) render(); });
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      document.getElementById("help").hidden = true;
      document.getElementById("codex").hidden = true;
    } else if ((event.key === "e" || event.key === "E") && document.activeElement === document.body) {
      endTurn();
    } else if (event.key === "?" ) {
      document.getElementById("help").hidden = false;
    }
  });

  function showLoadError(error) {
    var message = (error && error.message) || "Could not load the Iron Gate scenario.";
    document.getElementById("turn-label").textContent = message;
    setToast(message);
  }

  if (window.PANZERHAMMER_BUILTIN_SCENARIO) {
    try {
      builtIn = window.PANZERHAMMER_BUILTIN_SCENARIO;
      boot(builtIn, 3001);
    } catch (error) {
      showLoadError(error);
    }
  } else {
    // Optional path for a static server that has the JSON and not the script.
    // file:// cannot fetch local JSON, so index.html loads scenarios/iron-gate.js.
    fetch("scenarios/iron-gate.json")
      .then(function (response) {
        if (!response.ok) throw new Error("Could not load the Iron Gate scenario.");
        return response.json();
      })
      .then(function (doc) {
        builtIn = doc;
        boot(doc, 3001);
      })
      .catch(showLoadError);
  }
})();
