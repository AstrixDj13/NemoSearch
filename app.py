"""Entrypoint for Hugging Face ZeroGPU & Render / Uvicorn."""
import os
import uvicorn

# Satisfy Hugging Face ZeroGPU startup check if running inside a ZeroGPU Space
try:
    import spaces  # type: ignore

    @spaces.GPU
    def _zerogpu_noop():
        return "ok"
except Exception:
    pass

if __name__ == "__main__":
    port = int(os.environ.get("GRADIO_SERVER_PORT", os.environ.get("PORT", "7860")))
    uvicorn.run("backend.app.main:app", host="0.0.0.0", port=port)
