// Same-origin HTTPS port-443 relay for Iron Fists Boxing.
// Runs on Netlify Edge Functions so strict school Wi-Fi firewalls (which block
// non-443 ports and third-party relay domains) cannot block Online Mode.

export default async (request) => {
  const url = new URL(request.url);
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const rawTopic = url.searchParams.get('topic') || '';
  const topic = rawTopic.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (!topic) {
    return new Response(JSON.stringify({ error: 'missing topic' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const ntfyTopic = 'ifb_v4_' + topic;

  try {
    if (request.method === 'POST') {
      const body = await request.text();
      if (body.length > 24576) {
        return new Response(JSON.stringify({ error: 'payload too large' }), {
          status: 413,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const upstream = await fetch('https://ntfy.sh/' + ntfyTopic, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body
      });
      return new Response(JSON.stringify({ ok: upstream.ok }), {
        status: upstream.ok ? 200 : upstream.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'GET') {
      const upstream = await fetch('https://ntfy.sh/' + ntfyTopic + '/sse', {
        headers: { 'Accept': 'text/event-stream' }
      });
      if (!upstream.ok || !upstream.body) {
        return new Response('upstream error', { status: 502, headers: corsHeaders });
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Accel-Buffering': 'no'
        }
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err && err.message || err) }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
};
