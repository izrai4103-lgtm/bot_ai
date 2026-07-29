import 'dotenv/config';
import { sandboxChat, sandboxChatStream, checkSandbox, geminiCall } from './sandbox_client.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

// ============ PLAIN.JSON ============
// Vercel serverless: /tmp is the only writable directory
const PLAIN_TMP = '/tmp/bot_ai_plain.json';

// ============ REGULATIONS ============
let REGULATIONS = '';
try {
  const regPaths = [join(ROOT, 'regulation.md'), join(__dirname, 'regulation.md')];
  for (const p of regPaths) {
    if (existsSync(p)) {
      REGULATIONS = readFileSync(p, 'utf-8');
      break;
    }
  }
} catch {}

// ============ DATA CONTENT ============
let DATA_CONTENT = '';
try {
  const dataPaths = [join(ROOT, 'data.content'), join(__dirname, 'data.content')];
  for (const p of dataPaths) {
    if (existsSync(p)) {
      DATA_CONTENT = readFileSync(p, 'utf-8');
      break;
    }
  }
} catch (e) {
  console.error('Load data.content error:', e.message);
}

// ============ LICENSE PDF ============
let LICENSE_TEXT = '';
try {
  // Try multiple paths for Vercel compatibility
  const paths = [
    join(ROOT, 'extracted_license.txt'),
    join(__dirname, 'extracted_license.txt'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      LICENSE_TEXT = readFileSync(p, 'utf-8');
      break;
    }
  }
  if (!LICENSE_TEXT) {
    // Try the original PDF path
    for (const p of [join(ROOT, 'license.pdf'), join(__dirname, 'license.pdf')]) {
      if (existsSync(p)) {
        LICENSE_TEXT = 'License file available at license.pdf';
        break;
      }
    }
  }
} catch (e) {
  console.error('Load license error:', e.message);
}

// ============ OPENAI DOCS ============
let OPENAI_DOCS_CACHE = {};
const OPENAI_DOCS_URLS = {
  latestModel: 'https://developers.openai.com/api/docs/guides/latest-model.md',
  codexManual: 'https://developers.openai.com/codex/codex-manual.md',
  promptingGuide: 'https://developers.openai.com/api/docs/guides/prompt-guidance.md',
  responsesApi: 'https://developers.openai.com/api/docs/guides/responses-api.md'
};

async function refreshOpenAIDocs() {
  const now = Date.now();
  // Refresh cache if older than 1 hour
  if (OPENAI_DOCS_CACHE._timestamp && (now - OPENAI_DOCS_CACHE._timestamp) < 3600000) return;
  
  for (const [key, url] of Object.entries(OPENAI_DOCS_URLS)) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const text = await resp.text();
        // Limit to reasonable size
        OPENAI_DOCS_CACHE[key] = text.substring(0, 8000);
      }
    } catch (e) {
      console.error('OpenAI docs fetch error for', key, e.message);
    }
  }
  OPENAI_DOCS_CACHE._timestamp = Date.now();
}

function getOpenAIDocsContext(query) {
  const cache = OPENAI_DOCS_CACHE;
  if (!cache.latestModel && !cache.codexManual) return '';
  
  let context = '# OpenAI Documentation (sumber resmi)\n';
  if (cache.latestModel) {
    context += '## Model Terbaru\n' + cache.latestModel.substring(0, 2000) + '\n\n';
  }
  if (cache.responsesApi) {
    context += '## Responses API\n' + cache.responsesApi.substring(0, 2000) + '\n\n';
  }
  if (cache.codexManual) {
    context += '## Codex Manual\n' + cache.codexManual.substring(0, 2000) + '\n\n';
  }
  if (cache.promptingGuide) {
    context += '## Prompting Guide\n' + cache.promptingGuide.substring(0, 2000) + '\n\n';
  }
  return context + '\nGunakan dokumentasi resmi di atas untuk memastikan jawaban akurat dan tidak kadaluarsa.\n';
}

// ============ BOT NAME ============
const BOT_NAME = 'ELENA';

function defaultPlain() {
  return {
    version: 1,
    learnings: [],
    knowledge: { bot_name: 'ELENA', language: 'Bahasa Indonesia', platform: 'Groq AI' },
    preferences: {},
    stats: { total_conversations: 0, total_learnings: 0, last_updated: null }
  };
}

function loadPlain() {
  // Always read from /tmp (writable directory)
  try {
    if (existsSync(PLAIN_TMP)) {
      const data = JSON.parse(readFileSync(PLAIN_TMP, 'utf-8'));
      if (data && data.version) return data;
    }
  } catch {}
  return defaultPlain();
}

function savePlain(data) {
  try {
    writeFileSync(PLAIN_TMP, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Save plain error:', err.message);
  }
}

function stripThinkTags(text) {
  // Strip <think>...</think> and <Thinking>...</Thinking> reasoning tags
  return text.replace(/<[Tt]hink>[\s\S]*?<\/[Tt]hink>/g, '').trim();
}

function extractTextFromContent(content) {
  // Handle content block format: [{ type: "text", text: "..." }, ...]
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  }
  return String(content || '');
}

function makeContentBlocks(text) {
  // Create content block array from text string
  return [{ type: 'text', text: text }];
}

function normalizeMessages(messages) {
  // Normalize messages to always use simple { role, content: string } format
  return messages.map(msg => {
    if (msg.content && Array.isArray(msg.content)) {
      return { ...msg, content: extractTextFromContent(msg.content) };
    }
    if (msg.content === undefined || msg.content === null) {
      return { ...msg, content: '' };
    }
    return msg;
  });
}
// ============ WEB SEARCH & BROWSE ============
const SEARCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ============ GEMINI SEARCH ============
async function geminiSearch(query) { 
  const geminiKey = process.env.GEMINI_SEARCH_API_KEY || process.env.GOOGLE_API_KEY;
  if (!geminiKey) return null;
  
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(geminiKey);
    const body = {
      contents: [{
        role: 'user',
        parts: [{ text: 'Cari informasi terbaru tentang: ' + query + '. Berikan hasil pencarian dalam format terstruktur dengan URL, judul, dan deskripsi singkat untuk setiap hasil. Cantumkan minimal 3 dan maksimal 5 hasil.' }]
      }],
      tools: [{ googleSearch: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        candidateCount: 1
      }
    };
    
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    
    const data = await resp.json();
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const parts = data.candidates[0].content.parts;
      const textPart = parts.find(p => p.text)?.text || '';
      const groundingMetadata = data.candidates[0].groundingMetadata;
      
      // Extract search results from grounding chunks
      const results = [];
      if (groundingMetadata?.groundingChunks) {
        for (const chunk of groundingMetadata.groundingChunks) {
          if (chunk.web?.uri && chunk.web?.title) {
            // Find corresponding snippet from the text or from the groundingSupports
            let snippet = '';
            if (groundingMetadata.groundingSupports) {
              for (const support of groundingMetadata.groundingSupports) {
                if (support.segment?.text) {
                  snippet += support.segment.text + ' ';
                }
              }
            }
            results.push({
              url: chunk.web.uri,
              title: chunk.web.title,
              snippet: snippet.trim() || chunk.web.title
            });
            if (results.length >= 5) break;
          }
        }
      }
      
      // Fallback: parse text response for URLs if grounding chunks not available
      if (results.length === 0 && textPart) {
        const urlRegex = /https?:\/\/[^\s"')\]}]+/g;
        const urls = textPart.match(urlRegex);
        if (urls) {
          for (const u of urls.slice(0, 5)) {
            results.push({
              url: u,
              title: 'Hasil pencarian',
              snippet: textPart.substring(0, 300)
            });
          }
        }
      }
      
      if (results.length > 0) return results;
    }
    return null;
  } catch (err) {
    console.error('Gemini search error:', err.message);
    return null;
  }
}

// Search the web using multiple methods
async function webSearch(query) {
  // 1. Try Gemini with Google Search Grounding (REAL data, anti-hallucination)
  const geminiResults = await geminiSearch(query);
  if (geminiResults && geminiResults.length > 0) {
    console.log('Gemini search success for:', query);
    return geminiResults;
  }
  console.log('Gemini search failed or empty for:', query);

  // 2. Try Google Programmable Search API if configured
  const googleKey = process.env.GOOGLE_API_KEY;
  const googleCx = process.env.GOOGLE_CX;
  if (googleKey && googleCx) {
    try {
      const gUrl = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(googleKey) + '&cx=' + encodeURIComponent(googleCx) + '&q=' + encodeURIComponent(query) + '&lr=lang_id&num=5';
      const resp = await fetch(gUrl, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json();
      if (data.items && Array.isArray(data.items)) {
        return data.items.map(item => ({
          url: item.link || '',
          title: item.title || '',
          snippet: (item.snippet || '').substring(0, 500)
        })).slice(0, 5);
      }
    } catch (err) { console.error('Google API fail:', err.message); }
  }

  // 3. Try DuckDuckGo API (may be blocked on some hosts)
  try {
    const ddgUrl = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
    const resp = await fetch(ddgUrl, { 
      headers: { 'User-Agent': SEARCH_USER_AGENT },
      signal: AbortSignal.timeout(10000)
    });
    const text = await resp.text();
    if (text && text.length > 10) {
      const data = JSON.parse(text);
      const results = [];
      if (data.AbstractText) {
        results.push({ url: data.AbstractURL || 'https://duckduckgo.com', title: data.Heading || query, snippet: data.AbstractText.substring(0, 500) });
      }
      if (data.Answer && data.Answer !== data.AbstractText) {
        results.push({ url: data.AnswerURL || 'https://duckduckgo.com', title: data.Heading || query, snippet: data.Answer.substring(0, 500) });
      }
      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const t of data.RelatedTopics) {
          if (results.length >= 5) break;
          if (t.Text) results.push({ url: t.FirstURL || 'https://duckduckgo.com', title: t.Text.split(' - ')[0] || query, snippet: t.Text.substring(0, 500) });
        }
      }
      if (results.length > 0) return results;
    }
  } catch (err) { console.error('DDG API fail:', err.message); }

  // Fallback: Try DuckDuckGo HTML search
  try {
    const htmlResp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': SEARCH_USER_AGENT },
      signal: AbortSignal.timeout(15000)
    });
    const html = await htmlResp.text();
    const results = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\//gi;
    const urls = [], titles = [], snippets = [];
    let m;
    while ((m = resultRegex.exec(html)) !== null && urls.length < 5) {
      let href = m[1];
      if (href.startsWith('//')) href = 'https:' + href;
      if (href.startsWith('/')) href = 'https://duckduckgo.com' + href;
      urls.push(href);
      titles.push(m[2].replace(/<[^>]*>/g, '').trim());
    }
    while ((m = snippetRegex.exec(html)) !== null && snippets.length < 5) {
      snippets.push(m[1].replace(/<[^>]*>/g, '').trim());
    }
    for (let i = 0; i < Math.min(urls.length, 5); i++) {
      results.push({ url: urls[i], title: titles[i], snippet: snippets[i] || '' });
    }
    if (results.length > 0) return results;
  } catch (err) { console.error('DDG HTML fail:', err.message); }

  // Fallback: Try Bing search
  try {
    const bingResp = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=5', {
      headers: { 'User-Agent': SEARCH_USER_AGENT, 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(10000)
    });
    const bingHtml = await bingResp.text();
    const results = [];
    // Parse Bing results
    const bingRegex = /<li class="b_algo">[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = bingRegex.exec(bingHtml)) !== null && results.length < 5) {
      results.push({
        url: m[1],
        title: m[2].replace(/<[^>]*>/g, '').trim(),
        snippet: m[3].replace(/<[^>]*>/g, '').trim()
      });
    }
    if (results.length > 0) return results;
  } catch (err) { console.error('Bing fail:', err.message); }

  return [];
}



// Browse and extract text from a URL
async function browseUrl(targetUrl) {
  try {
    const response = await fetch(targetUrl, {
      headers: { 'User-Agent': SEARCH_USER_AGENT },
      signal: AbortSignal.timeout(10000)
    });
    const html = await response.text();
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[^;]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 8000) text = text.substring(0, 8000) + '... [truncated]';
    return text;
  } catch (err) {
    console.error('Browse error:', err.message);
    return '';
  }
}

async function researchQuery(query) {
  const searchResults = await webSearch(query);
  if (searchResults.length === 0) {
    return 'Pencarian web untuk "' + query + '" tidak menghasilkan hasil dari sumber eksternal. Jawab berdasarkan pengetahuan yang kamu miliki.';
  }
  let context = '## Hasil Riset Web\nPertanyaan: "' + query + '"\n\n';
  searchResults.forEach((r, i) => {
    context += '### ' + (i + 1) + '. ' + r.title + '\n';
    context += '- **URL**: ' + r.url + '\n';
    context += '- **Ringkasan**: ' + (r.snippet || 'Tidak ada ringkasan') + '\n\n';
  });
  // Browse the top result for more detail (skip if it looks like a search portal)
  const topUrl = searchResults[0].url;
  if (topUrl && !topUrl.includes('duckduckgo.com') && !topUrl.includes('google.com')) {
    try {
      const detail = await browseUrl(topUrl);
      if (detail && !detail.startsWith('Error:')) {
        context += '### Detail dari halaman utama\n**URL**: ' + topUrl + '\n**Konten**:\n' + detail.substring(0, 3000) + '\n\n';
      }
    } catch (e) {
      // Silently skip if browse fails
    }
  }
  return context;
}



function addLearning(userMsg, aiMsg) {
  const plain = loadPlain();
  if (plain.learnings.length > 500) {
    plain.learnings = plain.learnings.slice(-250);
  }
  plain.learnings.push({
    id: Date.now().toString(),
    user_message: userMsg,
    ai_response: aiMsg,
    timestamp: new Date().toISOString()
  });
  plain.stats.total_learnings = plain.learnings.length;
  plain.stats.total_conversations++;
  plain.stats.last_updated = new Date().toISOString();
  savePlain(plain);
  return plain;
}

// ============ MULTI-AGENT SYSTEM ============
// 4 AI Agents dengan tugas masing-masing:
// 1. Thinking Agent - menganalisis & merencanakan
// 2. Search Agent - riset web
// 3. Security Agent - menjaga aturan & sandbox
// 4. ELENA (Main AI) - menjawab user

const AGENT_MAX_TOKENS = 250;

async function callAgent({ prompt, history, system, apiKey, model, temperature, maxTokens }) {
  return geminiCall({
    prompt,
    history: history || [],
    system: system || '',
    apiKey,
    model: model || 'gemini-2.5-flash',
    temperature: temperature || 0.3,
    maxTokens: maxTokens || AGENT_MAX_TOKENS,
  });
}

// ============ 1. THINKING AGENT ============
// Menganalisis pertanyaan user, membuat rencana jawaban
async function thinkingAgent(userMessage, history, webContext) {
  const apiKey = process.env.GEMINI_THINKING_API_KEY || process.env.GOOGLE_API_KEY;
  
  const systemPrompt = `Kamu adalah **Thinking Agent** — AI yang bertugas menganalisis pertanyaan dan membuat rencana jawaban.
Tugasmu:
1. Analisis inti pertanyaan user
2. Identifikasi topik utama dan konteks
3. Buat rencana jawaban singkat (2-3 poin)
4. Tentukan apakah perlu data tambahan

Keluarkan dalam format:
**Analisis**: [analisis singkat]
**Rencana**: [rencana jawaban]
**Kesimpulan**: [kesimpulan untuk diteruskan ke ELENA]

${webContext ? "\n## Hasil Riset Web\n" + webContext : ""}`;

  try {
    const result = await callAgent({
      prompt: userMessage,
      history: history || [],
      system: systemPrompt,
      apiKey,
      temperature: 0.3,
      maxTokens: 250,
    });
    return result;
  } catch (err) {
    console.error('Thinking Agent error:', err.message);
    return '**Analisis**: Pertanyaan user\n**Rencana**: Jawab langsung\n**Kesimpulan**: Berikan jawaban terbaik';
  }
}

// ============ 2. SEARCH AGENT ============
// Mencari informasi di web (via Gemini Search Grounding)
// Fungsi geminiSearch sudah ada di atas

// ============ 3. SECURITY AGENT ============
// Memeriksa apakah jawaban aman dan sesuai aturan
// ============ 2. READER AGENT ============
// Membaca konten website yang ditemukan Search Agent
async function readerAgent(urls, query) {
  const apiKey = process.env.GEMINI_READER_API_KEY || process.env.GOOGLE_API_KEY;
  if (!urls || urls.length === 0) return '';

  let results = [];
  const maxRead = Math.min(urls.length, 3);
  
  for (let i = 0; i < maxRead; i++) {
    try {
      const content = await browseUrl(urls[i].url);
      if (content && !content.startsWith('Error:')) {
        // Use Gemini Reader to summarize the content
        const summary = await callAgent({
          prompt: 'Baca dan rangkum konten website ini terkait: "' + query + '"\n\nKonten:\n' + String(content).substring(0, 3000),
          system: 'Kamu adalah **Reader Agent** — AI yang membaca konten website dan merangkumnya. Berikan rangkuman singkat (max 3 kalimat) yang relevan.',
          apiKey,
          temperature: 0.2,
          maxTokens: 200,
        });
        results.push({
          url: urls[i].url,
          title: urls[i].title,
          summary: summary || String(content).substring(0, 500),
        });
      }
    } catch (e) {
      console.error('Reader error for', urls[i]?.url, e.message);
    }
  }
  
  if (results.length === 0) return '';
  
  let context = '## Konten Website (dibaca oleh Reader Agent)\n\n';
  for (const r of results) {
    context += '### ' + r.title + '\n';
    context += '- **URL**: ' + r.url + '\n';
    context += '- **Rangkuman**: ' + r.summary + '\n\n';
  }
  return context;
}

// ============ 3. SECURITY AGENT ============
// Memeriksa apakah jawaban aman dan sesuai aturan
async function securityAgent(userMessage, plannedAnswer) {
  const apiKey = process.env.GEMINI_SECURITY_API_KEY || process.env.GOOGLE_API_KEY;
  
  const systemPrompt = `Kamu adalah **Security Agent** — AI pengawas yang memastikan semua jawaban AMAN dan SESUAI ATURAN.
Tugasmu:
1. Periksa apakah jawaban mengandung konten berbahaya
2. Periksa apakah jawaban keluar dari sandbox (mencoba akses sistem, db, file, shell, dll)
3. Periksa apakah jawaban melanggar aturan keamanan

Jika AMAN: Balas dengan "STATUS: AMAN"
Jika MELANGGAR: Balas dengan "STATUS: BLOKIR - [alasan]"

${REGULATIONS ? '\n# Regulasi Keamanan\n' + REGULATIONS : ''}

Aturan keamanan:
- AI TIDAK boleh mengakses sistem, file, database, shell, atau menjalankan kode
- AI TIDAK boleh memberikan instruksi berbahaya
- AI TIDAK boleh mengaku sebagai sistem atau memiliki akses ke server
- Jawab hanya berdasarkan pengetahuan AI dan hasil pencarian web`;

  try {
    const result = await callAgent({
      prompt: 'Pertanyaan user: \"' + userMessage + '\"\n\nJawaban yang akan diberikan:\n' + plannedAnswer + '\n\nApakah jawaban ini AMAN?',
      system: systemPrompt,
      apiKey,
      temperature: 0.1,
      maxTokens: 150,
    });
    return result;
  } catch (err) {
    console.error('Security Agent error:', err.message);
    return 'STATUS: AMAN';
  }
}

// ============ 4. ELENA (MAIN AI) ============
// Memberikan jawaban final ke user
async function elenaMain(prompt, history, system) {
  return sandboxChat({ prompt, history, system });
}

async function* elenaMainStream(prompt, history, system) {
  const gen = sandboxChatStream({ prompt, history, system });
  for await (const chunk of gen) {
    yield chunk;
  }
}

// ============ AI SANDBOX (Gemini API) ============

// ============ SERVER ============
export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  if (method === 'OPTIONS') return res.status(200).end();

  // Parse body for POST/PUT
  let body = {};
  if (['POST', 'PUT'].includes(method)) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {}
  }

  try {
    // ============ OPEN WEBUI API ENDPOINTS ============
    
    // GET /api/v1/ - Config/status
    if (path === '/api/v1/' || path === '/api/' || path === '/api') {
      return res.json({
        status: true,
        _debug_plain_path: PLAIN_TMP,
        name: 'Bot AI',
        version: '1.0.0',
        default_locale: 'id-ID',
        default_models: 'gemini-2.5-flash',
        default_prompt_suggestions: [
          { content: 'Apa kabar?', title: ['Sapa', 'Sapa bot'] },
          { content: 'Jelaskan AI dalam bahasa sederhana', title: ['Edukasi', 'Belajar AI'] },
          { content: 'Bantu saya menulis kode Python', title: ['Kode', 'Python'] }
        ],
        features: {
          auth: false,
          enable_signup: false,
          enable_login_form: false,
          enable_api_keys: false,
          enable_web_search: false,
          enable_image_generation: false,
          enable_admin_export: false,
          enable_admin_chat_access: false,
          enable_admin_analytics: false,
          enable_community_sharing: false,
          enable_memories: true,
          enable_plugins: false,
          enable_autocomplete_generation: false,
          enable_direct_connections: false,
          enable_version_update_check: false,
          enable_pyodide_file_persistence: false
        },
        oauth: { providers: {} },
        ui: {}
      });
    }

    // GET /api/v1/models or /api/models
    if (path === '/api/v1/models' || path === '/api/models') {
      const models = [
        { id: 'gemini-2.5-flash', name: 'Gemini 2.0 Flash', owned_by: 'google', info: { capabilities: { vision: false, chat: true } } }
      ];
      return res.json({ data: models });
    }

    // GET /api/v1/auth/ - Auth status (no auth mode)
    if (path.startsWith('/api/v1/auth')) {
      if (path.endsWith('/')) {
        return res.json({ status: true, user: { id: 'local', name: 'User', email: 'user@local', role: 'admin', profile_image_url: '/static/user.png' } });
      }
      return res.json({ status: true });
    }

    // Open WebUI auth endpoints
    if (path === '/api/v1/auths/' || path === '/api/v1/auths') {
      return res.json({ status: true, user: { id: 'local', name: 'User', email: 'user@local', role: 'admin' } });
    }

    // GET /api/v1/chats/ - List chats
    if (path.startsWith('/api/v1/chats')) {
      if (method === 'GET') return res.json([]);
      if (method === 'POST') return res.json({ id: Date.now().toString(), ...body });
      if (path.includes('/config')) return res.json({});
      if (method === 'DELETE') return res.json({ status: true });
      return res.json({ status: true });
    }

    // GET /api/v1/memories/
    if (path === '/api/v1/memories/' || path === '/api/v1/memories') {
      const plain = loadPlain();
      return res.json({ data: plain.learnings.map(l => ({ id: l.id, content: l.user_message + ' -> ' + l.ai_response, created_at: l.timestamp })) });
    }

    // GET /api/v1/configs/
    if (path.startsWith('/api/v1/configs') || path.startsWith('/api/v1/config')) {
      return res.json({ status: true });
    }

    // GET /api/v1/knowledge/
    if (path.startsWith('/api/v1/knowledge')) return res.json({ data: [] });

    // GET /api/v1/tools/
    if (path.startsWith('/api/v1/tools')) return res.json({ data: [] });

    // GET /api/v1/functions/
    if (path.startsWith('/api/v1/functions')) return res.json({ data: [] });

    // GET /api/v1/prompts/
    if (path.startsWith('/api/v1/prompts')) return res.json({ data: [] });

    // GET /api/v1/folders/
    if (path.startsWith('/api/v1/folders')) return res.json({ data: [] });

    // GET /api/v1/tags/
    if (path.startsWith('/api/v1/tags')) return res.json({ data: [] });

    // GET /api/v1/users/
    if (path.startsWith('/api/v1/users')) return res.json({ data: [] });

    // GET /api/v1/groups/
    if (path.startsWith('/api/v1/groups')) return res.json({ data: [] });

    // GET /api/v1/files/
    if (path.startsWith('/api/v1/files')) return res.json({ data: [] });

    

    
    // ============ WEB SEARCH CONFIG ============
    if (path === '/api/web/config') {
      const hasGeminiKey = !!process.env.GOOGLE_API_KEY;
      const hasCx = !!process.env.GOOGLE_CX;
      return res.json({
        gemini_available: hasGeminiKey,
        google_cx_configured: hasCx,
        available: hasGeminiKey || hasCx,
        message: 'Gemini dengan Google Search Grounding: ' + (hasGeminiKey ? 'API Key terpasang' : 'Belum ada API Key') + '.',
        note: 'Gemini Search memberikan data REAL dengan Google Search grounding (anti-halusinasi). Jika kehabisan kuota, tunggu reset harian atau aktifkan billing di https://aistudio.google.com'
      });
    }

// ============ WEB SEARCH & BROWSE API ============
    if (path === '/api/web/search' && method === 'POST') {
      const { query } = body;
      if (!query) return res.json({ results: [], error: 'Query diperlukan' });
      const results = await webSearch(query);
      return res.json({ results, query });
    }

    if (path === '/api/web/browse' && method === 'POST') {
      const { url } = body;
      if (!url) return res.json({ error: 'URL diperlukan' });
      const content = await browseUrl(url);
      return res.json({ url, content: content.substring(0, 5000) });
    }

    if (path === '/api/web/research' && method === 'POST') {
      const { query } = body;
      if (!query) return res.json({ context: '', error: 'Query diperlukan' });
      const context = await researchQuery(query);
      return res.json({ query, context });
    }

    // GET /api/web/search
    if (path === '/api/web/search' && method === 'GET') {
      const q = url.searchParams.get('q');
      if (!q) return res.json({ results: [], error: 'Query parameter q diperlukan' });
      const results = await webSearch(q);
      return res.json({ results, query: q });
    }

    // GET /api/web/browse
    if (path === '/api/web/browse' && method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return res.json({ error: 'URL parameter url diperlukan' });
      const content = await browseUrl(targetUrl);
      return res.json({ url: targetUrl, content: content.substring(0, 5000) });
    }

    // GET /api/web/research
    if (path === '/api/web/research' && method === 'GET') {
      const q = url.searchParams.get('q');
      if (!q) return res.json({ context: '', error: 'Query parameter q diperlukan' });
      const context = await researchQuery(q);
      return res.json({ query: q, context });
    }

// ============ OPENAI COMPATIBLE ENDPOINTS ============
    
    // GET /openai/models - List Groq models
    if (path === '/openai/models') {
      return res.json({
        data: [
          { id: 'gemini-2.5-flash', object: 'model', owned_by: 'google' }
        ]
      });
    }

    // POST /openai/chat/completions - Chat completion via Groq
    // POST /api/chat/completions
    if ((path === '/openai/chat/completions' || path === '/api/chat/completions' || path === '/api/v1/chat/completions') && method === 'POST') {
      const model = body.model || 'gemini-2.5-flash';
      const messages = normalizeMessages(body.messages || []);
      const stream = body.stream !== false;

      // Add system message with plain.json knowledge
      const plain = loadPlain();
      // Web search integration for OpenAI-compatible endpoint
      let openaiWebContext = '';
      if (body.web_search === true && messages.length > 0) {
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        if (lastUserMsg) {
          const msgText = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content);
          try {
            const searchData = await researchQuery(msgText);
            openaiWebContext = '# Hasil Riset Web\n' + searchData + '\n\n---\n\nGunakan informasi di atas untuk menjawab pertanyaan user. Cantumkan sumber URL jika relevan.\n\n';
          } catch (e) {
            console.error('Web search error:', e.message);
          }
        }
      }
      // Auto-refresh OpenAI docs if needed
      try { refreshOpenAIDocs(); } catch(e) {}

            const openaiDocsCtx = getOpenAIDocsContext("");
      const systemMsg = `${openaiWebContext}${openaiDocsCtx}Kamu adalah asisten AI bernama ELENA yang berjalan di dalam **AI ELENA (Gemini)** — lingkungan aman dan terisolasi dengan sistem log, statistik, error handling, dan filter bawaan.

# Format Pertanyaan Terstruktur
Jika kamu perlu menggali informasi dari user (seperti survei, polling, atau kebutuhan spesifik), gunakan format JSON berikut. Keluarkan JSON ini **saja tanpa teks lain** di awal pesan, lalu setelah user menjawab baru berikan respons lanjutan.

[JSON Example]\n{
  "questions": [
    {
      "id": "tujuan",
      "question": "Apa tujuan utama kamu?",
      "description": "Penjelasan tambahan (opsional)",
      "type": "single_select",
      "required_answer": true,
      "options": [
        { "label": "Belajar AI", "value": "belajar" },
        { "label": "Pekerjaan", "value": "pekerjaan" },
        { "label": "Hiburan", "value": "hiburan" }
      ]
    }
  ]
}


Aturan:
- Wajib ada kunci "questions" berisi 1-3 pertanyaan
- Setiap pertanyaan wajib ada "question" (teks tanya), "options" (2-4 pilihan), dan "id"
- Type: "single_select" (pilih satu), "multi_select" (pilih banyak), "rank_priorities" (urutkan)
- Jangan tambah teks lain saat mengeluarkan pertanyaan — hanya murni JSON
- Setelah user menjawab, berikan respons lanjutan yang natural

# Personality
Kamu adalah kolaborator yang capable: mudah didekati, steady, dan direct. Jawab dengan singkat, padat, dan langsung ke inti. Gunakan bahasa Indonesia yang alami dan mudah dipahami.

# Aturan Utama
- Jawaban harus SINGKAT dan PADAT — maksimal 3-4 paragraf, lebih baik 1-2 paragraf
- Langsung ke inti jawaban, tanpa basa-basi
- Karena kamu sudah melalui fase analisis dan rangkuman, langsung berikan HASIL AKHIR berupa rangkuman atau jawaban konkret
- Jangan menjelaskan proses berpikir
- Jangan mengulang pertanyaan user
- Jika pertanyaan terkait API OpenAI, model AI, atau dokumentasi terbaru, gunakan dokumentasi OpenAI yang sudah disediakan di atas untuk memastikan jawaban akurat dan tidak kadaluarsa

# Konteks Bot
Nama: ${plain.knowledge.bot_name || 'Chat AI'}
Bahasa: ${plain.knowledge.language || 'Bahasa Indonesia'}

${plain.learnings.length > 0 ? '# Data Pembelajaran\n' + plain.learnings.slice(-20).map(l => `- User: ${l.user_message}\n  AI: ${l.ai_response}`).join('\n') : ''}

${REGULATIONS ? '\n# Regulasi Keamanan\n' + REGULATIONS : ''}

${DATA_CONTENT ? '\n# Format Pesan (Content Blocks)\n' + DATA_CONTENT : ''}

${LICENSE_TEXT ? '\n# Lisensi\n' + LICENSE_TEXT : ''}

${body.system ? '\n### Instruksi Tambahan\n' + body.system : ''}`;

      const fullMessages = [
        { role: 'system', content: systemMsg },
        ...messages
      ];

      try {
        const responseText = await sandboxChat({
          prompt: extractTextFromContent(messages[messages.length - 1]?.content || ''),
          history: messages.slice(0, -1).filter(m => m.role !== 'system'),
          model: model,
          temperature: body.temperature || 0.7,
          maxTokens: body.max_tokens || 4096,
          system: systemMsg,
        });

        const lastMsg = messages[messages.length - 1];
        if (lastMsg && responseText) {
          addLearning(extractTextFromContent(lastMsg?.content || ''), stripThinkTags(responseText));
        }

        return res.json({
          id: 'chat-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: stripThinkTags(responseText) },
            finish_reason: 'stop'
          }],
          usage: { total_tokens: 0 }
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ============ OPENAI CONFIG ============
    if (path === '/openai/config') {
      return res.json({ ENABLE_OPENAI_API: true, OPENAI_API_BASE_URLS: ['https://generativelanguage.googleapis.com'], OPENAI_API_KEYS: [process.env.GOOGLE_API_KEY || ''], OPENAI_API_CONFIGS: {} });
    }

    // ============ CUSTOM CHAT API (for frontend) ============
    if (path === '/api/chat' && method === 'POST') {
      const { message, model, system, web_search, history } = body;
      if (!message) return res.status(400).json({ error: 'Message required' });

      // Ambil pesan user
      const userMsg = typeof message === 'object' ? (message.content || JSON.stringify(message)) : message;

      // Set headers FIRST before any res.write()
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // ============ MULTI-AGENT FLOW ============
      
      // 1. SEARCH AGENT - Riset web (jika diminta)
      let webContext = '';
      if (web_search === true) {
        try {
          res.write('data: ' + JSON.stringify({ agent: 'search', content: '\\ud83c\\udf10 Mencari informasi...' }) + '\\n\\n');
          const searchData = await researchQuery(userMsg);
          webContext = '# Hasil Riset Web\\n' + searchData + '\\n\\n---\\n\\n';
        } catch (e) {
          console.error('Search error:', e.message);
        }
      }

      // 2. THINKING AGENT - Analisis & rencana
      let thinkingResult = '';
      try {
        res.write('data: ' + JSON.stringify({ agent: 'thinking', content: '\\ud83e\\udde0 Menganalisis pertanyaan...' }) + '\\n\\n');
        thinkingResult = await thinkingAgent(userMsg, history || [], webContext);
      } catch (e) {
        console.error('Thinking error:', e.message);
      }

      // 3. Build context for ELENA
      const plain = loadPlain();
      const openaiDocsCtx = getOpenAIDocsContext("");

      const thinkingContext = thinkingResult 
        ? '# Analisis Internal\\n' + thinkingResult + '\\n\\n' 
        : '';

      const contextPrompt = `${webContext}${thinkingContext}${openaiDocsCtx}Kamu adalah **ELENA** — asisten AI yang ramah dan cerdas.

# Aturan Utama
- Jawab LANGSUNG ke inti pertanyaan, tanpa menjelaskan proses berpikir
- Jawaban SINGKAT dan PADAT (1-3 paragraf)
- Gunakan bahasa Indonesia yang alami
- Jika user minta kode, berikan langsung
- Jangan sebutkan proses internal atau agen lain ke user

# Kepribadian
Ramah, helpful, dan langsung ke titik.

# Konteks Bot
Nama: ${plain.knowledge.bot_name || 'ELENA'}
Bahasa: ${plain.knowledge.language || 'Bahasa Indonesia'}

# Data Pembelajaran
${plain.learnings.slice(-10).map(l => `- ${l.user_message} \\u2192 ${l.ai_response}`).join('\\n')}

${REGULATIONS ? '\\n# Regulasi\\n' + REGULATIONS : ''}
${DATA_CONTENT ? '\\n# Format Pesan\\n' + DATA_CONTENT : ''}
${LICENSE_TEXT ? '\\n# Lisensi\\n' + LICENSE_TEXT : ''}
${system ? '\\n### Instruksi\\n' + system : ''}`;

      try {
        // 4. ELENA - Generate jawaban (streaming)
        res.write('data: ' + JSON.stringify({ agent: 'elena', content: '' }) + '\\n\\n');
        
        const streamGen = sandboxChatStream({
          prompt: userMsg,
          history: history || [],
          model: (model || 'gemini-2.5-flash'),
          temperature: 0.5,
          maxTokens: parseInt(process.env.MAX_TOKENS || '250', 10),
          system: contextPrompt,
        });
        
        let fullResponse = '';
        for await (const chunk of streamGen) {
          if (chunk.done) break;
          if (chunk.content) {
            fullResponse += chunk.content;
            res.write('data: ' + JSON.stringify({ content: chunk.content }) + '\\n\\n');
          }
        }

        // 5. SECURITY AGENT - Final check
        try {
          const securityResult = await securityAgent(userMsg, fullResponse);
          if (securityResult && securityResult.includes('BLOKIR')) {
            console.warn('SECURITY BLOCK:', securityResult);
          }
        } catch (e) {
          console.error('Security check error:', e.message);
        }

        if (fullResponse) {
          addLearning(userMsg, fullResponse);
        }
        
        res.write('data: [DONE]\\n\\n');
        return res.end();
      } catch (err) {
        console.error('ELENA error:', err);
        res.write('data: ' + JSON.stringify({ error: err.message }) + '\\n\\n');
        res.write('data: [DONE]\\n\\n');
        return res.end();
      }
    }

    // ============ PLAIN.JSON MANAGEMENT ============
    if (path === '/api/plain') {
      const plain = loadPlain();
      if (method === 'GET') return res.json(plain);
      if (method === 'POST') {
        if (body.action === 'reset') {
          savePlain({ version: 1, learnings: [], knowledge: plain.knowledge, preferences: {}, stats: { total_conversations: 0, total_learnings: 0, last_updated: null } });
          return res.json({ status: 'reset' });
        }
        if (body.action === 'update_knowledge') {
          plain.knowledge = { ...plain.knowledge, ...body.knowledge };
          savePlain(plain);
          return res.json(plain);
        }
        return res.json(plain);
      }
      return res.json(plain);
    }

    // ============ STATIC FILES FROM OPEN WEBUI ============
    if (path.startsWith('/static/')) {
      const filePath = join(ROOT, 'static', path.replace('/static/', ''));
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = extname(filePath);
        const mime = {
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.webp': 'image/webp',
          '.json': 'application/json',
          '.xml': 'application/xml',
          '.txt': 'text/plain',
          '.html': 'text/html'
        }[ext] || 'application/octet-stream';
        const content = readFileSync(filePath);
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        return res.end(content);
      }
    }

    // ============ DEBUG ============
    
if (path === '/api/debug') {
      return res.json({
        plain_path: PLAIN_TMP,
        root: ROOT,
        exists_tmp: existsSync(PLAIN_TMP),
        node_version: process.version,
        deploy_time: new Date().toISOString()
      });
    }

    // ============ FAVICON ============
    if (path === '/favicon.ico') {
      try {
        const icon = readFileSync(join(ROOT, 'static', 'favicon.ico'));
        res.setHeader('Content-Type', 'image/x-icon');
        return res.end(icon);
      } catch {
        return res.status(404).end();
      }
    }

    // ============ FRONTEND - ChatGPT UI ============
    // Serve the frontend HTML for root and all non-matching routes
    const PUBLIC_DIR = join(ROOT, 'public');
    const htmlPath = join(PUBLIC_DIR, 'index.html');
    
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      return res.end(html);
    }

    // Fallback 404
    return res.status(404).json({ error: 'Not found', path });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// force rebuild 1785301524

// ============ STANDALONE SERVER (for local dev / Docker) ============
// When this file is run directly with `node api/index.js`, start an HTTP server
import { createServer } from 'http';

const isStandalone = process.argv[1] && (
  process.argv[1].endsWith('api/index.js') || 
  process.argv[1].endsWith('api\\index.js') ||
  process.argv[1].endsWith('index.js')
);

if (isStandalone) {
  const PORT = process.env.PORT || 3000;
  
  const server = createServer((req, res) => {
    // Create a simple Express-like request/response wrapper
    const enhancedRes = new Proxy(res, {
      get(target, prop) {
        if (prop === 'json') {
          return (data) => {
            target.setHeader('Content-Type', 'application/json');
            target.end(JSON.stringify(data));
          };
        }
        if (prop === 'status') {
          return (code) => {
            target.statusCode = code;
            return enhancedRes;
          };
        }
        if (prop === 'setHeader') {
          return target.setHeader.bind(target);
        }
        if (prop === 'end') {
          return target.end.bind(target);
        }
        return target[prop];
      }
    });
    
    handler(req, enhancedRes);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Bot AI server running on http://0.0.0.0:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}
