# Cardex

A mobile web app for learning foreign words.

- **Dictionary**: the start screen, with all saved words and their progress.
- **Add**: the round "+" button at the bottom right opens a sheet. Type a word and Grok 4.20 returns its translation, transcription, explanation and examples. Or choose "Fill in manually" to enter a word, one or more meanings and examples without calling Grok. Close the sheet with the X or by tapping the backdrop.
- **Learn**: flashcards using the Leitner system. Card language: in your language, in the section's language (for example, "In German"), or mixed. Answers are checked locally, and Grok judges inexact ones.
- **Profile**: account email, your language, password change and sign out. Your language is the one Grok writes translations, explanations and answer feedback in; it applies to new cards, and existing ones stay as they are. The choice is stored in the browser.
- **Language sections**: a dropdown at the top right, with one language always selected. A section appears on its own when you add the first word in a new language (Grok detects the language); "+ Add language…" creates one ahead of time. The selected section is remembered, training and the dictionary show only its words, and words in your language are translated into its language. In a section for your own language, words get a card of their own with synonyms and a definition.

## How it works

- Frontend: static `index.html`, `app.js`, `styles.css` (no build step), hosted on GitHub Pages. Pages caches files for 10 minutes, so when you change `app.js` or `styles.css`, bump `?v=N` in their links in `index.html`, otherwise the browser combines the new page with the old script.
- Data: Supabase, table `public.cards` with RLS (each user sees only their own cards).
- Grok: edge function `supabase/functions/grok`. The xAI key is stored in Supabase Vault (`xai_api_key`) and read only by the service role through `public.get_xai_key()`.
