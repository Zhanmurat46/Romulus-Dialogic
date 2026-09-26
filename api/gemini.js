// Vercel serverless-функция: держит ключ Gemini на сервере и перебирает модели.
// Ключ берётся только из переменной окружения GEMINI_API_KEY.

// 2.x закрыты для новых ключей (404) — Google сам указал замены
const MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
  "gemini-flash-lite-latest"
];

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
const TIMEOUT_MS = 40000; // оценка всего диалога у думающих моделей может идти 15–30 с

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается: нужен POST" });
  }

  // Защита квоты от случайных ботов: если ACCESS_CODE задан, фронтенд обязан прислать его в заголовке
  const accessCode = process.env.ACCESS_CODE;
  if (accessCode && req.headers["x-access-code"] !== accessCode) {
    return res.status(401).json({ error: "Неверный код доступа" });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: "На сервере не задан GEMINI_API_KEY. Добавьте переменную в настройках Vercel и сделайте повторный деплой."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || !Array.isArray(body.contents) || body.contents.length === 0) {
    return res.status(400).json({ error: "В теле запроса нет поля contents" });
  }

  const payload = { contents: body.contents };
  if (body.system) payload.systemInstruction = { parts: [{ text: String(body.system) }] };
  if (body.generationConfig) payload.generationConfig = body.generationConfig;

  // GEMINI_MODELS в Vercel позволяет поменять список без правки кода: "model-a,model-b"
  const models = process.env.GEMINI_MODELS
    ? process.env.GEMINI_MODELS.split(",").map(s => s.trim()).filter(Boolean)
    : MODELS;

  const attempts = [];
  let lastStatus = 502;
  let lastError = "Нет ответа ни от одной модели";

  for (const model of models) {
    try {
      const r = await fetch(ENDPOINT + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const raw = await r.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { /* ответ не JSON — отдадим как есть */ }

      if (!r.ok) {
        lastStatus = r.status;
        lastError = (data && data.error && data.error.message) || raw || ("HTTP " + r.status);
        attempts.push({ model, status: r.status, error: lastError });
        continue;
      }

      const cand = data && data.candidates && data.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join("");
      if (!text) {
        const reason = (cand && cand.finishReason)
          || (data && data.promptFeedback && data.promptFeedback.blockReason)
          || "пустой ответ";
        lastStatus = 502;
        lastError = "Модель вернула пустой ответ (" + reason + ")";
        attempts.push({ model, status: 200, error: lastError });
        continue;
      }

      return res.status(200).json({ text, model });
    } catch (e) {
      lastStatus = 504;
      lastError = (e && e.name === "TimeoutError")
        ? "Модель не ответила за " + TIMEOUT_MS / 1000 + " с"
        : "Сбой запроса к Google: " + (e && e.message ? e.message : String(e));
      attempts.push({ model, status: 0, error: lastError });
    }
  }

  return res.status(lastStatus).json({ error: lastError, attempts });
};
