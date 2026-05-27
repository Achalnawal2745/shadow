import subprocess
import sys
from typing import Dict

from app.tool.base import BaseTool


class PythonExecute(BaseTool):
    """A tool for executing Python code with timeout and safety restrictions."""

    name: str = "python_execute"
    description: str = "Executes Python code string. Note: Only print outputs are visible, function return values are not captured. Use print statements to see results. If an import fails with ModuleNotFoundError, you can install the missing package yourself using: import subprocess; subprocess.run(['pip', 'install', 'package_name'])."
    parameters: dict = {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "The Python code to execute.",
            },
        },
        "required": ["code"],
    }

    async def execute(
        self,
        code: str,
        timeout: int = 60,
    ) -> Dict:
        """
        Executes the provided Python code with a timeout using a clean subprocess.

        Args:
            code (str): The Python code to execute.
            timeout (int): Execution timeout in seconds.

        Returns:
            Dict: Contains 'observation' with execution output and 'success' status.
        """
        try:
            # Run the python code using a clean subprocess with sys.executable
            # passing the code via stdin/string execution
            result = subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                text=True,
                timeout=timeout
            )
            
            # Combine stdout and stderr for full visibility
            output = result.stdout + result.stderr
            return {
                "observation": output,
                "success": result.returncode == 0
            }
            
        except subprocess.TimeoutExpired:
            return {
                "observation": f"Execution timeout after {timeout} seconds",
                "success": False
            }
        except Exception as e:
            return {
                "observation": f"Failed to execute code: {str(e)}",
                "success": False
            }
