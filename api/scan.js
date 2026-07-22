// Mise — vision endpoint (OpenAI)
// POST /api/scan   body: { image: "<base64 jpeg>" }
//
// Requires OPENAI_API_KEY in the Vercel environment.
// Optional: OPENAI_VISION_MODEL to pin a specific model.
//
// Tries several models in order so a model your account can't reach
// doesn't silently kill the feature. Whichever answers first is used
// and reported back in the response as `model`.

const MODELS = [
  process.env.OPENAI_VISION_MODEL,
  "gpt-4o",
  "gpt-5.6",
  "gpt-5.5",
  "gpt-4o-mini",
].filter(Boolean);

const MAX_BYTES = 8 * 1024 * 1024;

const BIAS = {
  hotline: "This is a hot-line kitchen doing bulk prep. Estimate in bulk market units — bag, big bowl, paint bucket, derica, keg, crate.",
  pastry:  "This is a pastry section working to gram precision. Estimate in grams, millilitres and single units, and keep quantities small and exact.",
};

const PROMPT = `Analyze this image of raw food ingredients or prep items on a kitchen bench in Nigeria.

Identify each distinct food item you can genuinely see. For each one estimate:
- how it is bought in bulk (quantity + the unit it is sold in)
- a reasonable Lagos market price in Naira for that bulk purchase
- how much of it a cook would use in one batch of about 20 portions

Prefer natural Nigerian market units where they apply — bag, big bowl, paint bucket,
derica, keg, crate, bulb, tuber — and only use kg when that is genuinely how it sells.

Return ONLY valid JSON in exactly this structure:

{"items":[{"name":"Tomatoes","buyQty":50,"unit":"kg","buyPrice":19500,"useQty":2,"confidence":92}]}

buyQty and buyPrice describe the bulk purchase. useQty is what one batch consumes.
confidence is 0-100.

Rules:
- Only list what is actually visible. Never invent items.
- If there are no food items at all, return {"items":[]}
- Maximum 6 items, most prominent first.`;

const num = (v) => {
  const n = parseFloat(v);
  return isFinite(n) && n >= 0 ? n : 0;
};

// Accepts our own shape, or a looser {name, quantity:"3 bulbs", estimated_price}
function normalise(i) {
  if (!i || typeof i.name !== "string" || !i.name.trim()) return null;

  let buyQty = num(i.buyQty);
  let unit = typeof i.unit === "string" ? i.unit.trim() : "";
  let buyPrice = num(i.buyPrice ?? i.estimated_price ?? i.price);
  let useQty = num(i.useQty);

  // "3 bulbs" / "50kg bag" / "2" → split leading number from the unit
  if ((!buyQty || !unit) && typeof i.quantity === "string") {
    const m = i.quantity.trim().match(/^([\d.]+)\s*(.*)$/);
    if (m) {
      if (!buyQty) buyQty = num(m[1]);
      if (!unit) unit = (m[2] || "").trim();
    } else if (!unit) {
      unit = i.quantity.trim();
    }
  } else if ((!buyQty || !unit) && typeof i.quantity === "number") {
    if (!buyQty) buyQty = num(i.quantity);
  }

  if (!buyQty) buyQty = 1;
  if (!unit) unit = "unit";
  if (!useQty) useQty = buyQty;          // assume the batch uses what was bought
  if (buyPrice <= 0) return null;        // a price of zero is useless for costing

  return {
    name: String(i.name).slice(0, 60),
    buyQty,
    unit: unit.slice(0, 20),
    buyPrice: Math.round(buyPrice),
    useQty,
    confidence: Math.min(Math.max(Math.round(num(i.confidence)), 0), 100) || null,
  };
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST an image to this endpoint." });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.status(500).json({
      ok: false,
      error: "OPENAI_API_KEY is not set on this deployment. Add it in Vercel → Settings → Environment Variables, then redeploy.",
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    let image = body.image;

    if (!image || typeof image !== "string") {
      return res.status(400).json({ ok: false, error: "No image received in the request body." });
    }
    if (image.startsWith("data:")) image = image.split(",")[1];

    const approxBytes = Math.floor((image.length * 3) / 4);
    if (approxBytes > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: "Image too large — capture at a lower resolution." });
    }

    const bias = BIAS[body.bias] || BIAS.hotline;
    const prompt = `${PROMPT}\n\nContext: ${bias}`;
    const dataUrl = `data:image/jpeg;base64,${image}`;
    const attempts = [];

    for (const model of MODELS) {
      let upstream;
      try {
        upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            response_format: { type: "json_object" },
            messages: [{
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
              ],
            }],
          }),
        });
      } catch (netErr) {
        attempts.push(`${model}: network error — ${netErr.message}`);
        continue;
      }

      if (upstream.ok) {
        const data = await upstream.json();
        const text = data?.choices?.[0]?.message?.content || "";
        const parsed = extractJson(text);

        const raw = Array.isArray(parsed) ? parsed
          : Array.isArray(parsed?.items) ? parsed.items
          : [];

        const items = raw.map(normalise).filter(Boolean).slice(0, 6);

        return res.status(200).json({
          ok: true,
          model,
          items,
          attempts,
          note: items.length
            ? "Prices are model estimates. Confirm against your own purchase before pricing a menu."
            : "No food items were recognised in that frame.",
        });
      }

      // read the upstream error so we can report it verbatim
      let detail = "";
      try {
        const errBody = await upstream.json();
        detail = errBody?.error?.message || JSON.stringify(errBody).slice(0, 300);
      } catch {
        detail = (await upstream.text().catch(() => "")).slice(0, 300);
      }

      console.error("OpenAI error", model, upstream.status, detail);
      attempts.push(`${model}: ${upstream.status} — ${detail}`);

      // a missing/unavailable model is worth retrying with the next one;
      // auth and billing failures are not.
      const retryable =
        upstream.status === 404 ||
        /model/i.test(detail) && /not (exist|found|available)|do not have access/i.test(detail);

      if (!retryable) {
        return res.status(500).json({
          ok: false,
          error: detail || `OpenAI returned ${upstream.status}.`,
          status: upstream.status,
          model,
          attempts,
        });
      }
    }

    return res.status(500).json({
      ok: false,
      error: "None of the vision models were reachable on this account.",
      attempts,
    });
  } catch (err) {
    console.error("scan error", err);
    return res.status(500).json({ ok: false, error: err.message || "Analysis failed." });
  }
};
