#!/usr/bin/env python3
"""
browser-use runner bridge for the competitive bench harness.

Takes (goal, url, model, output_dir, timeout, max_steps) on the CLI and runs
a browser_use Agent against the URL. Captures every LLM call's usage by
monkey-patching ChatOpenAI.ainvoke (browser-use 0.12.x doesn't expose token
counts on the AgentHistoryList, but its LLM wrapper returns them on each
ainvoke call). Writes result.json matching the CompetitiveRunResult shape
that the .mjs adapter consumes.

Usage:
    python _browser_use_runner.py \\
        --goal "Click Next" \\
        --url "http://127.0.0.1:8080/form.html" \\
        --model gpt-5.2 \\
        --output-dir /tmp/run-1 \\
        --max-steps 30 \\
        --timeout-sec 600

Output:
    <output-dir>/result.json — see the dict at the bottom of run() for shape

This script runs in the venv at .venv-browseruse/bin/python; it's launched
by bench/competitive/adapters/browser-use.mjs.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="browser-use bench runner")
    parser.add_argument("--goal", required=True, help="Task goal in natural language")
    parser.add_argument("--url", required=True, help="Starting URL")
    parser.add_argument("--model", default="gpt-5.2", help="OpenAI model id")
    parser.add_argument("--output-dir", required=True, help="Where result.json + artifacts go")
    parser.add_argument("--max-steps", type=int, default=30)
    parser.add_argument("--timeout-sec", type=float, default=600.0)
    return parser.parse_args()


async def run() -> dict[str, Any]:
    args = parse_args()
    started_at = time.time()
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Token capture: monkey-patch ChatOpenAI.ainvoke to tee every usage
    # block into a totals dict. browser-use 0.12.x does not expose tokens
    # on the AgentHistoryList; the LLM wrapper does, so we intercept there.
    from browser_use.llm.openai.chat import ChatOpenAI

    totals = {
        "llm_calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cached_input_tokens": 0,
        "total_tokens": 0,
    }
    original_ainvoke = ChatOpenAI.ainvoke

    async def patched_ainvoke(self, messages, output_format=None, **kwargs):  # type: ignore[no-untyped-def]
        result = await original_ainvoke(self, messages, output_format=output_format, **kwargs)
        usage = getattr(result, "usage", None)
        if usage is not None:
            totals["llm_calls"] += 1
            prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
            completion = int(getattr(usage, "completion_tokens", 0) or 0)
            cached = int(getattr(usage, "prompt_cached_tokens", 0) or 0)
            total = int(getattr(usage, "total_tokens", 0) or (prompt + completion))
            totals["input_tokens"] += prompt
            totals["output_tokens"] += completion
            totals["cached_input_tokens"] += cached
            totals["total_tokens"] += total
        return result

    ChatOpenAI.ainvoke = patched_ainvoke  # type: ignore[method-assign]

    # Build the agent. directly_open_url=True means browser-use opens the
    # URL directly instead of via search, which is the closer comparison
    # to bad's startUrl behavior.
    from browser_use import Agent

    llm = ChatOpenAI(model=args.model)
    full_task = f"{args.goal}\n\nStart at: {args.url}"

    agent_state: dict[str, Any] = {
        "agent": None,
        "history": None,
        "errors": None,
    }

    # Capture page state via on_step_end callback. We can't call
    # get_state_as_text after agent.run() returns — by then the
    # browser session is being torn down and the call hangs forever.
    # So we record state after every step and keep the latest.
    last_state = {"page_text": "", "page_url": ""}

    async def _on_step_end(agent_obj):  # type: ignore[no-untyped-def]
        try:
            session = getattr(agent_obj, "browser_session", None)
            if session is None:
                return
            try:
                last_state["page_text"] = (await session.get_state_as_text()) or ""
            except Exception:
                pass
            try:
                last_state["page_url"] = (await session.get_current_page_url()) or ""
            except Exception:
                pass
        except Exception:
            pass

    async def _run_agent() -> None:
        agent = Agent(
            task=full_task,
            llm=llm,
            use_vision=False,
            calculate_cost=False,
            directly_open_url=True,
            step_timeout=180,
        )
        agent_state["agent"] = agent
        try:
            history = await agent.run(max_steps=args.max_steps, on_step_end=_on_step_end)
            agent_state["history"] = history
        except Exception as exc:
            agent_state["errors"] = str(exc)
        agent_state["final_page_text"] = last_state["page_text"]
        agent_state["final_page_url"] = last_state["page_url"]

    try:
        await asyncio.wait_for(_run_agent(), timeout=args.timeout_sec)
    except asyncio.TimeoutError:
        agent_state["errors"] = f"timeout after {args.timeout_sec}s"

    wall_time_ms = int((time.time() - started_at) * 1000)

    # Extract final state. Even if the run errored we want as much info as
    # we can dig out — the bench reports honest failures.
    history = agent_state["history"]
    final_url = ""
    final_snapshot = ""
    result_text = ""
    turn_count: int | None = None
    is_done = False
    is_successful = False

    if history is not None:
        try:
            turn_count = history.number_of_steps()
        except Exception:
            turn_count = None
        try:
            is_done = bool(history.is_done())
        except Exception:
            pass
        try:
            is_successful = bool(history.is_successful())
        except Exception:
            pass
        try:
            result_text = str(history.final_result() or "")
        except Exception:
            result_text = ""
        try:
            urls = history.urls()
            if urls:
                final_url = str(urls[-1] or "")
        except Exception:
            pass

    # Prefer the captured page DOM (real state) over extracted_content
    # (agent narrative). The DOM is what the oracle should match against.
    page_text = agent_state.get("final_page_text") or ""
    if page_text:
        final_snapshot = page_text
    if agent_state.get("final_page_url"):
        final_url = agent_state["final_page_url"]
    if not final_snapshot and history is not None:
        # Fall back to extracted_content only if we couldn't get the DOM.
        try:
            extracted = history.extracted_content()
            if extracted:
                final_snapshot = "\n".join(str(s) for s in extracted)
        except Exception:
            pass

    out = {
        "framework": "browser-use",
        "framework_version": __import__("importlib.metadata", fromlist=["version"]).version("browser-use"),
        "started_at_unix": started_at,
        "wall_time_ms": wall_time_ms,
        "turn_count": turn_count,
        "llm_call_count": totals["llm_calls"],
        "input_tokens": totals["input_tokens"] or None,
        "output_tokens": totals["output_tokens"] or None,
        "cached_input_tokens": totals["cached_input_tokens"],
        "total_tokens": totals["total_tokens"] or None,
        "is_done": is_done,
        "is_successful": is_successful,
        "final_url": final_url,
        "final_snapshot": final_snapshot,
        "result_text": result_text,
        "error_reason": agent_state["errors"],
        "model": args.model,
    }

    result_path = out_dir / "result.json"
    result_path.write_text(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    try:
        result = asyncio.run(run())
        print(f"browser-use bridge: wrote result for {result['framework']} v{result['framework_version']}", file=sys.stderr)
        sys.exit(0 if result.get("error_reason") is None else 1)
    except Exception as exc:
        print(f"browser-use bridge ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(2)
