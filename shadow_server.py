import asyncio
import json
import os
import sys
import websockets
from typing import Any, Dict, List, Optional

# Add OpenManus directory to python path to resolve its internal absolute imports
workspace_dir = os.path.dirname(os.path.abspath(__file__))
openmanus_dir = os.path.join(workspace_dir, "Shadow")
sys.path.append(openmanus_dir)

from app.logger import logger
from app.config import config as app_config
from app.agent.shadow import Shadow
from app.tool import ToolCollection, ManageMemory
from app.tool.base import BaseTool
from app.tool.python_execute import PythonExecute
from app.tool.str_replace_editor import StrReplaceEditor
from app.tool.terminate import Terminate
from app.tool.extension_browser import ExtensionBrowserTool, request_manager
from app.llm import LLM
from app.schema import AgentState
from app.memory_manager import memory_manager

PORT = 3001

# Globals to track connections and handle human response loops
active_websocket = None
pending_human_inputs = None
active_agent = None

class ExtensionAskHuman(BaseTool):
    """Subclass tool to ask the human for feedback directly inside the sidebar extension chat."""
    name: str = "ask_human"
    description: str = "Use this tool to ask human for help."
    parameters: dict = {
        "type": "object",
        "properties": {
            "inquire": {
                "type": "string",
                "description": "The question you want to ask human."
            }
        },
        "required": ["inquire"]
    }
    
    websocket_conn: Any = None

    async def execute(self, inquire: str) -> str:
        global pending_human_inputs
        if not self.websocket_conn:
            return "Error: WebSocket connection to extension is not active."
        
        # Send bot's question to extension sidebar
        logger.info(f"Asking user in extension: {inquire}")
        await self.websocket_conn.send(json.dumps({
            "type": "REPLY",
            "data": {"reply": f"🙋‍♂️ Shadow Inquires: {inquire}"}
        }))
        
        # Suspend agent run loop and await user chat response
        pending_human_inputs = asyncio.Future()
        user_response = await pending_human_inputs
        pending_human_inputs = None
        
        return user_response

class ShadowAgent(Shadow):
    """Extended Shadow agent subclass that replaces Playwright with Chrome Extension web control."""
    websocket_conn: Any = None
    
    def __init__(self, websocket_conn=None, **data):
        super().__init__(**data)
        self.websocket_conn = websocket_conn
        
        # Re-register tools to route browser interactions through the WebSocket and support sidebar chat prompt inputs
        self.available_tools = ToolCollection(
            PythonExecute(),
            ExtensionBrowserTool(connection=self.websocket_conn),
            StrReplaceEditor(),
            ExtensionAskHuman(websocket_conn=self.websocket_conn),
            ManageMemory(),
            Terminate()
        )
        
    async def think(self) -> bool:
        """Runs the agent reasoning and streams thoughts/actions back to the sidebar panel."""
        result = await super().think()
        if self.memory.messages and self.websocket_conn:
            last_msg = self.memory.messages[-1]
            if last_msg.role == "assistant":
                content = last_msg.content or ""
                # Send agent thoughts if available
                if content:
                    await self.websocket_conn.send(json.dumps({
                        "type": "STREAM",
                        "data": {"text": content + "\n\n"}
                    }))
        return result

    async def act(self) -> str:
        """Sends status updates of current tool actions executing back to the extension sidebar."""
        if self.tool_calls and self.websocket_conn:
            tool_names = [tc.function.name for tc in self.tool_calls]
            await self.websocket_conn.send(json.dumps({
                "type": "STATUS_UPDATE",
                "data": {"message": f"Executing action(s): {', '.join(tool_names)}"}
            }))
        return await super().act()

    async def step(self) -> str:
        """Override step to pause execution if agent only sends a text reply to the user."""
        result = await super().step()
        if not self.tool_calls and self.state != AgentState.FINISHED:
            global pending_human_inputs
            if self.websocket_conn:
                logger.info("Agent sent a text reply. Suspending step execution until next user message...")
                pending_human_inputs = asyncio.Future()
                user_response = await pending_human_inputs
                pending_human_inputs = None
                self.update_memory("user", user_response)
        return result

async def ws_handler(websocket, path=None):
    global active_websocket, pending_human_inputs, active_agent
    active_websocket = websocket
    logger.info("Chrome Extension connected to Shadow Server!")
    
    try:
        # Send connection status indicator
        await websocket.send(json.dumps({"type": "STATUS", "status": "connected"}))
        
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")
            
            if msg_type == "LOG":
                print(f"[CLIENT_LOG] {data.get('data')}")
                
            elif msg_type == "RESPONSE" or msg_type == "BROWSER_RESPONSE":
                # Handle async browser tool response mapping
                req_id = data.get("id")
                if req_id and req_id in request_manager.pending_futures:
                    future = request_manager.pending_futures.pop(req_id)
                    if not future.done():
                        future.set_result(data.get("data", {}))
                        
            elif msg_type == "PROMPT":
                prompt_data = data.get("data", {})
                prompt_text = prompt_data.get("message", "").strip()
                user_config = prompt_data.get("config", {})
                
                # If agent was waiting for human answer, resolve future and continue execution
                if pending_human_inputs and not pending_human_inputs.done():
                    if prompt_text.lower() in ["stop", "cancel", "exit", "quit"] and active_agent:
                        active_agent.state = AgentState.FINISHED
                    if active_agent:
                        active_agent.current_step = 0  # Reset step counter for new turn
                    pending_human_inputs.set_result(prompt_text)
                    continue
 
                if active_agent and active_agent.state == AgentState.RUNNING:
                    if prompt_text.lower() in ["stop", "cancel", "exit", "quit"]:
                        logger.info("User requested to stop the active agent.")
                        active_agent.state = AgentState.FINISHED
                        await websocket.send(json.dumps({
                            "type": "STATUS_UPDATE",
                            "data": {"message": "Agent execution halted by user."}
                        }))
                    else:
                        logger.info(f"Injecting user message into active agent memory: {prompt_text}")
                        active_agent.update_memory("user", prompt_text)
                        active_agent.current_step = 0  # Reset step counter for new instruction
                        await websocket.send(json.dumps({
                            "type": "STATUS_UPDATE",
                            "data": {"message": "Injected comment into agent's active memory."}
                        }))
                    continue
                    
                if not prompt_text:
                    continue
                    
                logger.info(f"Triggering Shadow agent with prompt: {prompt_text}")
                
                # Dynamically inject settings (Model, API Key, Base URL) passed by the extension UI into config
                if "default" in app_config.llm:
                    llm_config = app_config.llm["default"]
                    
                    # Read .env file for environment fallbacks
                    env_vars = {}
                    env_path = os.path.join(workspace_dir, '.env')
                    if os.path.exists(env_path):
                        try:
                            with open(env_path, 'r', encoding='utf-8') as f:
                                for line in f:
                                    line = line.strip()
                                    if line and not line.startswith('#') and '=' in line:
                                        parts = line.split('=', 1)
                                        if len(parts) == 2:
                                            env_vars[parts[0].strip()] = parts[1].strip()
                        except Exception as e:
                            logger.error(f"Error loading .env file: {e}")

                    # Determine URL and Model
                    base_url = user_config.get("baseUrl") or llm_config.base_url
                    model = user_config.get("model") or llm_config.model
                    
                    # Find a valid API key
                    api_key = user_config.get("apiKey")
                    if not api_key:
                        if "pollinations" in base_url:
                            api_key = os.environ.get("POLLINATIONS_API_KEY") or env_vars.get("POLLINATIONS_API_KEY")
                        if not api_key:
                            api_key = os.environ.get("OPENAI_API_KEY") or env_vars.get("OPENAI_API_KEY")
                    
                    # Apply changes to config
                    llm_config.base_url = base_url
                    llm_config.model = model
                    if api_key:
                        llm_config.api_key = api_key
                    elif llm_config.api_key == "YOUR_API_KEY":
                        # If no API key is specified anywhere, default to an empty string (or placeholder)
                        llm_config.api_key = "none"
                    
                    if user_config.get("temperature") is not None:
                        llm_config.temperature = float(user_config.get("temperature"))
                    
                    # Force LLM client re-initialization by clearing cached LLM instances
                    LLM._instances.clear()
                    memory_manager.reinit()
                    
                    logger.info(f"Using LLM settings: model={llm_config.model}, base_url={llm_config.base_url}, api_key={'***' if llm_config.api_key else 'none'}")
                
                # Create and run ShadowAgent
                agent = await ShadowAgent.create(websocket_conn=websocket)
                
                async def run_agent():
                    global active_agent
                    active_agent = agent
                    try:
                        await agent.run(prompt_text)
                        try:
                            await websocket.send(json.dumps({
                                "type": "STATUS_UPDATE",
                                "data": {"message": "Shadow completed task execution successfully."}
                            }))
                        except Exception:
                            pass
                    except Exception as err:
                        logger.error(f"Error running ShadowAgent: {err}")
                        try:
                            await websocket.send(json.dumps({
                                "type": "REPLY",
                                "data": {"reply": f"Error running agent: {str(err)}"}
                            }))
                        except Exception:
                            pass
                    finally:
                        if active_agent == agent:
                            active_agent = None
                        
                asyncio.create_task(run_agent())
                
    except websockets.ConnectionClosed:
        logger.info("Extension connection closed.")
    finally:
        if active_websocket == websocket:
            active_websocket = None

async def main():
    logger.info(f"Starting Shadow Bridge Server on ws://localhost:{PORT}...")
    async with websockets.serve(ws_handler, "localhost", PORT):
        await asyncio.Future()  # Keep server running infinitely

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server terminated by user.")
