// ══════════════════════════════════════════
// /api/quote — Proxy para BrAPI
// Busca dados atuais de preço e fundamentos
// Token fica seguro no servidor (env var)
// ══════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { ticker } = req.query;
  if (!ticker) {
    return res.status(400).json({ error: 'Parâmetro "ticker" é obrigatório' });
  }

  const token = process.env.BRAPI_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'BRAPI_TOKEN não configurado no servidor' });
  }

  try {
    const url = `https://brapi.dev/api/quote/${encodeURIComponent(ticker.toUpperCase())}?fundamental=true&token=${token}`;
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({
        error: `BrAPI retornou status ${response.status}`
      });
    }

    const data = await response.json();

    if (!data.results || !data.results.length) {
      return res.status(404).json({ error: `Ticker "${ticker}" não encontrado na B3` });
    }

    const q = data.results[0];

    // Mapeia os dados da BrAPI para nosso formato padronizado
    const result = {
      ticker: q.symbol || ticker.toUpperCase(),
      company: q.longName || q.shortName || ticker.toUpperCase(),
      sector: q.sector || '',
      industry: q.industry || '',
      description: q.summaryProfile?.longBusinessSummary || '',
      currentPrice: q.regularMarketPrice ?? null,
      previousClose: q.regularMarketPreviousClose ?? null,
      change: q.regularMarketChange ?? null,
      changePercent: q.regularMarketChangePercent ?? null,
      marketCap: q.marketCap ?? null,
      shares: q.sharesOutstanding ?? null,
      volume: q.regularMarketVolume ?? null,
      metrics: {
        pl: q.priceEarnings ?? null,
        pvp: q.priceToBook ?? null,
        evEbitda: q.enterpriseValueOverEbitda ?? null,
        dividendYield: q.dividendYield != null ? q.dividendYield : null,
        roe: q.returnOnEquity != null ? q.returnOnEquity * 100 : null,
        roic: null, // BrAPI geralmente não fornece ROIC
        roa: q.returnOnAssets != null ? q.returnOnAssets * 100 : null,
        margemBruta: q.grossMargins != null ? q.grossMargins * 100 : null,
        margemEbitda: q.ebitdaMargins != null ? q.ebitdaMargins * 100 : null,
        margemLiquida: q.profitMargins != null ? q.profitMargins * 100 : null,
        dividaLiquidaEbitda: q.netDebtToEbitda ?? null,
        dividaLiquidaPl: q.debtToEquity != null ? q.debtToEquity / 100 : null,
        liquidezCorrente: q.currentRatio ?? null,
        lpa: q.earningsPerShare ?? null,
        vpa: q.bookValue ?? null,
        payout: q.payoutRatio != null ? q.payoutRatio * 100 : null,
        cagr5anos: q.revenueGrowth != null ? q.revenueGrowth * 100 : null
      }
    };

    // Cache de 5 minutos no CDN da Vercel para mesma query
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(result);

  } catch (err) {
    console.error('Erro no /api/quote:', err.message);
    return res.status(500).json({ error: 'Erro interno ao buscar dados: ' + err.message });
  }
}
