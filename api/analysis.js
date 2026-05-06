// ══════════════════════════════════════════════════════
// /api/analysis — Análise Fundamentalista com IA + Cache Supabase
//
// Fluxo resiliente:
// 1. Tenta cache Supabase (timeout 5s — se falhar, ignora)
// 2. Tenta Gemini (1 tentativa — se falhar, ignora)
// 3. Fallback: OpenRouter/DeepSeek (timeout 50s)
// 4. Salva no Supabase em background (se falhar, ignora)
// ══════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

// ── Helpers ──

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function isCacheFresh(updatedAt) {
  if (!updatedAt) return false;
  const ttlHours = parseInt(process.env.CACHE_TTL_HOURS) || 168; // 7 dias padrão
  const age = Date.now() - new Date(updatedAt).getTime();
  return age < ttlHours * 60 * 60 * 1000;
}

// Fetch com timeout via AbortController
function fetchWithTimeout(url, options, timeoutMs = 50000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── Prompt ──

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
  "analysis": "Texto em Markdown com: Resumo Executivo, Receita e Crescimento, Rentabilidade, Geração de Caixa, Endividamento, Dividendos, Riscos, Conclusão. Seja específico com números.",
  "dataSource": "Fontes consultadas"
}

REGRAS:
- Use null para qualquer dado indisponível
- Valores monetários em milhões de BRL (exceto por ação)
- Percentuais como números (12.5 para 12,5%)
- Inclua 4-6 anos de dados históricos reais
- Retorne APENAS o JSON, sem texto adicional`;
}

// ── Extrair JSON de texto ──

function extractJSON(text) {
  // Limpa blocos "Thinking..." e footers que alguns modelos adicionam
  text = text.replace(/\*Thinking\.\.\.\*\n\n(?:> [^\n]*\n?)*/g, '');
  text = text.replace(/\n*---\n+(?:Learn more|Related searches):\n[\s\S]*$/, '');

  try { return JSON.parse(text.trim()); } catch (_) { /* continua */ }
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
// ── Provider 1: Google Gemini (timeout 15s) ──
// ══════════════════════════════════════════

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  if (!apiKey) return null;

  console.log('[Gemini] Tentando...');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetchWithTimeout(url, {
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
  }, 15000); // 15s timeout

  if (!response.ok) {
    console.log(`[Gemini] Erro ${response.status} — fallback`);
    return null;
  }

  const data = await response.json();
  if (!data.candidates?.length) return null;
  const text = data.candidates[0].content?.parts?.[0]?.text;
  if (!text) return null;

  console.log('[Gemini] Sucesso!');
  return extractJSON(text);
}

// ══════════════════════════════════════════
// ── Provider 2: OpenRouter (timeout 50s) ──
// ══════════════════════════════════════════

async function callOpenRouter(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';
  if (!apiKey) throw new Error('OPENROUTER_API_KEY não configurada.');

  console.log(`[OpenRouter] Usando ${model}...`);

  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
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
        { role: 'system', content: 'Responda SEMPRE em JSON válido, sem texto adicional.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 12000
    })
  }, 50000); // 50s timeout

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('[OpenRouter] Erro:', response.status, errBody.substring(0, 200));
    throw new Error(`Erro na API OpenRouter (${response.status})`);
  }

  const data = await response.json();
  if (!data.choices?.length) throw new Error('OpenRouter sem resposta');

  const text = data.choices[0].message?.content;
  if (!text) throw new Error('Resposta vazia do OpenRouter');

  console.log('[OpenRouter] Sucesso!');
  return extractJSON(text);
}

// ══════════════════════════════════════════
// ── Orquestrador: Gemini → OpenRouter ──
// ══════════════════════════════════════════

async function callAI(prompt) {
  try {
    const geminiResult = await callGemini(prompt);
    if (geminiResult) return { result: geminiResult, provider: 'Gemini AI' };
  } catch (err) {
    console.log('[Gemini] Falhou:', err.message);
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
  console.log(`[analysis] Iniciando análise de ${tickerUpper}`);

  // ── 1. Tentar Cache Supabase (com timeout de 5s) ──
  let supabase = null;
  try {
    supabase = getSupabase();
    if (supabase) {
      console.log('[Supabase] Verificando cache...');
      const cachePromise = supabase
        .from('stock_analyses')
        .select('*')
        .eq('ticker', tickerUpper)
        .single();

      // Timeout de 5 segundos para o Supabase
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Supabase timeout')), 5000)
      );

      const { data: cached, error: cacheError } = await Promise.race([cachePromise, timeoutPromise]);

      if (!cacheError && cached && isCacheFresh(cached.updated_at)) {
        console.log('[Supabase] Cache fresco encontrado!');
        return res.status(200).json({
          historical: cached.historical || {},
          dcfInputs: cached.dcf_inputs || {},
          analysis: cached.analysis_text || '',
          dataSource: cached.data_source || '',
          fromCache: true,
          updatedAt: cached.updated_at
        });
      }
      console.log('[Supabase] Sem cache fresco, chamando IA...');
    }
  } catch (cacheErr) {
    console.log('[Supabase] Cache falhou (ignorando):', cacheErr.message);
    // Continua sem cache — vai direto para a IA
  }

  // ── 2. Chamar IA ──
  try {
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

    // ── 3. Salvar no Supabase (fire-and-forget, não bloqueia resposta) ──
    if (supabase) {
      // Não usa await — salva em background
      supabase.from('stock_analyses').upsert({
        ticker: tickerUpper,
        company_name: companyName || tickerUpper,
        sector: '',
        description: '',
        historical: result.historical,
        dcf_inputs: result.dcfInputs,
        analysis_text: result.analysis,
        data_source: result.dataSource,
        updated_at: result.updatedAt
      }, { onConflict: 'ticker' }).then(() => {
        console.log('[Supabase] Cache salvo com sucesso');
      }).catch(err => {
        console.error('[Supabase] Erro ao salvar:', err.message);
      });
    }

    console.log(`[analysis] Concluído via ${provider}`);
    return res.status(200).json(result);

  } catch (err) {
    console.error('[analysis] Erro final:', err.message);
    return res.status(500).json({
      error: 'Erro ao gerar análise: ' + err.message
    });
  }
}
