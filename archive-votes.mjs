// Holt alle Nachrichten, die ntfy.sh gerade noch vorhält, und hängt neue an votes-archive.json an.
// Läuft in der GitHub Action (Node 20, fetch ist eingebaut).
import { readFile, writeFile } from "node:fs/promises";

const FILE = "votes-archive.json";
const KEEP_DAYS = 70; // ältere Nachrichten fliegen raus, damit die Datei klein bleibt

// Den Kanal aus index.html lesen, damit er nur an einer Stelle steht
const html = await readFile("index.html", "utf8");
const topic = html.match(/const TOPIC = "([^"]+)"/)?.[1];
if (!topic) throw new Error("TOPIC in index.html nicht gefunden");

let archive = [];
try { archive = JSON.parse(await readFile(FILE, "utf8")); } catch { /* erste Ausführung */ }

const res = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`);
if (!res.ok) throw new Error(`ntfy.sh antwortet mit HTTP ${res.status}`);
const fresh = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((ev) => ev.event === "message");

const byId = new Map(archive.map((ev) => [ev.id, ev]));
let added = 0;
for (const ev of fresh) {
  if (byId.has(ev.id)) continue;
  // Nur die Felder speichern, die die Seite braucht
  byId.set(ev.id, { id: ev.id, time: ev.time, event: "message", message: ev.message });
  added++;
}

const cutoff = Date.now() / 1000 - KEEP_DAYS * 86400;
const out = [...byId.values()].filter((ev) => ev.time >= cutoff).sort((a, b) => a.time - b.time);

await writeFile(FILE, JSON.stringify(out, null, 0) + "\n");
console.log(`${added} neue Nachrichten, ${out.length} im Archiv.`);
