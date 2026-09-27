"""
services/dialogue.py
====================
Generates professor/student dialogue script from course summaries using LLM.
Supports initial generation and refinement with previous_script + correction_prompt.
Includes strict rules for spoken French math expressions and JSON repair fallback.
"""

import json
import logging
import re
from typing import Dict, Any, List, Optional

from services.llm_fallback import generate_summary_untraced

logger = logging.getLogger(__name__)

_DIALOGUE_SYSTEM_INSTRUCTIONS = r"""Tu es un scénariste pédagogique expert.
À partir du résumé pédagogique fourni, génère un dialogue de podcast éducatif entre un PROFESSEUR et un ÉTUDIANT.

RÈGLES STRICTES :
1. Le professeur explique les concepts de façon claire et progressive.
2. L'étudiant pose des questions naturelles, demande des exemples, exprime ses doutes.
3. Couvre TOUS les concepts importants du résumé -- ne saute rien.
4. Utilise un français courant et naturel, adapté à un podcast audio oral.
5. Le dialogue doit compter entre 10 et 20 échanges (tours de parole).
6. Réponds UNIQUEMENT avec un tableau JSON valide, sans texte avant ni après.
7. PODCAST ORAL : Le dialogue est destiné à la synthèse vocale audio. N'inclus JAMAIS de tableaux Markdown (|---|---|), ni de blocs de code (```), ni de séparateurs.
8. LANGAGE ORAL MATHÉMATIQUE OBLIGATOIRE : Ne recopie JAMAIS de syntaxe LaTeX brute dans le texte. Les symboles comme \delta, \xrightarrow, \begin{}, \end{}, &, $, \frac, \sum sont INTERDITS dans le texte parlé. Reformule TOUJOURS en langage naturel français oral, comme le ferait un professeur devant un tableau :
   - \delta(q_0, a, Z_0) -> 'delta de q zéro, avec a et Z zéro'
   - x^2 -> 'x au carré'
   - \frac{a}{b} -> 'a sur b'
   - \sum_{i=0}^{n} -> 'la somme de i égal zéro à n'
   - \rightarrow -> 'qui donne' ou 'vers'

FORMAT DE SORTIE ATTENDU (JSON uniquement) :
[
  {"speaker": "professeur", "text": "Texte du professeur ici."},
  {"speaker": "etudiant",   "text": "Texte de l'étudiant ici."}
]

N'ajoute aucun commentaire, aucun markdown, aucune explication en dehors du JSON."""


def _parse_and_repair_json(raw: str) -> List[Dict[str, str]]:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned, strict=False)
        if isinstance(data, list) and len(data) > 0:
            return data
    except Exception:
        pass

    match = re.search(r"\[\s*\{[\s\S]*\}\s*\]", cleaned)
    if match:
        try:
            data = json.loads(match.group(0), strict=False)
            if isinstance(data, list) and len(data) > 0:
                return data
        except Exception:
            pass

    pattern = r'\{\s*"speaker"\s*:\s*"([^"]+)"\s*,\s*"text"\s*:\s*"([^"]+)"\s*\}'
    turns = []
    for m in re.finditer(pattern, cleaned):
        turns.append({"speaker": m.group(1), "text": m.group(2)})
    if turns:
        return turns

    return [{"speaker": "professeur", "text": cleaned[:2000]}]


def generate_dialogue_script(
    summary: str,
    previous_script: Optional[List[Dict[str, str]]] = None,
    correction_prompt: Optional[str] = None
) -> Dict[str, Any]:
    """
    Generate or refine a professor/student podcast script.
    If previous_script and/or correction_prompt are provided, perform a refinement generation.
    """
    if previous_script or correction_prompt:
        prev_json = json.dumps(previous_script, ensure_ascii=False, indent=2) if previous_script else "(aucun script précédent)"
        instruction = correction_prompt or "Génère une NOUVELLE version du dialogue avec des explications plus claires, des questions plus naturelles et un rythme dynamique."

        prompt = f"""{_DIALOGUE_SYSTEM_INSTRUCTIONS}

RÉSUMÉ DU COURS ORIGINAL :
{summary}

PRÉCÉDENT SCRIPT DE DIALOGUE À AMÉLIORER ET REMPLACER :
{prev_json}

DIRECTIVES D'AMÉLIORATION / CORRECTION :
{instruction}

CONSIGNE : Génère un NOUVEAU dialogue complet en JSON, totalement différent et nettement meilleur que le précédent script.
DIALOGUE (JSON) :"""
    else:
        prompt = f"{_DIALOGUE_SYSTEM_INSTRUCTIONS}\n\nRÉSUMÉ DU COURS :\n{summary}\n\nDIALOGUE (JSON) :"

    try:
        res = generate_summary_untraced(prompt, prompt_name="dialogue_generation")
        raw_output = res.get("summary", "")
        script = _parse_and_repair_json(raw_output)
        return {
            "script": script,
            "provider_used": res.get("provider_used"),
            "token_usage": res.get("token_usage", {}),
        }
    except Exception as e:
        logger.error(f"[DIALOGUE] Error generating script: {e}")
        return {"error": str(e), "script": []}
