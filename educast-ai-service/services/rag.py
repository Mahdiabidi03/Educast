"""
services/rag.py
===============
Handles RAG (Retrieval-Augmented Generation) for answering student questions during the podcast.
"""

import logging
from typing import Dict, Any

from services.vector_store import get_index
from services.embedding import model as embedding_model
from services.llm_fallback import generate_summary_untraced

logger = logging.getLogger(__name__)

def rag_answer(question: str, document_id: str, transcript_context: str) -> Dict[str, Any]:
    """
    Given a question and the current state of the transcript, retrieve relevant chunks
    from Pinecone and answer the question using the LLM fallback chain.
    """
    logger.info(f"[RAG] Answering question for document {document_id}: {question}")
    
    # 1. Embed the question
    question_embedding = embedding_model.encode(question, convert_to_numpy=True).tolist()
    
    # 2. Query Pinecone
    index = get_index()
    
    # We only want chunks from this specific document
    # Using metadata filtering on document_id
    try:
        query_response = index.query(
            vector=question_embedding,
            top_k=5,
            include_metadata=True,
            filter={"document_id": {"$eq": document_id}}
        )
        
        chunks = []
        for match in query_response.get("matches", []):
            meta = match.get("metadata", {})
            text = meta.get("text", "")
            if text:
                chunks.append(text)
                
        retrieved_text = "\n\n---\n\n".join(chunks)
        if not retrieved_text:
            retrieved_text = "(Aucune information supplementaire trouvee dans le document)"
            
    except Exception as e:
        logger.error(f"[RAG] Pinecone query failed: {e}")
        retrieved_text = "(Erreur lors de la recuperation du contexte)"
        
    # 3. Construct the prompt
    prompt = f"""\
Tu es le PROFESSEUR dans un podcast educatif. Tu es en train de discuter avec un ETUDIANT.
L'etudiant vient de t'interrompre pour te poser une question.

--- CONTEXTE DU DOCUMENT ---
Voici les extraits du cours original les plus pertinents pour repondre a la question :
{retrieved_text}

--- TRANSCRIPTION DU PODCAST JUSQU'A LA PAUSE ---
{transcript_context}

--- QUESTION DE L'ETUDIANT ---
{question}

--- INSTRUCTIONS ---
Reponds directement a la question de l'etudiant de maniere naturelle et pedagogique.
- LANGUE STRICTE ET OBLIGATOIRE : Tu dois TOUJOURS répondre EXCLUSIVEMENT en FRANÇAIS. Même si la question de l'étudiant est posée en anglais ou dans une autre langue, ou même s'il te demande explicitement de répondre en anglais, tu dois REFUSER de parler anglais et répondre uniquement en français.
- Ne dis pas "Bonjour" ou "Bienvenue", vous etiez deja en train de parler.
- Utilise le tutoiement pour t'adresser a l'etudiant.
- Ta reponse doit etre sous forme de texte brut, sans JSON, sans balises, prete a etre lue a voix haute.
- Si la reponse se trouve dans le contexte du document, base-toi dessus.
- Si le contexte du document ne contient pas la reponse, dis-le honnetement mais essaie d'aider si possible.
- FORMULES MATHÉMATIQUES : N'utilise pas de LaTeX brut. Explique les mathématiques en français oral fluide.
"""

    # 4. Call LLM
    try:
        # We use untraced to avoid spamming MLflow with these quick chat interactions
        result = generate_summary_untraced(
            prompt=prompt,
            prompt_name="rag_podcast_chat",
            prompt_version="1"
        )
        
        answer = result.get("summary", "")
        if not answer or answer == "CONTENU_INVALIDE":
            answer = "Je suis desole, je n'ai pas pu generer de reponse a cette question."
            
        return {
            "answer": answer,
            "provider_used": result.get("provider_used"),
            "token_usage": result.get("token_usage", {})
        }
        
    except Exception as e:
        logger.error(f"[RAG] LLM fallback failed: {e}")
        return {
            "answer": "Une erreur technique s'est produite lors de la generation de la reponse. Veuillez reessayer.",
            "provider_used": "None",
            "token_usage": {}
        }
