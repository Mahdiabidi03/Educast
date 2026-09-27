"""
Test script — LLM Fallback Chain
=================================
Simule un échec d'Ollama (Ollama non démarré ou modèle absent) et vérifie
que le fallback automatique vers les providers suivants fonctionne.

Usage :
    python test_fallback.py
"""
import logging
import sys
import os

# Configure verbose logging so we see every provider attempt
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)

# Make sure the project root is on the path
sys.path.insert(0, os.path.dirname(__file__))

from services.llm_fallback import build_summary_prompt, generate_summary

# ── 1. Build a sample prompt from dummy chunks ────────────────────────────────
test_chunks = [
    "Les réseaux de neurones artificiels s'inspirent du cerveau humain. "
    "Ils sont composés de couches de neurones artificiels interconnectés.",

    "L'apprentissage supervisé utilise des données étiquetées pour entraîner "
    "un modèle à prédire des sorties à partir d'entrées inconnues.",

    "Le gradient descent est l'algorithme d'optimisation le plus utilisé en "
    "deep learning. Il ajuste les poids du réseau pour minimiser la fonction de perte.",
]

print("\n" + "="*60)
print("  TEST : Chaîne de fallback LLM")
print("="*60 + "\n")

prompt = build_summary_prompt(test_chunks)
print(f"[TEST] Prompt construit ({len(prompt)} caractères)")
print("-"*60)

result = generate_summary(prompt)

print("\n" + "="*60)
print(f"  Provider utilisé : {result['provider_used']}")
print("="*60)
print("\n[SUMMARY] Resume genere :\n")
print(result["summary"])
print("\n" + "="*60)

if result["provider_used"] == "None":
    print("\n[WARN] Tous les providers ont echoue !")
    sys.exit(1)
else:
    print(f"\n[OK] Succes via : {result['provider_used']}")
    sys.exit(0)
