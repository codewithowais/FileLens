/**
 * FileLens - AI Origin Detector
 *
 * Looks for the evidence AI tools leave inside a file and reports WHO made it, WHICH model,
 * WHEN and with WHAT settings. Evidence comes from:
 *   1. Standard AI labels      IPTC DigitalSourceType, C2PA "Content Credentials"
 *   2. Tool fingerprints       Stable Diffusion/A1111 "parameters", ComfyUI graphs, Midjourney job ids...
 *   3. Named products          Software / Comment / Description tags that name an AI tool
 *
 * Honest limits (also shown to the user):
 *   - Metadata is easy to remove (screenshots, social media re-uploads), so "nothing found"
 *     never proves a file is human-made.
 *   - Metadata can also be edited. This tool does NOT verify C2PA cryptographic signatures.
 */

class AiDetector {
  // Products named in tag values (strong evidence) or, for the `raw` pattern, anywhere in the
  // file bytes (medium evidence). Raw patterns are long/specific to avoid false hits in binary data.
  static get PRODUCTS() {
    return [
      // --- Images ---
      { name: 'Stable Diffusion', vendor: 'Stability AI / community', kind: 'image', re: /stable[ _-]?diffusion|\bsdxl\b|\bsd[ _-]?(?:1\.5|2\.1|3(?:\.5)?)\b/i, raw: /stable[ _-]?diffusion/i },
      { name: 'AUTOMATIC1111 WebUI', vendor: 'Stable Diffusion WebUI', kind: 'image', re: /automatic1111|stable-diffusion-webui/i, raw: /automatic1111|stable-diffusion-webui/i },
      { name: 'ComfyUI', vendor: 'ComfyUI (open source)', kind: 'image', re: /comfy ?ui/i, raw: /comfyui/i },
      { name: 'FLUX', vendor: 'Black Forest Labs', kind: 'image', re: /\bflux[.\- ]?1\b|\bflux[ _-](?:dev|schnell|pro|kontext)\b/i },
      { name: 'Midjourney', vendor: 'Midjourney', kind: 'image', re: /midjourney/i, raw: /midjourney/i },
      { name: 'DALL·E', vendor: 'OpenAI', kind: 'image', re: /\bdall[-·. _]?e\b/i, raw: /\bdall[-·.]e\b/i },
      { name: 'ChatGPT / GPT Image', vendor: 'OpenAI', kind: 'image', re: /chatgpt|gpt[- ]?image|gpt-?4o/i },
      { name: 'Adobe Firefly', vendor: 'Adobe', kind: 'image', re: /firefly|generative (?:fill|expand|recolor)/i, raw: /adobe[ _]firefly/i },
      { name: 'Google AI (Imagen / Gemini)', vendor: 'Google', kind: 'image', re: /\bimagen[ -]?\d|made with google ai|\bgemini[ -]?(?:\d|pro|flash|ultra|image)|nano banana|synthid/i, raw: /made with google ai|synthid/i },
      { name: 'Microsoft Designer / Bing Image Creator', vendor: 'Microsoft', kind: 'image', re: /bing image creator|microsoft designer/i },
      { name: 'Meta AI', vendor: 'Meta', kind: 'image', re: /imagined with ai|\bmeta ai\b/i, raw: /imagined with ai/i },
      { name: 'NovelAI', vendor: 'NovelAI', kind: 'image', re: /novelai/i, raw: /novelai/i },
      { name: 'InvokeAI', vendor: 'InvokeAI', kind: 'image', re: /invokeai/i, raw: /invokeai/i },
      { name: 'Leonardo.Ai', vendor: 'Leonardo.Ai', kind: 'image', re: /leonardo\.ai/i },
      { name: 'Ideogram', vendor: 'Ideogram', kind: 'image', re: /\bideogram\b/i },
      { name: 'Fooocus', vendor: 'Fooocus (open source)', kind: 'image', re: /fooocus/i },
      { name: 'DiffusionBee', vendor: 'DiffusionBee', kind: 'image', re: /diffusionbee/i },
      { name: 'Craiyon', vendor: 'Craiyon', kind: 'image', re: /craiyon/i },
      { name: 'DreamStudio', vendor: 'Stability AI', kind: 'image', re: /dreamstudio/i },
      { name: 'Samsung Galaxy AI', vendor: 'Samsung', kind: 'image', re: /galaxy ai|generative edit/i },
      { name: 'Apple Image Playground', vendor: 'Apple', kind: 'image', re: /image playground|genmoji/i },
      { name: 'Amazon Titan Image Generator', vendor: 'Amazon', kind: 'image', re: /titan image generator/i },
      // --- Documents / text / slides ---
      { name: 'Claude', vendor: 'Anthropic', kind: 'document', prog: /^claude\b/i, re: /\banthropic\b|claude\.ai|\bclaude[ -]?(?:\d|opus|sonnet|haiku|code)/i },
      { name: 'Perplexity', vendor: 'Perplexity', kind: 'document', prog: /^perplexity\b/i, re: /perplexity(?:\.ai)?/i },
      { name: 'Microsoft Copilot', vendor: 'Microsoft', kind: 'document', re: /microsoft (?:365 )?copilot|\bm365 copilot\b/i },
      { name: 'Gamma', vendor: 'Gamma', kind: 'document', prog: /^gamma(?:\.app| ai)?$/i, re: /\bgamma\.app\b|made with gamma|\bgamma ai\b/i },
      { name: 'Beautiful.ai', vendor: 'Beautiful.ai', kind: 'document', prog: /^beautiful\.ai\b/i, re: /beautiful\.ai/i },
      { name: 'Notion AI', vendor: 'Notion', kind: 'document', re: /notion ai/i },
      { name: 'Canva Magic (AI)', vendor: 'Canva', kind: 'document', re: /canva magic|magic (?:design|write|media|studio)/i },
      { name: 'Jasper', vendor: 'Jasper', kind: 'document', re: /\bjasper(?:\.ai)?\b.{0,20}\bai\b|jasper\.ai/i },
      // --- Video ---
      { name: 'Hailuo / MiniMax', vendor: 'MiniMax', kind: 'video', re: /hailuo|minimax/i },
      { name: 'Pika', vendor: 'Pika Labs', kind: 'video', re: /\bpika(?: labs| art)\b/i },
      { name: 'Sora', vendor: 'OpenAI', kind: 'video', re: /openai[^\n]{0,40}\bsora\b|\bsora\b[^\n]{0,40}openai|\bsora[ -]2\b/i },
      { name: 'Runway', vendor: 'Runway', kind: 'video', re: /runway ?ml|\brunway gen|\bgen-[234]\b/i },
      { name: 'Luma Dream Machine', vendor: 'Luma AI', kind: 'video', re: /dream machine/i },
      { name: 'Kling', vendor: 'Kuaishou', kind: 'video', re: /\bkling\b/i },
      { name: 'Google Veo', vendor: 'Google', kind: 'video', re: /\bveo[ -]?\d/i },
      { name: 'Synthesia', vendor: 'Synthesia', kind: 'video', re: /synthesia/i },
      { name: 'HeyGen', vendor: 'HeyGen', kind: 'video', re: /heygen/i },
      // --- Audio / voice ---
      { name: 'NotebookLM', vendor: 'Google', kind: 'audio', re: /notebook ?lm/i },
      { name: 'Google Lyria', vendor: 'Google', kind: 'audio', re: /\blyria\b/i },
      { name: 'Mureka', vendor: 'Mureka', kind: 'audio', re: /mureka/i },
      { name: 'Soundful', vendor: 'Soundful', kind: 'audio', re: /soundful/i },
      { name: 'Beatoven.ai', vendor: 'Beatoven', kind: 'audio', re: /beatoven/i },
      { name: 'Uberduck', vendor: 'Uberduck', kind: 'audio', re: /uberduck/i },
      { name: 'Suno', vendor: 'Suno', kind: 'audio', re: /\bsuno\b/i, raw: /made with suno|suno\.(?:ai|com)/i },
      { name: 'Udio', vendor: 'Udio', kind: 'audio', re: /\budio(?:\.com|[ -]v?\d)|\bmade with udio\b/i, raw: /udio\.com/i },
      { name: 'ElevenLabs', vendor: 'ElevenLabs', kind: 'audio', re: /eleven ?labs/i, raw: /elevenlabs/i },
      { name: 'Stable Audio', vendor: 'Stability AI', kind: 'audio', re: /stable[ _-]?audio/i, raw: /stable[ _-]?audio/i },
      { name: 'MusicGen / AudioCraft', vendor: 'Meta', kind: 'audio', re: /musicgen|audiocraft/i, raw: /musicgen|audiocraft/i },
      { name: 'Riffusion', vendor: 'Riffusion', kind: 'audio', re: /riffusion/i },
      { name: 'Mubert', vendor: 'Mubert', kind: 'audio', re: /mubert/i },
      { name: 'AIVA', vendor: 'AIVA', kind: 'audio', re: /\baiva\b/i },
      { name: 'Boomy', vendor: 'Boomy', kind: 'audio', re: /boomy\.com|\bboomy ai\b/i },
      { name: 'Soundraw', vendor: 'Soundraw', kind: 'audio', re: /soundraw/i },
      { name: 'OpenAI Text-to-Speech', vendor: 'OpenAI', kind: 'audio', re: /openai[ -]?tts|\btts-1(?:-hd)?\b/i },
      { name: 'Amazon Polly', vendor: 'Amazon', kind: 'audio', re: /amazon polly/i },
      { name: 'Google Cloud Text-to-Speech', vendor: 'Google', kind: 'audio', re: /google (?:cloud )?text-to-speech/i },
      { name: 'Azure Neural Voice', vendor: 'Microsoft', kind: 'audio', re: /azure.{0,24}(?:tts|neural)|microsoft neural/i },
      { name: 'Coqui / XTTS', vendor: 'Coqui', kind: 'audio', re: /coqui|\bxtts\b/i },
      { name: 'Murf', vendor: 'Murf AI', kind: 'audio', re: /\bmurf(?:\.ai)?\b/i },
      { name: 'WellSaid Labs', vendor: 'WellSaid', kind: 'audio', re: /wellsaid/i },
      { name: 'Play.ht', vendor: 'PlayHT', kind: 'audio', re: /play\.ht/i },
      { name: 'Resemble AI', vendor: 'Resemble', kind: 'audio', re: /resemble ?ai/i },
      { name: 'Speechify', vendor: 'Speechify', kind: 'audio', re: /speechify/i }
    ];
  }

  // Specific model names pulled out of free text
  static get MODEL_PATTERNS() {
    return [
      /\bSDXL[\w. -]{0,24}/i, /\bstable[ _-]?diffusion[ _-]?(?:xl|[\d.]+)[\w. -]{0,16}/i, /\bFLUX\.?1?[ _-]?(?:dev|schnell|pro|kontext)?\b/i,
      /\bDALL[-·. ]?E[ -]?[23]?\b/i, /\bgpt-?image-?1\b/i, /\bGPT-?4o\b/i, /\bImagen[ -]?\d[\w.]*/i, /\bGemini[ -]?[\d.]+[\w -]{0,12}/i,
      /\bVeo[ -]?\d[\w.]*/i, /\bSora[ -]?\d?\b/i, /\bFirefly(?: Image| Video)?[ -]?\d?[\w.]*/i, /\bMidjourney[ -]?(?:v|version)?[ ]?[\d.]+/i,
      /\bSuno[ -]?v?\d[\w.]*/i, /\bUdio[ -]?v?\d?[\w.]*/i, /\bStable Audio[ \w.]{0,10}/i, /\beleven[_ -]?(?:multilingual|turbo|flash|v)\w*/i,
      /\bMusicGen[\w. -]{0,16}/i, /\bKling[ -]?[\d.]+/i, /\bGen-[234][\w ]{0,8}/i
    ];
  }

  // Libraries that create files automatically. AI chat tools often use them, but so do ordinary programs,
  // so they are reported as hints only.
  static get SCRIPT_GENERATORS() {
    return [
      [/python-docx/i, 'python-docx'], [/openpyxl/i, 'openpyxl'], [/python-pptx/i, 'python-pptx'], [/xlsxwriter/i, 'XlsxWriter'],
      [/reportlab/i, 'ReportLab'], [/\bfpdf2?\b/i, 'FPDF'], [/weasyprint/i, 'WeasyPrint'], [/wkhtmltopdf/i, 'wkhtmltopdf'],
      [/skia\/pdf/i, 'Chrome / Skia PDF export'], [/pdf-lib/i, 'pdf-lib'], [/pdfkit/i, 'PDFKit'], [/pptxgenjs/i, 'PptxGenJS'],
      [/jspdf/i, 'jsPDF'], [/\bpandoc\b/i, 'Pandoc'], [/apache fop|\bitext\b/i, 'iText / Apache FOP'], [/docx4j|apache poi/i, 'Java document library'],
      [/puppeteer|playwright|headless ?chrome/i, 'Headless browser']
    ];
  }

  /** Fields whose whole value names the program that made the file. */
  static get PROGRAM_KEYS() { return /^(?:software|creator|producer|encoder|creatortool|application|generator|isft|author|lastmodifiedby)$/i; }

  static get TOOL_KEYS() {
    return /^(?:software|creator|producer|encoder|encoded_by|encodedby|creatortool|application|generator|isft|tool|originator|bext_originator|handler_name|comment|description|imagedescription|usercomment|credit|source|artist|author|lastmodifiedby|digitalsourcetype|iptc (?:credit|source|creator|caption)|long_description|ai_prompt)$/i;
  }

  static decodeLatin1(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('latin1').decode(u8);
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return s;
  }

  static flattenTags(tags) {
    const out = [];
    for (const [k, v] of Object.entries(tags || {})) {
      if (v === null || v === undefined) continue;
      const val = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      out.push([k, val]);
    }
    return out;
  }

  /**
   * @param {object} result  parsed file info ({format, streams, all_tags, ...})
   * @param {Uint8Array} u8  file bytes
   * @param {object} file    File (name, lastModified)
   */
  static analyze(result, u8, file) {
    const tags = { ...((result.format && result.format.tags) || {}), ...(result.all_tags || {}) };
    const tagList = this.flattenTags(tags);
    const evidence = [];
    const addEvidence = (strength, source, detail) => {
      if (!evidence.some(e => e.source === source && e.detail === detail)) evidence.push({ strength, source, detail });
    };

    // Raw text of the start and end of the file (where metadata normally lives).
    // NULs are stripped so UTF-16 strings (EXIF UserComment) become searchable.
    const HEAD = 4 * 1024 * 1024, TAIL = 1024 * 1024;
    const rawHead = this.decodeLatin1(u8.subarray(0, Math.min(u8.length, HEAD)));
    const rawTail = u8.length > HEAD ? this.decodeLatin1(u8.subarray(Math.max(HEAD, u8.length - TAIL))) : '';
    const raw = (rawHead + '\n' + rawTail).replace(/\u0000/g, '');

    let vendor = null, model = null, tool = null, prompt = null, negative = null;
    const settings = {};
    let createdAt = null, createdSource = null;
    const credentials = { present: false, actions: [], generator: null, signer: null, time: null, ai_marked: false, verification: null };
    let strongest = 0; // 0 none, 1 weak, 2 medium, 3 strong

    const bump = (lvl) => { if (lvl > strongest) strongest = lvl; };

    // ---------- 1a. IPTC / XMP standard AI label ----------
    const dst = raw.match(/\b(compositeWithTrainedAlgorithmicMedia|trainedAlgorithmicMedia|compositeSynthetic)\b/);
    if (!dst && /\balgorithmicMedia\b/.test(raw)) addEvidence('info', 'IPTC / XMP label', 'Digital source type: "algorithmicMedia" (made by software, not labelled as AI)');
    if (dst) {
      const t = dst[1];
      const edited = /^composite/.test(t);
      addEvidence('strong', 'IPTC / XMP label', `Digital source type: "${t}" (${edited ? 'AI used to edit or composite' : 'created by an AI model'})`);
      bump(3);
    }
    if (/Made with Google AI|SynthID/i.test(raw)) { addEvidence('strong', 'Google label', 'Contains a "Made with Google AI" / SynthID marker'); bump(3); }
    if (/Imagined with AI/i.test(raw)) { addEvidence('strong', 'Meta label', 'Contains the "Imagined with AI" label'); bump(3); }

    // ---------- 1b. C2PA Content Credentials ----------
    const c2 = result.c2pa;
    if (c2 && c2.present && c2.status !== 'unreadable') {
      credentials.present = true;
      credentials.verification = c2;
      credentials.generator = c2.claim && c2.claim.generator ? (c2.claim.generator + (c2.claim.generator_version ? ' ' + c2.claim.generator_version : '')) : null;
      credentials.actions = [...new Set(c2.actions.map(a => a.action).filter(Boolean))];
      credentials.time = (c2.time && c2.time.value) || (c2.actions.find(a => a.when) || {}).when || null;
      credentials.signer = c2.signer ? c2.signer.name : null;
      credentials.ai_marked = Boolean(c2.ai && c2.ai.marked);
      const state = { valid: 'verified', valid_untrusted: 'signature valid, signer not on the trust list', partial: 'signature valid, file content not checked', invalid: 'FAILED verification' }[c2.status] || c2.status;
      if (credentials.ai_marked) {
        const strength = c2.status === 'invalid' ? 'medium' : 'strong';
        const agent = (c2.actions.find(a => a.softwareAgent) || {}).softwareAgent || (c2.claim && c2.claim.generator) || null;
        addEvidence(strength, 'Content Credentials (C2PA)', `Credentials say this was ${c2.ai.sourceTypes.some(t => /^composite/.test(t)) ? 'edited with' : 'created by'} AI${agent ? ' (' + agent + ')' : ''} [${state}]`);
        bump(strength === 'strong' ? 3 : 2);
        if (agent) tool = tool || agent;
        if (c2.signer && c2.signer.organization) vendor = vendor || c2.signer.organization;
      } else {
        addEvidence('info', 'Content Credentials (C2PA)', `Content Credentials present [${state}]${credentials.generator ? '; made with ' + credentials.generator : ''}${c2.ai && c2.ai.algorithmic ? '; labelled as made by software (not as AI)' : '; no AI label'}`);
      }
    } else {
      // Fallback when the manifest cannot be parsed: look for telltale text
      const c2paIdx = raw.search(/c2pa\.(?:actions|hash|claim|assertions|created|opened|signature)|urn:c2pa|contentauth/i);
      if (c2paIdx >= 0) {
        credentials.present = true;
        const region = raw.slice(Math.max(0, c2paIdx - 2048), c2paIdx + 131072);
        const gen = region.match(/(OpenAI|ChatGPT|DALL[-·. ]?E[ -]?\d?|GPT-?4o|GPT[- ]?Image|Sora|Adobe[ _]?Firefly|Firefly|Google[ _]?(?:AI|Imagen|Gemini)|Gemini|Imagen[ -]?\d?|Veo[ -]?\d?|Midjourney|Microsoft[ _]?(?:Designer|Bing)|Bing Image Creator|Meta AI|Amazon Titan|Stability AI|Leonardo|Runway|Truepic|ElevenLabs)/i);
        if (gen) credentials.generator = gen[1].replace(/_/g, ' ');
        const when = region.match(/\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/);
        if (when) credentials.time = when[1];
        const aiSrc = region.match(/(trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|compositeSynthetic)/);
        credentials.ai_marked = Boolean(aiSrc);
        addEvidence(credentials.ai_marked ? 'medium' : 'info', 'Content Credentials (C2PA)',
          `Credentials were found but could not be verified${credentials.ai_marked ? '; their text says AI-made' : ''}${credentials.generator ? ' (' + credentials.generator + ')' : ''}`);
        if (credentials.ai_marked) bump(2);
      }
    }

    // ---------- 2a. Stable Diffusion / A1111 / Forge "parameters" ----------
    const textSources = [];
    if (tags.ai_prompt) textSources.push(['PNG text chunk', String(tags.ai_prompt)]);
    if (tags.parameters) textSources.push(['parameters tag', String(tags.parameters)]);
    if (tags.UserComment) textSources.push(['EXIF UserComment', String(tags.UserComment)]);
    textSources.push(['file data', raw]);

    for (const [src, text] of textSources) {
      const m = text.match(/Steps:\s*\d+,\s*Sampler:/);
      if (!m) continue;
      const idx = text.indexOf(m[0]);
      const before = text.slice(Math.max(0, idx - 4000), idx);
      let head = before.replace(/^[\s\S]*?(?:UNICODE|ASCII|JIS)/, '');
      const neg = head.match(/Negative prompt:\s*([\s\S]*)$/);
      if (neg) { negative = neg[1].trim(); head = head.slice(0, head.indexOf('Negative prompt:')); }
      prompt = prompt || head.trim() || null;
      const line = text.slice(idx, idx + 1200).split('\n')[0];
      const pick = (key) => { const r = line.match(new RegExp('(?:^|, )' + key + ':\\s*([^,]+)')); return r ? r[1].trim() : null; };
      settings.steps = pick('Steps'); settings.sampler = pick('Sampler'); settings.cfg = pick('CFG scale');
      settings.seed = pick('Seed'); settings.size = pick('Size'); settings.model_hash = pick('Model hash');
      settings.version = pick('Version');
      model = model || pick('Model');
      tool = tool || (settings.version && /^f\d|forge/i.test(settings.version) ? 'Stable Diffusion WebUI Forge' : 'Stable Diffusion WebUI (AUTOMATIC1111-style)');
      vendor = vendor || 'Stable Diffusion (open-source toolchain)';
      addEvidence('strong', src, 'Contains Stable Diffusion generation settings (Steps, Sampler, Seed, CFG scale)');
      bump(3);
      break;
    }

    // ---------- 2b. ComfyUI workflow / InvokeAI metadata ----------
    const jsonCandidates = [tags.prompt, tags.workflow, tags.ai_prompt, tags.invokeai_metadata, tags.Comment, tags.comment]
      .filter(v => typeof v === 'string' && v.trim().startsWith('{'));
    for (const txt of jsonCandidates) {
      let obj; try { obj = JSON.parse(txt); } catch (e) { continue; }
      if (obj && typeof obj === 'object' && Object.values(obj).some(n => n && typeof n === 'object' && 'class_type' in n)) {
        const nodes = Object.values(obj);
        const ckpt = nodes.find(n => n.inputs && (n.inputs.ckpt_name || n.inputs.unet_name || n.inputs.model_name));
        const ks = nodes.find(n => /KSampler/.test(n.class_type || ''));
        const clip = nodes.filter(n => /CLIPTextEncode/.test(n.class_type || '') && n.inputs && typeof n.inputs.text === 'string');
        if (ckpt) model = model || String(ckpt.inputs.ckpt_name || ckpt.inputs.unet_name || ckpt.inputs.model_name).replace(/\.(safetensors|ckpt|gguf)$/i, '');
        if (ks) { settings.seed = settings.seed || String(ks.inputs.seed ?? ks.inputs.noise_seed ?? ''); settings.steps = settings.steps || String(ks.inputs.steps ?? ''); settings.sampler = settings.sampler || ks.inputs.sampler_name; settings.cfg = settings.cfg || String(ks.inputs.cfg ?? ''); }
        if (clip[0]) prompt = prompt || clip[0].inputs.text;
        if (clip[1]) negative = negative || clip[1].inputs.text;
        tool = tool || 'ComfyUI';
        vendor = vendor || 'ComfyUI (open-source toolchain)';
        addEvidence('strong', 'ComfyUI workflow', 'Contains a ComfyUI node graph (samplers, checkpoints, prompts)');
        bump(3);
        break;
      }
      if (obj && obj.model && (obj.model.model_name || obj.model.name) && (obj.positive_prompt || obj.generation_mode)) {
        model = model || obj.model.model_name || obj.model.name;
        prompt = prompt || obj.positive_prompt || null; negative = negative || obj.negative_prompt || null;
        settings.seed = settings.seed || String(obj.seed ?? ''); settings.steps = settings.steps || String(obj.steps ?? '');
        tool = tool || 'InvokeAI'; vendor = vendor || 'InvokeAI';
        addEvidence('strong', 'InvokeAI metadata', 'Contains InvokeAI generation metadata');
        bump(3); break;
      }
      if (obj && typeof obj.prompt === 'string' && (obj.steps || obj.seed || obj.sampler || obj.uc)) {
        prompt = prompt || obj.prompt; negative = negative || obj.uc || null;
        settings.seed = settings.seed || String(obj.seed ?? ''); settings.steps = settings.steps || String(obj.steps ?? ''); settings.sampler = settings.sampler || obj.sampler;
        tool = tool || 'NovelAI'; vendor = vendor || 'NovelAI';
        addEvidence('strong', 'Comment JSON', 'Contains NovelAI-style generation settings');
        bump(3); break;
      }
    }

    // ---------- 2c. Midjourney ----------
    const mj = raw.match(/Job ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (mj) {
      tool = tool || 'Midjourney'; vendor = 'Midjourney';
      settings.job_id = mj[1];
      const around = raw.slice(Math.max(0, mj.index - 1500), mj.index + 1500);
      const desc = around.match(/([^\n\r]{8,600}?)\s+--(?:v|ar|style|stylize|chaos|niji)\b[^\n\r]{0,80}/);
      if (desc && !prompt) prompt = desc[0].trim();
      addEvidence('strong', 'Midjourney metadata', `Contains a Midjourney job ID (${mj[1]})`);
      bump(3);
    }

    // ---------- 3. Named AI products in tags (strong) and file data (medium) ----------
    const hits = new Map();
    for (const prod of this.PRODUCTS) {
      for (const [k, v] of tagList) {
        if (k === 'xmp_history' || k === 'ai_parameters') continue;
        const m = v.match(prod.re) || (prod.prog && this.PROGRAM_KEYS.test(k) ? v.match(prod.prog) : null);
        if (m && !hits.has(prod.name)) {
          // A tool name in a field that records the creating program is strong evidence;
          // in a free-text field (title, keywords...) it may just be about the topic.
          hits.set(prod.name, { prod, strength: this.TOOL_KEYS.test(k) ? 'strong' : 'medium', where: `tag "${k}"`, text: m[0] });
        }
      }
      if (!hits.has(prod.name) && prod.raw) {
        const m = raw.match(prod.raw);
        if (m) hits.set(prod.name, { prod, strength: 'medium', where: 'file data', text: m[0] });
      }
    }
    for (const h of hits.values()) {
      addEvidence(h.strength, h.where, `Mentions "${h.text}" (${h.prod.name}, ${h.prod.vendor})`);
      bump(h.strength === 'strong' ? 3 : 2);
    }
    // Pick the headline product: prefer strong tag hits, then the first
    const ranked = [...hits.values()].sort((a, b) => (a.strength === 'strong' ? 0 : 1) - (b.strength === 'strong' ? 0 : 1));
    if (ranked.length) {
      const top = ranked[0].prod;
      tool = tool || top.name;
      vendor = vendor || top.vendor;
    }
    if (credentials.ai_marked && credentials.generator) {
      const prod = this.PRODUCTS.find(p => p.re.test(credentials.generator));
      if (prod) { tool = tool || prod.name; vendor = vendor || prod.vendor; }
      else { tool = tool || credentials.generator; }
    }

    // Exact model name from any text we collected
    if (!model && (strongest >= 2)) {
      const corpus = tagList.map(([, v]) => v).join('\n') + '\n' + (credentials.generator || '');
      for (const re of this.MODEL_PATTERNS) {
        const m = corpus.match(re);
        if (m) { model = m[0].trim(); break; }
      }
    }

    // Prompt from XMP description if nothing else found
    if (!prompt && tags.ai_prompt && !/^\s*\{/.test(String(tags.ai_prompt))) prompt = String(tags.ai_prompt).split(/\nNegative prompt:|\nSteps:/)[0].trim();

    // ---------- When was it made? ----------
    const ctime = credentials.ai_marked && credentials.time;
    const candidates = [
      [ctime, 'Content Credentials'],
      [tags.CreateDate, 'XMP CreateDate'], [tags.DateTimeOriginal, 'EXIF original date'],
      [tags.creation_time, 'File creation tag'], [tags['Creation Time'], 'PNG creation time'],
      [tags.date, 'Date tag'], [tags.TDRC || tags.TDOR || tags.year, 'Audio date tag'], [tags.bext_origination_date, 'Broadcast Wave date'],
      [tags.ModifyDate, 'Last modified tag'], [tags.modification_time, 'Last modified tag']
    ];
    for (const [val, src] of candidates) { if (val) { createdAt = String(val); createdSource = src; break; } }
    if (!createdAt && file && file.lastModified) {
      createdAt = new Date(file.lastModified).toISOString(); createdSource = 'File date on this device (not stored inside the file; may just be when it was downloaded)';
    }

    // ---------- Verdict ----------
    const hasStrong = evidence.some(e => e.strength === 'strong');
    const hasMedium = evidence.some(e => e.strength === 'medium');
    let confidence = 'none', label = 'No AI marks found', isAi = false;
    if (hasStrong) { confidence = 'confirmed'; isAi = true; }
    else if (hasMedium) { confidence = 'likely'; isAi = true; }

    if (isAi) {
      const editedOnly = (credentials.actions.includes('c2pa.edited') && !credentials.actions.includes('c2pa.created')) ||
        evidence.some(e => /AI used to edit or composite|edited with AI/i.test(e.detail)) && !evidence.some(e => /created by (?:an )?AI/i.test(e.detail));
      label = confidence === 'confirmed'
        ? (editedOnly ? 'AI-assisted / AI-edited' : 'AI-generated')
        : 'Probably AI-generated';
    }

    const isDocument = ['pdf', 'docx', 'doc', 'odt', 'txt', 'rtf'].includes(((file && file.name) || '').split('.').pop().toLowerCase())
      || (result.format && result.format.format_name === 'pdf');
    const hints = [];
    const programText = tagList.filter(([k]) => /^(software|creator|producer|encoder|application|generator|author|lastmodifiedby|creatortool)$/i.test(k)).map(([, v]) => v).join(' | ');
    for (const [re, name] of this.SCRIPT_GENERATORS) {
      if (re.test(programText)) hints.push(`Made by a program or script (${name}). Some AI chat tools create files this way, but so do many ordinary apps, so this is only a hint.`);
    }
    if (/python-docx/i.test(programText) && /2013-12-23/.test(String(tags.creation_time || ''))) {
      hints.push('The creation date is the default of the python-docx template, so the original timestamp was not recorded.');
    }
    const notes = [
      'Metadata is easy to remove (screenshots, messaging apps and social media strip it), so "no AI marks found" does not prove a person made the file.',
      'Metadata can also be edited. Marks found here show what the file claims, not cryptographic proof. This tool does not verify Content Credentials signatures.'
    ];
    if (isDocument) {
      notes.unshift('This is a document. Files like PDFs only record the program that exported them, so text that an AI wrote and a person pasted into Word, Google Docs or LibreOffice leaves no trace here. This check cannot tell whether AI helped write the words.');
    }
    if (!isAi) {
      const ext = ((file && file.name) || '').split('.').pop().toLowerCase();
      const dims = (result.streams || []).find(s => s.codec_type === 'video');
      if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) && dims && dims.width >= 512 && dims.width % 64 === 0 && dims.height % 64 === 0 && !tags.Make && !tags.Model) {
        notes.push(`Weak hint only: the size (${dims.width}×${dims.height}) is a multiple of 64 and there is no camera information. Many AI image tools produce sizes like this, but so do other programs.`);
      }
    }

    return {
      is_ai: isAi,
      confidence,
      label,
      vendor: vendor || null,
      model: model || null,
      tool: tool || null,
      created_at: createdAt,
      created_at_source: createdSource,
      prompt: prompt || null,
      negative_prompt: negative || null,
      settings,
      content_credentials: credentials,
      evidence,
      hints,
      notes
    };
  }
}

if (typeof window !== 'undefined') window.AiDetector = AiDetector;
if (typeof module !== 'undefined' && module.exports) module.exports = AiDetector;
