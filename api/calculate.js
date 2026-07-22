export default function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  try {
    const {
      dishName = "Dish", batchSize = 1, ingredients = [],
      cookHours = 0, gasBurnRate = 0.4, gasPricePerKg = 1600,
      packPrice = 0, spoilagePct = 7, laborHours = 0, laborRate = 500,
      currentPrice = null,
    } = req.body || {};
    const ingredientCost = ingredients.reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.price) || 0), 0);
    const gasCost = (parseFloat(gasBurnRate) || 0) * (parseFloat(cookHours) || 0) * (parseFloat(gasPricePerKg) || 0);
    const packagingCost = (parseFloat(packPrice) || 0) * (parseFloat(batchSize) || 0);
    const spoilageCost = ingredientCost * ((parseFloat(spoilagePct) || 0) / 100);
    const laborCost = (parseFloat(laborHours) || 0) * (parseFloat(laborRate) || 0);
    const totalCost = ingredientCost + gasCost + packagingCost + spoilageCost + laborCost;
    const bSize = parseFloat(batchSize) || 1;
    const costPerPortion = totalCost / bSize;
    const suggestedPrices = Object.fromEntries([30,40,50].map(m => [`margin_${m}pct`, Math.round(costPerPortion/(1-m/100))]));
    let comparison = null;
    if (currentPrice !== null && !isNaN(parseFloat(currentPrice))) {
      const current = parseFloat(currentPrice);
      const gapPerPortion = current - costPerPortion;
      comparison = { currentPrice: current, gapPerPortion: Math.round(gapPerPortion), gapTotal: Math.round(gapPerPortion*bSize), status: gapPerPortion < 0 ? "losing_money" : gapPerPortion < costPerPortion*0.15 ? "thin_margin" : "profitable" };
    }
    res.status(200).json({ ok: true, dishName, batchSize: bSize, breakdown: { ingredientCost: Math.round(ingredientCost), gasCost: Math.round(gasCost), packagingCost: Math.round(packagingCost), spoilageCost: Math.round(spoilageCost), laborCost: Math.round(laborCost), totalCost: Math.round(totalCost) }, costPerPortion: Math.round(costPerPortion), suggestedPrices, comparison });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
