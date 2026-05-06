// ══════════════════════════════════════════════════════
// /api/analysis — Análise Fundamentalista com IA + Cache Supabase
//
// Fluxo:
// 1. Recebe ticker + dados atuais do BrAPI (via frontend)
// 2. Verifica cache no Supabase (TTL configurável)
// 3. Se cache fresco → retorna imediatamente
// 4. Se cache vencido → tenta Gemini → se falhar → OpenRouter (DeepSeek)
// 5. Salva resultado no Supabase → retorna
//
// Retorno JSON:
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Prompt (compartilhado entre Gemini e OpenRouter) ──

function buildPrompt(ticker, companyName, metrics) {
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

// ── Extrair JSON de texto (remove markdown code fences, etc.) ──

function extractJSON(text) {
  try { return JSON.parse(text); } catch (_) { /* continua */ }

  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch (_) { /* continua */ }
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) { /* continua */ }
  }

  throw new Error('Não foi possível extrair JSON da resposta da IA');
}

// ══════════════════════════════════════════
// ── Provider 1: Google Gemini ──
// ══════════════════════════════════════════

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Tenta UMA vez — se falhar, cai no OpenRouter imediatamente (sem retry)
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
    console.log(`Gemini erro ${response.status} — passando para OpenRouter`);
    return null;
  }

  const data = await response.json();
  if (!data.candidates?.length) return null;

  const text = data.candidates[0].content?.parts?.[0]?.text;
  if (!text) return null;

  return extractJSON(text);
}

// ══════════════════════════════════════════
// ── Provider 2: OpenRouter (DeepSeek) ──
// ══════════════════════════════════════════

async function callOpenRouter(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';

  if (!apiKey) throw new Error('Gemini indisponível e OPENROUTER_API_KEY não configurada. Configure pelo menos uma das duas.');

  console.log(`Usando OpenRouter (${model}) como fallback`);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://valoria.vercel.app',
      'X-Title': 'ValorIA'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'Você é um analista fundamentalista sênior. Responda SEMPRE em JSON válido, sem texto adicional antes ou depois do JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 16384
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error('OpenRouter erro:', errBody);
    throw new Error(`Erro na API OpenRouter (${response.status}). Tente novamente em alguns instantes.`);
  }

  const data = await response.json();

  if (!data.choices?.length) {
    throw new Error('OpenRouter não retornou resposta');
  }

  const text = data.choices[0].message?.content;
  if (!text) throw new Error('Resposta vazia do OpenRouter');

  return extractJSON(text);
}

// ══════════════════════════════════════════
// ── Orquestrador: Gemini → OpenRouter ──
// ══════════════════════════════════════════

async function callAI(prompt) {
  try {
    const geminiResult = await callGemini(prompt);
    if (geminiResult) {
      return { result: geminiResult, provider: 'Gemini AI' };
    }
    console.log('Gemini retornou null — usando OpenRouter como fallback');
  } catch (geminiErr) {
    console.log('Gemini falhou com erro:', geminiErr.message, '— usando OpenRouter como fallback');
  }

  const openRouterResult = await callOpenRouter(prompt);
  return { result: openRouterResult, provider: 'DeepSeek via OpenRouter' };
}

// ── Handler Principal ──

export default async function handler(req, res) {
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

    // ── 2. Chamar IA (Gemini → OpenRouter fallback) ──
    const prompt = buildPrompt(tickerUpper, companyName || tickerUpper, metrics);
    const { result: aiResult, provider } = await callAI(prompt);

    const result = {
      historical: aiResult.historical || {},
      dcfInputs: aiResult.dcfInputs || {},
      analysis: aiResult.analysis || '',
      dataSource: aiResult.dataSource || provider,
      fromCache: false,
      updatedAt: new Date().toISOString(),
      provider
    };

    // ── 3. Salvar no Supabase ──
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
