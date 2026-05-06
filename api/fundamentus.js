// ══════════════════════════════════════════════════════
// /api/fundamentus — Scraping de indicadores do fundamentus.com.br
//
// Busca dados fundamentalistas completos diretamente do site.
// Não requer API key — dados públicos.
// Cache de 1h no CDN da Vercel.
// ══════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const { ticker } = req.query;
  if (!ticker) {
    return res.status(400).json({ error: 'Parâmetro "ticker" é obrigatório' });
  }

  const tickerUpper = ticker.toUpperCase();
  console.log(`[Fundamentus] Buscando ${tickerUpper}...`);

  try {
    const url = `https://www.fundamentus.com.br/detalhes.php?papel=${encodeURIComponent(tickerUpper)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.fundamentus.com.br/',
        'Connection': 'keep-alive',
      }
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      console.error(`[Fundamentus] HTTP ${response.status}`);
      return res.status(502).json({ error: `Fundamentus retornou status ${response.status}` });
    }

    // Decode ISO-8859-1 (encoding usado pelo fundamentus)
    const buffer = await response.arrayBuffer();
    const html = new TextDecoder('latin1').decode(buffer);

    // Verifica se obteve uma página válida
    if (!html.toLowerCase().includes(tickerUpper.toLowerCase())) {
      return res.status(404).json({ error: `Ticker "${tickerUpper}" não encontrado no Fundamentus` });
    }

    // Parse da página
    const pairs = extractLabelValuePairs(html);
    const pairCount = Object.keys(pairs).length;

    if (pairCount < 5) {
      console.error(`[Fundamentus] Poucos dados extraídos: ${pairCount} pares`);
      console.error('[Fundamentus] Pares:', JSON.stringify(pairs).substring(0, 500));
      return res.status(404).json({ error: `Dados insuficientes para "${tickerUpper}" no Fundamentus` });
    }

    const result = mapToStandardFormat(pairs, tickerUpper);
    const metricsCount = Object.values(result.metrics).filter(v => v != null).length;
    const nullMetrics = Object.entries(result.metrics).filter(e => e[1] == null).map(e => e[0]);
    console.log(`[Fundamentus] Sucesso: ${metricsCount} métricas para ${tickerUpper} (${pairCount} pares extraídos)`);
    if (nullMetrics.length > 0) {
      console.log(`[Fundamentus] Métricas null: ${nullMetrics.join(', ')}`);
    }

    // Cache de 1h no CDN da Vercel
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
    return res.status(200).json(result);

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[Fundamentus] Timeout (10s)');
      return res.status(504).json({ error: 'Timeout ao acessar Fundamentus' });
    }
    console.error('[Fundamentus] Erro:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar Fundamentus: ' + err.message });
  }
}

// ══════════════════════════════════════════
// ── Extração de pares label-valor do HTML ──
// ══════════════════════════════════════════

function cleanCellText(raw) {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/^\?+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLabelValuePairs(html) {
  const pairs = {};

  // Normaliza whitespace para facilitar regex
  const flat = html.replace(/[\r\n]+/g, ' ');

  // Estratégia: processa cada <tr> independentemente
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(flat)) !== null) {
    const rowHtml = rowMatch[1];
    let texts = [];

    // Primário: spans com class contendo "txt" (regex flexível)
    // Aceita class="txt", class="txt destaque", class="destaque txt", etc.
    const spanRegex = /<span[^>]*\bclass\s*=\s*"[^"]*\btxt\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    let spanMatch;

    while ((spanMatch = spanRegex.exec(rowHtml)) !== null) {
      const text = cleanCellText(spanMatch[1]);
      if (text) texts.push(text);
    }

    // Fallback: se poucos spans encontrados, tenta extrair de <td> diretamente
    // (algumas células podem usar classes diferentes ou sem span)
    if (texts.length < 2) {
      texts = [];
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdMatch;
      while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
        const text = cleanCellText(tdMatch[1]);
        if (text) texts.push(text);
      }
    }

    // Pares: [label, valor, label, valor, ...]
    for (let i = 0; i < texts.length - 1; i += 2) {
      const label = texts[i];
      const value = texts[i + 1];
      // Mantém primeira ocorrência (dados 12 meses vêm antes dos trimestrais)
      if (label && value && !Object.prototype.hasOwnProperty.call(pairs, label)) {
        pairs[label] = value;
      }
    }
  }

  // Log para debug no Vercel
  console.log('[Fundamentus] Labels extraídos:', Object.keys(pairs).join(', '));

  return pairs;
}

// ══════════════════════════════════════════
// ── Parsing de números no formato brasileiro ──
// ══════════════════════════════════════════

function parseNum(str) {
  if (!str || str === '-' || str === '—' || str === 'N/A' || str === '0') {
    return str === '0' ? 0 : null;
  }
  // Formato BR: 1.234.567,89 → 1234567.89
  const cleaned = str
    .replace(/\./g, '')     // Remove separador de milhares (pontos)
    .replace(',', '.')      // Troca vírgula decimal por ponto
    .replace('%', '')        // Remove símbolo de porcentagem
    .trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ══════════════════════════════════════════
// ── Lookup flexível de labels ──
// ══════════════════════════════════════════

function get(pairs, ...labels) {
  // 1. Busca exata
  for (const label of labels) {
    if (Object.prototype.hasOwnProperty.call(pairs, label)) {
      return pairs[label];
    }
  }
  // 2. Busca case-insensitive + normalizada
  const targets = labels.map(l => l.toLowerCase().replace(/\s+/g, ' ').trim());
  for (const [key, value] of Object.entries(pairs)) {
    const norm = key.toLowerCase().replace(/\s+/g, ' ').trim();
    if (targets.includes(norm)) return value;
  }
  // 3. Fuzzy: remove TODA pontuação/espaço e compara
  // Resolve diferenças como "EV / EBITDA" vs "EV/EBITDA", "Div. Yield" vs "Div.Yield"
  const fuzzyTargets = labels.map(l => l.toLowerCase().replace(/[^a-z0-9áàâãéèêíïóôõúüç]/gi, ''));
  for (const [key, value] of Object.entries(pairs)) {
    const fuzzy = key.toLowerCase().replace(/[^a-z0-9áàâãéèêíïóôõúüç]/gi, '');
    if (fuzzyTargets.includes(fuzzy)) return value;
  }
  return null;
}

function num(pairs, ...labels) {
  return parseNum(get(pairs, ...labels));
}

// ══════════════════════════════════════════
// ── Mapeia pares para formato padronizado ──
// ══════════════════════════════════════════

function mapToStandardFormat(pairs, ticker) {
  // === Info da empresa ===
  const company = get(pairs, 'Empresa') || '';
  const setor = get(pairs, 'Setor') || '';
  const subsetor = get(pairs, 'Subsetor') || '';

  // === Dados de mercado ===
  const cotacao = num(pairs, 'Cotação', 'Cotacao');
  const marketCap = num(pairs, 'Valor de mercado');
  const ev = num(pairs, 'Valor da firma');
  const shares = num(pairs, 'Nro. Ações', 'Nro. Acoes');

  // === Múltiplos de Valuation ===
  const pl = num(pairs, 'P/L');
  const pvp = num(pairs, 'P/VP');
  const evEbitda = num(pairs, 'EV/EBITDA', 'EV / EBITDA');
  const evEbit = num(pairs, 'EV/EBIT', 'EV / EBIT');
  const pEbit = num(pairs, 'P/EBIT', 'P/ EBIT');
  const psr = num(pairs, 'PSR');

  // === Dividendos ===
  const dividendYield = num(pairs, 'Div.Yield', 'Div. Yield', 'Div Yield', 'DY');

  // === Rentabilidade ===
  const margemBruta = num(pairs, 'Marg. Bruta', 'Mrg. Bruta', 'Margem Bruta', 'Mrg Bruta');
  const margemEbit = num(pairs, 'Marg. EBIT', 'Marg EBIT', 'Mrg Ebit', 'Mrg. Ebit', 'Margem EBIT');
  const margemLiquida = num(pairs, 'Marg. Líquida', 'Margem Líquida', 'Marg Líquida',
    'Mrg. Líq.', 'Mrg. Liq.', 'Mrg Líq', 'Mrg Liq', 'Marg. Liq.', 'Marg. Líq.');
  const roic = num(pairs, 'ROIC');
  const roe = num(pairs, 'ROE');

  // === Endividamento ===
  const liqCorr = num(pairs, 'Liquidez Corr', 'Liquidez Corrente', 'Liq. Corr.', 'Liq.Corr.', 'Liq Corr');
  const divBrutaPatrim = num(pairs, 'Dív Bruta/ Patrim.', 'Div Bruta/ Patrim.', 'Dív Bruta/Patrim.',
    'Dív. Bruta/ Patrim.', 'Dív Líq / Patrim');
  const divLiqPatrim = num(pairs, 'Dív Líq / Patrim', 'Dív Líq/ Patrim', 'Dív. Líquida/ Patrim.',
    'Div. Liquida/ Patrim.', 'Dív. Líquida/Patrim.', 'Dív Líquida/ Patrim.');
  const divLiqEbitda = num(pairs, 'Dív. Líquida/EBITDA', 'Div. Liquida/EBITDA', 'Dív Líquida/EBITDA',
    'Dív. Líquida / EBITDA');

  // === Por ação ===
  const lpa = num(pairs, 'LPA');
  const vpa = num(pairs, 'VPA');

  // === Crescimento ===
  const cagr5 = num(pairs, 'Cres. Rec (5a)', 'Cres.Rec (5a)', 'Cres. Rec(5a)');

  // === Balanço Patrimonial ===
  const ativo = num(pairs, 'Ativo');
  const disponibilidades = num(pairs, 'Disponibilidades');
  const ativoCirculante = num(pairs, 'Ativo Circulante');
  const divBruta = num(pairs, 'Dív. Bruta', 'Div. Bruta', 'Dív Bruta');
  const divLiquida = num(pairs, 'Dív. Líquida', 'Div. Liquida', 'Dív Líquida');
  const patrimLiq = num(pairs, 'Patrim. Líq', 'Patrim. Liq', 'Patrim Líq');

  // === DRE (últimos 12 meses) ===
  const receitaLiquida = num(pairs, 'Receita Líquida', 'Receita Liquida');
  const ebit = num(pairs, 'EBIT');
  const lucroLiquido = num(pairs, 'Lucro Líquido', 'Lucro Liquido');

  // === Métricas Calculadas ===

  // EBITDA = EV / (EV/EBITDA)
  let ebitda = null;
  if (ev != null && evEbitda != null && evEbitda !== 0) {
    ebitda = ev / evEbitda;
  }

  // Margem EBITDA = EBITDA / Receita × 100
  let margemEbitda = null;
  if (ebitda != null && receitaLiquida != null && receitaLiquida !== 0) {
    margemEbitda = (ebitda / receitaLiquida) * 100;
  }

  // ROA = Lucro / Ativo Total × 100
  let roa = null;
  if (lucroLiquido != null && ativo != null && ativo !== 0) {
    roa = (lucroLiquido / ativo) * 100;
  }

  // Payout = DPA / LPA × 100 (se tivermos DY e preço, DPA = preço × DY / 100)
  let payout = null;
  if (dividendYield != null && cotacao != null && lpa != null && lpa !== 0) {
    const dpa = cotacao * dividendYield / 100;
    payout = (dpa / lpa) * 100;
  }

  return {
    ticker,
    company,
    setor,
    subsetor,
    cotacao,
    marketCap,
    enterpriseValue: ev,
    shares,

    metrics: {
      pl,
      pvp,
      evEbitda,
      dividendYield,
      roe,
      roic,
      roa,
      margemBruta,           // Capturada do Fundamentus (Marg. Bruta)
      margemEbitda,          // Calculada a partir do EV/EBITDA
      margemEbit,            // Exibida diretamente pelo Fundamentus
      margemLiquida,
      dividaLiquidaEbitda: divLiqEbitda,
      dividaLiquidaPl: divLiqPatrim,
      liquidezCorrente: liqCorr,
      lpa,
      vpa,
      payout,
      cagr5anos: cagr5,
      pEbit,
      psr,
    },

    balanco: {
      ativo,
      disponibilidades,
      ativoCirculante,
      divBruta,
      divLiquida,
      patrimLiq,
    },

    dre: {
      receitaLiquida,
      ebit,
      ebitda,
      lucroLiquido,
    }
  };
}
