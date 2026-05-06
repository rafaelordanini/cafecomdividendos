// ══════════════════════════════════════════════════════
// /api/analysis — Análise Fundamentalista com Gemini + Cache Supabase
//
// Fluxo:
// 1. Recebe ticker + dados atuais do BrAPI (via frontend)
// 2. Verifica cache no Supabase (TTL configurável)
// 3. Se cache fresco → retorna imediatamente
// 4. Se cache vencido → chama Gemini → salva no Supabase → retorna
//
// Gemini retorna JSON com:
//   - historical: dados financeiros de 4-6 anos
//   - dcfInputs: premissas para cálculo DCF
//   - analysis: texto markdown da análise completa
// ══════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

// ── Helpers ──

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios');
  return createClient(url, key);
}

function isCacheFresh(updatedAt) {
  if (!updatedAt) return false;
  const ttlHours = parseInt(process.env.CACHE_TTL_HOURS) || 24;
  const age = Date.now() - new Date(updatedAt).getTime();
  return age < ttlHours * 60 * 60 * 1000;
}

function buildGeminiPrompt(ticker, companyName, metrics) {
  const metricsStr = metrics ? JSON.stringify(metrics, null, 2) : 'Não disponível';

  return `Você é um analista fundamentalista sênior especializado no mercado brasileiro de ações.

TAREFA: Gere uma análise completa de ${ticker} (${companyName}) incluindo dados históricos e análise qualitativa.

DADOS ATUAIS DO MERCADO (via BrAPI):
${metricsStr}

RETORNE UM JSON com esta estrutura exata:
{
  "historical": {
    "years": [2019, 2020, 2021, 2022, 2023, 2024],
    "receitaLiquida": [números em milhões BRL ou null],
    "ebitda": [números em milhões BRL ou null],
    "lucroLiquido": [números em milhões BRL ou null],
    "margemBruta": [percentuais ou null],
    "margemEbitda": [percentuais ou null],
    "margemLiquida": [percentuais ou null],
    "fco": [fluxo caixa operacional em milhões ou null],
    "fcl": [fluxo caixa livre em milhões ou null],
    "capex": [capex em milhões, valores negativos ou null],
    "dividaLiquida": [milhões ou null],
    "patrimonioLiquido": [milhões ou null],
    "dividendosPorAcao": [BRL por ação ou null],
    "dividendYield": [percentuais ou null]
  },
  "dcfInputs": {
    "lastFCL": número_em_milhões_ou_null,
    "wacc": percentual_sugerido,
    "crescimentoProjetado": percentual_sugerido,
    "crescimentoPerpetuo": percentual_sugerido,
    "dividaLiquida": milhões_ou_null,
    "caixa": milhões_ou_null,
    "acoes": número_total_ações_ou_null
  },
  "analysis": "Texto completo em Markdown com a análise. Use ## para títulos das seções: Resumo Executivo, Receita e Crescimento, Rentabilidade, Geração de Caixa, Endividamento, Dividendos, Riscos, Conclusão. Seja específico com números e datas.",
  "dataSource": "Fontes consultadas para os dados históricos"
}

REGRAS:
- Use null para qualquer dado indisponível
- Valores monetários em milhões de BRL (exceto por ação)
- Percentuais como números (12.5 para 12,5%)
- Inclua 4-6 anos de dados históricos reais
- A análise deve ter pelo menos 800 palavras
- Priorize dados de fontes oficiais (RI, CVM, B3, DFPs, ITRs)
- Complemente com agregadores (Status Invest, Fundamentus, Investidor10)
- Retorne APENAS o JSON, sem texto adicional`;
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  if (!apiKey) throw new Error('GEMINI_API_KEY não configurado');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.7,
        maxOutputTokens: 16384
      }
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();

  if (!data.candidates || !data.candidates.length) {
    throw new Error('Gemini não retornou candidatos');
  }

  const text = data.candidates[0].content?.parts?.[0]?.text;
  if (!text) throw new Error('Resposta vazia do Gemini');

  return JSON.parse(text);
}

// ── Handler Principal ──

export default async function handler(req, res) {
  // CORS para desenvolvimento local
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const { ticker, companyName, metrics } = req.body;
  if (!ticker) {
    return res.status(400).json({ error: 'Parâmetro "ticker" é obrigatório' });
  }

  const tickerUpper = ticker.toUpperCase();

  try {
    const supabase = getSupabase();

    // ── 1. Verificar Cache ──
    const { data: cached, error: cacheError } = await supabase
      .from('stock_analyses')
      .select('*')
      .eq('ticker', tickerUpper)
      .single();

    if (!cacheError && cached && isCacheFresh(cached.updated_at)) {
      return res.status(200).json({
        historical: cached.historical || {},
        dcfInputs: cached.dcf_inputs || {},
        analysis: cached.analysis_text || '',
        dataSource: cached.data_source || '',
        fromCache: true,
        updatedAt: cached.updated_at
      });
    }

    // ── 2. Chamar Gemini ──
    const prompt = buildGeminiPrompt(tickerUpper, companyName || tickerUpper, metrics);
    const geminiResult = await callGemini(prompt);

    const result = {
      historical: geminiResult.historical || {},
      dcfInputs: geminiResult.dcfInputs || {},
      analysis: geminiResult.analysis || '',
      dataSource: geminiResult.dataSource || 'Gemini AI',
      fromCache: false,
      updatedAt: new Date().toISOString()
    };

    // ── 3. Salvar no Supabase (fire-and-forget com fallback) ──
    try {
      await supabase.from('stock_analyses').upsert({
        ticker: tickerUpper,
        company_name: companyName || tickerUpper,
        sector: '',
        description: '',
        historical: result.historical,
        dcf_inputs: result.dcfInputs,
        analysis_text: result.analysis,
        data_source: result.dataSource,
        updated_at: result.updatedAt
      }, { onConflict: 'ticker' });
    } catch (saveErr) {
      // Cache write falhou — não bloqueia a resposta
      console.error('Erro ao salvar cache no Supabase:', saveErr.message);
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('Erro no /api/analysis:', err.message);
    return res.status(500).json({
      error: 'Erro ao gerar análise: ' + err.message
    });
  }
}
