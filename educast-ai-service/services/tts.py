"""
services/tts.py -- EduCast TTS with full LaTeX/Markdown normalization.
Includes: comprehensive cleaning, segment skip, retry, generate_rag_audio.
"""
import os, re, asyncio, logging
from typing import List, Dict

try:
    import edge_tts
    from pydub import AudioSegment
except ImportError:
    edge_tts = None
    AudioSegment = None

logger = logging.getLogger(__name__)
VOICE_PROF    = "fr-FR-HenriNeural"
VOICE_STUDENT = "fr-FR-DeniseNeural"

_GREEK = [
    (r"\\alpha","alpha"),(r"\\beta","beta"),(r"\\gamma","gamma"),
    (r"\\delta","delta"),(r"\\epsilon","epsilon"),(r"\\varepsilon","epsilon"),
    (r"\\zeta","zeta"),(r"\\eta","eta"),(r"\\theta","theta"),
    (r"\\iota","iota"),(r"\\kappa","kappa"),(r"\\lambda","lambda"),
    (r"\\mu","mu"),(r"\\nu","nu"),(r"\\xi","xi"),(r"\\pi","pi"),
    (r"\\rho","rho"),(r"\\sigma","sigma"),(r"\\tau","tau"),
    (r"\\phi","phi"),(r"\\chi","chi"),(r"\\psi","psi"),(r"\\omega","omega"),
    (r"\\Gamma","Gamma"),(r"\\Delta","Delta"),(r"\\Theta","Theta"),
    (r"\\Lambda","Lambda"),(r"\\Sigma","Sigma"),(r"\\Omega","Omega"),
]

_MATH_OPS = [
    (r"\\leq","inferieur ou egal a"),(r"\\geq","superieur ou egal a"),
    (r"\\neq","different de"),(r"\\approx","environ"),
    (r"\\infty","l infini"),(r"\\sum","somme de"),(r"\\int","integrale de"),
    (r"\\lim","limite de"),(r"\\sqrt","racine carree de"),
    (r"\\forall","pour tout"),(r"\\exists","il existe"),
    (r"\\in","appartient a"),(r"\\cup","union"),(r"\\cap","intersection"),
    (r"\\cdot","fois"),(r"\\times","fois"),(r"\\rightarrow","vers"),
    (r"\\leftarrow","depuis"),(r"\\Rightarrow","implique"),
    (r"\\Leftrightarrow","si et seulement si"),(r"\\leftrightarrow","equivalent a"),
    (r"\\xrightarrow","vers"),(r"\\lfloor",""),(r"\\rfloor",""),
    (r"\\lceil",""),(r"\\rceil",""),(r"\\ldots","et ainsi de suite"),
    (r"\\cdots","et ainsi de suite"),(r"\\vdots",""),(r"\\ddots",""),
    (r"\\land","et"),(r"\\lor","ou"),(r"\\neg","non"),
    (r"\\emptyset","ensemble vide"),(r"\\partial","derivee partielle de"),
    (r"\\nabla","gradient de"),
]

def _clean_text_for_tts(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"```[a-zA-Z]*\n?", " ", text)
    text = text.replace("`", " ")
    text = re.sub(r"\\begin\{[^}]*\}", " ", text)
    text = re.sub(r"\\end\{[^}]*\}", " ", text)
    text = re.sub(r"\\xrightarrow\{[^}]*\}", " vers ", text)
    text = re.sub(r"\\delta\s*\(([^)]*)\)", lambda m: f"delta de {m.group(1)}", text)
    text = re.sub(r"\\frac\{([^}]+)\}\{([^}]+)\}", lambda m: f"{m.group(1)} sur {m.group(2)}", text)
    text = re.sub(r"([a-zA-Z]?)_\{([^}]+)\}", lambda m: f"{m.group(1)} {m.group(2)}", text)
    text = re.sub(r"([a-zA-Z]?)_([0-9a-zA-Z])", lambda m: f"{m.group(1)} {m.group(2)}", text)
    text = re.sub(r"\^2\b", " au carre", text)
    text = re.sub(r"\^3\b", " au cube", text)
    text = re.sub(r"\^\{([^}]+)\}", lambda m: f" puissance {m.group(1)}", text)
    text = re.sub(r"\^([0-9a-zA-Z])", lambda m: f" puissance {m.group(1)}", text)
    for pat, rep in _GREEK:
        text = re.sub(pat + r"(?=[^a-zA-Z]|$)", f" {rep} ", text)
    for pat, rep in _MATH_OPS:
        text = re.sub(pat + r"(?=[^a-zA-Z]|$)", f" {rep} ", text)
    text = re.sub(r"\$\$(.*?)\$\$", r" \1 ", text, flags=re.DOTALL)
    text = re.sub(r"\$(.*?)\$", r" \1 ", text, flags=re.DOTALL)
    text = re.sub(r"\\\[(.*?)\\\]", r" \1 ", text, flags=re.DOTALL)
    text = re.sub(r"\\\((.*?)\\\)", r" \1 ", text, flags=re.DOTALL)
    text = re.sub(r"\\[a-zA-Z]+\{[^}]*\}", " ", text)
    text = re.sub(r"\\[a-zA-Z]+", " ", text)
    text = re.sub(r"\\[^a-zA-Z ]", " ", text)
    text = re.sub(r"\|\s*[-:\s|]+\s*\|", " ", text)
    text = re.sub(r"\|", " ", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    text = re.sub(r"[#~{}\[\]\\]", " ", text)
    text = re.sub(r"\s*&\s*", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

def _is_speakable(text: str) -> bool:
    cleaned = _clean_text_for_tts(text)
    return bool(re.search(r"[a-zA-Z0-9\u00C0-\u024F]", cleaned))

async def _gen_seg_retry(text: str, voice: str, out: str, retries: int = 1) -> bool:
    cleaned = _clean_text_for_tts(text)
    for attempt in range(1 + retries):
        try:
            await edge_tts.Communicate(cleaned, voice).save(out)
            if os.path.exists(out) and os.path.getsize(out) > 0:
                return True
            logger.warning(f"[TTS] attempt {attempt+1}: 0-byte file")
        except Exception as e:
            logger.warning(f"[TTS] attempt {attempt+1} failed: {e}")
            if attempt < retries:
                await asyncio.sleep(0.8)
    return False

async def generate_podcast_audio(script: List[Dict[str, str]], course_id: str) -> str:
    if edge_tts is None or AudioSegment is None:
        raise ImportError("edge-tts or pydub not installed.")
    import tempfile
    base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out_dir = os.path.join(base, "educast-backend", "uploads", "podcasts")
    os.makedirs(out_dir, exist_ok=True)
    final = os.path.join(out_dir, f"{course_id}.mp3")
    with tempfile.TemporaryDirectory() as tmp:
        files = []
        logger.info(f"[TTS] {len(script)} segments for course {course_id}")
        for i, turn in enumerate(script):
            spk = turn.get("speaker", "professeur").lower()
            raw = turn.get("text", "").strip()
            if not raw or not _is_speakable(raw):
                logger.warning(f"[TTS] SKIP seg {i} ({spk}): not speakable")
                continue
            voice = VOICE_PROF if spk == "professeur" else VOICE_STUDENT
            seg = os.path.join(tmp, f"s{i}.mp3")
            if await _gen_seg_retry(raw, voice, seg):
                files.append(seg)
            else:
                logger.warning(f"[TTS] SKIP seg {i}: failed after retries")
        if not files:
            raise ValueError("No audio segments generated.")
        def _export():
            combined = AudioSegment.empty()
            pause = AudioSegment.silent(duration=500)
            for f in files:
                combined += AudioSegment.from_file(f, format="mp3") + pause
            combined.export(final, format="mp3", parameters=["-q:a", "0"])
        await asyncio.to_thread(_export)
    return f"/uploads/podcasts/{course_id}.mp3"

async def generate_rag_audio(text: str, course_id: str, rag_id: str) -> str:
    if edge_tts is None or AudioSegment is None:
        raise ImportError("edge-tts or pydub not installed.")
    base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    rag_dir = os.path.join(base, "educast-backend", "uploads", "rag")
    os.makedirs(rag_dir, exist_ok=True)
    out = os.path.join(rag_dir, f"{course_id}_{rag_id}.mp3")
    if not text or not _is_speakable(text):
        raise ValueError("RAG text has no speakable content.")
    if not await _gen_seg_retry(text, VOICE_PROF, out):
        raise RuntimeError("RAG TTS failed after retries.")
    return f"/uploads/rag/{course_id}_{rag_id}.mp3"
