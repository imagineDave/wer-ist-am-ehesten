// Gemeinsamer Code für die Abstimmung (index.html) und die Frageneinreichung (fragen/index.html).
// Stellt alles unter window.WIAE bereit.
(function (g) {
  "use strict";

  const REPO_RAW = "https://raw.githubusercontent.com/imagineDave/wer-ist-am-ehesten/main/";

  // Eigener Kanal nur für eingereichte Fragen (getrennt von den Stimmen).
  // scripts/archive-questions.mjs liest den Namen hier heraus.
  const QUESTION_TOPIC = "wiae-507bf71c5d0d1c72233d-fragen";
  const QUESTION_BASE = "https://ntfy.sh/" + QUESTION_TOPIC;
  const SUBMITTED_FILE = "submitted-questions.json";

  const SWITCH_HOUR = 22;   // Wechsel jeden Sonntag um 22 Uhr deutscher Zeit
  const PER_WEEK = 16;      // Fragen pro Woche
  const MIN_LEN = 10, MAX_LEN = 140;
  // Wer in den letzten 10 Minuten vor dem Wechsel einreicht, landet eine Woche später.
  // So berechnen alle Handys rund um 22 Uhr garantiert dieselben Fragen.
  const BUFFER_S = 600;
  const USER_TAG = "Von euch";

  // ---------- Wochen ----------
  // Wanduhrzeit in Berlin als "UTC-Millisekunden" (Sommer-/Winterzeit erledigt Intl)
  function berlinWallMs(d) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute);
  }
  // Wochennummer: Uhr um 2 Stunden vorstellen, dann ist "Sonntag 22 Uhr" = "Montag 0 Uhr"
  function berlinDay(d = new Date()) {
    const days = Math.floor((berlinWallMs(d) + (24 - SWITCH_HOUR) * 3600000) / 86400000);
    return "w" + Math.floor((days + 3) / 7); // 1.1.1970 war ein Donnerstag, +3 richtet auf Montag aus
  }
  function dayNumber(key) { return parseInt(key.slice(1), 10); }
  const weekOfTime = (sec) => dayNumber(berlinDay(new Date(sec * 1000)));
  // Ende der Woche: der Sonntag, an dem um 22 Uhr gewechselt wird
  const dateLabel = (key) => new Date((dayNumber(key) * 7 + 3) * 86400000)
    .toLocaleDateString("de-DE", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
  const weekKey = (n) => "w" + n;

  // ---------- Hilfen ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const normalize = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const cleanText = (s) => String(s).replace(/\s+/g, " ").trim();

  // ---------- Eingereichte Fragen laden ----------
  // Nachrichten im Fragen-Kanal:
  //   { k: "q", text: "Wer …?" }       neue Frage
  //   { k: "del", target: "s<id>" }    Spielleitung nimmt eine Frage aus der Warteschlange
  function parseEvent(ev) {
    if (!ev || ev.event !== "message" || typeof ev.id !== "string") return null;
    let body;
    try { body = JSON.parse(ev.message); } catch (e) { return null; }
    if (!body || typeof body !== "object") return null;
    const time = Number(ev.time) || 0;
    if (body.k === "q" && typeof body.text === "string") {
      const text = cleanText(body.text).slice(0, MAX_LEN);
      if (text.length < MIN_LEN) return null;
      return { kind: "q", id: "s" + ev.id, time, text };
    }
    if (body.k === "del" && typeof body.target === "string") return { kind: "del", id: ev.id, time, target: body.target };
    return null;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(url + ": HTTP " + res.status);
    return res.json();
  }

  // Archiv (GitHub) + was ntfy.sh gerade noch vorhält (~12 h). Wirft einen Fehler, wenn etwas fehlt:
  // Mit unvollständigen Daten würde dieses Handy andere Wochenfragen berechnen als die anderen.
  async function loadSubmissions(relRoot = "") {
    const bust = "?t=" + Math.floor(Date.now() / 300000);
    let archive;
    try { archive = await fetchJson(REPO_RAW + SUBMITTED_FILE + bust); }
    catch (e) { archive = await fetchJson(relRoot + SUBMITTED_FILE + bust); }
    const res = await fetch(QUESTION_BASE + "/json?poll=1&since=all", { cache: "no-store" });
    if (!res.ok) throw new Error("ntfy: HTTP " + res.status);
    const live = (await res.text()).split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
    const byId = new Map();
    for (const ev of [...(Array.isArray(archive) ? archive : []), ...live]) {
      const p = parseEvent(ev);
      if (p && !byId.has(p.id)) byId.set(p.id, p);
    }
    return [...byId.values()].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async function submitQuestion(text) {
    const res = await fetch(QUESTION_BASE, { method: "POST", body: JSON.stringify({ k: "q", text: cleanText(text) }) });
    if (!res.ok) { const err = new Error("HTTP " + res.status); err.status = res.status; throw err; }
    const ev = await res.json();
    return parseEvent(ev);
  }
  async function deleteQuestion(target) {
    const res = await fetch(QUESTION_BASE, { method: "POST", body: JSON.stringify({ k: "del", target }) });
    if (!res.ok) { const err = new Error("HTTP " + res.status); err.status = res.status; throw err; }
    return parseEvent(await res.json());
  }

  // ---------- Warteschlange ----------
  // Verteilt die eingereichten Fragen auf Wochen: in der Reihenfolge des Einreichens, bis zu 16 pro Woche.
  // Eine Frage kann frühestens in der Woche nach dem Einreichen drankommen. Hängt nur von Daten ab,
  // die vor Wochenbeginn feststanden, deshalb ändern sich die Fragen der laufenden Woche nie.
  // upTo: letzte Woche (Zahl), die berechnet wird. Ergebnis: Map Woche -> [Fragen], plus Warteschlange.
  function schedule(events, upTo) {
    const subs = [], delWeek = new Map();
    for (const e of events) {
      if (e.kind === "q") subs.push({ id: e.id, text: e.text, time: e.time, from: weekOfTime(e.time + BUFFER_S) + 1 });
      else if (e.kind === "del" && !delWeek.has(e.target)) delWeek.set(e.target, weekOfTime(e.time + BUFFER_S));
    }
    const byWeek = new Map(), weekOf = new Map();
    if (subs.length) {
      const first = Math.min(...subs.map((s) => s.from));
      for (let w = first; w <= upTo; w++) {
        const take = [];
        for (const s of subs) {
          if (take.length >= PER_WEEK) break;
          if (weekOf.has(s.id) || s.from > w) continue;
          const dw = delWeek.get(s.id);
          if (dw !== undefined && dw < w) continue; // vor Beginn dieser Woche gelöscht
          take.push(s);
        }
        for (const s of take) weekOf.set(s.id, w);
        if (take.length) byWeek.set(w, take);
      }
    }
    for (const s of subs) {
      s.week = weekOf.get(s.id);           // Woche, in der sie drankommt (falls schon berechnet)
      s.deleted = delWeek.has(s.id);
    }
    return { byWeek, subs };
  }

  // Wie geht es weiter, wenn niemand mehr etwas einreicht? Für die Anzeige auf der Einreichungsseite.
  function project(events, currentWeek) {
    const nQ = events.filter((e) => e.kind === "q").length;
    return schedule(events, currentWeek + Math.ceil(nQ / PER_WEEK) + 2);
  }

  g.WIAE = {
    QUESTION_TOPIC, SWITCH_HOUR, PER_WEEK, MIN_LEN, MAX_LEN, USER_TAG,
    berlinDay, dayNumber, dateLabel, weekKey, esc, normalize, cleanText,
    loadSubmissions, submitQuestion, deleteQuestion, schedule, project
  };
})(window);
