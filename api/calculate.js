// Mise — Agent Service Provider endpoint
// POST /api/calculate
//
// Registered on-chain as an OKX ASP:
// tx 0xc2786fb119e5c05d46eb47e7e4e5a9d4b418fbc97f2f7ffe39897ed2e9eafb0d
//
// Actions:
//   { action: "catalog" }        → market price library + starter sheet (FREE)
//   { ingredients: [...], ... }  → costing for a batch (PAID via x402)
//
// x402: the "calculate" action requires payment. Callers without a valid
// payment proof get an HTTP 402 back describing how much to pay and where.
// Network advertised is eip155:196 (X Layer) per OKX ASP listing requirements.
//
// Formula:
//   ingredient cost = (buyPrice / buyQty) * useQty
//   total           = Σ ingredients * (1 + wastePct/100)
//   per portion     = total / batchSize
//   menu price      = per portion / (1 - marginPct/100)

/* ─────────────────────────────────────────────
   x402 CONFIG
   PAYMENT_ADDRESS must be set in Vercel env vars
   once you have an X Layer wallet address.
   ───────────────────────────────────────────── */
const X402_CONFIG = {
  chainId: "eip155:196", // X Layer — required by OKX ASP listing
  // x402 expects `asset` to be the token CONTRACT ADDRESS on that chain,
  // not a ticker. Set PAYMENT_ASSET in Vercel to the USDT contract on
  // X Layer. Until then the challenge is advertised with the ticker,
  // which reviewers may reject.
  asset: process.env.PAYMENT_ASSET || "USDT",
  payTo: process.env.PAYMENT_ADDRESS || null,
  // Atomic units, as a string. USDT has 6 decimals, so 0.01 USDT = "10000".
  amount: process.env.CALCULATE_PRICE_ATOMIC || "10000",
  // Human-readable equivalent, used only for the discovery response.
  priceUsd: process.env.CALCULATE_PRICE_USD || "0.01",
  maxTimeoutSeconds: 300,
  resource: "/api/calculate",
};

/* ─────────────────────────────────────────────
   MARKET PRICE LIBRARY — single source of truth.
   Mile 12 Market (Lagos wholesale), Naija Food,
   Jumia Groceries. Update here; the frontend
   picks it up with no redeploy.
   ───────────────────────────────────────────── */
const PRICE_BOOK = [
  // Mile 12 Market — natural market units, not forced to kg
  { key: "tomatoes",  name: "Tomatoes",                buyQty: 50, unit: "kg",           buyPrice: 19500, defaultUse: 2,    source: "Mile 12 Market",  category: "produce" },
  { key: "tatase",    name: "Tatase pepper",           buyQty: 50, unit: "kg",           buyPrice: 19500, defaultUse: 1.5,  source: "Mile 12 Market",  category: "produce" },
  { key: "rodo",      name: "Rodo pepper",             buyQty: 1,  unit: "big bowl",     buyPrice: 21000, defaultUse: 0.15, source: "Mile 12 Market",  category: "produce" },
  { key: "shombo",    name: "Shombo pepper",           buyQty: 1,  unit: "big bowl",     buyPrice: 7000,  defaultUse: 0.2,  source: "Mile 12 Market",  category: "produce" },
  { key: "onions",    name: "Onions, red",             buyQty: 1,  unit: "big bowl",     buyPrice: 9500,  defaultUse: 0.25, source: "Mile 12 Market",  category: "produce" },
  { key: "crayfish",  name: "Crayfish, medium",        buyQty: 1,  unit: "paint bucket", buyPrice: 18700, defaultUse: 0.1,  source: "Mile 12 Market",  category: "seasoning" },

  // Naija Food / supermarket staples
  { key: "rice",      name: "Rice",                    buyQty: 1,  unit: "derica",       buyPrice: 1500,  defaultUse: 5,    source: "Naija Food",      category: "staple" },
  { key: "veg-oil",   name: "Vegetable oil",           buyQty: 25, unit: "L",            buyPrice: 28875, defaultUse: 1.5,  source: "Naija Food",      category: "staple" },
  { key: "chicken",   name: "Chicken wings",           buyQty: 1,  unit: "kg",           buyPrice: 2790,  defaultUse: 2,    source: "Naija Food",      category: "protein" },
  { key: "beef",      name: "Beef, cut up",            buyQty: 1,  unit: "kg",           buyPrice: 7900,  defaultUse: 1.5,  source: "Naija Food",      category: "protein" },
  { key: "seasoning", name: "Seasoning cubes & spice", buyQty: 1,  unit: "lump sum",     buyPrice: 1500,  defaultUse: 1,    source: "Jumia Groceries", category: "seasoning" },

  // Packaging & utility
  { key: "pack",      name: "Takeaway pack",           buyQty: 50, unit: "pack",         buyPrice: 6000,  defaultUse: 20,   source: "Jumia Groceries", category: "packaging" },
  { key: "gas",       name: "Cooking gas",             buyQty: 1,  unit: "kg",           buyPrice: 1600,  defaultUse: 1,    source: "Jumia Groceries", category: "utility" },
];

// Opening sheet, expressed only as references into the price book.
const STARTER = [
  { key: "rice",     useQty: 5 },
  { key: "tomatoes", useQty: 2 },
  { key: "onions",   useQty: 0.25 },
];

const DEFAULTS = { wastePct: 7, marginPct: 66, batchSize: 20, vatRate: 0.075, currency: "NGN" };

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;

/* ─────────────────────────────────────────────
   x402 helpers
   ───────────────────────────────────────────── */

// Builds the x402 challenge object. OKX review requires the full
// structure: x402Version, resource, and an accepts[] entry carrying
// scheme, network, asset, amount, payTo, maxTimeoutSeconds and extra.
function buildChallenge() {
  return {
    x402Version: 1,
    resource: X402_CONFIG.resource,
    accepts: [
      {
        scheme: "exact",
        network: X402_CONFIG.chainId,
        asset: X402_CONFIG.asset,
        amount: X402_CONFIG.amount,
        payTo: X402_CONFIG.payTo,
        maxTimeoutSeconds: X402_CONFIG.maxTimeoutSeconds,
        extra: {
          name: "Mise food-cost calculation",
          description: "One food-cost and menu-price calculation per call.",
        },
      },
    ],
  };
}

// Sends the 402. The challenge goes in BOTH places: base64 in the
// PAYMENT-REQUIRED header (what OKX's reviewer checks for) and as the
// JSON body (what a human debugging the endpoint will read).
function send402(res) {
  const challenge = buildChallenge();
  const encoded = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");

  res.setHeader("PAYMENT-REQUIRED", encoded);
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED");

  return res.status(402).json(Object.assign({ error: "Payment required" }, challenge));
}

// Very intentionally simple: checks for a payment proof header.
// Swap this for real on-chain / facilitator verification before going live —
// this stub only unblocks local testing and listing checks.
function hasValidPayment(req) {
  const proof = req.headers["x-payment"] || req.headers["x-payment-proof"];
  return Boolean(proof && String(proof).trim().length > 0);
}

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Discovery — lets another agent see what this service offers.
  // Stays free and un-gated so agents can evaluate Mise before paying.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "Mise — food costing",
      agent: { name: "Mise", role: "asp", chain: X402_CONFIG.chainId },
      payment: {
        required: true,
        action: "calculate",
        network: X402_CONFIG.chainId,
        asset: X402_CONFIG.asset,
        amount: X402_CONFIG.amount,
        priceUsd: X402_CONFIG.priceUsd,
      },
      actions: {
        catalog: { method: "POST", body: { action: "catalog" }, payment: "free" },
        calculate: {
          method: "POST",
          payment: "required (x402)",
          body: {
            dishName: "Jollof Rice",
            batchSize: 20,
            marginPct: 40,
            wastePct: 7,
            ingredients: [{ key: "tomatoes", useQty: 2 }],
          },
        },
      },
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Use GET for discovery or POST to calculate." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    /* ── catalog — free, no payment gate ── */
    if (body.action === "catalog") {
      return res.status(200).json({
        ok: true,
        currency: DEFAULTS.currency,
        defaults: DEFAULTS,
        updated: "2026-07-19",
        sources: ["Mile 12 Market", "Naija Food", "Jumia Groceries"],
        catalog: PRICE_BOOK,
        starter: STARTER
          .map((s) => {
            const item = PRICE_BOOK.find((p) => p.key === s.key);
            return item ? Object.assign({}, item, { useQty: s.useQty }) : null;
          })
          .filter(Boolean),
        note: "Estimates only. Market prices move weekly — confirm against your own purchase.",
      });
    }

    /* ── calculate — paid via x402 ── */
    if (!X402_CONFIG.payTo) {
      // No wallet configured yet — fail loudly rather than silently giving
      // away the paid feature for free. Remove this block once
      // PAYMENT_ADDRESS is set in Vercel.
      return res.status(500).json({
        ok: false,
        error: "PAYMENT_ADDRESS is not set on this deployment yet — x402 cannot be enforced.",
      });
    }

    if (!hasValidPayment(req)) {
      return send402(res);
    }

    const {
      dishName = "Untitled",
      batchSize = DEFAULTS.batchSize,
      marginPct = DEFAULTS.marginPct,
      wastePct = DEFAULTS.wastePct,
      ingredients = [],
    } = body;

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ ok: false, error: "ingredients must be a non-empty array" });
    }

    const batch = Math.max(num(batchSize) || 1, 1);
    const margin = Math.min(Math.max(num(marginPct), 0), 95);
    const waste = Math.max(num(wastePct), 0);

    // An ingredient may cite a catalog key instead of carrying its own price.
    const lines = ingredients.map((i) => {
      const ref = i.key ? PRICE_BOOK.find((p) => p.key === i.key) : null;
      const buyQty = num(i.buyQty) || (ref ? ref.buyQty : 0);
      const buyPrice = num(i.buyPrice) || (ref ? ref.buyPrice : 0);
      const useQty = num(i.useQty);
      const unitRate = buyQty > 0 ? buyPrice / buyQty : 0;
      const cost = unitRate * useQty;
      return {
        name: i.name || (ref ? ref.name : "—"),
        unit: i.unit || (ref ? ref.unit : ""),
        source: ref ? ref.source : "user entered",
        buyQty, buyPrice, useQty,
        unitRate: r2(unitRate),
        cost: r2(cost),
      };
    });

    const baseCost = lines.reduce((s, l) => s + l.cost, 0);
    const wasteCost = baseCost * (waste / 100);
    const totalCost = baseCost + wasteCost;
    const costPerPortion = totalCost / batch;
    const suggestedPrice = margin < 100 ? costPerPortion / (1 - margin / 100) : costPerPortion;
    const foodCostPct = suggestedPrice > 0 ? Math.round((costPerPortion / suggestedPrice) * 100) : 0;

    lines.forEach((l) => { l.sharePct = baseCost > 0 ? Math.round((l.cost / baseCost) * 100) : 0; });

    return res.status(200).json({
      ok: true,
      agent: {
        name: "Mise",
        role: "asp",
        chain: X402_CONFIG.chainId,
        tx: "0xc2786fb119e5c05d46eb47e7e4e5a9d4b418fbc97f2f7ffe39897ed2e9eafb0d",
      },
      dishName,
      batchSize: batch,
      currency: DEFAULTS.currency,
      breakdown: lines,
      baseCost: r2(baseCost),
      wastePct: waste,
      wasteCost: r2(wasteCost),
      totalCost: r2(totalCost),
      costPerPortion: r2(costPerPortion),
      marginPct: margin,
      suggestedPrice: Math.round(suggestedPrice),
      suggestedPriceInclVat: Math.round(suggestedPrice * (1 + DEFAULTS.vatRate)),
      vatRate: DEFAULTS.vatRate,
      foodCostPercentage: foodCostPct,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: "Invalid request body" });
  }
};
