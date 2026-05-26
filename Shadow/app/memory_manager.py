import os
import json
from typing import List, Dict, Any, Optional

from mem0 import Memory
from langchain_community.embeddings import HuggingFaceEmbeddings

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

    def __init__(self):
        self.workspace_dir = config.workspace_root
        
        # Configure mem0 to use local HuggingFace embeddings
        # and store its vector database locally
        try:
            hf_embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
            
            mem0_config = {
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
                    }
                }
            }
            
            self.memory = Memory.from_config(mem0_config)
            logger.info("Initialized mem0 with local HuggingFace embeddings.")
        except Exception as e:
            logger.error(f"Failed to initialize mem0: {e}")
            self.memory = None

    def search(self, query: str) -> str:
        """Search past experiences relevant to the current query."""
        if not self.memory:
            return ""
            
        try:
            results = self.memory.search(query, user_id="shadow_user", limit=3)
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
                f"Task Execution Context:\n{json.dumps(context_messages[-12:])}\n\n"
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
