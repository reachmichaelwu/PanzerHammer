// Greedy Iron Warriors opponent.
// Wounds beat manoeuvre. Otherwise the force walks toward enemy units and
// strongpoints it does not already hold. One activation is move, attack, or both.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine"));
  else root.PanzerHammerAi = factory(root.PanzerHammer);
})(typeof self !== "undefined" ? self : this, function (Engine) {
  "use strict";

  function findUnit(state, id) {
    for (var i = 0; i < state.units.length; i++) {
      if (state.units[i].instanceId === id) return state.units[i];
    }
    return null;
  }

  function positionScore(state, unit, col, row) {
    var score = 0;
    var nearestEnemy = 99;
    state.units.forEach(function (other) {
      if (!other.alive || other.side === unit.side) return;
      var distance = Engine.hexDistance(col, row, other.col, other.row);
      if (distance < nearestEnemy) nearestEnemy = distance;
    });
    if (nearestEnemy < 99) score += (14 - nearestEnemy) * 2;
    state.objectives.forEach(function (objective) {
      var distance = Engine.hexDistance(col, row, objective.col, objective.row);
      if (objective.owner !== unit.side) score += (12 - Math.min(12, distance)) * 3;
      if (distance === 0) score += 6;
    });
    return score;
  }

  function attackValue(attack, target) {
    if (!attack || attack.expected <= 0 || !target) return 0;
    var score = 100 + attack.expected * 10;
    if (attack.expected >= target.hp) score += 25;
    return score;
  }

  function planAction(state, catalog, unit) {
    var best = {
      type: "rest",
      score: positionScore(state, unit, unit.col, unit.row)
    };
    Engine.legalAttacks(state, catalog, unit.instanceId).forEach(function (attack) {
      var score = attackValue(attack, findUnit(state, attack.targetId));
      if (score > best.score) best = { type: "attack", score: score, attack: attack };
    });
    Engine.legalMoves(state, catalog, unit.instanceId).forEach(function (move) {
      var moved = Engine.moveUnit(state, catalog, unit.instanceId, move.col, move.row);
      if (!moved.ok) return;
      var later = Engine.legalAttacks(moved.state, catalog, unit.instanceId);
      var foundShot = false;
      later.forEach(function (attack) {
        var score = attackValue(attack, findUnit(moved.state, attack.targetId)) - 1;
        if (score <= 0) return;
        foundShot = true;
        if (score > best.score) {
          best = {
            type: "move-attack",
            score: score,
            col: move.col,
            row: move.row,
            attack: attack
          };
        }
      });
      if (foundShot) return;
      var score = positionScore(moved.state, unit, move.col, move.row);
      if (score > best.score) best = { type: "move", score: score, col: move.col, row: move.row };
    });
    return best;
  }

  function applyPlan(state, catalog, unit, plan) {
    if (plan.type === "attack") {
      return Engine.attackUnit(state, catalog, unit.instanceId, plan.attack.targetId, plan.attack.mode);
    }
    if (plan.type === "move" || plan.type === "move-attack") {
      var moved = Engine.moveUnit(state, catalog, unit.instanceId, plan.col, plan.row);
      if (!moved.ok || moved.state.outcome || plan.type === "move") {
        if (moved.ok && !moved.state.outcome && plan.type === "move") {
          return Engine.restUnit(moved.state, catalog, unit.instanceId);
        }
        return moved.ok ? moved : Engine.restUnit(state, catalog, unit.instanceId);
      }
      var shot = Engine.attackUnit(
        moved.state,
        catalog,
        unit.instanceId,
        plan.attack.targetId,
        plan.attack.mode
      );
      if (!shot.ok) return Engine.restUnit(moved.state, catalog, unit.instanceId);
      return shot;
    }
    return Engine.restUnit(state, catalog, unit.instanceId);
  }

  function aiActNext(state, catalog) {
    if (state.outcome || state.phase === "over") return { ok: false, reason: "The battle is already decided.", state: state, events: [] };
    if (state.phase !== "ai") return { ok: false, reason: "It is not the enemy phase.", state: state, events: [] };
    var waiting = state.units.filter(function (unit) {
      return unit.alive && unit.side === "enemy" && !unit.acted;
    });
    if (!waiting.length) return Engine.finishAiPhase(state);
    var unit = waiting[0];
    var plan = planAction(state, catalog, unit);
    return applyPlan(state, catalog, unit, plan);
  }

  function runAiTurn(state, catalog) {
    var current = state;
    var guard = 0;
    while (current.phase === "ai" && !current.outcome && guard < 64) {
      var step = aiActNext(current, catalog);
      current = step.state;
      guard += 1;
    }
    return current;
  }

  return { planAction: planAction, aiActNext: aiActNext, runAiTurn: runAiTurn };
});
