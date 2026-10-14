import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    hasDefaultKey: !!process.env.GEMINI_API_KEY,
    systemReady: true
  });
});

// Endpoint untuk menguji koneksi API Key Gemini Pribadi
app.post('/api/gemini/test', async (req, res) => {
  const { apiKey } = req.body;
  const keyToUse = typeof apiKey === 'string' ? apiKey.trim() : '';

  if (!keyToUse) {
    return res.status(400).json({
      success: false,
      error: 'API Key Gemini pribadi wajib diisi. Silakan dapatkan API Key dari Google AI Studio (aistudio.google.com).'
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: keyToUse });
    const usedModel = 'gemini-3.8-flash';
    let reply = 'OK';

    try {
      // 1. Interactions API dengan model gemini-3.8-flash
      const interaction = await ai.interactions.create({
        model: 'gemini-3.8-flash',
        input: 'Balas hanya dengan kata OK'
      });
      reply = interaction.output_text || 'OK';
    } catch {
      // 2. Fallback ke models.generateContent dengan gemini-3.8-flash
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: 'Balas hanya dengan kata OK'
      });
      reply = response.text || 'OK';
    }

    return res.json({
      success: true,
      model: usedModel,
      reply
    });
  } catch (error: any) {
    console.error('Gemini Test Error:', error);
    let rawMsg = error?.message || String(error);
    let userMsg = 'Gagal memanggil Gemini API. Silakan periksa kembali API Key Anda.';

    if (rawMsg.includes('API key not valid') || rawMsg.includes('API_KEY_INVALID')) {
      userMsg = 'API Key Gemini tidak valid atau dinonaktifkan. Silakan salin API Key resmi dari Google AI Studio (aistudio.google.com).';
    } else if (rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('quota') || rawMsg.includes('rate limit')) {
      userMsg = 'Batas kuota gratis (Quota Exceeded) untuk API Key ini telah habis. Silakan buat API Key baru dengan akun Google lain di aistudio.google.com.';
    } else if (rawMsg.includes('PERMISSION_DENIED')) {
      userMsg = 'Akses ditolak (Permission Denied). Pastikan Generative Language API aktif pada project Google Cloud Anda.';
    } else if (rawMsg.includes('Method doesn\'t allow unregistered callers')) {
      userMsg = 'API Key belum terdaftar atau format salah. Silakan salin ulang dari aistudio.google.com.';
    }

    return res.status(400).json({
      success: false,
      error: userMsg,
      details: rawMsg
    });
  }
});

// Endpoint untuk generate dokumen atau auto-gen CP/TP via Gemini API
app.post('/api/gemini/generate', async (req, res) => {
  const { prompt, systemInstruction, apiKey } = req.body;
  const keyToUse = typeof apiKey === 'string' ? apiKey.trim() : '';

  if (!keyToUse) {
    return res.status(400).json({
      error: 'API Key Gemini pribadi wajib diisi. Masukkan API Key Anda pada pengaturan AI.'
    });
  }

  if (!prompt) {
    return res.status(400).json({
      error: 'Prompt tidak boleh kosong.'
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: keyToUse });
    let text = '';

    try {
      // 1. Interactions API dengan model gemini-3.8-flash
      const interaction = await ai.interactions.create({
        model: 'gemini-3.8-flash',
        input: prompt,
        system_instruction: systemInstruction || undefined
      });

      if (interaction.output_text) {
        text = interaction.output_text;
      } else if (interaction.steps && Array.isArray(interaction.steps)) {
        for (const step of interaction.steps) {
          if (step.type === 'model_output' && Array.isArray(step.content)) {
            const textContent = step.content.find((c: any) => c.type === 'text') as any;
            if (textContent && textContent.text) {
              text += textContent.text;
            }
          }
        }
      }
    } catch {
      // 2. Fallback ke models.generateContent dengan gemini-3.8-flash
      const fallbackResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: systemInstruction ? { systemInstruction } : undefined
      });
      text = fallbackResponse.text || '';
    }

    return res.json({ text });
  } catch (error: any) {
    console.error('Gemini Generate Error:', error);
    let rawMsg = error?.message || String(error);
    let friendlyMsg = 'Terjadi kendala saat memanggil Gemini AI.';

    if (rawMsg.includes('API key not valid') || rawMsg.includes('API_KEY_INVALID')) {
      friendlyMsg = 'API Key Gemini pribadi Anda tidak valid atau sudah kedaluwarsa.';
    } else if (rawMsg.includes('RESOURCE_EXHAUSTED')) {
      friendlyMsg = 'Batas kuota API Key pribadi Anda habis. Silakan coba buat API Key baru di aistudio.google.com.';
    }

    return res.status(500).json({
      error: friendlyMsg,
      details: rawMsg
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Edukara full-stack server running on http://0.0.0.0:${port}`);
  });
}

startServer();
