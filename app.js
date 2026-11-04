import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Languages offered for the user's own language and when creating a section by hand; sections for any other
// language appear on their own once Grok returns a word in it.
const LANGS = ["en", "ru", "de", "fr", "es", "it", "pt", "he", "pl", "zh", "ja", "ko", "tr", "nl"];

// Leitner boxes: days until the next review after a correct answer from box N.
const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16, 32, 64];
const LEARNED_BOX = 5;
const SESSION_SIZE = 20;

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// "from_ru", "to_ru" and an example's "ru" key are the names saved settings and cards
// already use; they mean "the user's language", state.userLang.
const state = {
  user: null,
  cards: [],
  studyLang: store.get("cardex.lang", null),        // current section; null only until cards first load
  extraLangs: store.get("cardex.extraLangs", []),   // sections created by hand, maybe still empty
  direction: store.get("cardex.dir", "from_ru"),
  userLang: store.get("cardex.userLang", "en"),     // the language Grok writes cards and feedback in
  session: null,
};

/* ---------- utils ---------- */

function toast(msg) {
  const t = $("#toast");
  // An open modal dialog sits in the top layer, so the toast has to live inside it to be seen.
  const host = $("dialog[open]:not(.closing)") ?? document.body;
  if (t.parentNode !== host) host.appendChild(t);
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

function speak(text, lang) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (lang) u.lang = lang;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

const speakIcon = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

// "de-DE" → "de", so a language always maps to one section.
function normLang(code) {
  return String(code || "").toLowerCase().split(/[-_]/)[0] || "und";
}

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

// English name of a language: "de" → "German". Works for any code, including
// old cards whose stored language_name is still in Russian.
function langName(code) {
  if (!code) return "";
  try { return languageNames.of(code); } catch { return code; }
}

async function grok(body) {
  const { data, error } = await sb.functions.invoke("grok", { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch {}
    throw new Error(msg);
  }
  return data;
}

// Clicks on the backdrop land on the dialog itself, outside its box.
function onBackdropClick(dialog, close) {
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) close();
  });
}

/* ---------- word card rendering ---------- */

// A card's meanings with their examples. Older cards have no senses, only one translation with its explanation.
function cardSenses(c) {
  return c.senses?.length ? c.senses : [{ meaning: c.translation, note: c.meaning, examples: c.examples || [] }];
}

function wordCardHTML(c) {
  const meta = [c.part_of_speech, langName(normLang(c.language))].filter(Boolean).map(esc).join(" · ");
  const ipa = c.transcription ? `<span class="ipa">[${esc(c.transcription)}]</span> · ` : "";
  const senses = cardSenses(c);
  const sensesHTML = senses.map((s) => {
    const examples = (s.examples || [])
      .map((e) => `<li><div class="ex">${esc(e.text)}</div><div class="ex-ru">${esc(e.ru)}</div></li>`)
      .join("");
    return `<li>
      <div class="wc-translation">${esc(s.meaning)}</div>
      ${s.note ? `<div class="wc-meaning">${esc(s.note)}</div>` : ""}
      ${examples ? `<ul class="wc-examples">${examples}</ul>` : ""}
    </li>`;
  }).join("");
  return `
    <div class="wc-head">
      <div>
        <div class="wc-word">${esc(c.word)}</div>
        <div class="wc-meta">${ipa}${meta}</div>
      </div>
      <button class="speak" type="button" data-speak="${esc(c.word)}" data-lang="${esc(c.language)}" aria-label="Pronounce">${speakIcon}</button>
    </div>
    <ol class="wc-senses${senses.length > 1 ? " numbered" : ""}">${sensesHTML}</ol>`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-speak]");
  if (b) speak(b.dataset.speak, b.dataset.lang);
});

/* ---------- auth ---------- */

let signUpMode = false;

function setAuthMode(signUp) {
  signUpMode = signUp;
  $("#auth-submit").textContent = signUp ? "Create account" : "Sign in";
  $("#auth-toggle").textContent = signUp ? "Already have an account? Sign in" : "No account? Create one";
  $("#auth-password").autocomplete = signUp ? "new-password" : "current-password";
  authMsg("");
}

function authMsg(text, isError = false) {
  const m = $("#auth-msg");
  m.textContent = text;
  m.classList.toggle("error", isError);
}

$("#auth-toggle").addEventListener("click", () => setAuthMode(!signUpMode));

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const btn = $("#auth-submit");
  btn.disabled = true;
  authMsg("");
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      if (!data.session) {
        setAuthMode(false);
        authMsg("Almost done! Confirm your address using the link in the email, then sign in.");
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    const map = {
      "Invalid login credentials": "Wrong email or password",
      "Email not confirmed": "Email not confirmed yet. Check your inbox.",
      "User already registered": "This user already exists. Sign in instead.",
    };
    authMsg(map[err.message] ?? err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("#logout").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  const user = session?.user ?? null;
  if (user?.id === state.user?.id) return;
  state.user = user;
  $("#auth").hidden = !!user;
  $("#app").hidden = !user;
  if (user) {
    $("#account-email").textContent = user.email;
    $("#pw-email").value = user.email;
    // Defer: awaiting Supabase calls inside this callback can deadlock the auth lock.
    setTimeout(() => {
      loadCards();
      if (pendingText) {
        openAddScreen();
        $("#text-input").value = pendingText;
        analyze({ text: pendingText });
        pendingText = null;
      }
    }, 0);
  } else {
    state.cards = [];
    renderAddScreen(null);
    showView("dict");
  }
});

/* ---------- data ---------- */

async function loadCards() {
  const { data, error } = await sb.from("cards").select("*").order("created_at", { ascending: false });
  if (error) return toast("Couldn't load the dictionary: " + error.message);
  state.cards = data;
  // There is no "all languages" view: start in the language of the newest word.
  if (!state.studyLang) {
    state.studyLang = data[0]?.language ?? "en";
    store.set("cardex.lang", state.studyLang);
  }
  renderAll();
}

async function saveCard(item) {
  const row = {
    word: item.word,
    language: normLang(item.language),
    language_name: item.language_name,
    transcription: item.transcription,
    part_of_speech: item.part_of_speech,
    translation: item.translation,
    meaning: item.meaning,
    examples: item.examples || [],
    senses: item.senses || [],
  };
  const { data, error } = await sb.from("cards").insert(row).select().single();
  if (error) {
    if (error.code === "23505") return { duplicate: true };
    throw error;
  }
  state.cards.unshift(data);
  renderAll();
  if (state.studyLang && data.language !== state.studyLang) toast(`Added to ${langName(data.language)}`);
  return { card: data };
}

/* ---------- navigation ---------- */

let currentView = "dict";

function showView(name) {
  currentView = name;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === "learn" && !state.session) renderLearnStart();
  syncFab();
  window.scrollTo(0, 0);
}

// The + button would cover the answer buttons during a training round.
function syncFab() {
  $("#fab").hidden = currentView === "profile" || (currentView === "learn" && !!state.session);
}

$$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

/* ---------- language sections ---------- */

// Sections in the order their first word was added, then hand-made empty ones.
function sections() {
  const counts = new Map();
  for (const c of [...state.cards].reverse()) counts.set(c.language, (counts.get(c.language) || 0) + 1);
  for (const code of [...state.extraLangs, state.studyLang]) if (code && !counts.has(code)) counts.set(code, 0);
  return [...counts].map(([code, count]) => ({ code, count }));
}

// Native <select> for the picker; the visible pill shows just the current section.
function renderSections() {
  const opt = (code, label, count) => `<option value="${esc(code ?? "")}">${esc(label)} · ${count}</option>`;
  $("#section-select").innerHTML =
    sections().map((s) => opt(s.code, langName(s.code), s.count)).join("") +
    `<option value="+">+ Add language…</option>`;
  $("#section-select").value = state.studyLang ?? "";
  $("#section-label").textContent = langName(state.studyLang);
}

function renderAll() {
  renderSections();
  renderDict();
  if (!state.session) renderLearnStart();
}

function selectSection(code) {
  state.studyLang = code;
  store.set("cardex.lang", state.studyLang);
  renderAll();
}

$("#section-select").addEventListener("change", (e) => {
  const code = e.target.value;
  e.target.value = state.studyLang ?? "";
  if (code === "+") {
    const taken = new Set(sections().map((s) => s.code));
    $("#lang-options").innerHTML = LANGS.filter((code) => !taken.has(code))
      .map((code) => `<button type="button" data-code="${code}">${esc(langName(code))}</button>`)
      .join("");
    $("#lang-modal").showModal();
    return;
  }
  if (state.session) return toast("Finish the training round first");
  selectSection(code);
});

$("#lang-options").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (!state.extraLangs.includes(b.dataset.code)) {
    state.extraLangs.push(b.dataset.code);
    store.set("cardex.extraLangs", state.extraLangs);
  }
  $("#lang-modal").close();
  selectSection(b.dataset.code);
});
onBackdropClick($("#lang-modal"), () => $("#lang-modal").close());

/* ---------- add screen ---------- */

// The screen and its manual pane are history entries, so the phone's back gesture steps back through them.
function renderAddScreen(pane) {
  const screen = $("#add-screen");
  screen.hidden = !pane;
  $("#app").inert = !!pane;
  if (!pane) return;
  $("#add-pane").hidden = pane !== "add";
  $("#manual-pane").hidden = pane !== "manual";
  $("#add-title").textContent = pane === "manual" ? "Manual entry" : "New word";
  screen.scrollTop = 0;
}

function openAddScreen() {
  analyzeSeq++; // a lookup still running belongs to the previous visit
  $("#text-input").value = "";
  $("#add-results").innerHTML = "";
  $("#text-submit").disabled = false;
  setAddStatus("");
  history.pushState({ add: "add" }, "");
  renderAddScreen("add");
  $("#text-input").focus({ preventScroll: true });
}

window.addEventListener("popstate", (e) => renderAddScreen(e.state?.add ?? null));
$("#fab").addEventListener("click", openAddScreen);
$("#add-back").addEventListener("click", () => history.back());

/* ---------- add mode ---------- */

let analyzeSeq = 0;

function setAddStatus(html, kind = "") {
  const s = $("#add-status");
  s.hidden = !html;
  s.className = "status" + (kind ? " " + kind : "");
  s.innerHTML = html || "";
}

async function analyze(payload) {
  const seq = ++analyzeSeq;
  $("#add-results").innerHTML = "";
  setAddStatus(`<div class="spinner"></div><span>Grok is thinking…</span>`);
  $("#text-submit").disabled = true;
  try {
    const studyLanguage = state.studyLang ? langName(state.studyLang) : null;
    const res = await grok({ action: "analyze", studyLanguage, userLanguage: langName(state.userLang), ...payload });
    if (seq !== analyzeSeq) return; // the screen was reopened meanwhile
    if (!res.items?.length) {
      setAddStatus(esc(res.error || "Couldn't find any words. Try again."), "error");
      return;
    }
    setAddStatus("");
    renderResults(res.items);
  } catch (err) {
    if (seq === analyzeSeq) setAddStatus("Error: " + esc(err.message), "error");
  } finally {
    if (seq === analyzeSeq) $("#text-submit").disabled = false;
  }
}

function renderResults(items) {
  const wrap = $("#add-results");
  wrap.innerHTML = "";
  items.forEach((item) => {
    const exists = state.cards.some((c) => c.language === normLang(item.language) && c.word.toLowerCase() === String(item.word).toLowerCase());
    const el = document.createElement("article");
    el.className = "word-card";
    el.innerHTML = `${wordCardHTML(item)}
      <div class="wc-actions">
        <button class="btn ${exists ? "added" : "btn-primary"}" type="button" ${exists ? "disabled" : ""}>${exists ? "Already in dictionary" : "Add to dictionary"}</button>
      </div>`;
    const btn = el.querySelector(".wc-actions .btn");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await saveCard(item);
        btn.className = "btn added";
        btn.textContent = r.duplicate ? "Already in dictionary" : "Added ✓";
      } catch (err) {
        btn.disabled = false;
        toast("Couldn't save: " + err.message);
      }
    });
    wrap.appendChild(el);
  });
}

function submitText() {
  const text = $("#text-input").value.trim();
  if (!text) return;
  $("#text-input").blur();
  analyze({ text });
}

$("#text-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitText();
});
$("#text-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitText();
  }
});

// Text handed over by a link, e.g. an iOS Shortcut: …/cardex/?text=Fernweh
const params = new URLSearchParams(location.search);
let pendingText = params.get("text")?.trim() || null;
if (pendingText) history.replaceState(null, "", location.pathname);

/* ---------- manual entry ---------- */

function exampleRow() {
  const el = document.createElement("div");
  el.className = "m-row";
  el.innerHTML = `<div class="m-ex">
      <input type="text" class="m-ex-text" placeholder="Example" aria-label="Example" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next">
      <input type="text" class="m-ex-ru" placeholder="Example translation" aria-label="Example translation" autocomplete="off" enterkeyhint="next">
    </div>
    <button type="button" class="m-remove" aria-label="Remove example">×</button>`;
  return el;
}

// One meaning with its examples. CSS hides the remove button on the last remaining block or example.
function senseBlock() {
  const el = document.createElement("div");
  el.className = "m-sense";
  const placeholder = `Meaning in ${esc(langName(state.userLang))}`;
  el.innerHTML = `<div class="m-sense-head">
      <span class="m-sense-label"></span>
      <button type="button" class="m-remove" aria-label="Remove meaning">×</button>
    </div>
    <input type="text" class="m-meaning" placeholder="${placeholder}" aria-label="${placeholder}" autocomplete="off" enterkeyhint="next">
    <div class="m-list"></div>
    <button type="button" class="btn-link m-add m-add-example">+ Add example</button>`;
  el.querySelector(".m-list").appendChild(exampleRow());
  return el;
}

function openManual() {
  $("#manual-form").reset();
  $("#m-senses").replaceChildren(senseBlock());
  const codes = [...new Set([...sections().map((s) => s.code), ...LANGS])];
  $("#m-lang").innerHTML = codes.map((c) => `<option value="${esc(c)}">${esc(langName(c))}</option>`).join("");
  $("#m-lang").value = state.studyLang || state.cards[0]?.language || "en";
  $("#m-word").value = $("#text-input").value.trim();
  history.pushState({ add: "manual" }, "");
  renderAddScreen("manual");
  ($("#m-word").value ? $("#m-grammar") : $("#m-word")).focus({ preventScroll: true });
}

$("#manual-open").addEventListener("click", openManual);
$("#m-add-sense").addEventListener("click", () => {
  const block = senseBlock();
  $("#m-senses").appendChild(block);
  block.querySelector(".m-meaning").focus();
});
$("#manual-form").addEventListener("click", (e) => {
  const remove = e.target.closest(".m-remove");
  if (remove) return remove.closest(".m-row, .m-sense").remove();
  const add = e.target.closest(".m-add-example");
  if (add) {
    const row = exampleRow();
    add.previousElementSibling.appendChild(row);
    row.querySelector("input").focus();
  }
});
$("#manual-form").addEventListener("input", (e) => e.target.classList.remove("invalid"));
// Return moves to the next field instead of submitting a half-filled card.
$("#manual-form").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.target.tagName !== "INPUT") return;
  e.preventDefault();
  const inputs = $$("#manual-form input");
  const next = inputs[inputs.indexOf(e.target) + 1];
  next ? next.focus() : e.target.blur();
});

// Reads the blocks, skipping untouched ones. Returns the field to fix when a block is only half filled.
function readSenses() {
  const senses = [];
  for (const block of $$(".m-sense")) {
    const input = block.querySelector(".m-meaning");
    const meaning = input.value.trim();
    const examples = [];
    for (const row of block.querySelectorAll(".m-ex")) {
      const textInput = row.querySelector(".m-ex-text");
      const text = textInput.value.trim();
      const ru = row.querySelector(".m-ex-ru").value.trim();
      if (text) examples.push({ text, ru });
      else if (ru) return { missing: textInput, message: "Enter the example for this translation" };
    }
    if (!meaning && examples.length) return { missing: input, message: "Enter the meaning for this example" };
    if (meaning) senses.push({ meaning, examples });
  }
  return senses.length ? { senses } : { missing: $(".m-meaning"), message: "Enter at least one meaning" };
}

$("#manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const word = $("#m-word").value.trim();
  const { senses, missing, message } = word ? readSenses() : { missing: $("#m-word"), message: "Enter a word" };
  if (missing) {
    missing.classList.add("invalid");
    missing.focus();
    return toast(message);
  }
  const language = $("#m-lang").value;
  const btn = $("#manual-submit");
  btn.disabled = true;
  try {
    const r = await saveCard({
      word,
      language,
      language_name: langName(language),
      part_of_speech: $("#m-grammar").value.trim() || null,
      translation: senses.map((s) => s.meaning).join("; "),
      examples: senses.flatMap((s) => s.examples),
      senses,
    });
    if (r.duplicate) return toast("This word is already in your dictionary");
    history.go(-2); // back past the manual pane and the lookup pane
    if (!state.studyLang || state.studyLang === normLang(language)) toast(`“${word}” added to your dictionary`);
  } catch (err) {
    toast("Couldn't save: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- learn mode ---------- */

function poolCards() {
  return state.cards.filter((c) => c.language === state.studyLang);
}

function dueCards() {
  const now = Date.now();
  return poolCards().filter((c) => new Date(c.due_at).getTime() <= now);
}

function renderLearnStart() {
  const pool = poolCards();
  const due = dueCards();
  $("#stat-due").textContent = due.length;
  $("#stat-total").textContent = pool.length;
  $("#stat-learned").textContent = pool.filter((c) => c.box >= LEARNED_BOX).length;
  $$("#direction button").forEach((b) => b.classList.toggle("active", b.dataset.dir === state.direction));
  // A section in the user's own language has no translation side, so its other side is the meaning.
  $('#direction [data-dir="from_ru"]').textContent = state.studyLang === state.userLang ? "Meaning" : `In ${langName(state.userLang)}`;
  $('#direction [data-dir="to_ru"]').textContent = `In ${langName(state.studyLang)}`;

  const go = $("#learn-go");
  const note = $("#learn-note");
  go.disabled = pool.length === 0;
  if (!pool.length) {
    go.textContent = "Start";
    note.textContent = `No ${langName(state.studyLang)} words yet.`;
  } else if (due.length) {
    go.textContent = "Start";
    note.textContent = "";
  } else {
    go.textContent = "Review anyway";
    note.textContent = "All caught up for today. You can still go through some random words.";
  }
}

$("#direction").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.direction = b.dataset.dir;
  store.set("cardex.dir", state.direction);
  renderLearnStart();
});

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startSession() {
  let queue = dueCards();
  queue = queue.length
    ? queue.sort((a, b) => a.box - b.box || new Date(a.due_at) - new Date(b.due_at)).slice(0, SESSION_SIZE)
    : shuffle([...poolCards()]).slice(0, SESSION_SIZE);
  shuffle(queue);
  state.session = { queue, index: 0, correct: 0, current: null };
  $("#learn-start").hidden = true;
  $("#learn-done").hidden = true;
  $("#learn-session").hidden = false;
  syncFab();
  nextQuestion();
}

function endSession() {
  const s = state.session;
  state.session = null;
  syncFab();
  $("#learn-session").hidden = true;
  if (s && s.index > 0) {
    $("#learn-done").hidden = false;
    $("#done-summary").textContent = `${s.correct} of ${s.index} correct.`;
  } else {
    $("#learn-start").hidden = false;
    renderLearnStart();
  }
}

function nextQuestion() {
  const s = state.session;
  if (s.index >= s.queue.length) return endSession();
  const card = s.queue[s.index];
  const dir = state.direction === "mix" ? (Math.random() < 0.5 ? "from_ru" : "to_ru") : state.direction;
  s.current = { card, dir, answered: false };

  $("#progress-bar").style.width = `${(s.index / s.queue.length) * 100}%`;
  $("#session-count").textContent = `${s.index + 1} / ${s.queue.length}`;

  const lang = langName(card.language);
  const base = card.language === state.userLang ? "Meaning" : langName(state.userLang);
  if (dir === "from_ru") {
    $("#quiz-tag").textContent = `${base} → ${lang}`;
    $("#quiz-prompt").textContent = card.translation;
    $("#quiz-sub").textContent = card.part_of_speech || "";
    $("#quiz-input").placeholder = `How do you say it in ${lang}?`;
    // Hint: the explanation, or the first example's translation.
    $("#quiz-hint").textContent = card.meaning || card.examples?.[0]?.ru || "";
  } else {
    $("#quiz-tag").textContent = `${lang} → ${base}`;
    $("#quiz-prompt").textContent = card.word;
    $("#quiz-sub").textContent = [card.transcription && `[${card.transcription}]`, card.part_of_speech].filter(Boolean).join(" · ");
    $("#quiz-input").placeholder = "What does it mean?";
    $("#quiz-hint").textContent = card.examples?.[0]?.text || "";
  }
  $("#quiz-hint").hidden = true;
  $("#quiz-hint-btn").hidden = !$("#quiz-hint").textContent;

  const qc = $("#quiz-card");
  qc.classList.remove("pop");
  void qc.offsetWidth;
  qc.classList.add("pop");

  $("#quiz-form").hidden = false;
  $("#quiz-result").hidden = true;
  $("#quiz-input").value = "";
  $("#quiz-check").disabled = false;
  $("#quiz-skip").disabled = false;
  $("#quiz-check").textContent = "Check";
  $("#quiz-input").focus({ preventScroll: true });
}

const ARTICLES = /^(der|die|das|the|to|a|an|le|la|les|l'|el|los|las|il|lo|gli|un|une|una|uno|ein|eine)\s+/;
function norm(s) {
  return String(s).toLowerCase().normalize("NFKC").replace(/ё/g, "е").replace(/[.,!?;:()«»"„“”]/g, " ").replace(/\s+/g, " ").trim();
}
function variants(s) {
  return String(s).split(/[,;/]/).map(norm).filter(Boolean).flatMap((v) => [v, v.replace(ARTICLES, "")]);
}

function localMatch(answer, card, dir) {
  const a = norm(answer);
  const a2 = a.replace(ARTICLES, "");
  const expected = dir === "from_ru" ? variants(card.word) : variants(card.translation);
  return expected.includes(a) || expected.includes(a2);
}

async function checkAnswer(answer) {
  const cur = state.session.current;
  if (cur.answered) return;
  const { card, dir } = cur;
  if (!answer) return showResult(false, "", "");
  if (localMatch(answer, card, dir)) return showResult(true, answer, "");

  $("#quiz-check").disabled = true;
  $("#quiz-skip").disabled = true;
  $("#quiz-check").innerHTML = `<div class="spinner"></div>`;
  try {
    const res = await grok({
      action: "check",
      userLanguage: langName(state.userLang),
      direction: dir,
      language: langName(card.language),
      prompt: dir === "from_ru" ? card.translation : card.word,
      expected: dir === "from_ru" ? card.word : card.translation,
      answer,
    });
    showResult(res.correct, answer, res.feedback);
  } catch (err) {
    toast("Grok didn't respond, checking against the dictionary");
    showResult(false, answer, "");
  }
}

function showResult(correct, answer, feedback) {
  const cur = state.session.current;
  cur.answered = true;
  cur.correct = correct;
  $("#quiz-form").hidden = true;
  $("#quiz-result").hidden = false;

  const v = $("#verdict");
  v.className = "verdict " + (correct ? "good" : "bad");
  const yours = answer && !correct ? `<span class="yours">Your answer: ${esc(answer)}</span>` : "";
  v.innerHTML = `${correct ? "Correct!" : answer ? "Not quite" : "Remember this one"}${yours}${feedback ? `<span class="fb">${esc(feedback)}</span>` : ""}`;
  $("#answer-card").innerHTML = `<div class="word-card">${wordCardHTML(cur.card)}</div>`;
  $("#quiz-override").hidden = correct || !answer;
  $("#quiz-next").focus({ preventScroll: true });
  if (correct) speak(cur.card.word, cur.card.language);

  grade(cur.card, correct);
}

async function grade(card, correct) {
  const box = correct ? Math.min(card.box + 1, INTERVAL_DAYS.length - 1) : 0;
  const due = new Date(Date.now() + INTERVAL_DAYS[box] * 86400000);
  const patch = {
    box,
    due_at: due.toISOString(),
    last_reviewed_at: new Date().toISOString(),
    correct_count: card.correct_count + (correct ? 1 : 0),
    wrong_count: card.wrong_count + (correct ? 0 : 1),
  };
  // Remember the pre-answer state so "I was right" can re-grade from it.
  state.session.current.before = { ...card };
  Object.assign(card, patch);
  if (correct) state.session.correct++;
  const { error } = await sb.from("cards").update(patch).eq("id", card.id);
  if (error) toast("Progress wasn't saved: " + error.message);
}

$("#quiz-form").addEventListener("submit", (e) => {
  e.preventDefault();
  checkAnswer($("#quiz-input").value.trim());
});
$("#quiz-skip").addEventListener("click", () => checkAnswer(""));
$("#quiz-hint-btn").addEventListener("click", () => {
  $("#quiz-hint").hidden = false;
  $("#quiz-hint-btn").hidden = true;
});
$("#quiz-next").addEventListener("click", () => {
  state.session.index++;
  nextQuestion();
});
$("#quiz-override").addEventListener("click", () => {
  const cur = state.session.current;
  Object.assign(cur.card, cur.before);
  $("#quiz-override").hidden = true;
  const v = $("#verdict");
  v.className = "verdict good";
  v.textContent = "Counted as correct";
  grade(cur.card, true);
});
$("#learn-go").addEventListener("click", startSession);
$("#session-quit").addEventListener("click", endSession);
$("#learn-again").addEventListener("click", () => {
  $("#learn-done").hidden = true;
  $("#learn-start").hidden = false;
  renderLearnStart();
});

/* ---------- dictionary ---------- */

function renderDict() {
  const q = norm($("#dict-search").value);
  const pool = poolCards();
  const list = pool.filter((c) => !q || norm(c.word).includes(q) || norm(c.translation).includes(q));
  $("#dict-empty").hidden = pool.length > 0;
  $("#dict-empty").textContent = state.cards.length
    ? `No ${langName(state.studyLang)} words yet.`
    : "Nothing here yet. Tap + to add your first word.";
  $("#dict-list").innerHTML = list.map((c) => {
    const boxes = Array.from({ length: LEARNED_BOX }, (_, i) => `<i class="${i < c.box ? "on" : ""}"></i>`).join("");
    return `<div class="dict-item" data-id="${c.id}">
      <button class="dict-row" type="button">
        <div class="dw"><div class="dw-word">${esc(c.word)}</div><div class="dw-tr">${esc(c.translation)}</div></div>
        <div class="boxes" title="Progress">${boxes}</div>
      </button>
    </div>`;
  }).join("");
}

$("#dict-search").addEventListener("input", renderDict);

$("#dict-list").addEventListener("click", (e) => {
  const item = e.target.closest(".dict-item");
  if (item) openSheet(state.cards.find((c) => c.id === item.dataset.id));
});

/* ---------- word card sheet ---------- */

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const sheet = $("#card-sheet");
let sheetCardId = null;

function openSheet(card) {
  sheetCardId = card.id;
  $("#sheet-card").innerHTML = wordCardHTML(card);
  sheet.showModal();
  sheet.querySelector(".sheet-scroll").scrollTop = 0;
}

function closeSheet() {
  if (!sheet.open || sheet.classList.contains("closing")) return;
  sheet.classList.add("closing");
  // A timer rather than animationend: children's animations bubble up, and hidden tabs may never fire it.
  setTimeout(() => {
    sheet.classList.remove("closing");
    sheet.style.transform = "";
    sheet.close();
  }, reducedMotion.matches ? 0 : 200);
}

sheet.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeSheet();
});
onBackdropClick(sheet, closeSheet);

// Drag the grip down to dismiss; a plain tap on it closes too.
const SHEET_DISMISS_PX = 80;
const grip = $("#sheet-grip");
let dragStartY = null;
let dragDistance = 0;

grip.addEventListener("pointerdown", (e) => {
  dragStartY = e.clientY;
  dragDistance = 0;
  grip.setPointerCapture(e.pointerId);
  sheet.classList.add("dragging");
});
grip.addEventListener("pointermove", (e) => {
  if (dragStartY === null) return;
  dragDistance = Math.max(0, e.clientY - dragStartY);
  sheet.style.transform = `translateY(${dragDistance}px)`;
});
function endDrag() {
  if (dragStartY === null) return;
  dragStartY = null;
  sheet.classList.remove("dragging");
  if (dragDistance > SHEET_DISMISS_PX) closeSheet();
  else sheet.style.transform = "";
}
grip.addEventListener("pointerup", endDrag);
grip.addEventListener("pointercancel", endDrag);
grip.addEventListener("click", () => {
  if (dragDistance < 5) closeSheet();
});

$("#sheet-delete").addEventListener("click", async () => {
  const card = state.cards.find((c) => c.id === sheetCardId);
  if (!confirm(`Delete “${card.word}” from your dictionary?`)) return;
  const { error } = await sb.from("cards").delete().eq("id", card.id);
  if (error) return toast("Couldn't delete: " + error.message);
  state.cards = state.cards.filter((c) => c.id !== card.id);
  renderAll();
  closeSheet();
});

/* ---------- profile ---------- */

$("#user-lang").innerHTML = LANGS.map((code) => `<option value="${code}">${esc(langName(code))}</option>`).join("");
$("#user-lang").value = state.userLang;
$("#user-lang").addEventListener("change", (e) => {
  state.userLang = e.target.value;
  store.set("cardex.userLang", state.userLang);
  renderAll();
});

$("#password-form").addEventListener("input", (e) => e.target.classList.remove("invalid"));

$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("#pw-new").value;
  const repeat = $("#pw-repeat").value;
  if (pw.length < 6) {
    $("#pw-new").classList.add("invalid");
    $("#pw-new").focus();
    return toast("Password must be at least 6 characters");
  }
  if (repeat !== pw) {
    $("#pw-repeat").classList.add("invalid");
    $("#pw-repeat").focus();
    return toast("Passwords don't match");
  }
  const btn = $("#pw-submit");
  btn.disabled = true;
  try {
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) throw error;
    $("#password-form").reset();
    $("#pw-email").value = state.user?.email ?? "";
    toast("Password changed");
  } catch (err) {
    toast("Couldn't change password: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- boot ---------- */

renderSections();
setAuthMode(false);
const { data: { session } } = await sb.auth.getSession();
if (!session) {
  $("#auth").hidden = false;
}
