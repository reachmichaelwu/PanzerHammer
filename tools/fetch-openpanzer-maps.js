#!/usr/bin/env node
/**
 * Download Open Panzer scenario XML and map images for private local play.
 *
 * The files are Panzer General 2 derivatives (Ubisoft copyright). This script
 * writes them only under private-maps/, which is gitignored. Do not commit
 * that folder, the XML, the images, or the bundles generated from them.
 *
 * Open Panzer's source tree (nicupavel/openpanzer) gitignores
 * resources/scenarios/data/*.xml and resources/maps/images. The same paths
 * are published in the Open Panzer deployment repo (nicupavel/panzermarshal).
 * Each download tries the source repo first, then the deployment repo.
 *
 * Usage:
 *   node tools/fetch-openpanzer-maps.js
 *   node tools/fetch-openpanzer-maps.js --scenario bc_it_bre.xml
 *   node tools/fetch-openpanzer-maps.js --all --limit 5
 *
 * Then open index.html and choose Private maps, or Import a JSON file from
 * private-maps/scenarios/. Both work from a file:// page.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const loader = require("./openpanzer-loader");

const SOURCES = [
  "https://raw.githubusercontent.com/nicupavel/openpanzer/master/",
  "https://raw.githubusercontent.com/nicupavel/panzermarshal/master/"
];
const LIST_URL = "https://api.github.com/repos/nicupavel/panzermarshal/contents/resources/scenarios/data?ref=master";
const DEST = path.resolve(__dirname, "..", "private-maps");

function usage() {
  console.error("Usage: node tools/fetch-openpanzer-maps.js [--scenario name.xml]... [--all] [--limit N]");
  console.error("Writes private-maps/ only. Those files stay off the public repo.");
}

function parseArgs(argv) {
  const args = { scenarios: [], all: false, limit: 0, help: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--limit") args.limit = Number(argv[++i] || 0);
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
    else if (arg === "--scenario" || arg === "-s") args.scenarios.push(argv[++i] || "");
    else if (arg.startsWith("--scenario=")) args.scenarios.push(arg.slice("--scenario=".length));
    else {
      console.error("Unknown argument: " + arg);
      args.help = true;
    }
  }
  args.scenarios = args.scenarios.filter(Boolean).map(function (name) {
    return name.toLowerCase().endsWith(".xml") ? name : name + ".xml";
  });
  return args;
}

function insideDest(file) {
  const resolved = path.resolve(file);
  return resolved === DEST || resolved.startsWith(DEST + path.sep);
}

function writeFile(file, data) {
  if (!insideDest(file)) throw new Error("Refusing to write outside private-maps: " + file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

async function download(relativePath) {
  const errors = [];
  for (const base of SOURCES) {
    const url = base + relativePath.replace(/^\//, "");
    const response = await fetch(url, { headers: { "User-Agent": "panzerhammer-private-maps" } });
    if (response.ok) {
      return { bytes: Buffer.from(await response.arrayBuffer()), url: url };
    }
    errors.push(response.status + " " + url);
  }
  throw new Error("Could not download " + relativePath + "\n" + errors.join("\n"));
}

async function listScenarios() {
  const response = await fetch(LIST_URL, {
    headers: {
      "User-Agent": "panzerhammer-private-maps",
      "Accept": "application/vnd.github+json"
    }
  });
  if (!response.ok) throw new Error("Could not list scenarios (" + response.status + ").");
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Scenario list was not a directory listing.");
  return data.filter(function (item) { return item && String(item.name || "").endsWith(".xml"); })
    .map(function (item) { return item.name; })
    .sort();
}

function scenarioId(filename) {
  return path.basename(filename, ".xml").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function writeBundle(id, scenario) {
  const scenarioFile = path.join(DEST, "scenarios", id + ".json");
  const bundleFile = path.join(DEST, "bundles", id + ".js");
  const body = JSON.stringify(scenario, null, 2);
  writeFile(scenarioFile, body + "\n");
  writeFile(bundleFile, "var PANZERHAMMER_PRIVATE_SCENARIO = " + body + ";\n");
}

function rebuildCatalog() {
  const dir = path.join(DEST, "scenarios");
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter(function (name) { return name.endsWith(".json"); }).sort().map(function (name) {
    const scenario = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const id = name.replace(/\.json$/, "");
    return {
      id: id,
      name: scenario.map && scenario.map.name || id,
      cols: scenario.map && scenario.map.cols || 0,
      rows: scenario.map && scenario.map.rows || 0,
      bundle: "private-maps/bundles/" + id + ".js",
      scenario: "private-maps/scenarios/" + id + ".json",
      image: scenario.map && scenario.map.image || ""
    };
  });
  const catalog = "var PANZERHAMMER_PRIVATE_CATALOG = " + JSON.stringify(entries, null, 2) + ";\n";
  writeFile(path.join(DEST, "catalog.js"), catalog);
  return entries;
}

async function fetchOne(filename) {
  const id = scenarioId(filename);
  const xmlFile = path.join(DEST, "raw", id + ".xml");
  const downloaded = await download("resources/scenarios/data/" + filename);
  writeFile(xmlFile, downloaded.bytes);
  const xml = downloaded.bytes.toString("utf8");
  const scenario = loader.parseOpenPanzerXml(xml, {
    id: id,
    imageDir: "private-maps/images"
  });
  const imageName = scenario.map.image ? path.basename(scenario.map.image) : "";
  if (imageName) {
    const imageFile = path.join(DEST, "images", imageName);
    if (!fs.existsSync(imageFile)) {
      const image = await download("resources/maps/images/" + imageName);
      writeFile(imageFile, image.bytes);
      console.log("image " + imageName + " from " + image.url);
    } else {
      console.log("image " + imageName + " already present");
    }
  } else {
    console.log("no map image named in " + filename + "; terrain hexes only");
  }
  writeBundle(id, scenario);
  console.log("scenario " + filename + " → private-maps/bundles/" + id + ".js (" + scenario.map.cols + "×" + scenario.map.rows + ", " + scenario.order.length + " units)");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  console.log("Private use only. Open Panzer / Panzer General maps stay in private-maps/ and must not be committed.");
  let names = args.scenarios.slice();
  if (args.all || !names.length && args.limit) {
    names = await listScenarios();
  }
  if (!names.length) names = ["tutorial.xml"];
  if (args.limit > 0) names = names.slice(0, args.limit);
  for (const name of names) {
    await fetchOne(name);
  }
  const entries = rebuildCatalog();
  console.log("Wrote private-maps/catalog.js with " + entries.length + " map(s).");
  console.log("Open index.html and choose Private maps, or Import private-maps/scenarios/<id>.json.");
}

main().catch(function (error) {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
