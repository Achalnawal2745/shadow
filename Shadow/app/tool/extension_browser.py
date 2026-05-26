import asyncio
import json
import uuid
from typing import Any, Dict, Optional
from pydantic import Field

from app.tool.base import BaseTool, ToolResult
from app.logger import logger

# Global container to handle request-response mapping over the websocket
class ExtensionRequestManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance.pending_futures = {}
        return cls._instance

request_manager = ExtensionRequestManager()

class ExtensionBrowserTool(BaseTool):
    name: str = "browser_use"  # Named browser_use so it integrates seamlessly with Manus agent prompts
    description: str = "A tool to control the user's active browser window via a Chrome extension."
    parameters: dict = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "go_to_url",
                    "click_element",
                    "input_text",
                    "scroll_down",
                    "scroll_up",
                    "wait",
                    "eval_js"
                ],
                "description": "The browser action to perform",
            },
            "url": {
                "type": "string",
                "description": "URL for 'go_to_url' action",
            },
            "index": {
                "type": "integer",
                "description": "Element index for 'click_element' or 'input_text' actions",
            },
            "text": {
                "type": "string",
                "description": "Text for 'input_text' action, or Javascript code for 'eval_js' action",
            },
            "seconds": {
                "type": "integer",
                "description": "Seconds to wait for 'wait' action",
            }
        },
        "required": ["action"]
    }

    # Connection reference
    connection: Optional[Any] = None

    class Config:
        arbitrary_types_allowed = True

    async def execute(
        self,
        action: str,
        url: Optional[str] = None,
        index: Optional[int] = None,
        text: Optional[str] = None,
        seconds: Optional[int] = None,
        **kwargs
    ) -> ToolResult:
        """Executes a browser command by sending it over the WebSocket connection to the extension."""
        if not self.connection:
            return ToolResult(error="WebSocket connection to extension is not active.")

        logger.info(f"ExtensionBrowserTool executing action: {action}")

        # Handle local wait directly
        if action == "wait":
            wait_time = seconds if seconds is not None else 3
            await asyncio.sleep(wait_time)
            return ToolResult(output=f"Waited for {wait_time} seconds successfully.")

        # Map actions to what the extension background script expects
        mapped_action = action
        if action == "go_to_url":
            mapped_action = "navigate"
        elif action == "click_element":
            mapped_action = "click"
        elif action == "input_text":
            mapped_action = "type"
        elif action == "scroll_down":
            mapped_action = "scroll"
            kwargs["direction"] = "down"
        elif action == "scroll_up":
            mapped_action = "scroll"
            kwargs["direction"] = "up"
        elif action == "eval_js":
            mapped_action = "eval"

        # Construct the payload
        request_id = str(uuid.uuid4())
        future = asyncio.Future()
        request_manager.pending_futures[request_id] = future

        cmd_data = {
            "action": mapped_action
        }
        if url:
            cmd_data["url"] = url
        if index is not None:
            cmd_data["index"] = index
        if text:
            if action == "eval_js":
                cmd_data["code"] = text
            else:
                cmd_data["text"] = text
        if "direction" in kwargs:
            cmd_data["direction"] = kwargs["direction"]

        payload = {
            "type": "BROWSER_COMMAND",
            "id": request_id,
            "data": cmd_data
        }

        try:
            # Send command over websocket
            await self.connection.send(json.dumps(payload))
            
            # Await the response from the extension background script
            logger.info(f"Awaiting extension response for action '{mapped_action}' (ID: {request_id})...")
            response = await asyncio.wait_for(future, timeout=30.0)
            
            # Handle results
            if response.get("status") == "error":
                return ToolResult(error=response.get("error", "Unknown error in extension execution"))
            
            output_msg = f"Browser action '{action}' completed successfully."
            if "result" in response and isinstance(response["result"], dict) and "innerText" in response["result"]:
                output_msg = response["result"]["innerText"]
            elif "result" in response:
                output_msg = str(response["result"])
                
            return ToolResult(output=output_msg)
            
        except asyncio.TimeoutError:
            request_manager.pending_futures.pop(request_id, None)
            return ToolResult(error=f"Browser action '{action}' timed out waiting for extension response.")
        except Exception as e:
            request_manager.pending_futures.pop(request_id, None)
            return ToolResult(error=f"Browser action '{action}' failed: {str(e)}")

    async def get_current_state(self) -> ToolResult:
        """Fetch the current DOM tree state from the extension."""
        if not self.connection:
            return ToolResult(error="WebSocket connection to extension is not active.")

        request_id = str(uuid.uuid4())
        future = asyncio.Future()
        request_manager.pending_futures[request_id] = future

        payload = {
            "type": "BROWSER_COMMAND",
            "id": request_id,
            "data": {
                "action": "scrape"
            }
        }

        try:
            await self.connection.send(json.dumps(payload))
            response = await asyncio.wait_for(future, timeout=20.0)

            if response.get("status") == "error":
                return ToolResult(error=response.get("error"))

            res = response.get("result", {})
            url = res.get("url", "")
            title = res.get("title", "")
            innerText = res.get("innerText", "")

            # Formulate OpenManus-compatible browser state JSON
            state_info = {
                "url": url,
                "title": title,
                "tabs": [{"tab_id": 0, "title": title, "url": url}],
                "help": "[0], [1], etc. represent interactive index numbers overlaying elements.",
                "interactive_elements": innerText,
                "scroll_info": {
                    "pixels_above": 0,
                    "pixels_below": 0,
                    "total_height": 1000
                },
                "viewport_height": 800
            }

            return ToolResult(output=json.dumps(state_info, indent=4, ensure_ascii=False))

        except asyncio.TimeoutError:
            request_manager.pending_futures.pop(request_id, None)
            return ToolResult(error="Timed out scraping browser DOM state.")
        except Exception as e:
            request_manager.pending_futures.pop(request_id, None)
            return ToolResult(error=f"Failed to fetch browser state: {str(e)}")
