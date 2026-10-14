// Lectura de la foto de una planilla con IA: recibe la imagen y devuelve los clientes.
// Lo llama server.js (no se expone la clave: vive en el servidor).
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';

const PROMPT = 'Esta es una planilla de reparto. Extraé cada cliente en el orden en que aparece. ' +
  'Respondé SOLO con un JSON array, sin texto extra: [{"name":"cliente","addr":"dirección o vacío","importe":"importe a cobrar tal cual está impreso"}]. ' +
  'En importe copiá los dígitos, los separadores y el signo exactamente como se ven, sin interpretarlos ni convertirlos: fijate bien dónde está la coma o el punto de los decimales ' +
  'y si el importe es negativo (signo menos o entre paréntesis, por ejemplo una nota de crédito). ' +
  'La planilla trabaja con dos decimales (normalmente los últimos dos dígitos), a veces sin separador visible. Si no se lee, usá "0".';

// Los últimos dos dígitos son decimales salvo que se vea otro separador; los casos dudosos se marcan para revisar.
function interpretar(c) {
  const txt = String(c.importe ?? c.total ?? '').trim();
  const digits = txt.replace(/\D/g, '');
  const m = /[.,](\d{1,2})$/.exec(txt);
  const dec = m ? m[1].length : 2;
  const negativo = /^\s*[-−–]/.test(txt) || /^\(.*\)$/.test(txt) || /-\s*$/.test(txt) || /\bcr\b/i.test(txt);
  const dudoso = /[.,]\d{3}$/.test(txt) || (m && m[1].length === 1) || digits.length < 3;
  const valor = (parseInt(digits, 10) || 0) / Math.pow(10, dec);
  return {
    name: String(c.name || '').trim().slice(0, 200),
    addr: String(c.addr || '').trim().slice(0, 300),
    total: negativo ? -valor : valor,
    revisar: !!dudoso && digits !== '0',
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requerido' });
  const { image } = req.body || {};
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
  if (!m) return res.status(400).json({ error: 'Imagen inválida' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'La lectura de fotos no está configurada en el servidor.' });

  let r, data;
  try {
    r = await fetch(API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(90000),
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: PROMPT },
        ] }],
      }),
    });
    data = await r.json();
  } catch (e) {
    console.error('Lectura de foto:', e.message);
    return res.status(504).json({ error: 'No se pudo leer la foto (sin respuesta). Probá de nuevo.' });
  }
  if (!r.ok) {
    console.error('Lectura de foto: la API respondió', r.status, data && data.error && data.error.message);   // el detalle queda en el log, no se manda al celular
    return res.status(502).json({ error: 'No se pudo leer la foto. Probá de nuevo en un momento.' });
  }
  const text = (data.content || []).map(b => b.text || '').join('');
  try {
    const raw = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    res.json({ clients: raw.slice(0, 500).map(interpretar) });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo interpretar la respuesta de la lectura.' });
  }
};
module.exports.interpretar = interpretar;
