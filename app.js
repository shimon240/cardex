import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Languages offered when creating a section by hand; sections for any other
// language appear on their own once Grok returns a word in it.
const LANGS = [
  { code: "en", label: "English", ru: "английский" },
  { code: "de", label: "Deutsch", ru: "немецкий" },
  { code: "fr", label: "Français", ru: "французский" },
  { code: "es", label: "Español", ru: "испанский" },
  { code: "it", label: "Italiano", ru: "итальянский" },
  { code: "pt", label: "Português", ru: "португальский" },
  { code: "he", label: "עברית", ru: "иврит" },
  { code: "pl", label: "Polski", ru: "польский" },
  { code: "zh", label: "中文", ru: "китайский" },
  { code: "ja", label: "日本語", ru: "японский" },
  { code: "ko", label: "한국어", ru: "корейский" },
  { code: "tr", label: "Türkçe", ru: "турецкий" },
  { code: "nl", label: "Nederlands", ru: "нидерландский" },
];

// Leitner boxes: days until the next review after a correct answer from box N.
const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16, 32, 64];
const LEARNED_BOX = 5;
const SESSION_SIZE = 20;

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  user: null,
  cards: [],
  studyLang: store.get("cardex.lang", null),        // current section; null only until cards first load
  extraLangs: store.get("cardex.extraLangs", []),   // sections created by hand, maybe still empty
  direction: store.get("cardex.dir", "from_ru"),
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

// Russian name of a language, capitalized: "Немецкий".
function langName(code) {
  if (!code) return "";
  const ru = LANGS.find((l) => l.code === code)?.ru ?? state.cards.find((c) => c.language === code)?.language_name ?? code;
  return ru.charAt(0).toUpperCase() + ru.slice(1);
}

// Locative form for "На немецком", "На иврите".
function langLocative(code) {
  const name = langName(code).toLowerCase();
  if (/(ий|ый|ой)$/.test(name)) return name.slice(0, -2) + "ом";
  if (/ь$/.test(name)) return name.slice(0, -1) + "и";
  if (/[бвгджзклмнпрстфхцчшщ]$/.test(name)) return name + "е";
  return name;
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

function wordCardHTML(c) {
  const meta = [c.part_of_speech, c.language_name || langName(normLang(c.language)).toLowerCase()].filter(Boolean).map(esc).join(" · ");
  const ipa = c.transcription ? `<span class="ipa">[${esc(c.transcription)}]</span> · ` : "";
  const examples = (c.examples || [])
    .map((e) => `<li><div class="ex">${esc(e.text)}</div><div class="ex-ru">${esc(e.ru)}</div></li>`)
    .join("");
  return `
    <div class="wc-head">
      <div>
        <div class="wc-word">${esc(c.word)}</div>
        <div class="wc-meta">${ipa}${meta}</div>
      </div>
      <button class="speak" type="button" data-speak="${esc(c.word)}" data-lang="${esc(c.language)}" aria-label="Произнести">${speakIcon}</button>
    </div>
    <div class="wc-translation">${esc(c.translation)}</div>
    ${c.meaning ? `<div class="wc-meaning">${esc(c.meaning)}</div>` : ""}
    ${examples ? `<ul class="wc-examples">${examples}</ul>` : ""}`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-speak]");
  if (b) speak(b.dataset.speak, b.dataset.lang);
});

/* ---------- auth ---------- */

let signUpMode = false;

function setAuthMode(signUp) {
  signUpMode = signUp;
  $("#auth-submit").textContent = signUp ? "Создать аккаунт" : "Войти";
  $("#auth-toggle").textContent = signUp ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Создать";
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
        authMsg("Готово! Подтверди адрес по ссылке из письма, потом войди.");
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    const map = {
      "Invalid login credentials": "Неверный email или пароль",
      "Email not confirmed": "Email ещё не подтверждён — проверь почту",
      "User already registered": "Такой пользователь уже есть — войди",
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
        openAddModal();
        $("#text-input").value = pendingText;
        analyze({ text: pendingText });
        pendingText = null;
      }
    }, 0);
  } else {
    state.cards = [];
    showView("dict");
  }
});

/* ---------- data ---------- */

async function loadCards() {
  const { data, error } = await sb.from("cards").select("*").order("created_at", { ascending: false });
  if (error) return toast("Не удалось загрузить словарь: " + error.message);
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
  };
  const { data, error } = await sb.from("cards").insert(row).select().single();
  if (error) {
    if (error.code === "23505") return { duplicate: true };
    throw error;
  }
  state.cards.unshift(data);
  renderAll();
  if (state.studyLang && data.language !== state.studyLang) toast(`Добавлено в раздел «${langName(data.language)}»`);
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
    `<option value="+">+ Добавить язык…</option>`;
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
    $("#lang-options").innerHTML = LANGS.filter((l) => !taken.has(l.code))
      .map((l) => `<button type="button" data-code="${l.code}">${esc(langName(l.code))}</button>`)
      .join("");
    $("#lang-modal").showModal();
    return;
  }
  if (state.session) return toast("Сначала закончи тренировку");
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

/* ---------- add modal ---------- */

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

let closeTimer;

function openAddModal() {
  const d = $("#add-modal");
  clearTimeout(closeTimer);
  d.classList.remove("closing");
  $("#text-input").value = "";
  $("#add-results").innerHTML = "";
  setAddStatus("");
  showAddPane("add");
  if (!d.open) d.showModal();
  $("#text-input").focus({ preventScroll: true });
}

function closeAddModal() {
  const d = $("#add-modal");
  if (!d.open || d.classList.contains("closing")) return;
  d.classList.add("closing");
  // A timer rather than animationend: children's animations bubble up, and hidden tabs may never fire it.
  closeTimer = setTimeout(() => {
    d.classList.remove("closing");
    d.close();
  }, reducedMotion.matches ? 0 : 160);
}

function showAddPane(name) {
  $("#add-pane").hidden = name !== "add";
  $("#manual-pane").hidden = name !== "manual";
  $("#add-title").textContent = name === "manual" ? "Вручную" : "Новое слово";
  $("#add-modal").scrollTop = 0;
}

$("#fab").addEventListener("click", openAddModal);
$("#add-close").addEventListener("click", closeAddModal);
$("#add-modal").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeAddModal();
});
onBackdropClick($("#add-modal"), closeAddModal);

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
  setAddStatus(`<div class="spinner"></div><span>Грок думает…</span>`);
  $("#text-submit").disabled = true;
  try {
    const studyLanguage = state.studyLang ? langName(state.studyLang).toLowerCase() : null;
    const res = await grok({ action: "analyze", studyLanguage, ...payload });
    if (seq !== analyzeSeq) return; // the modal was reopened meanwhile
    if (!res.items?.length) {
      setAddStatus(esc(res.error || "Не нашёл иностранных слов. Попробуй ещё раз."), "error");
      return;
    }
    setAddStatus("");
    renderResults(res.items);
  } catch (err) {
    if (seq === analyzeSeq) setAddStatus("Ошибка: " + esc(err.message), "error");
  } finally {
    $("#text-submit").disabled = false;
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
        <button class="btn ${exists ? "added" : "btn-primary"}" type="button" ${exists ? "disabled" : ""}>${exists ? "Уже в словаре" : "Добавить в словарь"}</button>
      </div>`;
    const btn = el.querySelector(".wc-actions .btn");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await saveCard(item);
        btn.className = "btn added";
        btn.textContent = r.duplicate ? "Уже в словаре" : "Добавлено ✓";
      } catch (err) {
        btn.disabled = false;
        toast("Не сохранилось: " + err.message);
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

// The first meaning and first example are always there; extra rows can be removed.
function manualRow(kind, removable) {
  const el = document.createElement("div");
  el.className = "m-row";
  el.innerHTML = kind === "meaning"
    ? `<input type="text" class="m-meaning" placeholder="Перевод на русский" autocomplete="off" enterkeyhint="next">`
    : `<div class="m-ex">
        <input type="text" class="m-ex-text" placeholder="Пример" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next">
        <input type="text" class="m-ex-ru" placeholder="Перевод примера" autocomplete="off" enterkeyhint="next">
      </div>`;
  if (removable) el.insertAdjacentHTML("beforeend", `<button type="button" class="m-remove" aria-label="Убрать">×</button>`);
  return el;
}

function openManual() {
  $("#manual-form").reset();
  $("#m-meanings").replaceChildren(manualRow("meaning", false));
  $("#m-examples").replaceChildren(manualRow("example", false));
  const codes = [...new Set([...sections().map((s) => s.code), ...LANGS.map((l) => l.code)])];
  $("#m-lang").innerHTML = codes.map((c) => `<option value="${esc(c)}">${esc(langName(c))}</option>`).join("");
  $("#m-lang").value = state.studyLang || state.cards[0]?.language || "en";
  $("#m-word").value = $("#text-input").value.trim();
  showAddPane("manual");
  ($("#m-word").value ? $(".m-meaning") : $("#m-word")).focus({ preventScroll: true });
}

function addManualRow(kind) {
  const list = kind === "meaning" ? $("#m-meanings") : $("#m-examples");
  const row = manualRow(kind, true);
  list.appendChild(row);
  row.querySelector("input").focus();
}

$("#manual-open").addEventListener("click", openManual);
$("#manual-back").addEventListener("click", () => showAddPane("add"));
$("#m-add-meaning").addEventListener("click", () => addManualRow("meaning"));
$("#m-add-example").addEventListener("click", () => addManualRow("example"));
$("#manual-form").addEventListener("click", (e) => {
  e.target.closest(".m-remove")?.closest(".m-row").remove();
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

$("#manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const word = $("#m-word").value.trim();
  const meanings = $$(".m-meaning").map((i) => i.value.trim()).filter(Boolean);
  const missing = !word ? $("#m-word") : !meanings.length ? $(".m-meaning") : null;
  if (missing) {
    missing.classList.add("invalid");
    missing.focus();
    return toast(word ? "Впиши хотя бы одно значение" : "Впиши слово");
  }
  const examples = $$(".m-ex")
    .map((ex) => ({ text: ex.querySelector(".m-ex-text").value.trim(), ru: ex.querySelector(".m-ex-ru").value.trim() }))
    .filter((ex) => ex.text);
  const language = $("#m-lang").value;
  const btn = $("#manual-submit");
  btn.disabled = true;
  try {
    const r = await saveCard({
      word,
      language,
      language_name: langName(language).toLowerCase(),
      translation: meanings.join(", "),
      examples,
    });
    if (r.duplicate) return toast("Это слово уже в словаре");
    closeAddModal();
    if (!state.studyLang || state.studyLang === normLang(language)) toast(`«${word}» в словаре`);
  } catch (err) {
    toast("Не сохранилось: " + err.message);
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
  $('#direction [data-dir="to_ru"]').textContent = `На ${langLocative(state.studyLang)}`;

  const go = $("#learn-go");
  const note = $("#learn-note");
  go.disabled = pool.length === 0;
  if (!pool.length) {
    go.textContent = "Начать";
    note.textContent = `В разделе «${langName(state.studyLang)}» пока нет слов.`;
  } else if (due.length) {
    go.textContent = "Начать";
    note.textContent = "";
  } else {
    go.textContent = "Повторить всё равно";
    note.textContent = "На сегодня всё повторено. Можно пройтись по случайным словам.";
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
    $("#done-summary").textContent = `Правильно ${s.correct} из ${s.index}.`;
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

  const lang = card.language_name || langName(card.language).toLowerCase();
  if (dir === "from_ru") {
    $("#quiz-tag").textContent = `Рус → ${lang}`;
    $("#quiz-prompt").textContent = card.translation;
    $("#quiz-sub").textContent = card.part_of_speech || "";
    $("#quiz-input").placeholder = `Как это на языке: ${lang}?`;
    // Hint: the Russian explanation, or the first example's translation.
    $("#quiz-hint").textContent = card.meaning || card.examples?.[0]?.ru || "";
  } else {
    $("#quiz-tag").textContent = `${lang} → рус`;
    $("#quiz-prompt").textContent = card.word;
    $("#quiz-sub").textContent = [card.transcription && `[${card.transcription}]`, card.part_of_speech].filter(Boolean).join(" · ");
    $("#quiz-input").placeholder = "Перевод на русский";
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
  $("#quiz-check").textContent = "Проверить";
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
      direction: dir,
      language: card.language_name || card.language,
      prompt: dir === "from_ru" ? card.translation : card.word,
      expected: dir === "from_ru" ? card.word : card.translation,
      answer,
    });
    showResult(res.correct, answer, res.feedback);
  } catch (err) {
    toast("Грок не ответил, сверяю по словарю");
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
  const yours = answer && !correct ? `<span class="yours">Твой ответ: ${esc(answer)}</span>` : "";
  v.innerHTML = `${correct ? "Верно!" : answer ? "Не совсем" : "Запомни"}${yours}${feedback ? `<span class="fb">${esc(feedback)}</span>` : ""}`;
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
  if (error) toast("Прогресс не сохранился: " + error.message);
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
  v.textContent = "Засчитано";
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
    ? `В разделе «${langName(state.studyLang)}» пока нет слов.`
    : "Пока пусто. Нажми «+», чтобы добавить первое слово.";
  $("#dict-list").innerHTML = list.map((c) => {
    const boxes = Array.from({ length: LEARNED_BOX }, (_, i) => `<i class="${i < c.box ? "on" : ""}"></i>`).join("");
    return `<div class="dict-item" data-id="${c.id}">
      <button class="dict-row" type="button">
        <div class="dw"><div class="dw-word">${esc(c.word)}</div><div class="dw-tr">${esc(c.translation)}</div></div>
        <div class="boxes" title="Прогресс">${boxes}</div>
      </button>
    </div>`;
  }).join("");
}

$("#dict-search").addEventListener("input", renderDict);

$("#dict-list").addEventListener("click", async (e) => {
  const item = e.target.closest(".dict-item");
  if (!item) return;
  const card = state.cards.find((c) => c.id === item.dataset.id);

  if (e.target.closest(".btn-del")) {
    if (!confirm(`Удалить «${card.word}» из словаря?`)) return;
    const { error } = await sb.from("cards").delete().eq("id", card.id);
    if (error) return toast("Не удалилось: " + error.message);
    state.cards = state.cards.filter((c) => c.id !== card.id);
    renderAll();
    return;
  }
  if (!e.target.closest(".dict-row")) return;

  const open = item.querySelector(".dict-detail");
  $$(".dict-detail").forEach((d) => d.remove());
  if (open) return;
  const detail = document.createElement("div");
  detail.className = "dict-detail";
  detail.innerHTML = `<div class="word-card">${wordCardHTML(card)}</div>
    <button class="btn btn-del" type="button">Удалить</button>`;
  item.appendChild(detail);
});

/* ---------- profile ---------- */

$("#password-form").addEventListener("input", (e) => e.target.classList.remove("invalid"));

$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("#pw-new").value;
  const repeat = $("#pw-repeat").value;
  if (pw.length < 6) {
    $("#pw-new").classList.add("invalid");
    $("#pw-new").focus();
    return toast("Пароль — минимум 6 символов");
  }
  if (repeat !== pw) {
    $("#pw-repeat").classList.add("invalid");
    $("#pw-repeat").focus();
    return toast("Пароли не совпадают");
  }
  const btn = $("#pw-submit");
  btn.disabled = true;
  try {
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) throw error;
    $("#password-form").reset();
    $("#pw-email").value = state.user?.email ?? "";
    toast("Пароль изменён");
  } catch (err) {
    const map = {
      "New password should be different from the old password.": "Новый пароль совпадает со старым",
    };
    toast(map[err.message] ?? "Не получилось: " + err.message);
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
