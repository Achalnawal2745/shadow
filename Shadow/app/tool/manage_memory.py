from app.tool import BaseTool
from app.memory_manager import memory_manager

class ManageMemory(BaseTool):
    """Tool to view, add, search, or delete memories from Shadow's long-term semantic memory."""

    name: str = "manage_memory"
    description: str = (
        "Use this tool to interact with Shadow's long-term semantic memory. "
        "Allows viewing all memories, adding new memories, searching, or deleting memories by ID."
    )
    parameters: dict = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "description": "The action to perform: 'add' (save a new preference/fact), 'search' (find relevant memories), 'delete' (remove a memory by its ID), or 'get_all' (view all stored memories).",
                "enum": ["add", "search", "delete", "get_all"]
            },
            "text": {
                "type": "string",
                "description": "The memory text to add (required if action is 'add')."
            },
            "query": {
                "type": "string",
                "description": "The search query (required if action is 'search')."
            },
            "memory_id": {
                "type": "string",
                "description": "The memory ID to delete (required if action is 'delete')."
            }
        },
        "required": ["action"]
    }

    async def execute(self, action: str, text: str = None, query: str = None, memory_id: str = None) -> str:
        if action == "add":
            if not text:
                return "Error: 'text' parameter is required when action is 'add'."
            memory_manager.save(text)
            return f"Successfully added memory: {text}"
        elif action == "search":
            if not query:
                return "Error: 'query' parameter is required when action is 'search'."
            return memory_manager.search_with_ids(query)
        elif action == "delete":
            if not memory_id:
                return "Error: 'memory_id' parameter is required when action is 'delete'."
            return memory_manager.delete(memory_id)
        elif action == "get_all":
            return memory_manager.get_all()
        else:
            return f"Error: Unsupported action '{action}'."
