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
            'Respondé SOLO con un JSON array, sin texto extra: [{"name":"cliente","addr":"dirección o vacío","importe":"importe a cobrar tal cual está impreso"}]. ' +
            'En importe copiá los dígitos y los separadores exactamente como se ven, sin interpretarlos ni convertirlos: fijate bien dónde está la coma o el punto de los decimales. La planilla trabaja con dos decimales (normalmente los últimos dos dígitos), a veces sin separador visible. Si no se lee, usá "0".' },
        ],
      }],
    }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Error de la API' });
  const text = (data.content || []).map(b => b.text || '').join('');
  try {
    const raw = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    // Los importes de la planilla trabajan con dos decimales. Se busca dónde está la coma o el punto
    // decimal; si no se ve ninguno, los últimos dos dígitos son los decimales. Los casos dudosos se marcan.
    const clients = raw.map(c => {
      const txt = String(c.importe ?? c.total ?? '').trim();
      const digits = txt.replace(/\D/g, '');
      const m = /[.,](\d{1,2})$/.exec(txt);
      const dec = m ? m[1].length : 2;
      const dudoso = /[.,]\d{3}$/.test(txt) || (m && m[1].length === 1) || digits.length < 3;
      return {
        name: String(c.name || '').trim(),
        addr: String(c.addr || '').trim(),
        total: (parseInt(digits, 10) || 0) / Math.pow(10, dec),
        revisar: !!dudoso && digits !== '0',
      };
    });
    res.json({ clients });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo interpretar la respuesta' });
  }
};
