class ToolError(Exception):
    """Raised when a tool encounters an error."""

    def __init__(self, message):
        self.message = message


class ShadowError(Exception):
    """Base exception for all Shadow errors"""


class TokenLimitExceeded(ShadowError):
    """Exception raised when the token limit is exceeded"""
