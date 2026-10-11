from . import Verdict

DETECTIONS = {
    "🏋": ["dumbbells", "treadmill", "workout gear"], "🍳": ["stovetop", "fresh ingredients", "kitchen counter"],
    "💻": ["laptop", "code editor", "workspace setup"], "🧹": ["clean surfaces", "organized room", "vacuum cleaner"],
    "📚": ["open books", "notebook", "desk lamp"], "🏃": ["running shoes", "outdoor path", "sportswear"],
    "🧘": ["yoga mat", "calm indoor setting"], "💊": ["pill bottle", "glass of water"],
    "🎨": ["canvas", "paint brushes", "easel"], "🌿": ["houseplants", "watering can"],
}


class MockVerifier:
    """Deterministic and offline. Passes everything unless told to reject (used by tests)."""

    def __init__(self, result="verified"):
        self.result = result

    def verify(self, task_name, icon, jpeg):
        if self.result == "rejected":
            return Verdict("rejected", 30, ["unclear scene"], "The captured scene does not clearly show the activity for this task.", "mock", "mock")
        things = DETECTIONS.get(icon.replace("️", ""), ["workspace", "daylight"])
        return Verdict("verified", 90, things[:3], "Scene matches the expected context for this task.", "mock", "mock")
