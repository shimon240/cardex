// Proxy between the cardex web app and the xAI Grok API.
// The API key is read from Vault through the service-role-only get_xai_key() RPC,
// so it never reaches the browser.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "grok-4.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

let cachedKey: string | null = null;
async function xaiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const { data, error } = await admin.rpc("get_xai_key");
  if (error || !data) throw new Error("xAI key is not configured");
  cachedKey = data as string;
  return cachedKey;
}

const ANALYZE_SYSTEM = `Ты — помощник для изучения иностранных слов. Пользователь говорит по-русски.
По входу (слово или текст, либо фотография — обычно обрезанная пользователем до нужного слова) составь словарные карточки.
Отвечай строго JSON-объектом без пояснений:
{"items":[{
  "word": "слово в словарной форме (существительные в ед. ч., глаголы в инфинитиве; для немецких существительных с артиклем der/die/das; если на входе устойчивое выражение — оставь выражение)",
  "language": "код языка BCP-47, например en, de, fr, es, it",
  "language_name": "название языка по-русски, со строчной буквы",
  "transcription": "транскрипция IPA без слешей",
  "part_of_speech": "часть речи по-русски, коротко (сущ., глаг., прил., нареч., выраж. и т. п.)",
  "translation": "краткий перевод на русский: 1–3 основных варианта через запятую",
  "meaning": "1–2 предложения по-русски: значение, оттенки, когда употребляется",
  "examples": [{"text": "естественный пример на языке слова", "ru": "перевод примера"}]
}],
"error": null}
Давай ровно 3 примера разной сложности.
Если на входе слово на русском — переведи его на изучаемый язык (если он указан, иначе на английский) и сделай карточку для иностранного слова.
Если слово написано с опечаткой — исправь.
Если на входе (или на фото) одно слово или короткая устойчивая фраза — верни только её. Если это предложение или больше — верни до 5 самых полезных и не самых простых слов. Если слово на фото обрезано краем — восстанови его по видимой части. Русский текст игнорируй.
Если не удалось найти иностранное слово — верни {"items":[],"error":"короткое объяснение по-русски"}.`;

const CHECK_SYSTEM = `Ты проверяешь ответ ученика в тренажёре слов. Ученик говорит по-русски.
Оцени, правильно ли он перевёл слово. Засчитывай синонимы и близкие по смыслу варианты, мелкие опечатки, другую форму слова. Отсутствие артикля у немецкого существительного засчитывай, но упомяни артикль.
Не засчитывай слово с другим значением.
Ответ строго JSON: {"correct": true|false, "feedback": "одно короткое предложение по-русски: что не так или уточнение; пустая строка, если всё идеально"}`;

async function grok(messages: unknown[]): Promise<any> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await xaiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Grok ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content);
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method not allowed" }, 405);

  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "unauthorized" }, 401);
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return reply({ error: "unauthorized" }, 401);

  try {
    const body = await req.json();

    if (body.action === "analyze") {
      const hint = body.studyLanguage ? `Изучаемый язык: ${body.studyLanguage}.` : "Изучаемый язык не указан.";
      let user: unknown;
      if (typeof body.image === "string" && body.image.startsWith("data:image/")) {
        if (body.image.length > 8_000_000) return reply({ error: "image too large" }, 413);
        user = [
          { type: "image_url", image_url: { url: body.image, detail: "high" } },
          { type: "text", text: `${hint} Найди на фото иностранное слово (или слова) и составь карточки.` },
        ];
      } else if (typeof body.text === "string" && body.text.trim()) {
        user = `${hint}\nВход:\n${body.text.trim().slice(0, 2000)}`;
      } else {
        return reply({ error: "text or image required" }, 400);
      }
      const result = await grok([
        { role: "system", content: ANALYZE_SYSTEM },
        { role: "user", content: user },
      ]);
      return reply({ items: Array.isArray(result.items) ? result.items : [], error: result.error ?? null });
    }

    if (body.action === "check") {
      const { prompt, expected, answer, direction, language } = body;
      const task = direction === "to_ru"
        ? `Слово (${language}): «${prompt}». Правильный перевод на русский: «${expected}».`
        : `Русское слово: «${prompt}». Правильный ответ (${language}): «${expected}».`;
      const result = await grok([
        { role: "system", content: CHECK_SYSTEM },
        { role: "user", content: `${task}\nОтвет ученика: «${String(answer).slice(0, 200)}».` },
      ]);
      return reply({ correct: !!result.correct, feedback: result.feedback ?? "" });
    }

    return reply({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
