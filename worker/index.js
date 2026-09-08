/*
 * Northern Shrike Analyst Copilot backend.
 *
 * A minimal proxy in front of the Anthropic Messages API. It exists only so the
 * public GitHub Pages site can run the Copilot chat without an API key ever
 * reaching the browser. It holds no state and implements no tool logic itself —
 * the page already knows how to execute queryObjects/getObjectDetail/etc.
 * against its own live in-memory catalog, so this Worker just forwards the
 * conversation to Claude and hands the response straight back.
 *
 * Deploy: paste this file into a Cloudflare Worker via the dashboard's Quick
 * Edit view, then add a secret named ANTHROPIC_API_KEY (Settings > Variables
 * and Secrets) with your key from console.anthropic.com.
 */

const ALLOWED_ORIGIN = 'https://mgdufour.github.io';
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS_CAP = 1024;

function corsHeaders(origin){
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env){
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST'){
      return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
    }
    if (origin !== ALLOWED_ORIGIN){
      return new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403, headers });
    }
    if (!env.ANTHROPIC_API_KEY){
      return new Response(JSON.stringify({ error: 'backend not configured' }), { status: 500, headers });
    }

    let body;
    try{
      body = await request.json();
    } catch(e){
      return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers });
    }

    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || !messages.length){
      return new Response(JSON.stringify({ error: 'messages is required' }), { status: 400, headers });
    }

    const upstreamBody = {
      model: MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP),
      messages,
    };
    if (Array.isArray(body.tools) && body.tools.length) upstreamBody.tools = body.tools;

    let upstream;
    try{
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(upstreamBody),
      });
    } catch(e){
      return new Response(JSON.stringify({ error: 'upstream request failed' }), { status: 502, headers });
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
