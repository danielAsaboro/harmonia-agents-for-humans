# Gemini & Google Agent Framework Integration

This document details the AI architecture, model selection, and agent frameworks used in the Closefold project.

## Gemini Model Selection
Closefold leverages state-of-the-art Gemini models accessed via the official **Gemini API** or **Vertex AI**.
* **Primary Model**: `gemini-1.5-pro` / `gemini-2.5-flash` or newer (supporting Gemini 3.5 capabilities where available).
* **Usage**: Used for complex reasoning, dynamic tool utilization, and agentic loop execution within `agent/closefold_agent/agents.py`.

## Google Agent Framework
The agent implementation is built on top of the official **Google GenAI SDK** / **Google Agent Development Kit (ADK)**.

### Framework Features Leveraged
* **Tool Calling (Function Calling)**: Allowing the Gemini model to interact with local repository files, issue tracking, and code refactoring functions.
* **Structured Outputs**: Ensuring the model returns parseable JSON that aligns with project specs.
* **Context Caching**: Leveraging Gemini's large context window and caching to optimize repeated queries over the codebase.

### Agent Definition Code Structure
The file `agent/closefold_agent/agents.py` initializes the Google GenAI SDK client:
```python
from google import genai
from google.genai import types

# Example Initialization of Gemini Model via GenAI SDK
client = genai.Client()

def run_agent(prompt: str):
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction="You are Closefold, an advanced development agent...",
            temperature=0.2,
        )
    )
    return response.text
```