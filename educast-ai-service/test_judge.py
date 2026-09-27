"""
Quick diagnostic: test the Groq judge call using qwen/qwen3.6-27b with reasoning_effort=none.
Run: python test_judge.py
"""
import os, json, traceback
from dotenv import load_dotenv
load_dotenv()

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_JUDGE_MODEL = os.environ.get("GROQ_JUDGE_MODEL", "qwen/qwen3.6-27b")

print(f"GROQ_API_KEY present: {bool(GROQ_API_KEY)} (first 8 chars: {GROQ_API_KEY[:8]}...)")
print(f"GROQ_JUDGE_MODEL: {GROQ_JUDGE_MODEL}")

try:
    from openai import OpenAI
    client = OpenAI(api_key=GROQ_API_KEY, base_url="https://api.groq.com/openai/v1", timeout=45.0)

    prompt = (
        "Tu es un juge expert en qualite linguistique.\n"
        "Evalue la fluidite du resume ci-dessous. Bareme (1-5): 5=Excellent, 1=Tres mauvais.\n\n"
        "=== DOCUMENT SOURCE ===\n"
        "Ceci est un document sur les services web.\n\n"
        "=== RESUME A EVALUER ===\n"
        "Les services web permettent l echange de donnees entre applications via HTTP.\n\n"
        'Instructions: Reponds UNIQUEMENT avec ce JSON:\n'
        '{"score": <entier 1-5>, "rationale": "<explication courte>"}'
    )

    print("\n--- TEST 1: json_object mode + reasoning_effort=none ---")
    try:
        resp = client.chat.completions.create(
            model=GROQ_JUDGE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.0,
            max_tokens=512,
            extra_body={"reasoning_effort": "none"},
        )
        content = resp.choices[0].message.content
        usage = resp.usage
        print(f"SUCCESS! Content: {content}")
        print(f"Tokens: prompt={usage.prompt_tokens}, completion={usage.completion_tokens}")
    except Exception as e:
        print(f"FAILED json_object+reasoning_effort mode: {e}")

        print("\n--- TEST 2: standard text mode + reasoning_effort=none ---")
        try:
            resp = client.chat.completions.create(
                model=GROQ_JUDGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=512,
                extra_body={"reasoning_effort": "none"},
            )
            content = resp.choices[0].message.content
            usage = resp.usage
            print(f"SUCCESS! Content: {content}")
            print(f"Tokens: prompt={usage.prompt_tokens}, completion={usage.completion_tokens}")
        except Exception as e2:
            print(f"FAILED standard text mode: {e2}")

            print("\n--- TEST 3: bare call, no extra_body ---")
            try:
                resp = client.chat.completions.create(
                    model=GROQ_JUDGE_MODEL,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.0,
                    max_tokens=512,
                )
                content = resp.choices[0].message.content
                usage = resp.usage
                print(f"SUCCESS! Content: {content}")
                print(f"Tokens: prompt={usage.prompt_tokens}, completion={usage.completion_tokens}")
            except Exception as e3:
                print(f"ALL TESTS FAILED: {e3}")
                traceback.print_exc()

except Exception as fatal:
    print(f"FATAL error: {fatal}")
    traceback.print_exc()
