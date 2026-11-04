// Proxy between the cardex web app and the xAI Grok API.
// The API key is read from Vault through the service-role-only get_xai_key() RPC,
// so it never reaches the browser.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Non-reasoning variant: same answers here, 2–3 s instead of 10–25 s.
const MODEL = "grok-4.20-0309-non-reasoning";

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

const analyzeSystem = (lang: string) => `You are an assistant for learning foreign words. The user speaks ${lang}.
From the input (a word or text, or a photo, usually cropped by the user to the word they want) build dictionary cards.
Reply strictly with a JSON object and no commentary:
{"items":[{
  "word": "the word in dictionary form (nouns in the singular, verbs in the infinitive; German nouns with the article der/die/das; if the input is a set phrase, keep the phrase)",
  "language": "BCP-47 language code, for example en, de, fr, es, it",
  "language_name": "the language's name in English, capitalized",
  "transcription": "IPA transcription without slashes",
  "part_of_speech": "grammatical characteristics in ${lang}, abbreviated: the part of speech plus what matters for this word, such as gender or verb type",
  "senses": [{
    "meaning": "one distinct meaning of the word: a short translation into ${lang}, 1–3 comma-separated options (for a word in ${lang} itself: a short definition)",
    "examples": [{"text": "a natural example of the word in this meaning, in the word's language", "ru": "translation of the example into ${lang} (for a word in ${lang} itself: a plain paraphrase)"}]
  }]
}],
"error": null}
Give one sense per genuinely distinct meaning, most common first, at most 4. Do not split shades of one meaning into separate senses.
Every sense needs at least one example: a word with a single sense gets 3 examples of varying difficulty, a word with several senses gets 1–2 per sense.
If the input is a word in ${lang} and a study language other than ${lang} is specified, translate it into the study language and build the card for the foreign word. If the study language is ${lang} or not specified, build the card for the word itself.
If the word has a typo, correct it.
If the input (or photo) is one word or a short set phrase, return only that. If it is a sentence or longer, return up to 5 of the most useful, not the simplest, words. If a word in the photo is cut off by the edge, restore it from the visible part. Ignore text in ${lang} unless the study language is ${lang}.
If no suitable word can be found, return {"items":[],"error":"a short explanation in ${lang}"}.`;

const checkSystem = (lang: string) => `You check a student's answer in a vocabulary trainer. The student speaks ${lang}.
Judge whether the word was translated correctly. Accept synonyms and close meanings, small typos, and other forms of the word. Accept a German noun without its article, but mention the article.
Do not accept a word with a different meaning.
Reply strictly with JSON: {"correct": true|false, "feedback": "one short sentence in ${lang}: what is wrong, or a clarification; an empty string if the answer is perfect"}`;

// The name of the language the user picked in their profile.
function userLanguage(value: unknown): string {
  return (typeof value === "string" && value.trim().slice(0, 40)) || "English";
}

// Keeps only well-formed senses, and adds the flat translation and examples the trainer and dictionary read.
function toCard(item: any) {
  const senses = (Array.isArray(item?.senses) ? item.senses : [])
    .filter((s: any) => typeof s?.meaning === "string" && s.meaning.trim())
    .map((s: any) => ({
      meaning: s.meaning.trim(),
      examples: (Array.isArray(s.examples) ? s.examples : []).filter((e: any) => typeof e?.text === "string" && e.text.trim()),
    }));
  return {
    ...item,
    senses,
    translation: senses.map((s: any) => s.meaning).join("; "),
    examples: senses.flatMap((s: any) => s.examples),
  };
}

async function grok(messages: unknown[]): Promise<any> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await xaiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
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
      const hint = body.studyLanguage ? `Study language: ${body.studyLanguage}.` : "Study language not specified.";
      let user: unknown;
      if (typeof body.image === "string" && body.image.startsWith("data:image/")) {
        if (body.image.length > 8_000_000) return reply({ error: "image too large" }, 413);
        user = [
          { type: "image_url", image_url: { url: body.image, detail: "high" } },
          { type: "text", text: `${hint} Find the foreign word (or words) in the photo and build cards.` },
        ];
      } else if (typeof body.text === "string" && body.text.trim()) {
        user = `${hint}\nInput:\n${body.text.trim().slice(0, 2000)}`;
      } else {
        return reply({ error: "text or image required" }, 400);
      }
      const result = await grok([
        { role: "system", content: analyzeSystem(userLanguage(body.userLanguage)) },
        { role: "user", content: user },
      ]);
      const items = (Array.isArray(result.items) ? result.items : []).map(toCard).filter((c: any) => c.word && c.senses.length);
      return reply({ items, error: result.error ?? null });
    }

    if (body.action === "check") {
      const { prompt, expected, answer, direction, language } = body;
      const task = direction === "to_ru"
        ? `Word (${language}): "${prompt}". Correct meaning: "${expected}".`
        : `Given meaning: "${prompt}". Correct answer (${language}): "${expected}".`;
      const result = await grok([
        { role: "system", content: checkSystem(userLanguage(body.userLanguage)) },
        { role: "user", content: `${task}\nStudent's answer: "${String(answer).slice(0, 200)}".` },
      ]);
      return reply({ correct: !!result.correct, feedback: result.feedback ?? "" });
    }

    return reply({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
