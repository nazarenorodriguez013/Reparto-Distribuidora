// Función serverless (Vercel): recibe la foto de la planilla y devuelve los clientes.
// Requiere la variable de entorno ANTHROPIC_API_KEY.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requerido' });
  const { image } = req.body || {};
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(image || '');
  if (!m) return res.status(400).json({ error: 'Imagen inválida' });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: 'Esta es una planilla de reparto. Extraé cada cliente en el orden en que aparece. ' +
            'Respondé SOLO con un JSON array, sin texto extra: [{"name":"cliente","addr":"dirección o vacío","total":número}]. ' +
            'total es el importe a cobrar como número (sin símbolo ni separador de miles, punto decimal). Si no se lee, usá 0.' },
        ],
      }],
    }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Error de la API' });
  const text = (data.content || []).map(b => b.text || '').join('');
  try {
    const clients = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    res.json({ clients });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo interpretar la respuesta' });
  }
};
