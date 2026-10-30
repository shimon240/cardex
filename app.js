import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { openCrop } from "./crop.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const LANGS = [
  { code: null, label: "Авто", ru: null },
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
  studyLang: store.get("cardex.lang", null),
  direction: store.get("cardex.dir", "from_ru"),
  session: null,
};

/* ---------- utils ---------- */

function toast(msg) {
  const t = $("#toast");
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

function langLabel(code) {
  return LANGS.find((l) => l.code === code)?.label ?? code;
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

/* ---------- word card rendering ---------- */

function wordCardHTML(c) {
  const meta = [c.part_of_speech, c.language_name || langLabel(c.language)].filter(Boolean).map(esc).join(" · ");
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
    // Defer: awaiting Supabase calls inside this callback can deadlock the auth lock.
    setTimeout(() => {
      loadCards();
      if (pendingText) {
        showView("add");
        analyze({ text: pendingText });
        pendingText = null;
      }
    }, 0);
  } else {
    state.cards = [];
  }
});

/* ---------- data ---------- */

async function loadCards() {
  const { data, error } = await sb.from("cards").select("*").order("created_at", { ascending: false });
  if (error) return toast("Не удалось загрузить словарь: " + error.message);
  state.cards = data;
  renderDict();
  renderLearnStart();
}

async function saveCard(item) {
  const row = {
    word: item.word,
    language: item.language,
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
  renderDict();
  renderLearnStart();
  return { card: data };
}

/* ---------- navigation ---------- */

const TITLES = { add: "Добавить слово", learn: "Тренировка", dict: "Словарь" };

function showView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  $("#topbar-title").textContent = TITLES[name];
  if (name === "learn" && !state.session) renderLearnStart();
  window.scrollTo(0, 0);
}

$$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

/* ---------- study language ---------- */

function renderLang() {
  $("#lang-label").textContent = langLabel(state.studyLang);
  $("#lang-options").innerHTML = LANGS.map(
    (l) => `<button type="button" data-code="${l.code ?? ""}" class="${l.code === state.studyLang ? "active" : ""}">${esc(l.label)}</button>`,
  ).join("");
}

$("#lang-btn").addEventListener("click", () => $("#lang-sheet").showModal());
$("#lang-options").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.studyLang = b.dataset.code || null;
  store.set("cardex.lang", state.studyLang);
  renderLang();
  renderLearnStart();
  $("#lang-sheet").close();
});
$("#lang-sheet").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

/* ---------- add mode ---------- */

function setAddStatus(html, kind = "") {
  const s = $("#add-status");
  s.hidden = !html;
  s.className = "status" + (kind ? " " + kind : "");
  s.innerHTML = html || "";
}

// payload is { text } or { image } (a JPEG data URL).
async function analyze(payload) {
  $("#add-results").innerHTML = "";
  const thumb = payload.image ? `<img src="${payload.image}" alt="">` : "";
  setAddStatus(`${thumb}<div class="spinner"></div><span>${payload.image ? "Грок читает фото…" : "Грок думает…"}</span>`);
  $("#text-submit").disabled = true;
  try {
    const lang = LANGS.find((l) => l.code === state.studyLang);
    const res = await grok({ action: "analyze", studyLanguage: lang?.ru ?? null, ...payload });
    if (!res.items?.length) {
      setAddStatus(esc(res.error || "Не нашёл иностранных слов. Попробуй ещё раз."), "error");
      return;
    }
    setAddStatus("");
    renderResults(res.items);
  } catch (err) {
    setAddStatus("Ошибка: " + esc(err.message), "error");
  } finally {
    $("#text-submit").disabled = false;
  }
}

function renderResults(items) {
  const wrap = $("#add-results");
  wrap.innerHTML = "";
  items.forEach((item) => {
    const exists = state.cards.some((c) => c.language === item.language && c.word.toLowerCase() === String(item.word).toLowerCase());
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

async function onPhoto(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const image = await openCrop(file);
    if (image) analyze({ image });
  } catch (err) {
    setAddStatus(esc(err.message), "error");
  }
}

$("#camera-btn").addEventListener("click", () => $("#camera-input").click());
$("#gallery-btn").addEventListener("click", () => $("#gallery-input").click());
$("#camera-input").addEventListener("change", onPhoto);
$("#gallery-input").addEventListener("change", onPhoto);

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
if (pendingText) {
  $("#text-input").value = pendingText;
  history.replaceState(null, "", location.pathname);
}

/* ---------- learn mode ---------- */

function poolCards() {
  return state.studyLang ? state.cards.filter((c) => c.language === state.studyLang) : state.cards;
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

  const go = $("#learn-go");
  const note = $("#learn-note");
  go.disabled = pool.length === 0;
  if (!pool.length) {
    go.textContent = "Начать";
    note.textContent = state.studyLang ? `Нет слов на языке «${langLabel(state.studyLang)}».` : "Сначала добавь пару слов.";
  } else if (due.length) {
    go.textContent = `Начать · ${Math.min(due.length, SESSION_SIZE)} слов`;
    note.textContent = state.studyLang ? `Только ${langLabel(state.studyLang)}` : "";
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
  nextQuestion();
}

function endSession() {
  const s = state.session;
  state.session = null;
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

  const lang = card.language_name || langLabel(card.language);
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
  const list = state.cards.filter((c) => !q || norm(c.word).includes(q) || norm(c.translation).includes(q));
  $("#dict-empty").hidden = state.cards.length > 0;
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
    renderDict();
    renderLearnStart();
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

/* ---------- boot ---------- */

renderLang();
setAuthMode(false);
const { data: { session } } = await sb.auth.getSession();
if (!session) {
  $("#auth").hidden = false;
}
