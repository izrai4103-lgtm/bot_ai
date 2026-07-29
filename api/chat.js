import Groq from 'groq-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAIN_PATH = join(__dirname, '..', 'plain.json');
const GITHUB_REPO = 'izrai4103-lgtm/bot_ai';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ============ GITHUB TOKEN ============
function getGitHubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch (e) { return ''; }
}

// ============ COMPOSIO TOOLKIT ============
const COMPOSIO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'composio_search_code',
      description: 'Cari kode atau repository di GitHub',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Kata kunci pencarian' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'composio_get_github_user',
      description: 'Lihat informasi user GitHub',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'composio_create_github_issue',
      description: 'Buat issue baru di repository GitHub',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Nama owner/org repo' },
          repo: { type: 'string', description: 'Nama repository' },
          title: { type: 'string', description: 'Judul issue' },
          body: { type: 'string', description: 'Isi/deskripsi issue' }
        },
        required: ['owner', 'repo', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'composio_list_repo_issues',
      description: 'Lihat daftar issues di repository GitHub',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Nama owner' },
          repo: { type: 'string', description: 'Nama repository' }
        },
        required: ['owner', 'repo']
      }
    }
  }
];

async function runComposioTool(name, args) {
  const toolMap = {
    composio_search_code: { slug: 'GITHUB_SEARCH_CODE', defaultArgs: {} },
    composio_get_github_user: { slug: 'GITHUB_GET_THE_AUTHENTICATED_USER', defaultArgs: {} },
    composio_create_github_issue: { slug: 'GITHUB_CREATE_AN_ISSUE', defaultArgs: {} },
    composio_list_repo_issues: { slug: 'GITHUB_LIST_REPOSITORY_ISSUES', defaultArgs: {} },
  };

  const tool = toolMap[name];
  if (!tool) return { error: `Tool ${name} tidak dikenal` };

  try {
    const params = { ...tool.defaultArgs, ...args };
    const jsonStr = JSON.stringify(params).replace(/'/g, "'\\''");
    const result = execSync(
      `composio execute ${tool.slug} -d '${jsonStr}' --skip-connection-check 2>/dev/null`,
      { timeout: 20000, encoding: 'utf-8' }
    );
    try { return JSON.parse(result); }
    catch (e) { return { output: result.trim() }; }
  } catch (e) {
    const msg = e.stderr || e.message || '';
    if (msg.includes('not connected') || msg.includes('not authenticated')) {
      return { error: `tool_not_connected: ${tool.slug}` };
    }
    return { error: msg };
  }
}

// ============ PLAIN.JSON ============
function loadPlain() {
  try {
    if (existsSync(PLAIN_PATH)) {
      return JSON.parse(readFileSync(PLAIN_PATH, 'utf-8'));
    }
  } catch (e) { console.error('plain.json load error:', e.message); }
  return { version: 1, created: new Date().toISOString().split('T')[0], learnings: [], knowledge: {}, preferences: {}, stats: { total_conversations: 0, total_learnings: 0, last_updated: null } };
}

function savePlain(data) {
  try {
    data.stats.last_updated = new Date().toISOString();
    writeFileSync(PLAIN_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) { console.error('plain.json save error:', e.message); return false; }
}

async function pushToGitHub(data) {
  const token = getGitHubToken();
  if (!token) return false;
  try {
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/plain.json`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' }
    });
    const existing = await getRes.json();
    const date = new Date().toISOString().split('T')[0];
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/plain.json`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
      body: JSON.stringify({ message: `auto: update plain.json [${date}]`, content, sha: existing.sha || undefined, branch: 'main' })
    });
    return res.ok;
  } catch (e) { console.error('GitHub push error:', e.message); return false; }
}

async function extractLearnings(conversation, currentLearnings) {
  try {
    const existingJSON = JSON.stringify(currentLearnings.slice(-20));
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: `Extract new learnings from this conversation as JSON array. Types: about_user, ai_taught, insight, preference. Existing: ${existingJSON}. Return [] if nothing new. No markdown.` },
        { role: 'user', content: conversation }
      ],
      temperature: 0.3, max_tokens: 1000,
    });
    const text = completion.choices[0]?.message?.content || '[]';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function buildSystemPrompt(plain) {
  const learnings = plain.learnings || [];
  const prefs = plain.preferences || {};
  let ctx = '';

  const prefKeys = Object.keys(prefs);
  if (prefKeys.length > 0) {
    ctx += '\n# Preferensi User:\n';
    prefKeys.forEach(k => { ctx += `- ${k}: ${prefs[k]}\n`; });
  }

  const recent = learnings.slice(-15);
  if (recent.length > 0) {
    ctx += '\n# Yang saya pelajari:\n';
    recent.forEach(l => { ctx += `- ${l.topic}: ${l.detail}\n`; });
  }

  return `Kamu adalah asisten AI cerdas yang terus belajar.

# Personality
Bantu user dengan sabar, respek, praktis. Bahasa Indonesia. Jawab tepat sasaran. Gunakan markdown.

# Tools
Kamu punya akses ke tools GitHub via Composio. Jika user minta sesuatu seperti:
- Cari repo/kode → gunakan composio_search_code
- Buat issue → gunakan composio_create_github_issue
- Lihat issue → gunakan composio_list_repo_issues
- Info user → gunakan composio_get_github_user

Panggil tool yang sesuai, lalu gunakan hasilnya untuk menjawab user.
Jika tool error "tool_not_connected", beri tahu user untuk menjalankan: composio link github

# Memory
Kamu bisa mengingat informasi dari percakapan sebelumnya.${ctx}`;
}

// ============ HANDLER ============

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, history = [], stream = false } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  const plain = loadPlain();
  plain.stats.total_conversations = (plain.stats.total_conversations || 0) + 1;

  const messages = [
    { role: 'system', content: buildSystemPrompt(plain) },
    ...history.slice(-30),
    { role: 'user', content: message },
  ];

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      res.write(`data: ${JSON.stringify({ content: '', preamble: true })}\n\n`);

      // First call: get response with possible tool calls
      const firstResp = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        tools: COMPOSIO_TOOLS,
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 4096,
      });

      const choice = firstResp.choices[0];
      const toolCalls = choice.finish_reason === 'tool_calls' ? choice.message.tool_calls : null;

      if (toolCalls && toolCalls.length > 0) {
        // Execute tools
        const results = [];
        for (const tc of toolCalls) {
          const args = JSON.parse(tc.function.arguments);
          const result = await runComposioTool(tc.function.name, args);
          results.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
        }

        // Stream the tool result message
        for (const r of results) {
          const data = JSON.parse(r.content);
          if (data.error === 'tool_not_connected') {
            const parts = data.error.split(': ');
            res.write(`data: ${JSON.stringify({ content: `⚠️ Tool **${parts[1]}** belum terhubung. Jalankan perintah ini di terminal:\n\`\`\`bash\ncomposio link github\n\`\`\`\nSetelah itu coba lagi.` })}\n\n`);
          } else if (data.error) {
            res.write(`data: ${JSON.stringify({ content: `⚠️ Error: ${data.error}` })}\n\n`);
          } else {
            // Feed tool result back to AI for final response
            const finalMessages = [...messages, choice.message, r];
            const finalResp = await groq.chat.completions.create({
              model: 'llama-3.3-70b-versatile',
              messages: finalMessages,
              temperature: 0.7,
              max_tokens: 2048,
              stream: true,
            });

            let full = '';
            for await (const chunk of finalResp) {
              const d = chunk.choices[0]?.delta?.content || '';
              full += d;
              if (d) res.write(`data: ${JSON.stringify({ content: d })}\n\n`);
            }

            // Save learnings
            const convText = `user: ${message}\nassistant: ${full}`;
            extractLearnings(convText, plain.learnings).then(newL => {
              if (newL.length > 0) {
                plain.learnings = plain.learnings.concat(newL);
                plain.stats.total_learnings = (plain.stats.total_learnings || 0) + newL.length;
                savePlain(plain);
                pushToGitHub(plain);
              }
            });
          }
        }
      } else {
        // No tool calls, just stream the response
        const streamResp = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages,
          temperature: 0.7,
          max_tokens: 4096,
          stream: true,
        });

        let full = '';
        for await (const chunk of streamResp) {
          const d = chunk.choices[0]?.delta?.content || '';
          full += d;
          if (d) res.write(`data: ${JSON.stringify({ content: d })}\n\n`);
        }

        const convText = `user: ${message}\nassistant: ${full}`;
        extractLearnings(convText, plain.learnings).then(newL => {
          if (newL.length > 0) {
            plain.learnings = plain.learnings.concat(newL);
            plain.stats.total_learnings = (plain.stats.total_learnings || 0) + newL.length;
            savePlain(plain);
            pushToGitHub(plain);
          }
        });
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error) {
      console.error('Error:', error);
      res.write(`data: ${JSON.stringify({ error: 'Maaf, terjadi kesalahan.' })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-streaming
  try {
    // Tool calling
    const firstResp = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      tools: COMPOSIO_TOOLS,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 4096,
    });

    const choice = firstResp.choices[0];
    const toolCalls = choice.finish_reason === 'tool_calls' ? choice.message.tool_calls : null;

    let reply;
    if (toolCalls && toolCalls.length > 0) {
      const results = [];
      for (const tc of toolCalls) {
        const args = JSON.parse(tc.function.arguments);
        const result = await runComposioTool(tc.function.name, args);
        results.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
      }

      const finalMessages = [...messages, choice.message, ...results];
      const finalResp = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: finalMessages,
        temperature: 0.7, max_tokens: 2048,
      });
      reply = finalResp.choices[0]?.message?.content || '';
    } else {
      reply = choice.message?.content || '';
    }

    const convText = `user: ${message}\nassistant: ${reply}`;
    extractLearnings(convText, plain.learnings).then(newL => {
      if (newL.length > 0) {
        plain.learnings = plain.learnings.concat(newL);
        plain.stats.total_learnings = (plain.stats.total_learnings || 0) + newL.length;
        savePlain(plain); pushToGitHub(plain);
      }
    });

    res.status(200).json({ reply, usage: firstResp.usage });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Maaf, terjadi kesalahan.' });
  }
}
