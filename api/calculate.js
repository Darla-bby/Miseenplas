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
// payment payload get an HTTP 402 carrying the challenge both as a base64
// PAYMENT-REQUIRED header and as the JSON body.
// Network advertised is eip155:196 (X Layer) per OKX ASP listing requirements.
//
// PAYMENT VERIFICATION — READ THIS:
// This endpoint validates the STRUCTURE of an incoming X-PAYMENT payload
// (scheme, network, asset, recipient, amount, expiry) but does NOT verify
// the signature on-chain or settle the transfer. A well-formed payload that
// was never signed by a funded wallet will still be accepted. Wiring in a
// real facilitator (verify + settle) is the remaining work — see
// verifyPayment() below.
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

  // `asset` is the token CONTRACT ADDRESS on that chain, not a ticker.
  asset: process.env.PAYMENT_ASSET || null,

  // EIP-712 domain fields for the token contract. The "exact" scheme signs an
  // EIP-3009 transferWithAuthorization, and the client needs the contract's
  // own name/version to build a matching domain separator. VERIFY these
  // against the contract on the X Layer explorer — a mismatch means every
  // signature a client produces will be rejected downstream.
  assetName: process.env.PAYMENT_ASSET_NAME || "USDT",
  assetVersion: process.env.PAYMENT_ASSET_VERSION || "1",

  payTo: process.env.PAYMENT_ADDRESS || null,

  // Atomic units, as a string. USDT on X Layer has 6 decimals,
  // so 0.01 USDT = "10000".
  amount: process.env.CALCULATE_PRICE_ATOMIC || "10000",

  // Human-readable equivalent, used only in the discovery response.
  priceUsd: process.env.CALCULATE_PRICE_USD || "0.01",

  maxTimeoutSeconds: 300,
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

// The resource must be an absolute URL, not a bare path — a caller that
// only sees the challenge has to be able to address the endpoint from it.
function absoluteResource(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "mise-api-five.vercel.app";
  return `${proto}://${host}/api/calculate`;
}

// Builds the x402 challenge. OKX review requires the full structure:
// x402Version, resource, and an accepts[] entry carrying scheme, network,
// asset, amount, payTo, maxTimeoutSeconds and extra.
function buildChallenge(req) {
  return {
    x402Version: 1,
    resource: absoluteResource(req),
    accepts: [
      {
        scheme: "exact",
        network: X402_CONFIG.chainId,
        asset: X402_CONFIG.asset,
        amount: X402_CONFIG.amount,
        maxAmountRequired: X402_CONFIG.amount, // alias some clients look for
        payTo: X402_CONFIG.payTo,
        maxTimeoutSeconds: X402_CONFIG.maxTimeoutSeconds,
        resource: absoluteResource(req),
        description: "One food-cost and menu-price calculation.",
        mimeType: "application/json",
        // EIP-712 domain of the payment token, needed to sign an
        // EIP-3009 transferWithAuthorization against it.
        extra: {
          name: X402_CONFIG.assetName,
          version: X402_CONFIG.assetVersion,
        },
      },
    ],
  };
}

// Sends the 402. The challenge goes in BOTH places: base64 in the
// PAYMENT-REQUIRED header (what OKX's reviewer checks for) and as the
// JSON body (what a human debugging the endpoint will read).
function send402(req, res, reason) {
  const challenge = buildChallenge(req);
  const encoded = Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");

  res.setHeader("PAYMENT-REQUIRED", encoded);
  res.setHeader("X-PAYMENT-REQUIRED", encoded); // some clients look here

  return res.status(402).json(
    Object.assign({ error: reason || "Payment required" }, challenge)
  );
}

const sameAddress = (a, b) =>
  typeof a === "string" && typeof b === "string" &&
  a.trim().toLowerCase() === b.trim().toLowerCase();

// Validates the shape and terms of an incoming X-PAYMENT payload.
//
// What this DOES check: that the header is base64 JSON, that it targets the
// scheme and network we advertised, that the token, recipient and amount
// match what we asked for, and that the authorization has not expired.
//
// What this does NOT check: the signature, the payer's balance, or whether
// any transfer actually settled on chain. Those need an x402 facilitator
// (a /verify + /settle service) or a signed-message check against an RPC
// node. Until that is wired in, a fabricated-but-well-formed payload passes.
function verifyPayment(req) {
  const raw = req.headers["x-payment"] || req.headers["x-payment-proof"];
  if (!raw || !String(raw).trim()) {
    return { ok: false, reason: "Payment required" };
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(raw).trim(), "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "X-PAYMENT must be base64-encoded JSON" };
  }

  if (decoded.x402Version !== 1) {
    return { ok: false, reason: "Unsupported x402Version" };
  }
  if (decoded.scheme !== "exact") {
    return { ok: false, reason: "Unsupported payment scheme" };
  }
  if (decoded.network !== X402_CONFIG.chainId) {
    return { ok: false, reason: "Payment offered on the wrong network" };
  }

  const inner = decoded.payload || {};
  const auth = inner.authorization || {};

  if (!inner.signature) {
    return { ok: false, reason: "Payment payload is missing its signature" };
  }
  if (X402_CONFIG.payTo && !sameAddress(auth.to, X402_CONFIG.payTo)) {
    return { ok: false, reason: "Payment is addressed to the wrong recipient" };
  }
  if (decoded.asset && X402_CONFIG.asset && !sameAddress(decoded.asset, X402_CONFIG.asset)) {
    return { ok: false, reason: "Payment offered in the wrong asset" };
  }

  let value;
  try {
    value = BigInt(String(auth.value ?? "0"));
  } catch {
    return { ok: false, reason: "Payment amount is not a valid integer" };
  }
  if (value < BigInt(X402_CONFIG.amount)) {
    return { ok: false, reason: "Payment amount is below the price" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (auth.validBefore && Number(auth.validBefore) < now) {
    return { ok: false, reason: "Payment authorization has expired" };
  }
  if (auth.validAfter && Number(auth.validAfter) > now) {
    return { ok: false, reason: "Payment authorization is not yet valid" };
  }

  return { ok: true, payer: auth.from || null };
}

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "PAYMENT-REQUIRED, X-PAYMENT-REQUIRED, X-PAYMENT-RESPONSE"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Health probes: some availability checkers use HEAD before anything else.
  if (req.method === "HEAD") return res.status(200).end();

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
        scheme: "exact",
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
    if (!X402_CONFIG.payTo || !X402_CONFIG.asset) {
      // No wallet configured yet — fail loudly rather than silently giving
      // away the paid feature for free. Remove this block once
      // PAYMENT_ADDRESS is set in Vercel.
      return res.status(500).json({
        ok: false,
        error: "PAYMENT_ADDRESS and PAYMENT_ASSET must both be set on this deployment before x402 can be enforced.",
      });
    }

    const payment = verifyPayment(req);
    if (!payment.ok) {
      return send402(req, res, payment.reason);
    }

    // Acknowledge the payment we accepted. No transaction hash is included
    // because this endpoint does not settle on chain — see verifyPayment().
    res.setHeader(
      "X-PAYMENT-RESPONSE",
      Buffer.from(
        JSON.stringify({
          success: true,
          network: X402_CONFIG.chainId,
          payer: payment.payer,
        }),
        "utf8"
      ).toString("base64")
    );

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
