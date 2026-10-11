class ApiError(Exception):
    """Raised anywhere in the backend; rendered as {"error": {code, message, details}}."""

    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details
