import os
import json
from typing import List, Dict, Any, Optional

from mem0 import Memory
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_openai import ChatOpenAI

from app.logger import logger
from app.config import config

class SemanticMemoryManager:
    """Manages long-term semantic memory using mem0 and local embeddings."""
    
    _instance = None
    
    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def reinit(self):
        """Re-initialize mem0 with the latest LLM configurations."""
        logger.info("Re-initializing memory manager with new LLM settings.")
        self.__init__()

    def __init__(self):
        self.workspace_dir = config.workspace_root
        
        # Configure mem0 to use local HuggingFace embeddings
        # and store its vector database locally
        try:
            # Initialize LangChain ChatOpenAI from project config
            llm_settings = config.llm.get("default")
            if llm_settings:
                import httpx
                
                class SyncHeaderOverrideClient(httpx.Client):
                    def send(self, request: httpx.Request, *args, **kwargs) -> httpx.Response:
                        request.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                        keys_to_remove = [k for k in request.headers.keys() if k.lower().startswith("x-stainless-")]
                        for k in keys_to_remove:
                            del request.headers[k]
                        return super().send(request, *args, **kwargs)

                class AsyncHeaderOverrideClient(httpx.AsyncClient):
                    async def send(self, request: httpx.Request, *args, **kwargs) -> httpx.Response:
                        request.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                        keys_to_remove = [k for k in request.headers.keys() if k.lower().startswith("x-stainless-")]
                        for k in keys_to_remove:
                            del request.headers[k]
                        return await super().send(request, *args, **kwargs)

                # Fallback to dummy key if none provided (e.g. for Pollinations)
                api_key = llm_settings.api_key if (llm_settings.api_key and llm_settings.api_key != "YOUR_API_KEY") else "none"
                llm_instance = ChatOpenAI(
                    model=llm_settings.model,
                    api_key=api_key,
                    base_url=llm_settings.base_url,
                    temperature=llm_settings.temperature,
                    http_client=SyncHeaderOverrideClient(),
                    http_async_client=AsyncHeaderOverrideClient()
                )
            else:
                llm_instance = None

            hf_embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
            
            mem0_config = {
                "llm": {
                    "provider": "langchain",
                    "config": {
                        "model": llm_instance
                    }
                },
                "embedder": {
                    "provider": "langchain",
                    "config": {
                        "model": hf_embeddings
                    }
                },
                "vector_store": {
                    "provider": "qdrant",
                    "config": {
                        "path": os.path.join(self.workspace_dir, "mem0_db"),
                        "embedding_model_dims": 384,
                    }
                }
            }
            
            self.memory = Memory.from_config(mem0_config)
            logger.info("Initialized mem0 with local HuggingFace embeddings and configured LLM.")
        except Exception as e:
            logger.error(f"Failed to initialize mem0: {e}")
            self.memory = None

    def search(self, query: str) -> str:
        """Search past experiences relevant to the current query."""
        if not self.memory:
            return ""
            
        try:
            results = self.memory.search(query, filters={"user_id": "shadow_user"}, limit=3)
            if isinstance(results, dict):
                results = results.get("results", [])
            if not results:
                return ""
            
            # Format the results into a readable string for the system prompt
            formatted = "\n--- RELEVANT PAST EXPERIENCES (MEM0) ---\n"
            found_any = False
            for idx, res in enumerate(results):
                # mem0 search results format can vary, usually it's a dict containing 'memory'
                text = res.get('memory') if isinstance(res, dict) else getattr(res, 'memory', str(res))
                if text:
                    formatted += f"{idx + 1}. {text}\n"
                    found_any = True
                    
            if not found_any:
                return ""
            return formatted + "----------------------------------------\n"
        except Exception as e:
            logger.error(f"Error searching mem0: {e}")
            return ""

    def save(self, memory_text: str):
        """Save a new lesson or preference to memory."""
        if not self.memory:
            return
            
        try:
            self.memory.add(memory_text, user_id="shadow_user")
            logger.info(f"Saved new memory: {memory_text}")
        except Exception as e:
            logger.error(f"Error saving to mem0: {e}")

    def delete(self, memory_id: str) -> str:
        """Delete a specific memory by its ID."""
        if not self.memory:
            return "Memory engine is offline."
        try:
            self.memory.delete(memory_id)
            logger.info(f"Deleted memory with ID: {memory_id}")
            return f"Successfully deleted memory: {memory_id}"
        except Exception as e:
            logger.error(f"Error deleting memory: {e}")
            return f"Error deleting memory: {e}"

    def get_all(self) -> str:
        """Get all stored memories with their IDs."""
        if not self.memory:
            return "Memory engine is offline."
        try:
            results = self.memory.get_all(filters={"user_id": "shadow_user"})
            if isinstance(results, dict):
                results = results.get("results", [])
            if not results:
                return "No memories found."
            
            formatted = "\n--- ALL STORED MEMORIES ---\n"
            for res in results:
                m_id = res.get('id') if isinstance(res, dict) else getattr(res, 'id', 'unknown')
                text = res.get('memory') if isinstance(res, dict) else getattr(res, 'memory', str(res))
                if m_id and text:
                    formatted += f"[{m_id}]: {text}\n"
            return formatted + "---------------------------\n"
        except Exception as e:
            logger.error(f"Error retrieving all memories: {e}")
            return f"Error retrieving all memories: {e}"

    def search_with_ids(self, query: str) -> str:
        """Search memories and return results with their IDs."""
        if not self.memory:
            return "Memory engine is offline."
        try:
            results = self.memory.search(query, filters={"user_id": "shadow_user"}, limit=5)
            if isinstance(results, dict):
                results = results.get("results", [])
            if not results:
                return "No relevant memories found."
            
            formatted = "\n--- RELEVANT PAST EXPERIENCES (WITH IDs) ---\n"
            for res in results:
                m_id = res.get('id') if isinstance(res, dict) else getattr(res, 'id', 'unknown')
                text = res.get('memory') if isinstance(res, dict) else getattr(res, 'memory', str(res))
                if m_id and text:
                    formatted += f"[{m_id}]: {text}\n"
            return formatted + "----------------------------------------\n"
        except Exception as e:
            logger.error(f"Error searching memories: {e}")
            return f"Error searching memories: {e}"

    async def summarize_and_save(self, request: str, messages: list):
        """Summarize the task experience and save it as a lesson learned."""
        if not self.memory:
            return
            
        try:
            from app.llm import LLM
            llm = LLM()
            
            # Extract user, assistant, and tool messages to analyze full context
            context_messages = [
                {"role": msg.role, "content": msg.content or str(msg.tool_calls)} 
                for msg in messages if msg.role in ["user", "assistant", "tool"]
            ]
            
            prompt = (
                f"User Request: {request}\n\n"
                f"Task Execution Context:\n{json.dumps(context_messages)}\n\n"
                "Based on the execution history and the user's guidance/comments, extract any clear user preferences "
                "(e.g., preferred tools/frameworks, style choices) or key technical lessons learned "
                "(e.g., how to solve a specific error, successful selectors, commands that worked). "
                "Write a concise 1-2 sentence lesson or preference. Ignore general chat, greetings, or transient details. "
                "Format as a simple, actionable insight."
            )
            
            summary = await llm.ask(prompt)
            if summary:
                self.save(summary)
        except Exception as e:
            logger.error(f"Error summarizing and saving memory: {e}")

memory_manager = SemanticMemoryManager.get_instance()
