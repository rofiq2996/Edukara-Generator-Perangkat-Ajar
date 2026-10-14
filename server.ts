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

// Daftar model Gemini yang didukung dengan urutan prioritas stabilitas & fitur
const CANDIDATE_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-3.5-flash'
];

function getModelCandidates(preferred?: string): string[] {
  const cleanPref = typeof preferred === 'string' ? preferred.trim() : '';
  if (cleanPref && cleanPref !== 'auto') {
    return Array.from(new Set([cleanPref, ...CANDIDATE_MODELS]));
  }
  return [...CANDIDATE_MODELS];
}

function getModelLabel(modelName: string): string {
  switch (modelName) {
    case 'gemini-2.5-flash': return 'Gemini 2.5 Flash (Sangat Stabil & Cepat)';
    case 'gemini-3.8-flash': return 'Gemini 3.8 Flash (Fitur Terbaru)';
    case 'gemini-3.1-flash-lite': return 'Gemini 3.1 Flash Lite (Hemat Kuota)';
    case 'gemini-flash-latest': return 'Gemini Flash Latest';
    case 'gemini-3.5-flash': return 'Gemini 3.5 Flash';
    default: return modelName;
  }
}

// Endpoint untuk menguji koneksi API Key Gemini Pribadi ke segala model Gemini
app.post('/api/gemini/test', async (req, res) => {
  const { apiKey, preferredModel } = req.body;
  const rawKey = typeof apiKey === 'string' ? apiKey.trim().replace(/\s+/g, '') : '';

  if (!rawKey) {
    return res.status(400).json({
      success: false,
      error: 'API Key Gemini pribadi wajib diisi. Silakan dapatkan API Key dari Google AI Studio (aistudio.google.com).'
    });
  }

  const ai = new GoogleGenAI({ apiKey: rawKey });
  const candidates = getModelCandidates(preferredModel);
  let lastError: any = null;
  let isKeyExplicitlyInvalid = false;

  for (const model of candidates) {
    try {
      const testTask = async () => {
        try {
          const result = await ai.models.generateContent({
            model,
            contents: 'Balas hanya dengan kata OK'
          });
          return result.text || 'OK';
        } catch {
          const inter = await ai.interactions.create({
            model,
            input: 'Balas hanya dengan kata OK'
          });
          return inter.output_text || 'OK';
        }
      };

      const reply = await Promise.race([
        testTask(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Timeout model test')), 9000))
      ]);

      if (reply) {
        return res.json({
          success: true,
          model,
          modelLabel: getModelLabel(model),
          reply: reply.trim()
        });
      }
    } catch (err: any) {
      lastError = err;
      const msg = err?.message || String(err);
      if (msg.includes('API key not valid') || msg.includes('API_KEY_INVALID')) {
        isKeyExplicitlyInvalid = true;
        break;
      }
      console.warn(`Test model ${model} belum berhasil, mencoba model berikutnya...:`, msg.slice(0, 100));
    }
  }

  // Jika seluruh kandidat model gagal diuji
  console.error('Gemini Test Key Error on all models:', lastError);
  let rawMsg = lastError?.message || String(lastError);
  let userMsg = 'Gagal memanggil Gemini API. Silakan periksa kembali API Key Anda.';

  if (isKeyExplicitlyInvalid || rawMsg.includes('API key not valid') || rawMsg.includes('API_KEY_INVALID')) {
    userMsg = 'API Key Gemini tidak valid atau dinonaktifkan. Silakan salin API Key resmi dari Google AI Studio (aistudio.google.com).';
  } else if (rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('quota') || rawMsg.includes('rate limit')) {
    userMsg = 'Batas kuota gratis (Quota Exceeded) untuk API Key ini telah habis. Silakan buat API Key baru dengan akun Google lain di aistudio.google.com.';
  } else if (rawMsg.includes('PERMISSION_DENIED')) {
    userMsg = 'Akses ditolak (Permission Denied). Pastikan Generative Language API aktif pada project Google Cloud Anda.';
  } else if (rawMsg.includes('503') || rawMsg.includes('high demand') || rawMsg.includes('UNAVAILABLE')) {
    userMsg = 'Server Google AI saat ini sedang mengalami lonjakan beban tinggi (High Demand Spikes). Silakan coba simpan kembali.';
  }

  return res.status(400).json({
    success: false,
    error: userMsg,
    details: rawMsg
  });
});

// Endpoint untuk generate dokumen atau auto-gen CP/TP via Gemini API dengan failover otomatis
app.post('/api/gemini/generate', async (req, res) => {
  const { prompt, systemInstruction, apiKey, model } = req.body;
  const rawKey = typeof apiKey === 'string' ? apiKey.trim().replace(/\s+/g, '') : '';

  if (!rawKey) {
    return res.status(400).json({
      error: 'API Key Gemini pribadi wajib diisi. Masukkan API Key Anda pada pengaturan AI.'
    });
  }

  if (!prompt) {
    return res.status(400).json({
      error: 'Prompt tidak boleh kosong.'
    });
  }

  const ai = new GoogleGenAI({ apiKey: rawKey });
  const candidates = getModelCandidates(model);
  let lastError: any = null;

  for (const candidateModel of candidates) {
    try {
      let text = '';

      try {
        const response = await ai.models.generateContent({
          model: candidateModel,
          contents: prompt,
          config: systemInstruction ? { systemInstruction } : undefined
        });
        text = response.text || '';
      } catch (genError: any) {
        const genMsg = genError?.message || String(genError);
        if (genMsg.includes('API key not valid') || genMsg.includes('API_KEY_INVALID')) {
          throw genError;
        }

        // Coba Interactions API jika generateContent menghasilkan error spesifik
        try {
          const interaction = await ai.interactions.create({
            model: candidateModel,
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
          throw genError;
        }
      }

      if (text && text.trim().length > 0) {
        return res.json({
          text,
          modelUsed: candidateModel
        });
      }
    } catch (err: any) {
      lastError = err;
      const msg = err?.message || String(err);
      if (msg.includes('API key not valid') || msg.includes('API_KEY_INVALID')) {
        return res.status(400).json({
          error: 'API Key Gemini pribadi Anda tidak valid atau sudah kedaluwarsa.',
          details: msg
        });
      }
      console.warn(`Model ${candidateModel} gagal untuk generate, beralih ke model berikutnya:`, msg.slice(0, 100));
    }
  }

  console.error('Gemini Generate Error on all models:', lastError);
  let rawMsg = lastError?.message || String(lastError);
  let friendlyMsg = 'Terjadi kendala saat memanggil Gemini AI.';

  if (rawMsg.includes('RESOURCE_EXHAUSTED')) {
    friendlyMsg = 'Batas kuota API Key pribadi Anda habis. Silakan buat API Key baru di aistudio.google.com.';
  } else if (rawMsg.includes('503') || rawMsg.includes('high demand') || rawMsg.includes('UNAVAILABLE')) {
    friendlyMsg = 'Server Google AI sedang mengalami lonjakan trafik tinggi. Silakan ulangi beberapa saat lagi.';
  }

  return res.status(500).json({
    error: friendlyMsg,
    details: rawMsg
  });
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
