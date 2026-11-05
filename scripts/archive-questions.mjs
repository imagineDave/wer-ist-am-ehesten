// Holt eingereichte Fragen aus ntfy.sh und hängt neue an submitted-questions.json an.
// Anders als bei den Stimmen wird hier nie etwas gelöscht: Die Wochenfragen werden aus der
// kompletten Liste berechnet, ältere Einträge müssen also erhalten bleiben.
// Läuft in der GitHub Action (Node 20, fetch ist eingebaut).
import { readFile, writeFile } from "node:fs/promises";

const FILE = "submitted-questions.json";

// Den Kanal aus shared.js lesen, damit er nur an einer Stelle steht
const shared = await readFile("shared.js", "utf8");
const topic = shared.match(/const QUESTION_TOPIC = "([^"]+)"/)?.[1];
if (!topic) throw new Error("QUESTION_TOPIC in shared.js nicht gefunden");

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
  byId.set(ev.id, { id: ev.id, time: ev.time, event: "message", message: ev.message });
  added++;
}

const out = [...byId.values()].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
// Eine Nachricht pro Zeile, damit die Git-Historie lesbar bleibt
await writeFile(FILE, out.length ? "[\n" + out.map((e) => JSON.stringify(e)).join(",\n") + "\n]\n" : "[]\n");
console.log(`${added} neue Einträge, ${out.length} im Archiv.`);
