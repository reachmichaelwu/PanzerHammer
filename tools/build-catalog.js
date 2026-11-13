#!/usr/bin/env node
/**
 * Build catalog.js from a Warhammer30K checkout.
 * Does not invent characteristics. Representative weapons and ranges are
 * chosen by the documented rules in README.md.
 *
 * The Warhammer30K tree is an input only. This script does not modify it.
 *
 * Usage:
 *   node tools/build-catalog.js --source /path/to/Warhammer30K
 *   WARHAMMER30K_ROOT=/path/to/Warhammer30K node tools/build-catalog.js
 *
 * Optional:
 *   --out path/to/catalog.js
 *     Defaults to catalog.js at the PanzerHammer repo root.
 *
 * Required files at the source root:
 *   02-unit-presets.js, 04-points.js, 05-weapon-profiles.js,
 *   07-army-builder-data.js, 12-charge.js, 15-main-app.js,
 *   27-new-recruit-stats-data.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function usage() {
  console.error("Usage: node tools/build-catalog.js --source /path/to/Warhammer30K [--out catalog.js]");
  console.error("   or: WARHAMMER30K_ROOT=/path/to/Warhammer30K node tools/build-catalog.js");
}

function parseArgs(argv) {
  const args = {
    source: process.env.WARHAMMER30K_ROOT || "",
    outFile: path.resolve(__dirname, "../catalog.js"),
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--source" || arg === "-s") args.source = argv[++i] || "";
    else if (arg.startsWith("--source=")) args.source = arg.slice("--source=".length);
    else if (arg === "--out" || arg === "-o") args.outFile = argv[++i] || "";
    else if (arg.startsWith("--out=")) args.outFile = arg.slice("--out=".length);
    else {
      console.error("Unknown argument: " + arg);
      args.help = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help || !args.source) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const root = path.resolve(args.source);
const REQUIRED = [
  "02-unit-presets.js",
  "04-points.js",
  "05-weapon-profiles.js",
  "07-army-builder-data.js",
  "12-charge.js",
  "15-main-app.js",
  "27-new-recruit-stats-data.js"
];
const missing = REQUIRED.filter(function (file) { return !fs.existsSync(path.join(root, file)); });
if (missing.length) {
  console.error("Warhammer30K checkout is missing: " + missing.join(", "));
  console.error("Looked in " + root);
  process.exit(1);
}

function load(file, sandbox) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  vm.runInContext(code, sandbox, { filename: file });
}

const sandbox = vm.createContext({ console });
load("02-unit-presets.js", sandbox);
load("04-points.js", sandbox);
load("05-weapon-profiles.js", sandbox);
load("07-army-builder-data.js", sandbox);
load("12-charge.js", sandbox);
load("27-new-recruit-stats-data.js", sandbox);

function armouryRanges() {
  const text = fs.readFileSync(path.join(root, "15-main-app.js"), "utf8");
  const idx = {};
  const re = /title:\s*"([^"]+)"[\s\S]{0,700}?Range\s+([^,]+),\s*Firepower/g;
  let match;
  while ((match = re.exec(text))) {
    const key = sandbox._wrNorm(match[1]);
    if (key && idx[key] === undefined) idx[key] = match[2].trim();
  }
  return idx;
}

const ARMOURY = armouryRanges();

const IDS = [
  "sigismund",
  "fafnir_rann",
  "alexis_polux",
  "templar_brethren",
  "phalanx_warder",
  "breacher",
  "tactical",
  "heavy_support",
  "contemptor",
  "predator",
  "sicaran",
  "centurion",
  "warsmith",
  "tyrant_siege_term",
  "vindicator",
  "cataphractii",
  "rapier",
];

const ART = {
  sigismund: "artwork/Champion.jpg",
  fafnir_rann: "artwork/Champion.jpg",
  alexis_polux: "artwork/Centurion.jpg",
  templar_brethren: "artwork/Veteran.jpg",
  phalanx_warder: "artwork/Breacher.jpg",
  breacher: "artwork/Breacher.jpg",
  tactical: "artwork/Tactical.jpg",
  heavy_support: "artwork/Heavy_Support.jpg",
  contemptor: "artwork/Contemptor Dreadnaught.jpg",
  predator: "artwork/Predator.jpg",
  sicaran: "artwork/Sicaran.jpg",
  centurion: "artwork/Centurion.jpg",
  warsmith: "artwork/Siege Breaker.jpg",
  tyrant_siege_term: "artwork/Cataphractii Terminator.jpg",
  vindicator: "artwork/VindicatorSiegeTank.jpg",
  cataphractii: "artwork/Cataphractii Terminator.jpg",
  rapier: "artwork/Rapier.jpg",
};

function pickRanged(id) {
  const legion = sandbox.LEGION_WEAPON_PROFILES[id];
  const core = sandbox.WEAPON_PROFILES[id];
  const list = (legion && legion.length ? legion : core) || [];
  const shooting = list.filter(function (w) {
    return w && w.type !== "Melee" && Number(w.shots) > 0;
  });
  const preferred = shooting.find(function (w) {
    return !/maximal|frag|fury of the legion/i.test(w.name || "");
  });
  return {
    weapon: preferred || shooting[0] || null,
    table: legion && legion.length ? "05-weapon-profiles.js LEGION_WEAPON_PROFILES" : "07-army-builder-data.js WEAPON_PROFILES",
  };
}

function boltPistolFallback() {
  const list = sandbox.WEAPON_PROFILES.despoiler || [];
  const pistol = list.find(function (w) { return w.name === "Bolt Pistol"; });
  if (!pistol) throw new Error("Bolt Pistol profile missing from WEAPON_PROFILES.despoiler");
  return pistol;
}

function trimWeapon(w, table, fallback) {
  const info = sandbox.getWeaponRangeInfo(w);
  let rangeInches = info.inches;
  let rangeLabel = info.label;
  let template = !!info.template;
  let rangeEstimated = !!info.estimated;
  let rangeSource = rangeEstimated
    ? "05-weapon-profiles.js type estimate (getWeaponRangeInfo)"
    : "05-weapon-profiles.js getWeaponRangeInfo";
  const armoury = ARMOURY[sandbox._wrNorm(w.name)];
  if (armoury) {
    const parsed = sandbox._weaponRangeFromString(armoury, false);
    if (parsed) {
      rangeInches = parsed.inches;
      rangeLabel = parsed.label;
      template = !!parsed.template;
      rangeEstimated = false;
      rangeSource = "15-main-app.js HELP_WEAPON_ARMOURY_ENTRIES";
    }
  }
  const rules = {};
  Object.keys(w.rules || {}).forEach(function (k) {
    if (w.rules[k]) rules[k] = true;
  });
  return {
    name: w.name,
    shots: w.shots,
    s: w.s,
    ap: w.ap,
    damage: w.damage,
    type: w.type,
    rules: rules,
    rangeInches: rangeInches,
    rangeLabel: rangeLabel,
    template: template,
    rangeEstimated: rangeEstimated,
    rangeSource: rangeSource,
    weaponTable: table,
    fallback: !!fallback,
  };
}

function trimMelee(row) {
  if (!row) return null;
  return {
    name: row.name,
    ws: row.ws,
    s: row.s,
    ap: row.ap,
    i: row.i,
    a: row.a,
    weaponTable: "12-charge.js MELEE_WEAPON_PROFILES",
  };
}

const pistol = boltPistolFallback();
const units = IDS.map(function (id) {
  const preset = sandbox.UNIT_PRESET_BY_ID[id];
  const stats = sandbox.NEW_RECRUIT_UNIT_STATS[id];
  if (!preset) throw new Error("Missing preset " + id);
  if (!stats) throw new Error("Missing New Recruit stats " + id);
  const profile = (stats.modelProfiles || []).find(function (p) { return p.id === stats.sourceProfileId; })
    || (stats.modelProfiles || [])[0]
    || null;
  let picked = pickRanged(id);
  let ranged = picked.weapon ? trimWeapon(picked.weapon, picked.table, false) : null;
  if (!ranged) {
    ranged = trimWeapon(pistol, "07-army-builder-data.js WEAPON_PROFILES.despoiler (Bolt Pistol)", true);
    ranged.fallbackReason = "This unit id has no shooting row in LEGION_WEAPON_PROFILES or WEAPON_PROFILES. The Bolt Pistol row already stored for Despoiler Squad is reused and flagged fallback.";
  }
  const meleeRows = sandbox.MELEE_WEAPON_PROFILES[id] || [];
  return {
    id: id,
    name: preset.name,
    category: sandbox.UNIT_CATEGORY_BY_ID[id] || null,
    models: preset.models,
    points: sandbox.POINTS_DATA[id] || null,
    art: ART[id] || null,
    source: {
      statsFile: "27-new-recruit-stats-data.js",
      statsObject: "NEW_RECRUIT_UNIT_STATS",
      presetFile: "02-unit-presets.js",
      profileId: stats.sourceProfileId || (profile && profile.id) || null,
      profileName: profile ? profile.name : null,
      profileFile: profile ? profile.file : null,
      characteristics: profile ? profile.characteristics : null,
      stats: {
        move: stats.move,
        ws: stats.ws,
        bs: stats.bs,
        s: stats.s,
        t: stats.t,
        w: stats.w,
        i: stats.i,
        a: stats.a,
        ld: stats.ld,
        cl: stats.cl,
        wp: stats.wp,
        int: stats.int,
        sv: stats.sv,
        inv: stats.inv,
        fnp: stats.fnp,
        modelType: stats.modelType,
        isVehicle: !!stats.isVehicle,
        isFlyer: !!stats.isFlyer,
        hp: stats.hp,
        avF: stats.avF,
        avS: stats.avS,
        avR: stats.avR,
      },
    },
    ranged: ranged,
    melee: trimMelee(meleeRows[0] || null),
  };
});

const catalog = {
  generatedFrom: "Warhammer30K repository data files. Regenerate with node tools/build-catalog.js --source /path/to/Warhammer30K",
  newRecruitSource: "Warhammer30K 27-new-recruit-stats-data.js (pinned from BSData horus-heresy-3rd-edition; see new-recruit-stats-reference.json in that checkout)",
  factions: {
    imperial_fists: {
      id: "imperial_fists",
      name: "Imperial Fists",
      numeral: "VII",
      allegiance: "Loyalist",
      banner: "legions/Imperialfist.jpg",
      marine: "legions/Imperialfist_Marine.jpg",
      categoryInPresets: "VII: IMPERIAL FISTS",
    },
    iron_warriors: {
      id: "iron_warriors",
      name: "Iron Warriors",
      numeral: "IV",
      allegiance: "Traitor",
      banner: "legions/Ironwarriors.jpg",
      marine: "legions/ironwarrior_marine.jpg",
      categoryInPresets: "IV: IRON WARRIORS",
    },
  },
  units: units,
};

const out = path.resolve(args.outFile);
const body = "var PANZERHAMMER_CATALOG = " + JSON.stringify(catalog, null, 2) + ";\n"
  + "if (typeof module !== \"undefined\" && module.exports) module.exports = PANZERHAMMER_CATALOG;\n";
fs.writeFileSync(out, body);
console.log("Wrote " + units.length + " units to " + out);
units.forEach(function (u) {
  const s = u.source.stats;
  console.log(
    u.id,
    u.name,
    "M" + s.move,
    s.modelType,
    s.isVehicle ? "AV" + s.avF + " HP" + s.hp : "W" + s.w + " Sv" + s.sv,
    "ranged=" + u.ranged.name + (u.ranged.fallback ? " FALLBACK" : "") + " " + u.ranged.rangeLabel + (u.ranged.rangeEstimated ? "~" : ""),
    "melee=" + (u.melee ? u.melee.name : "none")
  );
});
